/**
 * Servicio unificado de Plantillas de Gastos Fijos, Compras en Cuotas y Compromisos Mensuales.
 *
 * Arquitectura y decisiones técnicas:
 * - Regla estricta de no retroactividad: al editar o pausar una plantilla de gasto fijo,
 *   jamás alteramos meses pasados ni instancias del mes actual que ya estén marcadas como
 *   `is_paid = true`, preservando el registro real de lo que ya se abonó.
 * - Compras en cuotas mediante RPC: `create_installment_purchase` y `update_installment_purchase`
 *   se ejecutan atómicamente en PostgreSQL para garantizar que la compra padre y sus N
 *   compromisos mensuales queden consistentes sin operaciones a medias.
 * - Alerta real-time de Gustitos al adelantar cuotas: `advanceInstallments`
 *   dispara `triggerPurchaseGustitosAlertNonBlocking` pasando el `target_month_date`
 *   real cuando las cuotas adelantadas impactan en el mes calendario actual.
 */
import {
  addMonthsToMonthDate,
  parseLocalISODate,
  roundCurrency,
  toLocalISODate,
  toMonthStartISODate,
} from '../lib/formatters';
import { advanceInstallmentsSchema } from '../lib/validations';
import { supabase } from '../lib/supabaseClient';
import type {
  AdvanceInstallmentsInput,
  AdvanceInstallmentsResult,
  FixedExpenseTemplate,
  FixedExpenseTemplateInput,
  InstallmentPaymentBatch,
  InstallmentProgressSummary,
  InstallmentPurchase,
  InstallmentPurchaseInput,
  MonthlyCommitment,
  RevertInstallmentBatchResult,
} from '../types/database.types';
import { ensureMonthlyPeriod } from './settingsService';

async function requireAuthenticatedUserId(): Promise<string> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.user?.id) {
    throw new Error('Tu sesión expiró. Iniciá sesión nuevamente para continuar.');
  }

  return session.user.id;
}

function computeDueDateForMonth(monthDate: string, dueDay: number | null): string | null {
  if (dueDay === null || dueDay < 1 || dueDay > 31) return null;
  const start = parseLocalISODate(toMonthStartISODate(monthDate));
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const clampedDay = Math.min(dueDay, daysInMonth);
  return toLocalISODate(new Date(start.getFullYear(), start.getMonth(), clampedDay));
}

function mapTemplate(row: FixedExpenseTemplate): FixedExpenseTemplate {
  return {
    ...row,
    default_amount: Number(row.default_amount),
  };
}

function mapInstallmentPurchase(row: InstallmentPurchase): InstallmentPurchase {
  return {
    ...row,
    installment_amount: Number(row.installment_amount),
    total_amount: Number(row.total_amount),
    is_gustito: Boolean(row.is_gustito),
    source: row.source ?? 'web',
  };
}

function triggerPurchaseGustitosAlertNonBlocking(
  monthDate: string,
  purchaseId: string,
): void {
  void supabase.functions
    .invoke('notify-gustitos-alert', {
      body: { monthDate, purchaseId },
    })
    .then(({ error }) => {
      if (error) {
        console.warn('No se pudo evaluar la alerta de Gustitos en Telegram:', error.message);
      }
    })
    .catch((err: unknown) => {
      console.warn('Error al invocar notify-gustitos-alert:', err);
    });
}

function mapCommitment(row: MonthlyCommitment): MonthlyCommitment {
  return {
    ...row,
    amount: Number(row.amount),
  };
}

// ----------------------------------------------------------------------------
// 1. PLANTILLAS DE GASTOS FIJOS RECURRENTES
// ----------------------------------------------------------------------------

export async function getFixedExpenseTemplates(): Promise<FixedExpenseTemplate[]> {
  const { data, error } = await supabase
    .from('fixed_expense_templates')
    .select('*, category:categories(*)')
    .order('is_active', { ascending: false })
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`No se pudieron cargar los gastos fijos: ${error.message}`);
  }

  return ((data ?? []) as FixedExpenseTemplate[]).map(mapTemplate);
}

export async function createFixedExpenseTemplate(
  userId: string,
  input: FixedExpenseTemplateInput,
  currentMonthDate: string,
): Promise<FixedExpenseTemplate> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para crear plantillas para otro usuario.');
  }

  const normalizedMonth = toMonthStartISODate(currentMonthDate);
  const amount = roundCurrency(input.default_amount);

  const { data, error } = await supabase
    .from('fixed_expense_templates')
    .insert({
      user_id: sessionUserId,
      category_id: input.category_id,
      name: input.name.trim(),
      default_amount: amount,
      due_day: input.due_day,
      is_active: true,
      notes: input.notes?.trim() || null,
    })
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo crear la plantilla de gasto fijo: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  // Asegura snapshot e instancia inmediata en el mes actual vía RPC idempotente
  await ensureMonthlyPeriod(normalizedMonth);

  return mapTemplate(data as FixedExpenseTemplate);
}

