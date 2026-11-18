/**
 * Servicio de Movimientos Manuales (`transactions`) y series históricas de 6 meses.
 *
 * Arquitectura y decisiones técnicas:
 * - Rango local estricto (`YYYY-MM-01` hasta último día del mes): PostgreSQL compara
 *   la columna `DATE` directamente sin conversiones de zona horaria.
 * - Serie de 6 meses en 3 consultas agregadas: en lugar de disparar 18 queries (N+1),
 *   solicitamos de una sola vez los presupuestos, compromisos y transacciones de toda
 *   la ventana de 6 meses y consolidamos cada mes en memoria.
 * - Mutaciones atómicas con ahorro directo: `createTransaction` y `updateTransaction`
 *   validan con Zod y delegan en `create_transaction_with_savings` /
 *   `update_transaction_with_savings` para inicializar el período y sincronizar
 *   `savings_entries` dentro de una única transacción SQL sin estados intermedios.
 */
import {
  addMonthsToMonthDate,
  formatShortMonthLabel,
  getMonthEndISODate,
  roundCurrency,
  toMonthStartISODate,
} from '../lib/formatters';
import { transactionSchema } from '../lib/validations';
import { supabase } from '../lib/supabaseClient';
import type {
  MonthlyEvolutionPoint,
  Transaction,
  TransactionInput,
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

function mapTransaction(row: Transaction): Transaction {
  return {
    ...row,
    amount: Number(row.amount),
    is_gustito: Boolean(row.is_gustito),
    save_to_savings: Boolean(row.save_to_savings),
  };
}

function triggerGustitosAlertNonBlocking(monthDate: string, transactionId: string): void {
  void supabase.functions
    .invoke('notify-gustitos-alert', {
      body: { monthDate, transactionId },
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

export async function getTransactionsByMonth(monthDate: string): Promise<Transaction[]> {
  const monthStart = toMonthStartISODate(monthDate);
  const monthEnd = getMonthEndISODate(monthStart);

  const { data, error } = await supabase
    .from('transactions')
    .select('*, category:categories(*)')
    .gte('transaction_date', monthStart)
    .lte('transaction_date', monthEnd)
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`No se pudieron cargar los movimientos del mes: ${error.message}`);
  }

  return ((data ?? []) as Transaction[]).map(mapTransaction);
}

export async function createTransaction(
  userId: string,
  input: TransactionInput,
): Promise<Transaction> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para registrar movimientos para otro usuario.');
  }

  const parsed = transactionSchema.safeParse({
    type: input.type,
    category_id: input.category_id,
    amount: input.amount,
    transaction_date: input.transaction_date,
    description: input.description,
    notes: input.notes ?? null,
    is_gustito: input.type === 'expense' ? Boolean(input.is_gustito) : false,
    save_to_savings: input.type === 'income' ? Boolean(input.save_to_savings) : false,
  });

  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos del movimiento son inválidos.';
    throw new Error(firstErr);
  }

  const { data, error } = await supabase.rpc('create_transaction_with_savings', {
    p_type: parsed.data.type,
    p_category_id: parsed.data.category_id,
    p_amount: roundCurrency(parsed.data.amount),
    p_transaction_date: parsed.data.transaction_date,
    p_description: parsed.data.description,
    p_notes: parsed.data.notes?.trim() || null,
    p_is_gustito: parsed.data.is_gustito,
    p_save_to_savings: parsed.data.save_to_savings,
    p_source: 'web',
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo registrar el movimiento.',
    );
  }

  const created = mapTransaction(data as Transaction);
  const txMonth = toMonthStartISODate(created.transaction_date);
  const currentMonth = toMonthStartISODate(new Date());

  if (created.type === 'expense' && txMonth === currentMonth) {
    triggerGustitosAlertNonBlocking(txMonth, created.id);
  }

  return created;
}

export async function updateTransaction(
  id: string,
  input: TransactionInput,
): Promise<Transaction> {
  await requireAuthenticatedUserId();

  const parsed = transactionSchema.safeParse({
    type: input.type,
    category_id: input.category_id,
    amount: input.amount,
    transaction_date: input.transaction_date,
    description: input.description,
    notes: input.notes ?? null,
    is_gustito: input.type === 'expense' ? Boolean(input.is_gustito) : false,
    save_to_savings: input.type === 'income' ? Boolean(input.save_to_savings) : false,
  });

  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos del movimiento son inválidos.';
    throw new Error(firstErr);
  }

  const { data, error } = await supabase.rpc('update_transaction_with_savings', {
    p_transaction_id: id,
    p_type: parsed.data.type,
    p_category_id: parsed.data.category_id,
    p_amount: roundCurrency(parsed.data.amount),
    p_transaction_date: parsed.data.transaction_date,
    p_description: parsed.data.description,
    p_notes: parsed.data.notes?.trim() || null,
    p_is_gustito: parsed.data.is_gustito,
    p_save_to_savings: parsed.data.save_to_savings,
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo actualizar el movimiento.',
    );
  }

  const updated = mapTransaction(data as Transaction);
  const txMonth = toMonthStartISODate(updated.transaction_date);
  const currentMonth = toMonthStartISODate(new Date());

  if (updated.type === 'expense' && txMonth === currentMonth) {
    triggerGustitosAlertNonBlocking(txMonth, updated.id);
  }

  return updated;
}

