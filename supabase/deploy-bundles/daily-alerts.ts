// ============================================================================
// ARCHIVO AUTOGENERADO PARA DEPLOY MANUAL EN SUPABASE EDITOR: daily-alerts
// NO EDITAR ESTE ARCHIVO DIRECTAMENTE.
// Editá supabase/functions/daily-alerts/index.ts o supabase/functions/_shared/*
// y luego ejecutá: npm run bundle:functions
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

// ----------------------------------------------------------------------------
// Módulo: supabase/functions/_shared/financeHelpers.ts
// ----------------------------------------------------------------------------
/**
 * Helpers financieros y de calendario multi-timezone compartidos por las Edge Functions.
 *
 * Arquitectura y decisiones técnicas:
 * - Única fuente de verdad en servidor: replicamos exactamente las fórmulas de
 *   `useDashboardData` (Bolsa de Gustitos con exclusión de `fixed_expense` y límites
 *   individuales por categoría) para que las respuestas instantáneas de Telegram, las
 *   alertas en tiempo real y el cron diario coincidan al centavo con el Dashboard web.
 * - Cálculo de fecha local sin desfase UTC: `Intl.DateTimeFormat('en-CA', { timeZone })`
 *   permite conocer la hora exacta (`0..23`), el día del mes (`1..31`) y la fecha
 *   `YYYY-MM-DD` en el huso horario configurado de cada usuario sin librerías externas.
 * - Precisión monetaria en centavos enteros (`toCents` / `roundCurrency`): escalamos
 *   en base 10 a centavos antes de `Math.round` para evitar errores de punto flotante
 *   IEEE-754 en bordes como `1.005` (que `Number.EPSILON` o `* 100` redondean a `1.00`).
 * - Verificación estricta de `.error` en queries Supabase: toda lectura o
 *   escritura verifica `res.error` antes de operar con `data`, evitando cálculos
 *   silenciosos con montos en `$0` cuando hay fallos transitorios de base de datos.
 */

interface SupabaseAdminLike {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
  // deno-lint-ignore no-explicit-any
  rpc: (fn: string, args?: Record<string, unknown>) => any;
}

interface LocalDateParts {
  yyyyMmDd: string;
  monthStart: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  daysInMonth: number;
}

interface GustitosStatus {
  isConfigured: boolean;
  budget: number;
  spent: number;
  remaining: number;
  gustitoCategoriesCount: number;
  isExceeded: boolean;
}

interface CategoryLimitStatus {
  categoryId: string;
  categoryName: string;
  monthlyLimit: number | null;
  spent: number;
  usagePercent: number | null;
  remaining: number | null;
}

interface FixedLimitStatus {
  fixedLimit: number;
  spent: number;
  remaining: number;
  usagePercent: number | null;
  isExceeded: boolean;
}

interface FixedTermReturnResult {
  expectedReturnAmount: number | null;
  error?: string;
}

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

// deno-lint-ignore no-explicit-any
function assertQueryOk<T = any>(
  // deno-lint-ignore no-explicit-any
  res: { data?: any; error?: { message?: string } | null },
  context: string,
): T {
  if (res.error) {
    console.error(`Error de base de datos al consultar ${context}:`, res.error);
    throw new Error(
      `Error de base de datos (${context}): ${res.error.message ?? 'desconocido'}`,
    );
  }
  return res.data as T;
}

function assertMutationOk(
  res: { error: { message?: string } | null },
  context: string,
): void {
  if (res.error) {
    console.error(`Error de base de datos al guardar ${context}:`, res.error);
    throw new Error(
      `Error de base de datos (${context}): ${res.error.message ?? 'desconocido'}`,
    );
  }
}

function toCents(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const str = Math.abs(value).toString();
  const expIdx = str.indexOf('e');
  const scaled =
    expIdx !== -1
      ? Number(`${str.slice(0, expIdx)}e${Number(str.slice(expIdx + 1)) + 2}`)
      : Number(`${str}e2`);
  const cents = sign * Math.round(scaled);
  return cents === 0 ? 0 : cents;
}

function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const cents = toCents(value);
  return cents === 0 ? 0 : cents / 100;
}

function formatCurrencyARS(amount: number, currency = 'ARS'): string {
  const safe = Number.isFinite(amount) ? roundCurrency(amount) : 0;
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe);
  } catch {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe);
  }
}

function formatCurrency(amount: number, currency = 'ARS'): string {
  return formatCurrencyARS(amount, currency);
}