export async function updateFixedExpenseTemplate(
  userId: string,
  id: string,
  input: FixedExpenseTemplateInput,
  currentMonthDate: string,
): Promise<FixedExpenseTemplate> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para actualizar plantillas de otro usuario.');
  }

  const normalizedMonth = toMonthStartISODate(currentMonthDate);
  const amount = roundCurrency(input.default_amount);

  const { data, error } = await supabase
    .from('fixed_expense_templates')
    .update({
      category_id: input.category_id,
      name: input.name.trim(),
      default_amount: amount,
      due_day: input.due_day,
      notes: input.notes?.trim() || null,
    })
    .eq('id', id)
    .eq('user_id', sessionUserId)
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo actualizar el gasto fijo: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  // Sincroniza la instancia del mes actual SOLO si aún está pendiente (`is_paid = false`)
  const { error: syncError } = await supabase
    .from('monthly_commitments')
    .update({
      category_id: input.category_id,
      name: input.name.trim(),
      amount,
      due_date: computeDueDateForMonth(normalizedMonth, input.due_day),
      notes: input.notes?.trim() || null,
    })
    .eq('user_id', userId)
    .eq('fixed_expense_template_id', id)
    .eq('month_date', normalizedMonth)
    .eq('is_paid', false);

  if (syncError) {
    throw new Error(
      `Plantilla guardada, pero falló la actualización del mes actual: ${syncError.message}`,
    );
  }

  return mapTemplate(data as FixedExpenseTemplate);
}

export async function getCurrentMonthPendingForTemplate(
  userId: string,
  templateId: string,
  currentMonthDate: string,
): Promise<MonthlyCommitment | null> {
  const normalizedMonth = toMonthStartISODate(currentMonthDate);
  const { data, error } = await supabase
    .from('monthly_commitments')
    .select('*')
    .eq('user_id', userId)
    .eq('fixed_expense_template_id', templateId)
    .eq('month_date', normalizedMonth)
    .eq('is_paid', false)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo verificar el estado mensual de la plantilla: ${error.message}`);
  }

  return data ? mapCommitment(data as MonthlyCommitment) : null;
}

export async function toggleFixedExpenseTemplateActive(
  userId: string,
  id: string,
  isActive: boolean,
  currentMonthDate: string,
  removeCurrentMonthPending = false,
): Promise<FixedExpenseTemplate> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para modificar plantillas de otro usuario.');
  }

  const normalizedMonth = toMonthStartISODate(currentMonthDate);

  const { data, error } = await supabase
    .from('fixed_expense_templates')
    .update({ is_active: isActive })
    .eq('id', id)
    .eq('user_id', sessionUserId)
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo cambiar el estado de la plantilla: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  if (!isActive && removeCurrentMonthPending) {
    const { error: deleteError } = await supabase
      .from('monthly_commitments')
      .delete()
      .eq('user_id', userId)
      .eq('fixed_expense_template_id', id)
      .eq('month_date', normalizedMonth)
      .eq('is_paid', false);

    if (deleteError) {
      throw new Error(
        `Plantilla pausada, pero no se pudo quitar la instancia pendiente del mes actual: ${deleteError.message}`,
      );
    }
  } else if (isActive) {
    await ensureMonthlyPeriod(normalizedMonth);
  }

  return mapTemplate(data as FixedExpenseTemplate);
}

// ----------------------------------------------------------------------------
// 2. COMPRAS EN CUOTAS (PADRE + PRE-GENERACIÓN DE CUOTAS)
// ----------------------------------------------------------------------------

export async function getInstallmentPurchases(): Promise<InstallmentPurchase[]> {
  const { data, error } = await supabase
    .from('installment_purchases')
    .select('*, category:categories(*)')
    .order('first_installment_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`No se pudieron cargar las compras en cuotas: ${error.message}`);
  }

  return ((data ?? []) as InstallmentPurchase[]).map(mapInstallmentPurchase);
}

export async function getInstallmentProgressMap(): Promise<
  Record<string, InstallmentProgressSummary>
> {
  const { data, error } = await supabase
    .from('monthly_commitments')
    .select('installment_purchase_id, is_paid')
    .eq('commitment_type', 'installment')
    .not('installment_purchase_id', 'is', null);

  if (error) {
    throw new Error(`No se pudo consultar el avance de cuotas: ${error.message}`);
  }

  const map: Record<string, InstallmentProgressSummary> = {};
  for (const row of data ?? []) {
    const purchaseId = row.installment_purchase_id as string;
    if (!map[purchaseId]) {
      map[purchaseId] = { purchaseId, paidCount: 0, totalCount: 0 };
    }
    map[purchaseId].totalCount += 1;
    if (row.is_paid) {
      map[purchaseId].paidCount += 1;
    }
  }
  return map;
}

export async function createInstallmentPurchase(
  input: InstallmentPurchaseInput,
): Promise<InstallmentPurchase> {
  await requireAuthenticatedUserId();
  const { data, error } = await supabase.rpc('create_installment_purchase', {
    p_category_id: input.category_id,
    p_description: input.description.trim(),
    p_installment_amount: roundCurrency(input.installment_amount),
    p_installments_count: input.installments_count,
    p_purchase_date: input.purchase_date,
    p_first_installment_date: input.first_installment_date,
    p_notes: input.notes?.trim() || null,
    p_is_gustito: Boolean(input.is_gustito),
    p_source: 'web',
  });

  if (error || !data) {
    throw new Error(
      `No se pudo registrar la compra en cuotas: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  const created = mapInstallmentPurchase(data as InstallmentPurchase);
  const firstInstallmentMonth = toMonthStartISODate(created.first_installment_date);
  const currentMonth = toMonthStartISODate(new Date());
  if (firstInstallmentMonth === currentMonth) {
    triggerPurchaseGustitosAlertNonBlocking(firstInstallmentMonth, created.id);
  }

  return created;
}

