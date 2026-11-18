/**
 * Servicio de Bóveda de Ahorros Aislada (`savings_entries` + snapshots congelados).
 *
 * Arquitectura y decisiones técnicas:
 * - Aislamiento financiero y visual: un movimiento en `savings_entries` no es un gasto
 *   consumido (`transactions`), sino un apartado patrimonial hacia la Bóveda de Ahorros.
 *   Los aportes (`deposit`) más el `monthly_savings_target` congelado se descuentan del
 *   `Disponible Real` mensual sin exponer jamás el acumulado total en el Dashboard.
 * - Protección de saldo acumulado y acreditación atómica: `createSavingsEntry`
 *   valida con Zod y delega en la RPC `create_savings_entry_with_credit`, que bloquea al
 *   usuario con `pg_advisory_xact_lock`, valida el saldo líquido en PostgreSQL y registra
 *   tanto el movimiento de ahorro como el eventual ingreso compensatorio en 1 transacción.
 */
import { roundCurrency, toMonthStartISODate } from '../lib/formatters';
import { savingsEntrySchema } from '../lib/validations';
import { supabase } from '../lib/supabaseClient';
import type {
  AccumulatedSavingsSummary,
  SavingsEntry,
  SavingsEntryInput,
} from '../types/database.types';

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

function mapSavingsEntry(row: SavingsEntry): SavingsEntry {
  return {
    ...row,
    amount: Number(row.amount),
    source_type: row.source_type ?? 'manual',
    fixed_term_id: row.fixed_term_id ?? null,
    source_month_date: row.source_month_date ?? null,
  };
}

export async function getSavingsEntriesByMonth(monthDate: string): Promise<SavingsEntry[]> {
  const normalizedMonth = toMonthStartISODate(monthDate);

  const { data, error } = await supabase
    .from('savings_entries')
    .select('*')
    .eq('month_date', normalizedMonth)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`No se pudieron cargar los movimientos de ahorro del mes: ${error.message}`);
  }

  return ((data ?? []) as SavingsEntry[]).map(mapSavingsEntry);
}

export async function getAllSavingsEntries(): Promise<SavingsEntry[]> {
  const { data, error } = await supabase
    .from('savings_entries')
    .select('*')
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`No se pudo cargar el historial de ahorros: ${error.message}`);
  }

  return ((data ?? []) as SavingsEntry[]).map(mapSavingsEntry);
}

export async function getAccumulatedSavingsBalance(): Promise<AccumulatedSavingsSummary> {
  const currentCalendarMonth = toMonthStartISODate(new Date());

  const [budgetsRes, entriesRes, fixedTermsRes] = await Promise.all([
    supabase
      .from('monthly_budgets')
      .select('monthly_savings_target')
      .lte('month_date', currentCalendarMonth),
    supabase.from('savings_entries').select('entry_type, amount'),
    supabase
      .from('fixed_term_deposits')
      .select('principal_amount')
      .eq('status', 'active'),
  ]);

  if (budgetsRes.error) {
    throw new Error(
      `No se pudo calcular el ahorro mensual acumulado: ${budgetsRes.error.message}`,
    );
  }
  if (entriesRes.error) {
    throw new Error(
      `No se pudieron consolidar los movimientos de ahorro: ${entriesRes.error.message}`,
    );
  }
  if (fixedTermsRes.error) {
    throw new Error(
      `No se pudo calcular el capital inmovilizado en plazos fijos: ${fixedTermsRes.error.message}`,
    );
  }

  let totalMonthlyTargetsFrozen = 0;
  for (const row of budgetsRes.data ?? []) {
    totalMonthlyTargetsFrozen = roundCurrency(
      totalMonthlyTargetsFrozen + Number(row.monthly_savings_target ?? 0),
    );
  }

  let totalExtraDeposits = 0;
  let totalWithdrawals = 0;
  for (const row of entriesRes.data ?? []) {
    const amount = Number(row.amount ?? 0);
    if (row.entry_type === 'deposit') {
      totalExtraDeposits = roundCurrency(totalExtraDeposits + amount);
    } else if (row.entry_type === 'withdrawal') {
      totalWithdrawals = roundCurrency(totalWithdrawals + amount);
    }
  }

  let immobilizedInFixedTerms = 0;
  for (const row of fixedTermsRes.data ?? []) {
    immobilizedInFixedTerms = roundCurrency(
      immobilizedInFixedTerms + Number(row.principal_amount ?? 0),
    );
  }

  const liquidBalance = Math.max(
    0,
    roundCurrency(totalMonthlyTargetsFrozen + totalExtraDeposits - totalWithdrawals),
  );
  const totalPatrimony = roundCurrency(liquidBalance + immobilizedInFixedTerms);

  return {
    totalAccumulated: liquidBalance,
    liquidBalance,
    immobilizedInFixedTerms,
    totalPatrimony,
    totalMonthlyTargetsFrozen,
    totalExtraDeposits,
    totalWithdrawals,
  };
}

export async function createSavingsEntry(
  userId: string,
  input: SavingsEntryInput,
): Promise<SavingsEntry> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para registrar movimientos de ahorro para otro usuario.');
  }

  const parsed = savingsEntrySchema.safeParse({
    entry_type: input.entry_type,
    amount: input.amount,
    entry_date: input.entry_date,
    description: input.description,
    notes: input.notes ?? null,
    credit_to_available: Boolean(input.credit_to_available),
  });

  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos del movimiento de ahorro son inválidos.';
    throw new Error(firstErr);
  }

  const shouldCreditToAvailable =
    parsed.data.entry_type === 'withdrawal' && Boolean(parsed.data.credit_to_available);

  const { data, error } = await supabase.rpc('create_savings_entry_with_credit', {
    p_entry_type: parsed.data.entry_type,
    p_amount: roundCurrency(parsed.data.amount),
    p_entry_date: parsed.data.entry_date,
    p_description: parsed.data.description,
    p_notes: parsed.data.notes?.trim() || null,
    p_credit_to_available: shouldCreditToAvailable,
    p_compensatory_category_id: null,
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo registrar el movimiento de ahorro.',
    );
  }

  return mapSavingsEntry(data as SavingsEntry);
}

export async function deleteSavingsEntry(id: string): Promise<void> {
  const sessionUserId = await requireAuthenticatedUserId();
  const { error } = await supabase
    .from('savings_entries')
    .delete()
    .eq('id', id)
    .eq('user_id', sessionUserId);

  if (error) {
    throw new Error(`No se pudo eliminar el movimiento de ahorro: ${error.message}`);
  }
}