export async function deleteTransaction(id: string): Promise<void> {
  const sessionUserId = await requireAuthenticatedUserId();

  // Defensa en profundidad junto a ON DELETE CASCADE para limpiar cualquier aporte vinculado
  await supabase
    .from('savings_entries')
    .delete()
    .eq('source_transaction_id', id)
    .eq('user_id', sessionUserId);

  const { error } = await supabase
    .from('transactions')
    .delete()
    .eq('id', id)
    .eq('user_id', sessionUserId);

  if (error) {
    throw new Error(`No se pudo eliminar el movimiento: ${error.message}`);
  }
}

export async function getSixMonthsEvolution(
  endMonthDate: string,
  fallbackFixedSalary: number,
  fallbackSavingsTarget = 0,
  fallbackFixedLimit = 0,
  _fallbackGustitosBudget = 0,
): Promise<MonthlyEvolutionPoint[]> {
  const normalizedEnd = toMonthStartISODate(endMonthDate);
  const currentCalendarMonth = toMonthStartISODate(new Date());

  const months: string[] = [];
  for (let offset = -5; offset <= 0; offset += 1) {
    months.push(addMonthsToMonthDate(normalizedEnd, offset));
  }

  const hasFutureMonth = months.some((month) => month > currentCalendarMonth);
  const rangeStart = months[0];
  const rangeEnd = getMonthEndISODate(normalizedEnd);

  const [
    budgetsRes,
    commitmentsRes,
    transactionsRes,
    savingsRes,
    snapshotsRes,
    categoriesRes,
    fixedTermsRes,
    templatesRes,
  ] = await Promise.all([
    supabase
      .from('monthly_budgets')
      .select(
        'month_date, fixed_salary, monthly_savings_target, fixed_expenses_limit, gustitos_budget',
      )
      .gte('month_date', rangeStart)
      .lte('month_date', normalizedEnd),
    supabase
      .from('monthly_commitments')
      .select(
        'month_date, category_id, commitment_type, amount, fixed_expense_template_id, installment_purchase:installment_purchases(is_gustito)',
      )
      .gte('month_date', rangeStart)
      .lte('month_date', normalizedEnd),
    supabase
      .from('transactions')
      .select('transaction_date, category_id, type, amount, is_gustito')
      .gte('transaction_date', rangeStart)
      .lte('transaction_date', rangeEnd),
    supabase
      .from('savings_entries')
      .select('month_date, entry_type, amount, source_type')
      .gte('month_date', rangeStart)
      .lte('month_date', normalizedEnd)
      .eq('entry_type', 'deposit'),
    supabase
      .from('monthly_category_snapshots')
      .select('month_date, category_id, is_gustito')
      .gte('month_date', rangeStart)
      .lte('month_date', normalizedEnd),
    supabase.from('categories').select('id, is_gustito').eq('type', 'expense'),
    supabase
      .from('fixed_term_deposits')
      .select(
        'principal_amount, expected_return_amount, actual_return_amount, start_date, origin, status, accredited_month_date',
      )
      .neq('status', 'cancelled'),
    hasFutureMonth
      ? supabase
          .from('fixed_expense_templates')
          .select('id, default_amount')
          .eq('is_active', true)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (budgetsRes.error) {
    throw new Error(`Error al cargar presupuestos históricos: ${budgetsRes.error.message}`);
  }
  if (commitmentsRes.error) {
    throw new Error(`Error al cargar compromisos históricos: ${commitmentsRes.error.message}`);
  }
  if (transactionsRes.error) {
    throw new Error(`Error al cargar movimientos históricos: ${transactionsRes.error.message}`);
  }
  if (savingsRes.error) {
    throw new Error(`Error al cargar aportes de ahorro históricos: ${savingsRes.error.message}`);
  }
  if (snapshotsRes.error) {
    throw new Error(`Error al cargar snapshots de categorías: ${snapshotsRes.error.message}`);
  }
  if (categoriesRes.error) {
    throw new Error(`Error al cargar categorías históricas: ${categoriesRes.error.message}`);
  }
  if (fixedTermsRes.error) {
    throw new Error(`Error al cargar plazos fijos históricos: ${fixedTermsRes.error.message}`);
  }
  if (templatesRes.error) {
    throw new Error(`Error al cargar plantillas de gastos fijos: ${templatesRes.error.message}`);
  }

  const budgetByMonth = new Map<
    string,
    {
      fixedSalary: number;
      monthlySavingsTarget: number;
      fixedExpensesLimit: number;
      gustitosBudget: number;
    }
  >();
  for (const row of budgetsRes.data ?? []) {
    budgetByMonth.set(row.month_date as string, {
      fixedSalary: Number(row.fixed_salary ?? 0),
      monthlySavingsTarget: Number(row.monthly_savings_target ?? 0),
      fixedExpensesLimit: Number(row.fixed_expenses_limit ?? 0),
      gustitosBudget: Number(row.gustitos_budget ?? 0),
    });
  }

  const baseGustitoCatIds = new Set<string>();
  for (const cat of categoriesRes.data ?? []) {
    if (cat.is_gustito) {
      baseGustitoCatIds.add(cat.id as string);
    }
  }

  const snapshotsByMonth = new Map<string, Set<string>>();
  for (const snap of snapshotsRes.data ?? []) {
    const m = snap.month_date as string;
    let setForMonth = snapshotsByMonth.get(m);
    if (!setForMonth) {
      setForMonth = new Set<string>();
      snapshotsByMonth.set(m, setForMonth);
    }
    if (snap.is_gustito) {
      setForMonth.add(snap.category_id as string);
    }
  }

  const isGustitoCategoryInMonth = (month: string, categoryId: string): boolean => {
    const monthSnaps = snapshotsByMonth.get(month);
    if (monthSnaps) {
      return monthSnaps.has(categoryId);
    }
    return baseGustitoCatIds.has(categoryId);
  };

  const operationalSavingsByMonth = new Map<string, number>();
  const capSurplusFixedByMonth = new Map<string, number>();
  const capSurplusGustitosByMonth = new Map<string, number>();

  for (const row of savingsRes.data ?? []) {
    const key = row.month_date as string;
    const amt = Number(row.amount ?? 0);
    const sourceType = (row.source_type as string | undefined) ?? 'manual';
    if (sourceType === 'cap_surplus_fixed') {
      capSurplusFixedByMonth.set(
        key,
        roundCurrency((capSurplusFixedByMonth.get(key) ?? 0) + amt),
      );
    } else if (sourceType === 'cap_surplus_gustitos') {
      capSurplusGustitosByMonth.set(
        key,
        roundCurrency((capSurplusGustitosByMonth.get(key) ?? 0) + amt),
      );
    } else if (sourceType === 'manual' || sourceType === 'direct_income') {
      operationalSavingsByMonth.set(
        key,
        roundCurrency((operationalSavingsByMonth.get(key) ?? 0) + amt),
      );
    }
  }

  const fixedAndNonGustitoByMonth = new Map<string, number>();
  const gustitoCommitmentsByMonth = new Map<string, number>();
  const templateIdsByMonth = new Map<string, Set<string>>();

  for (const row of commitmentsRes.data ?? []) {
    const key = row.month_date as string;
    const amt = Number(row.amount ?? 0);
    if (row.fixed_expense_template_id) {
      const existingSet = templateIdsByMonth.get(key) ?? new Set<string>();
      existingSet.add(row.fixed_expense_template_id as string);
      templateIdsByMonth.set(key, existingSet);
    }

    if (row.commitment_type === 'fixed_expense') {
      fixedAndNonGustitoByMonth.set(
        key,
        roundCurrency((fixedAndNonGustitoByMonth.get(key) ?? 0) + amt),
      );
    } else {
      const purchaseRel = Array.isArray(row.installment_purchase)
        ? row.installment_purchase[0]
        : row.installment_purchase;
      const isGustitoInst =
        Boolean(purchaseRel?.is_gustito) ||
        isGustitoCategoryInMonth(key, row.category_id as string);

      if (isGustitoInst) {
        gustitoCommitmentsByMonth.set(
          key,
          roundCurrency((gustitoCommitmentsByMonth.get(key) ?? 0) + amt),
        );
      } else {
        fixedAndNonGustitoByMonth.set(
          key,
          roundCurrency((fixedAndNonGustitoByMonth.get(key) ?? 0) + amt),
        );
      }
    }
  }

  const activeTemplates = (templatesRes.data ?? []) as Array<{
    id: string;
    default_amount: number;
  }>;

  const extraIncomeByMonth = new Map<string, number>();
  const variableNonGustitoByMonth = new Map<string, number>();
  const variableGustitoByMonth = new Map<string, number>();

  for (const row of transactionsRes.data ?? []) {
    const key = toMonthStartISODate(row.transaction_date as string);
    const amount = Number(row.amount ?? 0);
    if (row.type === 'income') {
      extraIncomeByMonth.set(key, roundCurrency((extraIncomeByMonth.get(key) ?? 0) + amount));
    } else {
      const isGustitoTx =
        Boolean(row.is_gustito) ||
        isGustitoCategoryInMonth(key, row.category_id as string);
      if (isGustitoTx) {
        variableGustitoByMonth.set(
          key,
          roundCurrency((variableGustitoByMonth.get(key) ?? 0) + amount),
        );
      } else {
        variableNonGustitoByMonth.set(
          key,
          roundCurrency((variableNonGustitoByMonth.get(key) ?? 0) + amount),
        );
      }
    }
  }

  const ftFromAvailableByMonth = new Map<string, number>();
  const ftReturnedToAvailableByMonth = new Map<string, number>();

  for (const ft of fixedTermsRes.data ?? []) {
    if (ft.origin === 'monthly_available' && ft.start_date) {
      const startMonth = toMonthStartISODate(ft.start_date as string);
      ftFromAvailableByMonth.set(
        startMonth,
        roundCurrency(
          (ftFromAvailableByMonth.get(startMonth) ?? 0) + Number(ft.principal_amount ?? 0),
        ),
      );
    }
    if (ft.status === 'accredited_available' && ft.accredited_month_date) {
      const accMonth = toMonthStartISODate(ft.accredited_month_date as string);
      const returnAmt = Number(ft.actual_return_amount ?? ft.expected_return_amount ?? 0);
      ftReturnedToAvailableByMonth.set(
        accMonth,
        roundCurrency((ftReturnedToAvailableByMonth.get(accMonth) ?? 0) + returnAmt),
      );
    }
  }

  return months.map((month) => {
    const snapshot = budgetByMonth.get(month);
    const hasBudgetSnapshot = Boolean(snapshot);
    const isFutureUninit = !hasBudgetSnapshot && month > currentCalendarMonth;

    const fixedSalary = snapshot
      ? snapshot.fixedSalary
      : isFutureUninit
        ? fallbackFixedSalary
        : 0;
    const monthlySavingsTarget = snapshot
      ? snapshot.monthlySavingsTarget
      : isFutureUninit
        ? fallbackSavingsTarget
        : 0;
    const fixedLimit = snapshot
      ? snapshot.fixedExpensesLimit
      : isFutureUninit
        ? fallbackFixedLimit
        : 0;

    const operationalSavingsDeposits = operationalSavingsByMonth.get(month) ?? 0;
    const totalMonthlySavings = roundCurrency(
      monthlySavingsTarget + operationalSavingsDeposits,
    );

    const extraIncome = extraIncomeByMonth.get(month) ?? 0;
    const ftReturns = ftReturnedToAvailableByMonth.get(month) ?? 0;
    const totalIncome = roundCurrency(fixedSalary + extraIncome + ftReturns);

    let fixedAndNonGustito = fixedAndNonGustitoByMonth.get(month) ?? 0;
    if (isFutureUninit && activeTemplates.length > 0) {
      const existingTemplates = templateIdsByMonth.get(month);
      for (const tpl of activeTemplates) {
        if (!existingTemplates?.has(tpl.id)) {
          fixedAndNonGustito = roundCurrency(
            fixedAndNonGustito + Number(tpl.default_amount),
          );
        }
      }
    }

    const gustitosInst = gustitoCommitmentsByMonth.get(month) ?? 0;
    const variableNonGustito = variableNonGustitoByMonth.get(month) ?? 0;
    const variableGustito = variableGustitoByMonth.get(month) ?? 0;
    const gustitosSpent = roundCurrency(variableGustito + gustitosInst);

    const capFixedTransferred = capSurplusFixedByMonth.get(month) ?? 0;
    const capGustitosTransferred = capSurplusGustitosByMonth.get(month) ?? 0;

    const apartadoFijos = roundCurrency(
      Math.max(fixedLimit, fixedAndNonGustito + capFixedTransferred),
    );
    // El presupuesto de Gustitos permanece dentro del Disponible Real; solo
    // descuenta lo realmente gastado en Gustitos (y traslados históricos a Bóveda).
    const apartadoGustitos = roundCurrency(
      gustitosSpent + capGustitosTransferred,
    );

    const ftFromAvailable = ftFromAvailableByMonth.get(month) ?? 0;

    const realAvailable = roundCurrency(
      totalIncome -
        apartadoFijos -
        apartadoGustitos -
        totalMonthlySavings -
        variableNonGustito -
        ftFromAvailable,
    );

    const committedTotal = roundCurrency(fixedAndNonGustito + gustitosInst);
    const variableExpenses = roundCurrency(variableNonGustito + variableGustito);
    const totalExpenses = roundCurrency(committedTotal + variableExpenses);

    return {
      monthDate: month,
      label: formatShortMonthLabel(month),
      totalIncome,
      totalExpenses,
      committedTotal,
      variableExpenses,
      realAvailable,
    };
  });
}