function getLocalDateParts(
  timezone?: string | null,
  date: Date = new Date(),
): LocalDateParts {
  const tz = timezone && timezone.trim().length >= 3 ? timezone.trim() : DEFAULT_TIMEZONE;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';

  const year = Number(getPart('year'));
  const month = Number(getPart('month'));
  const day = Number(getPart('day'));
  const rawHour = Number(getPart('hour'));
  const hour = rawHour === 24 ? 0 : rawHour;

  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const yyyyMmDd = `${year}-${pad2(month)}-${pad2(day)}`;
  const monthStart = `${year}-${pad2(month)}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    yyyyMmDd,
    monthStart,
    year,
    month,
    day,
    hour,
    daysInMonth,
  };
}

function getMonthEndISODate(monthStart: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(monthStart.trim());
  if (!match) return monthStart;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
}

function normalizeMonthStart(dateIso: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(dateIso.trim());
  if (match) {
    return `${match[1]}-${match[2]}-01`;
  }
  return getLocalDateParts(DEFAULT_TIMEZONE).monthStart;
}

/**
 * Inicializa de forma idempotente el presupuesto del mes, los snapshots por categoría
 * y los gastos fijos activos de `userId` usando el cliente `service_role`.
 */
async function ensureMonthlyPeriodForUser(
  supabaseAdmin: SupabaseAdminLike,
  userId: string,
  monthDate: string,
): Promise<void> {
  const normalizedMonth = normalizeMonthStart(monthDate);

  const settingsRes = await supabaseAdmin
    .from('user_settings')
    .select('fixed_salary, monthly_savings_target, fixed_expenses_limit, gustitos_budget')
    .eq('user_id', userId)
    .maybeSingle();
  const settings = assertQueryOk(settingsRes, 'user_settings');

  const budgetUpsertRes = await supabaseAdmin
    .from('monthly_budgets')
    .upsert(
      {
        user_id: userId,
        month_date: normalizedMonth,
        fixed_salary: Number(settings?.fixed_salary ?? 0),
        monthly_savings_target: Number(settings?.monthly_savings_target ?? 0),
        fixed_expenses_limit: Number(settings?.fixed_expenses_limit ?? 0),
        gustitos_budget: Number(settings?.gustitos_budget ?? 0),
      },
      { onConflict: 'user_id,month_date', ignoreDuplicates: true },
    );
  assertMutationOk(budgetUpsertRes, 'monthly_budgets');

  const categoriesRes = await supabaseAdmin
    .from('categories')
    .select('id, is_gustito, monthly_limit')
    .eq('user_id', userId)
    .eq('type', 'expense');
  const expenseCategories = assertQueryOk(categoriesRes, 'categories');

  if (Array.isArray(expenseCategories) && expenseCategories.length > 0) {
    const snapshotsPayload = expenseCategories.map(
      (cat: { id: string; is_gustito: boolean; monthly_limit: number | null }) => ({
        user_id: userId,
        month_date: normalizedMonth,
        category_id: cat.id,
        is_gustito: Boolean(cat.is_gustito),
        monthly_limit: cat.monthly_limit !== null ? Number(cat.monthly_limit) : null,
      }),
    );

    const snapshotsUpsertRes = await supabaseAdmin
      .from('monthly_category_snapshots')
      .upsert(snapshotsPayload, {
        onConflict: 'user_id,month_date,category_id',
        ignoreDuplicates: true,
      });
    assertMutationOk(snapshotsUpsertRes, 'monthly_category_snapshots');
  }

  const templatesRes = await supabaseAdmin
    .from('fixed_expense_templates')
    .select('id, category_id, name, default_amount, due_day, notes')
    .eq('user_id', userId)
    .eq('is_active', true);
  const templates = assertQueryOk(templatesRes, 'fixed_expense_templates');

  if (Array.isArray(templates) && templates.length > 0) {
    const match = /^(\d{4})-(\d{2})-01$/.exec(normalizedMonth);
    const year = match ? Number(match[1]) : new Date().getUTCFullYear();
    const month = match ? Number(match[2]) : new Date().getUTCMonth() + 1;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const existingFixedRes = await supabaseAdmin
      .from('monthly_commitments')
      .select('fixed_expense_template_id')
      .eq('user_id', userId)
      .eq('month_date', normalizedMonth)
      .not('fixed_expense_template_id', 'is', null);
    const existingFixed = assertQueryOk(existingFixedRes, 'monthly_commitments');

    const existingIds = new Set(
      (existingFixed ?? []).map(
        (r: { fixed_expense_template_id: string }) => r.fixed_expense_template_id,
      ),
    );

    const toInsert = templates
      .filter((tpl: { id: string }) => !existingIds.has(tpl.id))
      .map(
        (tpl: {
          id: string;
          category_id: string;
          name: string;
          default_amount: number;
          due_day: number | null;
          notes: string | null;
        }) => {
          let dueDate: string | null = null;
          if (tpl.due_day !== null && tpl.due_day >= 1 && tpl.due_day <= 31) {
            const clampedDay = Math.min(tpl.due_day, daysInMonth);
            dueDate = `${String(year)}-${String(month).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
          }
          return {
            user_id: userId,
            month_date: normalizedMonth,
            category_id: tpl.category_id,
            commitment_type: 'fixed_expense',
            fixed_expense_template_id: tpl.id,
            name: tpl.name,
            amount: Number(tpl.default_amount),
            due_date: dueDate,
            is_paid: false,
            notes: tpl.notes ?? null,
          };
        },
      );

    if (toInsert.length > 0) {
      const insertCommRes = await supabaseAdmin
        .from('monthly_commitments')
        .insert(toInsert);
      assertMutationOk(insertCommRes, 'monthly_commitments');
    }
  }
}

async function computeGustitosStatus(
  supabaseAdmin: SupabaseAdminLike,
  userId: string,
  monthDate: string,
): Promise<GustitosStatus> {
  const monthStart = normalizeMonthStart(monthDate);
  const monthEnd = getMonthEndISODate(monthStart);

  const [budgetRes, settingsRes, snapshotsRes, categoriesRes, txRes, commRes] =
    await Promise.all([
      supabaseAdmin
        .from('monthly_budgets')
        .select('gustitos_budget')
        .eq('user_id', userId)
        .eq('month_date', monthStart)
        .maybeSingle(),
      supabaseAdmin
        .from('user_settings')
        .select('gustitos_budget')
        .eq('user_id', userId)
        .maybeSingle(),
      supabaseAdmin
        .from('monthly_category_snapshots')
        .select('category_id, is_gustito')
        .eq('user_id', userId)
        .eq('month_date', monthStart),
      supabaseAdmin
        .from('categories')
        .select('id, is_gustito')
        .eq('user_id', userId)
        .eq('type', 'expense'),
      supabaseAdmin
        .from('transactions')
        .select('category_id, amount, is_gustito')
        .eq('user_id', userId)
        .eq('type', 'expense')
        .gte('transaction_date', monthStart)
        .lte('transaction_date', monthEnd),
      supabaseAdmin
        .from('monthly_commitments')
        .select(
          'category_id, amount, commitment_type, installment_purchase:installment_purchases(is_gustito)',
        )
        .eq('user_id', userId)
        .eq('month_date', monthStart)
        .eq('commitment_type', 'installment'),
    ]);

  const budgetData = assertQueryOk(budgetRes, 'monthly_budgets');
  const settingsData = assertQueryOk(settingsRes, 'user_settings');
  const snapshotsData = assertQueryOk(snapshotsRes, 'monthly_category_snapshots');
  const categoriesData = assertQueryOk(categoriesRes, 'categories');
  const txData = assertQueryOk(txRes, 'transactions');
  const commData = assertQueryOk(commRes, 'monthly_commitments');

  const budget = roundCurrency(
    budgetData
      ? Number(budgetData.gustitos_budget ?? 0)
      : Number(settingsData?.gustitos_budget ?? 0),
  );

  const gustitoCategoryIds = new Set<string>();
  const snapshots = (snapshotsData ?? []) as Array<{
    category_id: string;
    is_gustito: boolean;
  }>;

  if (snapshots.length > 0) {
    for (const snap of snapshots) {
      if (snap.is_gustito) {
        gustitoCategoryIds.add(snap.category_id);
      }
    }
  } else {
    for (const cat of (categoriesData ?? []) as Array<{
      id: string;
      is_gustito: boolean;
    }>) {
      if (cat.is_gustito) {
        gustitoCategoryIds.add(cat.id);
      }
    }
  }

  let spent = 0;

  for (const tx of (txData ?? []) as Array<{
    category_id: string;
    amount: number;
    is_gustito: boolean;
  }>) {
    if (tx.is_gustito || gustitoCategoryIds.has(tx.category_id)) {
      spent = roundCurrency(spent + Number(tx.amount));
    }
  }

  for (const comm of (commData ?? []) as Array<{
    category_id: string;
    amount: number;
    commitment_type: string;
    installment_purchase:
      | { is_gustito?: boolean }
      | Array<{ is_gustito?: boolean }>
      | null;
  }>) {
    if (comm.commitment_type !== 'installment') continue;
    const purchaseRel = Array.isArray(comm.installment_purchase)
      ? comm.installment_purchase[0]
      : comm.installment_purchase;
    const purchaseMarked = Boolean(purchaseRel?.is_gustito);
    if (purchaseMarked || gustitoCategoryIds.has(comm.category_id)) {
      spent = roundCurrency(spent + Number(comm.amount));
    }
  }

  const gustitoCategoriesCount = gustitoCategoryIds.size;
  const isConfigured = budget > 0 && (gustitoCategoriesCount > 0 || spent > 0);
  const remaining = roundCurrency(budget - spent);
  const isExceeded = isConfigured && remaining <= 0;

  return {
    isConfigured,
    budget,
    spent,
    remaining,
    gustitoCategoriesCount,
    isExceeded,
  };
}

