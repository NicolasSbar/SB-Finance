// ============================================================================
// ARCHIVO AUTOGENERADO PARA DEPLOY MANUAL EN SUPABASE EDITOR: notify-gustitos-alert
// NO EDITAR ESTE ARCHIVO DIRECTAMENTE.
// Editá supabase/functions/notify-gustitos-alert/index.ts o supabase/functions/_shared/*
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
// Módulo: supabase/functions/notify-gustitos-alert/index.ts
// ----------------------------------------------------------------------------
/**
 * Supabase Edge Function (Deno): notify-gustitos-alert
 *
 * Arquitectura y decisiones técnicas:
 * - Aislamiento de identidad por JWT: validamos el token `Authorization: Bearer <jwt>`
 *   con `SUPABASE_ANON_KEY` para obtener `callerUser.id` y recién entonces consultamos
 *   con `SUPABASE_SERVICE_ROLE_KEY`, garantizando que un usuario nunca pueda disparar
 *   notificaciones hacia el Telegram de otra persona.
 * - Exclusión estricta de gastos fijos: solo evalúa gastos variables (`transactions` con
 *   `type = 'expense'`) y compras en cuotas (`installment_purchases`), verificando en BD
 *   que el movimiento pertenezca a Gustitos antes de consultar el saldo y alertar.
 * - Mes real de la cuota y endurecimiento HTTP: respetamos el `monthDate`
 *   enviado por el cliente al pagar/adelantar/editar cuotas (usando `first_installment_date`
 *   solo como fallback si no vino `monthDate`), restringimos CORS vía `ALLOWED_ORIGINS`
 *   y evitamos filtrar mensajes crudos de error (`err.message`) en respuestas HTTP.
 */

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

