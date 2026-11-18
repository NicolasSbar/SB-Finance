/**
 * Servicio de configuración del usuario y snapshots mensuales (`monthly_budgets`).
 *
 * Arquitectura y decisiones técnicas:
 * - Inmutabilidad histórica: cuando el usuario cambia su sueldo fijo o límite en
 *   `/settings`, actualizamos `user_settings` (futuro) y opcionalmente el snapshot
 *   del mes calendario actual, pero nunca tocamos los snapshots de meses anteriores.
 * - Lazy Initialization: invocamos la RPC `ensure_monthly_period` en PostgreSQL para
 *   garantizar creación atómica e idempotente (`ON CONFLICT DO NOTHING`) del presupuesto
 *   y los gastos fijos del mes.
 */
import { roundCurrency, toMonthStartISODate } from '../lib/formatters';
import { reconcileSurplusSchema } from '../lib/validations';
import { supabase } from '../lib/supabaseClient';
import type {
  MonthlyBudget,
  ReconcileCapSurplusInput,
  ReconcileCapSurplusResult,
  UpdateUserSettingsInput,
  UserSettings,
} from '../types/database.types';

function mapUserSettings(row: UserSettings): UserSettings {
  return {
    ...row,
    fixed_salary: Number(row.fixed_salary),
    monthly_savings_target: Number(row.monthly_savings_target ?? 0),
    fixed_expenses_limit: Number(row.fixed_expenses_limit),
    gustitos_budget: Number(row.gustitos_budget ?? 0),
    salary_payday: Number(row.salary_payday ?? 1),
    timezone: row.timezone || 'America/Argentina/Buenos_Aires',
  };
}

function mapMonthlyBudget(row: MonthlyBudget): MonthlyBudget {
  return {
    ...row,
    fixed_salary: Number(row.fixed_salary),
    monthly_savings_target: Number(row.monthly_savings_target ?? 0),
    fixed_expenses_limit: Number(row.fixed_expenses_limit),
    gustitos_budget: Number(row.gustitos_budget ?? 0),
    surplus_review_completed_at: row.surplus_review_completed_at ?? null,
  };
}

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo cargar tu configuración: ${error.message}`);
  }

  if (!data) {
    // Respaldo defensivo en caso de que el usuario existiera antes del trigger
    const { data: inserted, error: insertError } = await supabase
      .from('user_settings')
      .insert({
        user_id: userId,
        fixed_salary: 0,
        monthly_savings_target: 0,
        fixed_expenses_limit: 0,
        gustitos_budget: 0,
        salary_payday: 1,
        timezone: 'America/Argentina/Buenos_Aires',
        currency: 'ARS',
        is_admin: false,
      })
      .select('*')
      .single();

    if (insertError || !inserted) {
      throw new Error(
        `No se pudo inicializar tu perfil de configuración: ${insertError?.message ?? 'Error desconocido'}`,
      );
    }

    return mapUserSettings(inserted as UserSettings);
  }

  return mapUserSettings(data as UserSettings);
}

export async function ensureMonthlyPeriod(monthDate: string): Promise<MonthlyBudget> {
  const normalizedMonth = toMonthStartISODate(monthDate);
  const { data, error } = await supabase.rpc('ensure_monthly_period', {
    p_month_date: normalizedMonth,
  });

  if (error || !data) {
    throw new Error(
      `No se pudo inicializar el período mensual (${normalizedMonth}): ${error?.message ?? 'Sin datos'}`,
    );
  }

  return mapMonthlyBudget(data as MonthlyBudget);
}

export async function getMonthlyBudget(
  userId: string,
  monthDate: string,
): Promise<MonthlyBudget | null> {
  const normalizedMonth = toMonthStartISODate(monthDate);
  const { data, error } = await supabase
    .from('monthly_budgets')
    .select('*')
    .eq('user_id', userId)
    .eq('month_date', normalizedMonth)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo consultar el presupuesto del mes: ${error.message}`);
  }

  return data ? mapMonthlyBudget(data as MonthlyBudget) : null;
}