async function computeCategoryLimitStatus(
  supabaseAdmin: SupabaseAdminLike,
  userId: string,
  monthDate: string,
  categoryId: string,
): Promise<CategoryLimitStatus> {
  const monthStart = normalizeMonthStart(monthDate);
  const monthEnd = getMonthEndISODate(monthStart);

  const [catRes, snapRes, txRes, commRes] = await Promise.all([
    supabaseAdmin
      .from('categories')
      .select('id, name, monthly_limit')
      .eq('user_id', userId)
      .eq('id', categoryId)
      .maybeSingle(),
    supabaseAdmin
      .from('monthly_category_snapshots')
      .select('monthly_limit')
      .eq('user_id', userId)
      .eq('month_date', monthStart)
      .eq('category_id', categoryId)
      .maybeSingle(),
    supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('type', 'expense')
      .gte('transaction_date', monthStart)
      .lte('transaction_date', monthEnd),
    supabaseAdmin
      .from('monthly_commitments')
      .select('amount')
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('month_date', monthStart),
  ]);

  const catData = assertQueryOk(catRes, 'categories');
  const snapData = assertQueryOk(snapRes, 'monthly_category_snapshots');
  const txData = assertQueryOk(txRes, 'transactions');
  const commData = assertQueryOk(commRes, 'monthly_commitments');

  const categoryName = (catData?.name as string | undefined) ?? 'Categoría';
  const rawLimit = snapData
    ? snapData.monthly_limit
    : catData?.monthly_limit;
  const monthlyLimit =
    rawLimit !== null && rawLimit !== undefined && Number(rawLimit) > 0
      ? roundCurrency(Number(rawLimit))
      : null;

  let spent = 0;
  for (const tx of (txData ?? []) as Array<{ amount: number }>) {
    spent = roundCurrency(spent + Number(tx.amount));
  }
  for (const comm of (commData ?? []) as Array<{ amount: number }>) {
    spent = roundCurrency(spent + Number(comm.amount));
  }

  const usagePercent =
    monthlyLimit !== null && monthlyLimit > 0
      ? roundCurrency((spent / monthlyLimit) * 100)
      : null;
  const remaining =
    monthlyLimit !== null ? roundCurrency(monthlyLimit - spent) : null;

  return {
    categoryId,
    categoryName,
    monthlyLimit,
    spent,
    usagePercent,
    remaining,
  };
}

function addDaysToISODate(isoDate: string, daysToAdd: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return isoDate;
  const dt = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + daysToAdd),
  );
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function computeFixedLimitStatus(
  supabaseAdmin: SupabaseAdminLike,
  userId: string,
  monthDate: string,
): Promise<FixedLimitStatus> {
  const monthStart = normalizeMonthStart(monthDate);

  const [budgetRes, settingsRes, snapshotsRes, categoriesRes, commRes] =
    await Promise.all([
      supabaseAdmin
        .from('monthly_budgets')
        .select('fixed_expenses_limit')
        .eq('user_id', userId)
        .eq('month_date', monthStart)
        .maybeSingle(),
      supabaseAdmin
        .from('user_settings')
        .select('fixed_expenses_limit')
        .eq('user_id', userId)
        .maybeSingle(),
      supabaseAdmin
        .from('monthly_category_snapshots')
        .select('category_id, is_gustito')
        .eq('user_id', userId)
        .eq('month_date', monthStart),
      supabaseAdmin
        .from('categories')
        .select('id, is_gustito')
        .eq('user_id', userId)
        .eq('type', 'expense'),
      supabaseAdmin
        .from('monthly_commitments')
        .select(
          'category_id, amount, commitment_type, installment_purchase:installment_purchases(is_gustito)',
        )
        .eq('user_id', userId)
        .eq('month_date', monthStart),
    ]);

  const budgetData = assertQueryOk(budgetRes, 'monthly_budgets');
  const settingsData = assertQueryOk(settingsRes, 'user_settings');
  const snapshotsData = assertQueryOk(snapshotsRes, 'monthly_category_snapshots');
  const categoriesData = assertQueryOk(categoriesRes, 'categories');
  const commData = assertQueryOk(commRes, 'monthly_commitments');

  const fixedLimit = roundCurrency(
    budgetData
      ? Number(budgetData.fixed_expenses_limit ?? 0)
      : Number(settingsData?.fixed_expenses_limit ?? 0),
  );

  const gustitoCategoryIds = new Set<string>();
  const snapshots = (snapshotsData ?? []) as Array<{
    category_id: string;
    is_gustito: boolean;
  }>;

  if (snapshots.length > 0) {
    for (const snap of snapshots) {
      if (snap.is_gustito) {
        gustitoCategoryIds.add(snap.category_id);
      }
    }
  } else {
    for (const cat of (categoriesData ?? []) as Array<{
      id: string;
      is_gustito: boolean;
    }>) {
      if (cat.is_gustito) {
        gustitoCategoryIds.add(cat.id);
      }
    }
  }

  let spent = 0;
  for (const comm of (commData ?? []) as Array<{
    category_id: string;
    amount: number;
    commitment_type: string;
    installment_purchase:
      | { is_gustito?: boolean }
      | Array<{ is_gustito?: boolean }>
      | null;
  }>) {
    if (comm.commitment_type === 'fixed_expense') {
      spent = roundCurrency(spent + Number(comm.amount));
      continue;
    }

    if (comm.commitment_type === 'installment') {
      const purchaseRel = Array.isArray(comm.installment_purchase)
        ? comm.installment_purchase[0]
        : comm.installment_purchase;
      const isGustitoInstallment =
        Boolean(purchaseRel?.is_gustito) || gustitoCategoryIds.has(comm.category_id);
      if (!isGustitoInstallment) {
        spent = roundCurrency(spent + Number(comm.amount));
      }
    }
  }

  const usagePercent =
    fixedLimit > 0 ? roundCurrency((spent / fixedLimit) * 100) : null;
  const remaining = roundCurrency(fixedLimit - spent);
  const isExceeded = fixedLimit > 0 && spent >= fixedLimit;

  return {
    fixedLimit,
    spent,
    remaining,
    usagePercent,
    isExceeded,
  };
}