export async function updateInstallmentPurchase(
  purchaseId: string,
  input: InstallmentPurchaseInput,
): Promise<InstallmentPurchase> {
  await requireAuthenticatedUserId();
  const { data, error } = await supabase.rpc('update_installment_purchase', {
    p_purchase_id: purchaseId,
    p_category_id: input.category_id,
    p_description: input.description.trim(),
    p_installment_amount: roundCurrency(input.installment_amount),
    p_installments_count: input.installments_count,
    p_purchase_date: input.purchase_date,
    p_first_installment_date: input.first_installment_date,
    p_notes: input.notes?.trim() || null,
    p_is_gustito: Boolean(input.is_gustito),
  });

  if (error || !data) {
    throw new Error(
      `No se pudo actualizar la compra en cuotas: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  const updated = mapInstallmentPurchase(data as InstallmentPurchase);
  const firstInstallmentMonth = toMonthStartISODate(updated.first_installment_date);
  const lastInstallmentMonth = addMonthsToMonthDate(
    firstInstallmentMonth,
    Math.max(0, updated.installments_count - 1),
  );
  const currentMonth = toMonthStartISODate(new Date());

  if (
    firstInstallmentMonth <= currentMonth &&
    currentMonth <= lastInstallmentMonth
  ) {
    triggerPurchaseGustitosAlertNonBlocking(currentMonth, updated.id);
  }

  return updated;
}

export async function getPaidInstallmentsCount(purchaseId: string): Promise<number> {
  const { count, error } = await supabase
    .from('monthly_commitments')
    .select('id', { count: 'exact', head: true })
    .eq('installment_purchase_id', purchaseId)
    .eq('is_paid', true);

  if (error) {
    throw new Error(`No se pudo consultar el historial de cuotas pagadas: ${error.message}`);
  }

  return count ?? 0;
}

export async function deleteInstallmentPurchase(purchaseId: string): Promise<void> {
  const sessionUserId = await requireAuthenticatedUserId();
  const { error } = await supabase
    .from('installment_purchases')
    .delete()
    .eq('id', purchaseId)
    .eq('user_id', sessionUserId);

  if (error) {
    throw new Error(`No se pudo anular la compra en cuotas: ${error.message}`);
  }
}

// ----------------------------------------------------------------------------
// 3. COMPROMISOS MENSUALES (CHECKLIST DE PAGO Y AJUSTES DEL MES)
// ----------------------------------------------------------------------------

export async function getMonthlyCommitments(monthDate: string): Promise<MonthlyCommitment[]> {
  const normalizedMonth = toMonthStartISODate(monthDate);
  const { data, error } = await supabase
    .from('monthly_commitments')
    .select(
      '*, category:categories(*), installment_purchase:installment_purchases(id, is_gustito, source)',
    )
    .eq('month_date', normalizedMonth)
    .order('is_paid', { ascending: true })
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`No se pudieron cargar los compromisos del mes: ${error.message}`);
  }

  return ((data ?? []) as MonthlyCommitment[]).map(mapCommitment);
}

export async function toggleCommitmentPaidStatus(
  commitmentId: string,
  isPaid: boolean,
): Promise<MonthlyCommitment> {
  const sessionUserId = await requireAuthenticatedUserId();
  const { data, error } = await supabase
    .from('monthly_commitments')
    .update({
      is_paid: isPaid,
      paid_at: isPaid ? new Date().toISOString() : null,
    })
    .eq('id', commitmentId)
    .eq('user_id', sessionUserId)
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo actualizar el estado de pago: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  return mapCommitment(data as MonthlyCommitment);
}

export async function updateMonthlyCommitmentAmount(
  commitmentId: string,
  amount: number,
): Promise<MonthlyCommitment> {
  const sessionUserId = await requireAuthenticatedUserId();
  // Contrato defensivo: solo se ajustan puntualmente instancias de gasto fijo (nunca cuotas individuales)
  const { data, error } = await supabase
    .from('monthly_commitments')
    .update({
      amount: roundCurrency(amount),
    })
    .eq('id', commitmentId)
    .eq('user_id', sessionUserId)
    .eq('commitment_type', 'fixed_expense')
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo ajustar el monto del compromiso: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  return mapCommitment(data as MonthlyCommitment);
}

// ----------------------------------------------------------------------------
// 4. ADELANTO / PAGO MÚLTIPLE DE N CUOTAS Y REVERSIÓN POR LOTE
// ----------------------------------------------------------------------------

export async function getPendingInstallmentsForPurchase(
  purchaseId: string,
): Promise<MonthlyCommitment[]> {
  await requireAuthenticatedUserId();
  const { data, error } = await supabase
    .from('monthly_commitments')
    .select('*, category:categories(*)')
    .eq('installment_purchase_id', purchaseId)
    .eq('commitment_type', 'installment')
    .eq('is_paid', false)
    .order('installment_number', { ascending: true });

  if (error) {
    throw new Error(
      `No se pudieron cargar las cuotas pendientes: ${error.message}`,
    );
  }

  return ((data ?? []) as MonthlyCommitment[]).map(mapCommitment);
}

export async function advanceInstallments(
  input: AdvanceInstallmentsInput,
): Promise<AdvanceInstallmentsResult> {
  await requireAuthenticatedUserId();
  const parsed = advanceInstallmentsSchema.safeParse({
    count: input.count,
    custom_total_amount: input.total_amount ?? null,
  });

  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos para adelantar cuotas son inválidos.';
    throw new Error(firstErr);
  }

  const normalizedMonth = toMonthStartISODate(input.target_month_date);

  const { data, error } = await supabase.rpc('advance_installments', {
    p_purchase_id: input.purchase_id,
    p_count: parsed.data.count,
    p_target_month_date: normalizedMonth,
    p_total_amount:
      parsed.data.custom_total_amount !== null
        ? roundCurrency(parsed.data.custom_total_amount)
        : null,
    p_source: 'web',
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo completar el adelanto de cuotas.',
    );
  }

  const result = data as AdvanceInstallmentsResult;
  const targetMonth = toMonthStartISODate(result.target_month_date ?? normalizedMonth);
  const currentMonth = toMonthStartISODate(new Date());
  if (targetMonth === currentMonth) {
    triggerPurchaseGustitosAlertNonBlocking(targetMonth, result.purchase_id);
  }

  return result;
}

export async function revertInstallmentPaymentBatch(
  batchId: string,
): Promise<RevertInstallmentBatchResult> {
  await requireAuthenticatedUserId();
  const { data, error } = await supabase.rpc('revert_installment_payment_batch', {
    p_batch_id: batchId,
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo deshacer el lote de adelanto de cuotas.',
    );
  }

  return data as RevertInstallmentBatchResult;
}

export async function getRecentInstallmentBatches(
  targetMonthDate?: string,
): Promise<InstallmentPaymentBatch[]> {
  await requireAuthenticatedUserId();
  let query = supabase
    .from('installment_payment_batches')
    .select('*')
    .is('reverted_at', null)
    .order('created_at', { ascending: false });

  if (targetMonthDate) {
    query = query.eq('target_month_date', toMonthStartISODate(targetMonthDate));
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `No se pudieron cargar los lotes recientes de adelantos: ${error.message}`,
    );
  }

  return ((data ?? []) as InstallmentPaymentBatch[]).map((row) => ({
    ...row,
    installments_count: Number(row.installments_count),
    total_paid_amount: Number(row.total_paid_amount),
  }));
}