export async function updateUserSettings(
  userId: string,
  input: UpdateUserSettingsInput,
): Promise<UserSettings> {
  const fixedSalary = roundCurrency(input.fixed_salary);
  const monthlySavingsTarget = roundCurrency(input.monthly_savings_target);
  const fixedLimit = roundCurrency(input.fixed_expenses_limit);
  const gustitosBudget = roundCurrency(input.gustitos_budget);
  const rawPayday = Math.trunc(Number(input.salary_payday));
  const salaryPayday = Number.isFinite(rawPayday)
    ? Math.min(31, Math.max(0, rawPayday))
    : 1;
  const timezone = input.timezone.trim() || 'America/Argentina/Buenos_Aires';

  const { data, error } = await supabase
    .from('user_settings')
    .update({
      fixed_salary: fixedSalary,
      monthly_savings_target: monthlySavingsTarget,
      fixed_expenses_limit: fixedLimit,
      gustitos_budget: gustitosBudget,
      salary_payday: salaryPayday,
      timezone,
    })
    .eq('user_id', userId)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo guardar la configuración: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  if (input.update_current_month) {
    const currentMonth = toMonthStartISODate(new Date());
    await ensureMonthlyPeriod(currentMonth);

    const { error: budgetError } = await supabase
      .from('monthly_budgets')
      .update({
        fixed_salary: fixedSalary,
        monthly_savings_target: monthlySavingsTarget,
        fixed_expenses_limit: fixedLimit,
        gustitos_budget: gustitosBudget,
      })
      .eq('user_id', userId)
      .eq('month_date', currentMonth);

    if (budgetError) {
      throw new Error(
        `Se guardó tu configuración base, pero falló la actualización del mes actual: ${budgetError.message}`,
      );
    }
  }

  return mapUserSettings(data as UserSettings);
}

export async function updateMonthlyBudgetSnapshot(
  userId: string,
  monthDate: string,
  fixedSalary: number,
  monthlySavingsTarget: number,
  fixedExpensesLimit: number,
  gustitosBudget?: number,
): Promise<MonthlyBudget> {
  const normalizedMonth = toMonthStartISODate(monthDate);
  await ensureMonthlyPeriod(normalizedMonth);

  const updates: Partial<
    Pick<
      MonthlyBudget,
      | 'fixed_salary'
      | 'monthly_savings_target'
      | 'fixed_expenses_limit'
      | 'gustitos_budget'
    >
  > = {
    fixed_salary: roundCurrency(fixedSalary),
    monthly_savings_target: roundCurrency(monthlySavingsTarget),
    fixed_expenses_limit: roundCurrency(fixedExpensesLimit),
  };

  if (gustitosBudget !== undefined) {
    updates.gustitos_budget = roundCurrency(gustitosBudget);
  }

  const { data, error } = await supabase
    .from('monthly_budgets')
    .update(updates)
    .eq('user_id', userId)
    .eq('month_date', normalizedMonth)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo actualizar el presupuesto puntual del mes: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  return mapMonthlyBudget(data as MonthlyBudget);
}

export async function reconcileCapSurplus(
  input: ReconcileCapSurplusInput,
): Promise<ReconcileCapSurplusResult> {
  const {
    data: { session },
    error: authError,
  } = await supabase.auth.getSession();

  if (authError || !session?.user?.id) {
    throw new Error('Tu sesión expiró. Iniciá sesión nuevamente para continuar.');
  }

  const normalizedMonth = toMonthStartISODate(input.month_date);

  if (input.action !== 'mark_reviewed') {
    const parsed = reconcileSurplusSchema.safeParse({
      bucket: input.bucket,
      action: input.action,
      amount: input.amount,
    });
    if (!parsed.success) {
      const firstErr =
        Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
        'Los datos para conciliar el sobrante son inválidos.';
      throw new Error(firstErr);
    }
  }

  const targetIncomeMonth = input.target_income_month
    ? toMonthStartISODate(input.target_income_month)
    : null;

  const { data, error } = await supabase.rpc('reconcile_cap_surplus', {
    p_month_date: normalizedMonth,
    p_bucket: input.bucket,
    p_action: input.action,
    p_amount: input.action === 'mark_reviewed' ? 0 : roundCurrency(input.amount),
    p_target_income_month: targetIncomeMonth,
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo conciliar el sobrante del período.',
    );
  }

  return data as ReconcileCapSurplusResult;
}