function computeFixedTermReturn(params: {
  principalAmount: number;
  expectedReturnAmount?: number | null;
  yieldPercent?: number | null;
  ratePeriod?: 'period' | 'annual' | null;
  termDays?: number | null;
}): FixedTermReturnResult {
  const principal = roundCurrency(params.principalAmount);
  if (!Number.isFinite(principal) || principal <= 0) {
    return {
      expectedReturnAmount: null,
      error: 'El capital invertido debe ser mayor a cero.',
    };
  }

  if (
    typeof params.expectedReturnAmount === 'number' &&
    Number.isFinite(params.expectedReturnAmount) &&
    params.expectedReturnAmount > 0
  ) {
    const explicitReturn = roundCurrency(params.expectedReturnAmount);
    if (explicitReturn < principal) {
      return {
        expectedReturnAmount: null,
        error: 'El monto a recibir no puede ser menor al capital invertido.',
      };
    }
    return { expectedReturnAmount: explicitReturn };
  }

  if (
    typeof params.yieldPercent === 'number' &&
    Number.isFinite(params.yieldPercent) &&
    params.yieldPercent >= 0
  ) {
    if (params.ratePeriod === 'annual') {
      if (!params.termDays || params.termDays <= 0) {
        return {
          expectedReturnAmount: null,
          error:
            'Indicaste una tasa anual (TNA), necesito saber la cantidad de días o fecha de vencimiento del plazo fijo.',
        };
      }
      const computed = roundCurrency(
        principal * (1 + (params.yieldPercent / 100) * (params.termDays / 365)),
      );
      return { expectedReturnAmount: computed };
    }

    const computed = roundCurrency(principal * (1 + params.yieldPercent / 100));
    return { expectedReturnAmount: computed };
  }

  return { expectedReturnAmount: null };
}

// ----------------------------------------------------------------------------
// Módulo: supabase/functions/_shared/telegramApi.ts
// ----------------------------------------------------------------------------
/**
 * Helpers compartidos para interactuar con la API HTTP de Telegram Bot desde Deno.
 *
 * Arquitectura y decisiones técnicas:
 * - Cero dependencias externas ni APIs de Node.js: usamos `fetch` estándar de Deno y
 *   codificamos archivos binarios (`Uint8Array`) a Base64 en bloques de 8 KB
 *   (`chunkSize = 8192`) para evitar `RangeError: Maximum call stack size exceeded`
 *   al usar `String.fromCharCode(...bytes)` con notas de voz de hasta 5 MB.
 * - Timeouts explícitos (`AbortSignal.timeout`): todas las llamadas a la API de
 *   Telegram usan un límite de 10 s (20 s para descarga de audio) para evitar que una
 *   conexión colgada agote el tiempo de ejecución de la Edge Function sin respuesta.
 * - Reintento en texto plano + error explícito en `sendTelegramMessage`: si Telegram
 *   rechaza un mensaje (por ejemplo, error de parseo HTML/Markdown o fallo HTTP), se
 *   reintenta una vez sin `parse_mode`; si aún falla, se registra y lanza `Error` en
 *   lugar de devolver `null` silenciosamente y dejar al usuario sin confirmación.
 * - Comparación en tiempo constante (`timingSafeEqualStr`): protege los secretos
 *   entrantes (`X-Telegram-Bot-Api-Secret-Token` y `X-Cron-Secret`) frente a ataques
 *   de temporización por comparación carácter a carácter.
 */

const TELEGRAM_API_TIMEOUT_MS = 10_000;
const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 20_000;

interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

interface TelegramSendOptions {
  parseMode?: 'Markdown' | 'HTML';
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

interface TelegramSentMessage {
  message_id: number;
}

interface TelegramFileDownload {
  bytes: Uint8Array;
  base64: string;
  filePath: string;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);

  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i += 1) {
    const aByte = i < aBytes.length ? aBytes[i] : 0;
    const bByte = i < bBytes.length ? bBytes[i] : 0;
    diff |= aByte ^ bByte;
  }

  return diff === 0;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    let chunkStr = '';
    for (let j = 0; j < slice.length; j += 1) {
      chunkStr += String.fromCharCode(slice[j]);
    }
    binary += chunkStr;
  }
  return btoa(binary);
}

function toPlainTextFallback(
  text: string,
  parseMode?: 'Markdown' | 'HTML',
): string {
  if (parseMode !== 'HTML') return text;
  return text
    .replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler)(?:\s[^>]*)?>/gi, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