interface AlertPayload {
  monthDate?: unknown;
  transactionId?: unknown;
  purchaseId?: unknown;
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

function getAllowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS');
  if (raw && raw.trim().length > 0) {
    const parsed = raw
      .split(',')
      .map((item) => normalizeOrigin(item))
      .filter((item) => item.length > 0 && item !== '*');
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return DEFAULT_DEV_ORIGINS;
}

function buildCorsHeaders(requestOrigin: string | null): {
  allowed: boolean;
  headers: Record<string, string>;
} {
  const baseHeaders: Record<string, string> = {
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };

  if (!requestOrigin) {
    return { allowed: true, headers: baseHeaders };
  }

  const normalized = normalizeOrigin(requestOrigin);
  const allowedOrigins = getAllowedOrigins();
  if (!allowedOrigins.includes(normalized)) {
    return { allowed: false, headers: baseHeaders };
  }

  return {
    allowed: true,
    headers: {
      ...baseHeaders,
      'Access-Control-Allow-Origin': normalized,
    },
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req.headers.get('Origin'));

  if (!cors.allowed) {
    if (req.method === 'OPTIONS') {
      return new Response('Origen no permitido.', { status: 403, headers: cors.headers });
    }
    return jsonResponse({ error: 'Origen no permitido.' }, 403, cors.headers);
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors.headers });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método no permitido. Usá POST.' }, 405, cors.headers);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error('Missing required Supabase environment variables in notify-gustitos-alert.');
      return jsonResponse({ error: 'Error de configuración del servidor.' }, 500, cors.headers);
    }

    if (!botToken) {
      return jsonResponse(
        { sent: false, reason: 'telegram_not_configured' },
        200,
        cors.headers,
      );
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse(
        { error: 'Token de autorización faltante o inválido.' },
        401,
        cors.headers,
      );
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user: callerUser },
      error: authError,
    } = await callerClient.auth.getUser();

    if (authError || !callerUser) {
      return jsonResponse({ error: 'Sesión inválida o expirada.' }, 401, cors.headers);
    }

    let payload: AlertPayload;
    try {
      payload = (await req.json()) as AlertPayload;
    } catch {
      return jsonResponse({ error: 'Cuerpo JSON inválido.' }, 400, cors.headers);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse({ error: 'Cuerpo JSON inválido.' }, 400, cors.headers);
    }

    const transactionId =
      typeof payload.transactionId === 'string' ? payload.transactionId.trim() : null;
    const purchaseId =
      typeof payload.purchaseId === 'string' ? payload.purchaseId.trim() : null;

    if (!transactionId && !purchaseId) {
      return jsonResponse({ sent: false, reason: 'missing_reference' }, 200, cors.headers);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [linkRes, settingsRes] = await Promise.all([
      supabaseAdmin
        .from('telegram_links')
        .select('telegram_chat_id')
        .eq('user_id', callerUser.id)
        .maybeSingle(),
      supabaseAdmin
        .from('user_settings')
        .select('currency, timezone')
        .eq('user_id', callerUser.id)
        .maybeSingle(),
    ]);

    if (linkRes.error || settingsRes.error) {
      console.error('Error loading telegram_links/user_settings in notify-gustitos-alert:', {
        linkError: linkRes.error?.message,
        settingsError: settingsRes.error?.message,
      });
      return jsonResponse(
        { error: 'No se pudo consultar la configuración de alertas.' },
        500,
        cors.headers,
      );
    }

    if (!linkRes.data?.telegram_chat_id) {
      return jsonResponse({ sent: false, reason: 'no_telegram_link' }, 200, cors.headers);
    }

    const chatId = Number(linkRes.data.telegram_chat_id);
    const currency = (settingsRes.data?.currency as string | undefined) ?? 'ARS';
    const timezone =
      (settingsRes.data?.timezone as string | undefined) ??
      'America/Argentina/Buenos_Aires';
    const localParts = getLocalDateParts(timezone);

    const rawMonthDate =
      typeof payload.monthDate === 'string' ? payload.monthDate.trim() : '';
    const hasExplicitMonthDate = /^\d{4}-\d{2}(?:-\d{2})?$/.test(rawMonthDate);

    let monthDate = hasExplicitMonthDate
      ? normalizeMonthStart(rawMonthDate)
      : localParts.monthStart;

    let categoryId: string | null = null;
    let isDirectlyMarkedGustito = false;

    if (transactionId) {
      const { data: tx, error: txError } = await supabaseAdmin
        .from('transactions')
        .select('category_id, type, is_gustito, transaction_date')
        .eq('id', transactionId)
        .eq('user_id', callerUser.id)
        .maybeSingle();

      if (txError) {
        console.error('Error querying transaction in notify-gustitos-alert:', txError.message);
        return jsonResponse(
          { error: 'No se pudo validar el movimiento registrado.' },
          500,
          cors.headers,
        );
      }

      if (!tx || tx.type !== 'expense') {
        return jsonResponse({ sent: false, reason: 'not_an_expense' }, 200, cors.headers);
      }

      categoryId = tx.category_id as string;
      isDirectlyMarkedGustito = Boolean(tx.is_gustito);
      monthDate = normalizeMonthStart(tx.transaction_date as string);
    } else if (purchaseId) {
      const { data: purchase, error: purchaseError } = await supabaseAdmin
        .from('installment_purchases')
        .select('category_id, is_gustito, first_installment_date')
        .eq('id', purchaseId)
        .eq('user_id', callerUser.id)
        .maybeSingle();

      if (purchaseError) {
        console.error(
          'Error querying installment_purchase in notify-gustitos-alert:',
          purchaseError.message,
        );
        return jsonResponse(
          { error: 'No se pudo validar la compra en cuotas.' },
          500,
          cors.headers,
        );
      }

      if (!purchase) {
        return jsonResponse({ sent: false, reason: 'purchase_not_found' }, 200, cors.headers);
      }

      categoryId = purchase.category_id as string;
      isDirectlyMarkedGustito = Boolean(purchase.is_gustito);
      // Respetar el monthDate real enviado (ej. cuota adelantada o editada del mes actual);
      // usar first_installment_date únicamente como respaldo si no llegó monthDate explícito.
      if (!hasExplicitMonthDate && typeof purchase.first_installment_date === 'string') {
        monthDate = normalizeMonthStart(purchase.first_installment_date);
      }
    }

    if (!categoryId) {
      return jsonResponse({ sent: false, reason: 'no_category' }, 200, cors.headers);
    }

    let isCategoryGustito = false;
    if (!isDirectlyMarkedGustito) {
      const { data: snap, error: snapError } = await supabaseAdmin
        .from('monthly_category_snapshots')
        .select('is_gustito')
        .eq('user_id', callerUser.id)
        .eq('month_date', monthDate)
        .eq('category_id', categoryId)
        .maybeSingle();

      if (snapError) {
        console.error(
          'Error querying monthly_category_snapshots in notify-gustitos-alert:',
          snapError.message,
        );
        return jsonResponse(
          { error: 'No se pudo verificar la categoría del período.' },
          500,
          cors.headers,
        );
      }

      if (snap) {
        isCategoryGustito = Boolean(snap.is_gustito);
      } else {
        const { data: cat, error: catError } = await supabaseAdmin
          .from('categories')
          .select('is_gustito')
          .eq('id', categoryId)
          .eq('user_id', callerUser.id)
          .maybeSingle();

        if (catError) {
          console.error('Error querying category in notify-gustitos-alert:', catError.message);
          return jsonResponse(
            { error: 'No se pudo verificar la categoría del gasto.' },
            500,
            cors.headers,
          );
        }

        isCategoryGustito = Boolean(cat?.is_gustito);
      }
    }

    if (!isDirectlyMarkedGustito && !isCategoryGustito) {
      return jsonResponse({ sent: false, reason: 'not_gustito' }, 200, cors.headers);
    }

    const gustitosStatus = await computeGustitosStatus(
      supabaseAdmin as unknown as SupabaseAdminLike,
      callerUser.id,
      monthDate,
    );

    if (gustitosStatus.budget <= 0 || gustitosStatus.remaining > 0) {
      return jsonResponse(
        { sent: false, remaining: gustitosStatus.remaining, budget: gustitosStatus.budget },
        200,
        cors.headers,
      );
    }

    const alertText = `🚨 <b>Alerta Bolsa de Gustitos</b>\n\nRegistraste un gasto desde la web y tu saldo restante de Gustitos está en <b>${escapeHtml(
      formatCurrencyARS(gustitosStatus.remaining, currency),
    )}</b>.\n• Presupuesto del mes: ${escapeHtml(
      formatCurrencyARS(gustitosStatus.budget, currency),
    )}\n• Gastado acumulado: ${escapeHtml(
      formatCurrencyARS(gustitosStatus.spent, currency),
    )}`;

    let sent = false;
    try {
      await sendTelegramMessage(botToken, chatId, alertText, {
        parseMode: 'HTML',
      });
      sent = true;
    } catch (sendErr) {
      console.error('Error sending Gustitos alert to Telegram:', sendErr);
    }

    return jsonResponse(
      {
        sent,
        remaining: gustitosStatus.remaining,
        budget: gustitosStatus.budget,
      },
      200,
      cors.headers,
    );
  } catch (err) {
    console.error('Unexpected error in notify-gustitos-alert:', err);
    return jsonResponse(
      { error: 'Ocurrió un error interno al evaluar la alerta de Gustitos.' },
      500,
      cors.headers,
    );
  }
});