async function postTelegramJson(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs = TELEGRAM_API_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; bodyText: string; result?: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, bodyText };
  }

  try {
    const parsed = JSON.parse(bodyText) as { ok?: boolean; result?: unknown };
    return {
      ok: Boolean(parsed.ok),
      status: res.status,
      bodyText,
      result: parsed.result,
    };
  } catch {
    return { ok: false, status: res.status, bodyText };
  }
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number | string,
  text: string,
  options: TelegramSendOptions = {},
): Promise<TelegramSentMessage> {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };

  if (options.parseMode) {
    payload.parse_mode = options.parseMode;
  }
  if (options.replyMarkup) {
    payload.reply_markup = options.replyMarkup;
  }

  let firstAttemptError: string | null = null;
  try {
    const first = await postTelegramJson(endpoint, payload);
    const firstResult = first.result as { message_id?: number } | undefined;
    if (first.ok && typeof firstResult?.message_id === 'number') {
      return { message_id: firstResult.message_id };
    }
    firstAttemptError = `HTTP ${first.status}: ${first.bodyText}`;
    console.warn('Telegram sendMessage primer intento falló, reintentando en texto plano:', firstAttemptError);
  } catch (err) {
    firstAttemptError = err instanceof Error ? err.message : String(err);
    console.warn('Telegram sendMessage primer intento lanzó excepción, reintentando en texto plano:', firstAttemptError);
  }

  const plainPayload: Record<string, unknown> = {
    chat_id: chatId,
    text: toPlainTextFallback(text, options.parseMode),
  };
  if (options.replyMarkup) {
    plainPayload.reply_markup = options.replyMarkup;
  }

  try {
    const retry = await postTelegramJson(endpoint, plainPayload);
    const retryResult = retry.result as { message_id?: number } | undefined;
    if (retry.ok && typeof retryResult?.message_id === 'number') {
      return { message_id: retryResult.message_id };
    }
    const retryError = `HTTP ${retry.status}: ${retry.bodyText}`;
    console.error('Telegram sendMessage falló tras reintento en texto plano:', retryError);
    throw new Error(`Telegram sendMessage falló (${retryError})`);
  } catch (retryErr) {
    if (retryErr instanceof Error && retryErr.message.startsWith('Telegram sendMessage falló')) {
      throw retryErr;
    }
    const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
    console.error('Telegram sendMessage error de red/timeout en reintento:', retryMsg, 'Primer error:', firstAttemptError);
    throw new Error(`Telegram sendMessage falló tras reintento: ${retryMsg}`);
  }
}

async function editTelegramMessage(
  botToken: string,
  chatId: number | string,
  messageId: number,
  text: string,
  options: TelegramSendOptions = {},
): Promise<boolean> {
  const endpoint = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: options.replyMarkup ?? { inline_keyboard: [] },
  };

  if (options.parseMode) {
    payload.parse_mode = options.parseMode;
  }

  const first = await postTelegramJson(endpoint, payload);
  if (first.ok) {
    return true;
  }

  console.warn('Telegram editMessageText error, reintentando en texto plano:', first.status, first.bodyText);
  if (options.parseMode) {
    const plainPayload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: toPlainTextFallback(text, options.parseMode),
      reply_markup: options.replyMarkup ?? { inline_keyboard: [] },
    };
    const retry = await postTelegramJson(endpoint, plainPayload);
    if (retry.ok) {
      return true;
    }
    console.error('Telegram editMessageText falló en texto plano:', retry.status, retry.bodyText);
  }

  return false;
}

async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  const payload: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
    show_alert: showAlert,
  };
  if (text) {
    payload.text = text;
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error('Telegram answerCallbackQuery error:', res.status, errorBody);
  }
}

async function getTelegramFileBytes(
  botToken: string,
  fileId: string,
): Promise<TelegramFileDownload> {
  const metaRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS) },
  );

  if (!metaRes.ok) {
    throw new Error(`No se pudo consultar la metadata del audio (${metaRes.status}).`);
  }

  const metaJson = (await metaRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };

  const filePath = metaJson.result?.file_path;
  if (!metaJson.ok || !filePath) {
    throw new Error('Telegram no devolvió la ruta del archivo de audio.');
  }

  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
    { signal: AbortSignal.timeout(TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS) },
  );
  if (!fileRes.ok) {
    throw new Error(`No se pudo descargar el audio desde Telegram (${fileRes.status}).`);
  }

  const buffer = await fileRes.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return {
    bytes,
    base64: uint8ArrayToBase64(bytes),
    filePath,
  };
}

// ----------------------------------------------------------------------------
// Módulo: supabase/functions/daily-alerts/index.ts
// ----------------------------------------------------------------------------
/**
 * Supabase Edge Function (Deno): daily-alerts
 *
 * Arquitectura y decisiones técnicas:
 * - Ejecución multi-timezone sin un cron por usuario: `pg_cron` invoca esta función
 *   cada hora (`0 * * * *`). En memoria evaluamos `getLocalDateParts(user.timezone)` y
 *   procesamos únicamente a los usuarios cuyo reloj local marca las `08:00 AM` (`hour === 8`).
 * - Control anti-spam en `notification_logs`:
 *   - Límites de categoría y tope de gastos fijos (`> 80%` y `>= 100%`): máximo 1 alerta
 *     cada 7 días por `(user_id, month_date, alert_type, reference_id)`.
 *   - Recordatorios de compromisos pendientes (`is_paid = false`): máximo 1 envío el día 15
 *     y 1 envío 7 días antes de fin de mes (`daysInMonth - 7`).
 * - Aislamiento de fallos por usuario: cada consulta a PostgreSQL valida
 *   `.error` explícitamente (sin silenciar fallos de lectura que dispararían spam o
 *   cálculos incompletos), y un error en un usuario no interrumpe el envío al resto.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sendAlertAndRecordLog(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  userId: string;
  chatId: number;
  monthDate: string;
  alertType: string;
  referenceId: string | null;
  message: string;
}): Promise<boolean> {
  const {
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    monthDate,
    alertType,
    referenceId,
    message,
  } = params;

  try {
    const sent = await sendTelegramMessage(botToken, chatId, message, {
      parseMode: 'HTML',
    });

    if (!sent) {
      console.error('Error al enviar alerta diaria por Telegram:', {
        userId,
        chatId,
        alertType,
        referenceId,
      });
      return false;
    }

    const { error: logInsertError } = await supabaseAdmin
      .from('notification_logs')
      .insert({
        user_id: userId,
        month_date: monthDate,
        alert_type: alertType,
        reference_id: referenceId,
      });

    if (logInsertError) {
      console.error('Error al registrar alerta en notification_logs:', {
        userId,
        alertType,
        referenceId,
        error: logInsertError,
      });
    }

    return true;
  } catch (sendErr) {
    console.error('Excepción al enviar alerta diaria por Telegram:', {
      userId,
      chatId,
      alertType,
      referenceId,
      error: sendErr,
    });
    return false;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método no permitido. Usá POST.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const cronInternalSecret = Deno.env.get('CRON_INTERNAL_SECRET');

  if (!supabaseUrl || !supabaseServiceRoleKey || !cronInternalSecret) {
    return jsonResponse({ error: 'Configuración incompleta en daily-alerts.' }, 500);
  }

  const incomingSecret = req.headers.get('X-Cron-Secret') ?? '';
  if (!incomingSecret || !timingSafeEqualStr(incomingSecret, cronInternalSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!botToken) {
    return jsonResponse({ ok: true, skipped: 'missing_bot_token' }, 200);
  }

  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: links, error: linksError } = await supabaseAdmin
      .from('telegram_links')
      .select('user_id, telegram_chat_id');

    if (linksError) {
      console.error('Error al consultar telegram_links:', linksError);
      return jsonResponse({ error: 'Error al consultar cuentas vinculadas.' }, 500);
    }

    if (!links || links.length === 0) {
      return jsonResponse({ ok: true, processedUsers: 0, alertsSent: 0, userErrors: 0 }, 200);
    }

    const userIds = links.map((l) => l.user_id as string);
    const { data: settingsList, error: settingsError } = await supabaseAdmin
      .from('user_settings')
      .select('user_id, fixed_expenses_limit, currency, timezone')
      .in('user_id', userIds);

    if (settingsError) {
      console.error('Error al consultar user_settings:', settingsError);
      return jsonResponse({ error: 'Error al consultar configuración de usuarios.' }, 500);
    }

    const settingsByUser = new Map<
      string,
      { fixed_expenses_limit: number; currency: string; timezone: string }
    >();
    for (const row of settingsList ?? []) {
      settingsByUser.set(row.user_id as string, {
        fixed_expenses_limit: Number(row.fixed_expenses_limit ?? 0),
        currency: (row.currency as string | undefined) ?? 'ARS',
        timezone:
          (row.timezone as string | undefined) ?? 'America/Argentina/Buenos_Aires',
      });
    }

    const now = new Date();
    const sevenDaysAgoIso = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();
    const supabaseAdminLike = supabaseAdmin as unknown as SupabaseAdminLike;

    let processedUsers = 0;
    let alertsSent = 0;
    let userErrors = 0;

    for (const link of links) {
      const userId = link.user_id as string;
      const chatId = Number(link.telegram_chat_id);
      const userSettings = settingsByUser.get(userId) ?? {
        fixed_expenses_limit: 0,
        currency: 'ARS',
        timezone: 'America/Argentina/Buenos_Aires',
      };

      const local = getLocalDateParts(userSettings.timezone, now);
      if (local.hour !== 8) {
        continue;
      }

      processedUsers += 1;

      try {
        await ensureMonthlyPeriodForUser(
          supabaseAdminLike,
          userId,
          local.monthStart,
        );

        // A. Límites individuales por categoría (> 80% y >= 100%)
        const { data: snapshots, error: snapshotsError } = await supabaseAdmin
          .from('monthly_category_snapshots')
          .select('category_id, monthly_limit')
          .eq('user_id', userId)
          .eq('month_date', local.monthStart)
          .not('monthly_limit', 'is', null)
          .gt('monthly_limit', 0);

        if (snapshotsError) {
          console.error('Error al consultar monthly_category_snapshots:', {
            userId,
            error: snapshotsError,
          });
        } else {
          for (const snap of snapshots ?? []) {
            const categoryId = snap.category_id as string;
            const status = await computeCategoryLimitStatus(
              supabaseAdminLike,
              userId,
              local.monthStart,
              categoryId,
            );

            if (
              status.monthlyLimit === null ||
              status.monthlyLimit <= 0 ||
              status.usagePercent === null
            ) {
              continue;
            }

            let alertType: 'category_exceeded_100' | 'category_warning_80' | null = null;
            if (status.usagePercent >= 100) {
              alertType = 'category_exceeded_100';
            } else if (status.usagePercent > 80) {
              alertType = 'category_warning_80';
            }

            if (!alertType) continue;

            const { data: recentLog, error: recentLogError } = await supabaseAdmin
              .from('notification_logs')
              .select('id')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('alert_type', alertType)
              .eq('reference_id', categoryId)
              .gte('sent_at', sevenDaysAgoIso)
              .limit(1);

            if (recentLogError) {
              console.error('Error al verificar notification_logs (categoría):', {
                userId,
                categoryId,
                error: recentLogError,
              });
              continue;
            }

            if (recentLog && recentLog.length > 0) continue;

            const msg =
              alertType === 'category_exceeded_100'
                ? `🔴 <b>Límite superado en ${escapeHtml(status.categoryName)}</b>\n\nAlcanzaste el <b>${status.usagePercent.toFixed(
                    1,
                  )}%</b> (${escapeHtml(
                    formatCurrencyARS(status.spent, userSettings.currency),
                  )} de ${escapeHtml(
                    formatCurrencyARS(status.monthlyLimit, userSettings.currency),
                  )}).`
                : `⚠️ <b>Cerca del límite en ${escapeHtml(status.categoryName)}</b>\n\nYa consumiste el <b>${status.usagePercent.toFixed(
                    1,
                  )}%</b> de tu tope mensual (${escapeHtml(
                    formatCurrencyARS(status.spent, userSettings.currency),
                  )} de ${escapeHtml(
                    formatCurrencyARS(status.monthlyLimit, userSettings.currency),
                  )}).`;

            const sentOk = await sendAlertAndRecordLog({
              supabaseAdmin: supabaseAdminLike,
              botToken,
              userId,
              chatId,
              monthDate: local.monthStart,
              alertType,
              referenceId: categoryId,
              message: msg,
            });
            if (sentOk) alertsSent += 1;
          }
        }

        // B. Límite mensual de gastos fijos + cuotas no-Gustito (> 80% y >= 100%)
        const { data: monthCommitments, error: commitmentsError } = await supabaseAdmin
          .from('monthly_commitments')
          .select('id, name, amount, due_date, is_paid')
          .eq('user_id', userId)
          .eq('month_date', local.monthStart);

        if (commitmentsError) {
          console.error('Error al consultar monthly_commitments:', {
            userId,
            error: commitmentsError,
          });
        }

        const commitments = (!commitmentsError ? (monthCommitments ?? []) : []) as Array<{
          id: string;
          name: string;
          amount: number;
          due_date: string | null;
          is_paid: boolean;
        }>;

        const fixedStatus = await computeFixedLimitStatus(
          supabaseAdminLike,
          userId,
          local.monthStart,
        );

        if (fixedStatus.fixedLimit > 0 && fixedStatus.usagePercent !== null) {
          const fixedLimit = fixedStatus.fixedLimit;
          const totalCommitted = fixedStatus.spent;
          const pct = fixedStatus.usagePercent;
          const fixedAlertType =
            pct >= 100
              ? 'fixed_limit_exceeded_100'
              : pct > 80
                ? 'fixed_limit_warning_80'
                : null;

          if (fixedAlertType) {
            const { data: recentFixedLog, error: recentFixedError } = await supabaseAdmin
              .from('notification_logs')
              .select('id')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('alert_type', fixedAlertType)
              .is('reference_id', null)
              .gte('sent_at', sevenDaysAgoIso)
              .limit(1);

            if (recentFixedError) {
              console.error('Error al verificar notification_logs (límite fijo):', {
                userId,
                error: recentFixedError,
              });
            } else if (!recentFixedLog || recentFixedLog.length === 0) {
              const fixedMsg =
                fixedAlertType === 'fixed_limit_exceeded_100'
                  ? `🔴 <b>Límite de gastos fijos y cuotas superado</b>\n\nTus compromisos fijos y cuotas no-Gustito de este mes suman <b>${escapeHtml(
                      formatCurrencyARS(totalCommitted, userSettings.currency),
                    )}</b> (${pct.toFixed(1)}% de tu límite de ${escapeHtml(
                      formatCurrencyARS(fixedLimit, userSettings.currency),
                    )}).`
                  : `⚠️ <b>Cerca del límite de gastos fijos y cuotas</b>\n\nTus compromisos fijos y cuotas no-Gustito alcanzan <b>${escapeHtml(
                      formatCurrencyARS(totalCommitted, userSettings.currency),
                    )}</b> (${pct.toFixed(1)}% de tu límite de ${escapeHtml(
                      formatCurrencyARS(fixedLimit, userSettings.currency),
                    )}).`;

              const sentOk = await sendAlertAndRecordLog({
                supabaseAdmin: supabaseAdminLike,
                botToken,
                userId,
                chatId,
                monthDate: local.monthStart,
                alertType: fixedAlertType,
                referenceId: null,
                message: fixedMsg,
              });
              if (sentOk) alertsSent += 1;
            }
          }
        }

        // C. Recordatorios de pagos pendientes (día 15 y 7 días antes de fin de mes)
        const reminderTypes: Array<
          'mid_month_pending_reminder' | 'end_of_month_pending_reminder'
        > = [];
        if (local.day === 15) {
          reminderTypes.push('mid_month_pending_reminder');
        }
        if (local.day === local.daysInMonth - 7) {
          reminderTypes.push('end_of_month_pending_reminder');
        }

        if (reminderTypes.length > 0 && !commitmentsError) {
          const pendingItems = commitments.filter((c) => !c.is_paid);
          if (pendingItems.length > 0) {
            const pendingTotal = pendingItems.reduce(
              (acc, c) => roundCurrency(acc + Number(c.amount)),
              0,
            );

            for (const reminderType of reminderTypes) {
              const { data: existingReminder, error: reminderLogError } =
                await supabaseAdmin
                  .from('notification_logs')
                  .select('id')
                  .eq('user_id', userId)
                  .eq('month_date', local.monthStart)
                  .eq('alert_type', reminderType)
                  .limit(1);

              if (reminderLogError) {
                console.error('Error al verificar notification_logs (recordatorio):', {
                  userId,
                  reminderType,
                  error: reminderLogError,
                });
                continue;
              }

              if (existingReminder && existingReminder.length > 0) continue;

              const topList = pendingItems
                .slice(0, 6)
                .map(
                  (item) =>
                    `• ${escapeHtml(item.name)}: <b>${escapeHtml(
                      formatCurrencyARS(Number(item.amount), userSettings.currency),
                    )}</b>`,
                )
                .join('\n');
              const extraCount =
                pendingItems.length > 6
                  ? `\n<i>...y ${pendingItems.length - 6} compromiso(s) más.</i>`
                  : '';

              const title =
                reminderType === 'mid_month_pending_reminder'
                  ? '📅 <b>Recordatorio de mitad de mes (día 15)</b>'
                  : '⏳ <b>Recordatorio de cierre de mes (faltan 7 días)</b>';

              const reminderMsg = `${title}\n\nTenés <b>${pendingItems.length}</b> compromiso(s) pendiente(s) de pago por un total de <b>${escapeHtml(
                formatCurrencyARS(pendingTotal, userSettings.currency),
              )}</b>:\n\n${topList}${extraCount}`;

              const sentOk = await sendAlertAndRecordLog({
                supabaseAdmin: supabaseAdminLike,
                botToken,
                userId,
                chatId,
                monthDate: local.monthStart,
                alertType: reminderType,
                referenceId: null,
                message: reminderMsg,
              });
              if (sentOk) alertsSent += 1;
            }
          }
        }

        // D. Alertas de vencimientos de Plazos Fijos (3 días antes y el mismo día / vencidos)
        const localPlus3Days = addDaysToISODate(local.yyyyMmDd, 3);
        const { data: activeFixedTerms, error: fixedTermsError } = await supabaseAdmin
          .from('fixed_term_deposits')
          .select(
            'id, institution, principal_amount, expected_return_amount, maturity_date, origin',
          )
          .eq('user_id', userId)
          .eq('status', 'active')
          .lte('maturity_date', localPlus3Days);

        if (fixedTermsError) {
          console.error('Error al consultar fixed_term_deposits:', {
            userId,
            error: fixedTermsError,
          });
        } else {
          for (const ft of (activeFixedTerms ?? []) as Array<{
            id: string;
            institution: string;
            principal_amount: number;
            expected_return_amount: number;
            maturity_date: string;
            origin: string;
          }>) {
            let ftAlertType: 'fixed_term_due_3d' | 'fixed_term_due_today' | null = null;
            if (ft.maturity_date === localPlus3Days) {
              ftAlertType = 'fixed_term_due_3d';
            } else if (ft.maturity_date <= local.yyyyMmDd) {
              ftAlertType = 'fixed_term_due_today';
            }

            if (!ftAlertType) continue;

            const { data: existingFtAlert, error: existingFtError } =
              await supabaseAdmin
                .from('notification_logs')
                .select('id')
                .eq('user_id', userId)
                .eq('alert_type', ftAlertType)
                .eq('reference_id', ft.id)
                .limit(1);

            if (existingFtError) {
              console.error('Error al verificar notification_logs (plazo fijo):', {
                userId,
                fixedTermId: ft.id,
                error: existingFtError,
              });
              continue;
            }

            if (existingFtAlert && existingFtAlert.length > 0) continue;

            const originText =
              ft.origin === 'savings_fund'
                ? 'Bóveda de Ahorros'
                : 'Disponible Real del Mes';

            const ftMsg =
              ftAlertType === 'fixed_term_due_3d'
                ? `⏳ <b>Plazo Fijo próximo a vencer (en 3 días)</b>\n\n🏦 <b>${escapeHtml(ft.institution)}</b>\n• Capital: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.principal_amount), userSettings.currency),
                  )}</b>\n• Retorno esperado: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.expected_return_amount), userSettings.currency),
                  )}</b>\n• Vence: <b>${escapeHtml(ft.maturity_date)}</b>\n• Origen: ${escapeHtml(originText)}`
                : `🔔 <b>¡Plazo Fijo vencido — Listo para acreditar!</b>\n\n🏦 <b>${escapeHtml(ft.institution)}</b>\n• Capital: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.principal_amount), userSettings.currency),
                  )}</b>\n• Retorno esperado: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.expected_return_amount), userSettings.currency),
                  )}</b>\n• Vencimiento: <b>${escapeHtml(ft.maturity_date)}</b>\n\nIngresá a <b>Inversiones → Plazos Fijos</b> en SB-Finance para acreditar el retorno en tu Bóveda de Ahorros o Disponible Real.`;

            const sentOk = await sendAlertAndRecordLog({
              supabaseAdmin: supabaseAdminLike,
              botToken,
              userId,
              chatId,
              monthDate: local.monthStart,
              alertType: ftAlertType,
              referenceId: ft.id,
              message: ftMsg,
            });
            if (sentOk) alertsSent += 1;
          }
        }

        // E. Alerta de revisión de cierre de Gastos Fijos (<= 3 días para fin de mes)
        const daysRemainingInMonth = local.daysInMonth - local.day;
        if (daysRemainingInMonth <= 3 && fixedStatus.fixedLimit > 0) {
          const [monthBudgetRes, fixedSurplusRes, existingClosingRes] = await Promise.all([
            supabaseAdmin
              .from('monthly_budgets')
              .select('surplus_review_completed_at')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .maybeSingle(),
            supabaseAdmin
              .from('savings_entries')
              .select('amount')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('source_type', 'cap_surplus_fixed'),
            supabaseAdmin
              .from('notification_logs')
              .select('id')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('alert_type', 'fixed_cap_surplus_closing')
              .limit(1),
          ]);

          if (
            monthBudgetRes.error ||
            fixedSurplusRes.error ||
            existingClosingRes.error
          ) {
            console.error('Error al consultar datos de cierre de gastos fijos:', {
              userId,
              monthBudgetError: monthBudgetRes.error,
              fixedSurplusError: fixedSurplusRes.error,
              existingClosingError: existingClosingRes.error,
            });
          } else {
            const monthBudget = monthBudgetRes.data;
            const fixedSurplusEntries = fixedSurplusRes.data;
            const existingClosingAlert = existingClosingRes.data;
            const alreadyReviewed = Boolean(monthBudget?.surplus_review_completed_at);
            const alreadySent = Boolean(
              existingClosingAlert && existingClosingAlert.length > 0,
            );

            if (monthBudget && !alreadyReviewed && !alreadySent) {
              const transferredToSavings = (fixedSurplusEntries ?? []).reduce(
                (acc, row) =>
                  roundCurrency(acc + Number((row as { amount?: number }).amount ?? 0)),
                0,
              );
              const fixedCapSurplus = Math.max(
                0,
                roundCurrency(
                  fixedStatus.fixedLimit - fixedStatus.spent - transferredToSavings,
                ),
              );

              if (fixedCapSurplus > 0) {
                const daysLabel =
                  daysRemainingInMonth === 0
                    ? 'hoy termina el mes'
                    : daysRemainingInMonth === 1
                      ? 'falta 1 día para terminar el mes'
                      : `faltan ${daysRemainingInMonth} días para terminar el mes`;

                const closingMsg = `⏳ <b>Revisión de cierre de Gastos Fijos (${daysLabel})</b>\n\nTenés <b>${escapeHtml(
                  formatCurrencyARS(fixedCapSurplus, userSettings.currency),
                )}</b> sin usar dentro de tu límite de Gastos Fijos de este mes.\n\nIngresá al <b>Panel de SB-Finance</b> para verificar si olvidaste registrar algún gasto y decidir si enviarlo a tu <b>Bóveda de Ahorros</b> o liberarlo al <b>Disponible Real</b>.`;

                const sentOk = await sendAlertAndRecordLog({
                  supabaseAdmin: supabaseAdminLike,
                  botToken,
                  userId,
                  chatId,
                  monthDate: local.monthStart,
                  alertType: 'fixed_cap_surplus_closing',
                  referenceId: null,
                  message: closingMsg,
                });
                if (sentOk) alertsSent += 1;
              }
            }
          }
        }
      } catch (userErr) {
        userErrors += 1;
        console.error('Error procesando alertas diarias para usuario:', {
          userId,
          error: userErr,
        });
      }
    }

    return jsonResponse({ ok: true, processedUsers, alertsSent, userErrors }, 200);
  } catch (err) {
    console.error('Error fatal en daily-alerts:', err);
    return jsonResponse({ error: 'Error interno al ejecutar alertas diarias.' }, 500);
  }
});
