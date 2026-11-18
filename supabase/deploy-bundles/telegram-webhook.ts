// ============================================================================
// ARCHIVO AUTOGENERADO PARA DEPLOY MANUAL EN SUPABASE EDITOR: telegram-webhook
// NO EDITAR ESTE ARCHIVO DIRECTAMENTE.
// Editá supabase/functions/telegram-webhook/index.ts o supabase/functions/_shared/*
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
// Módulo: supabase/functions/_shared/telegramIntentProcessor.ts
// ----------------------------------------------------------------------------
/**
 * Procesador multimodal compartido para extracción y persistencia de intenciones
 * financieras desde Telegram (usado por `telegram-webhook` y `process-telegram-queue`).
 *
 * Arquitectura y decisiones técnicas:
 * - Única fuente de verdad para IA y persistencia: evitar duplicar el prompt,
 *   las reglas de negocio (cuotas sin división automática, Gustitos, ingreso directo
 *   a ahorros, adelanto de N cuotas y plazos fijos) y la persistencia entre el
 *   webhook en vivo y el worker de reintentos.
 * - Resiliencia de modelo IA (`GEMINI_MODEL` + `GEMINI_FALLBACK_MODEL`): las llamadas
 *   a Gemini usan `AbortSignal.timeout(25_000)` y hacen fallback automático al modelo
 *   de respaldo (`gemini-2.5-flash`) ante errores transitorios (`429`/`5xx`), `404`
 *   de modelo, timeouts o fallos de red antes de delegar a la cola persistente.
 * - Contexto de compras pendientes + filtrado de stop-words: enviamos las
 *   `installment_purchases` con cuotas pendientes al prompt para resolver frases
 *   sin dígitos (ej. "pagar las cuotas restantes de zapatillas") y excluimos
 *   stop-words (`de`, `la`, `el`, etc.) en `findMatchingPurchases`.
 * - Cálculo determinístico en Deno: Gemini Flash extrae únicamente parámetros
 *   estructurados; `computeFixedTermReturn` calcula rendimientos por `%` o TNA
 *   y PostgreSQL distribuye centavos exactos en `advance_installments`.
 * - Tipado explícito de errores transitorios (`TransientAiError`) y verificación de
 *   `.error` en queries Supabase: distinguimos saturación/caídas
 *   temporales de errores permanentes y validamos todo `JSON.parse` y query DB.
 */

const SESSION_TTL_MINUTES = 15;
const MAX_MONEY = 9999999999.99;
const GEMINI_FAST_RETRY_DELAY_MS = 1500;
const GEMINI_TIMEOUT_MS = 25_000;
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK_GEMINI_MODEL = 'gemini-2.5-flash';

function buildGeminiEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function resolveGeminiModels(): string[] {
  const rawPrimary = Deno.env.get('GEMINI_MODEL')?.trim() ?? '';
  const primary = /^[a-zA-Z0-9._-]{3,80}$/.test(rawPrimary)
    ? rawPrimary
    : DEFAULT_GEMINI_MODEL;

  const rawFallback = Deno.env.get('GEMINI_FALLBACK_MODEL')?.trim() ?? '';
  const fallback = /^[a-zA-Z0-9._-]{3,80}$/.test(rawFallback)
    ? rawFallback
    : DEFAULT_FALLBACK_GEMINI_MODEL;

  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

const GEMINI_FLASH_ENDPOINT = buildGeminiEndpoint(DEFAULT_GEMINI_MODEL);

type ParsedStatus = 'complete' | 'needs_clarification' | 'unrecognized';

type ParsedIntent =
  | 'expense'
  | 'income'
  | 'installment_purchase'
  | 'pay_installments'
  | 'fixed_term_deposit';

type MissingField =
  | 'category'
  | 'installment_amount'
  | 'installments_count'
  | 'first_installment_date'
  | 'amount'
  | 'description'
  | 'purchase_selection'
  | 'installments_to_pay'
  | 'fixed_term_return'
  | 'fixed_term_origin';

type PendingStep =
  | 'awaiting_category'
  | 'awaiting_amount'
  | 'awaiting_description'
  | 'awaiting_installment_details'
  | 'awaiting_first_installment_date'
  | 'awaiting_purchase_selection'
  | 'awaiting_installment_count'
  | 'awaiting_fixed_term_origin'
  | 'awaiting_fixed_term_return';

interface GeminiParsedIntent {
  status: ParsedStatus;
  intent: ParsedIntent | null;
  amount: number | null;
  description: string | null;
  category_id: string | null;
  category_confidence: 'high' | 'low';
  is_gustito: boolean;
  save_to_savings: boolean;
  transaction_date: string | null;
  installments_count: number | null;
  first_installment_date: string | null;
  purchase_query: string | null;
  purchase_id: string | null;
  installments_to_pay: number | null;
  total_paid_amount: number | null;
  institution: string | null;
  principal_amount: number | null;
  expected_return_amount: number | null;
  yield_percent: number | null;
  rate_period: 'period' | 'annual' | null;
  term_days: number | null;
  start_date: string | null;
  maturity_date: string | null;
  fixed_term_origin: 'monthly_available' | 'savings_fund' | null;
  missing_fields: MissingField[];
  clarification_message: string | null;
}

interface ActiveCategory {
  id: string;
  name: string;
  type: 'expense' | 'income';
  is_gustito: boolean;
  monthly_limit: number | null;
}

interface ConversationSession {
  id: string;
  user_id: string;
  chat_id: number;
  intent: ParsedIntent;
  pending_step: PendingStep;
  draft_json: Partial<GeminiParsedIntent>;
  expires_at: string;
}

interface PendingPurchaseCandidate {
  id: string;
  description: string;
  installments_count: number;
  installment_amount?: number;
  pendingCount: number;
}

class TransientAiError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'TransientAiError';
    this.statusCode = statusCode;
  }
}

function isTransientStatusCode(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeAudioMimeType(rawMime?: string | null): string {
  const baseMime = (rawMime ?? '').split(';')[0].trim().toLowerCase();
  if (!baseMime) return 'audio/ogg';
  const aliasMap: Record<string, string> = {
    'audio/opus': 'audio/ogg',
    'audio/x-m4a': 'audio/mp4',
    'audio/m4a': 'audio/mp4',
    'audio/x-wav': 'audio/wav',
  };
  return aliasMap[baseMime] ?? baseMime;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function diffDaysIso(startIso: string, endIso: string): number {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  return Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
}

function addMonthsClamped(isoDate: string, monthsToAdd: number): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const monthIndex = Number(mStr) - 1;
  const day = Number(dStr);
  const totalMonths = year * 12 + monthIndex + monthsToAdd;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = totalMonths % 12;
  const daysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0),
  ).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(
    clampedDay,
  ).padStart(2, '0')}`;
}

function buildCategoryButtons(
  categories: ActiveCategory[],
): TelegramInlineButton[][] {
  const rows: TelegramInlineButton[][] = [];
  for (let i = 0; i < categories.length; i += 2) {
    const chunk = categories.slice(i, i + 2);
    rows.push(
      chunk.map((cat, offset) => ({
        text: `${i + offset + 1}. ${cat.name}`,
        callback_data: `pick_cat:${cat.id}`,
      })),
    );
  }
  rows.push([{ text: '❌ Cancelar', callback_data: 'cancel_session' }]);
  return rows;
}

function buildFixedTermOriginButtons(): TelegramInlineButton[][] {
  return [
    [
      { text: '💰 Disponible del Mes', callback_data: 'pick_ft_origin:monthly_available' },
      { text: '🏦 Bóveda de Ahorros', callback_data: 'pick_ft_origin:savings_fund' },
    ],
    [{ text: '❌ Cancelar', callback_data: 'cancel_session' }],
  ];
}

function buildPurchaseSelectionButtons(
  purchases: PendingPurchaseCandidate[],
): TelegramInlineButton[][] {
  const rows: TelegramInlineButton[][] = purchases.slice(0, 8).map((p) => [
    {
      text: `${p.description.slice(0, 32)} (${p.pendingCount} pend.)`,
      callback_data: `pick_purchase:${p.id}`,
    },
  ]);
  rows.push([{ text: '❌ Cancelar', callback_data: 'cancel_session' }]);
  return rows;
}

function resolvePendingStep(
  intent: ParsedIntent,
  missingFields: MissingField[],
): PendingStep {
  if (intent === 'pay_installments') {
    if (missingFields.includes('purchase_selection')) {
      return 'awaiting_purchase_selection';
    }
    return 'awaiting_installment_count';
  }

  if (intent === 'fixed_term_deposit') {
    if (missingFields.includes('fixed_term_return')) {
      return 'awaiting_fixed_term_return';
    }
    if (missingFields.includes('fixed_term_origin')) {
      return 'awaiting_fixed_term_origin';
    }
    return 'awaiting_fixed_term_return';
  }

  if (
    intent === 'installment_purchase' &&
    (missingFields.includes('installment_amount') ||
      missingFields.includes('installments_count') ||
      missingFields.includes('amount'))
  ) {
    return 'awaiting_installment_details';
  }
  if (
    intent === 'installment_purchase' &&
    missingFields.includes('first_installment_date')
  ) {
    return 'awaiting_first_installment_date';
  }
  if (missingFields.includes('amount')) {
    return 'awaiting_amount';
  }
  if (missingFields.includes('description')) {
    return 'awaiting_description';
  }
  return 'awaiting_category';
}

function emptyParsedIntent(status: ParsedStatus = 'unrecognized'): GeminiParsedIntent {
  return {
    status,
    intent: null,
    amount: null,
    description: null,
    category_id: null,
    category_confidence: 'low',
    is_gustito: false,
    save_to_savings: false,
    transaction_date: null,
    installments_count: null,
    first_installment_date: null,
    purchase_query: null,
    purchase_id: null,
    installments_to_pay: null,
    total_paid_amount: null,
    institution: null,
    principal_amount: null,
    expected_return_amount: null,
    yield_percent: null,
    rate_period: null,
    term_days: null,
    start_date: null,
    maturity_date: null,
    fixed_term_origin: null,
    missing_fields: [],
    clarification_message: null,
  };
}

function normalizeAndValidateParsedIntent(
  raw: Omit<Partial<GeminiParsedIntent>, 'status'> & { status?: string },
  categories: ActiveCategory[],
  todayLocal: string,
): GeminiParsedIntent {
  // Compatibilidad defensiva si Gemini devuelve un legado `out_of_scope_fixed_term`
  const normalizedRawIntent: ParsedIntent | null =
    raw.status === 'out_of_scope_fixed_term'
      ? 'fixed_term_deposit'
      : raw.intent === 'expense' ||
          raw.intent === 'income' ||
          raw.intent === 'installment_purchase' ||
          raw.intent === 'pay_installments' ||
          raw.intent === 'fixed_term_deposit'
        ? raw.intent
        : null;

  const rawStatus: ParsedStatus =
    raw.status === 'complete' ||
    raw.status === 'needs_clarification' ||
    raw.status === 'unrecognized'
      ? raw.status
      : normalizedRawIntent
        ? 'needs_clarification'
        : 'unrecognized';

  if (rawStatus === 'unrecognized' || !normalizedRawIntent) {
    return {
      ...emptyParsedIntent('unrecognized'),
      clarification_message: raw.clarification_message ?? null,
    };
  }

  const intent = normalizedRawIntent;

  // Rama 1: Adelanto / pago múltiple de N cuotas
  if (intent === 'pay_installments') {
    const purchaseId =
      typeof raw.purchase_id === 'string' && raw.purchase_id.trim().length > 0
        ? raw.purchase_id.trim()
        : null;
    const purchaseQuery =
      typeof raw.purchase_query === 'string' && raw.purchase_query.trim().length >= 2
        ? raw.purchase_query.trim().slice(0, 120)
        : typeof raw.description === 'string' && raw.description.trim().length >= 2
          ? raw.description.trim().slice(0, 120)
          : null;

    const rawCount =
      typeof raw.installments_to_pay === 'number'
        ? raw.installments_to_pay
        : typeof raw.installments_count === 'number'
          ? raw.installments_count
          : null;
    const installmentsToPay =
      rawCount !== null &&
      Number.isInteger(rawCount) &&
      rawCount >= 1 &&
      rawCount <= 120
        ? rawCount
        : null;

    const rawTotal =
      typeof raw.total_paid_amount === 'number'
        ? raw.total_paid_amount
        : typeof raw.amount === 'number'
          ? raw.amount
          : null;
    const totalPaidAmount =
      rawTotal !== null &&
      Number.isFinite(rawTotal) &&
      rawTotal >= 0.01 &&
      rawTotal <= MAX_MONEY
        ? roundCurrency(rawTotal)
        : null;

    const missingFields: MissingField[] = [];
    if (!purchaseId) {
      missingFields.push('purchase_selection');
    }
    if (!installmentsToPay) {
      missingFields.push('installments_to_pay');
    }

    return {
      ...emptyParsedIntent(
        missingFields.length > 0 ? 'needs_clarification' : 'complete',
      ),
      intent: 'pay_installments',
      purchase_query: purchaseQuery,
      purchase_id: purchaseId,
      installments_to_pay: installmentsToPay,
      total_paid_amount: totalPaidAmount,
      missing_fields: missingFields,
      clarification_message: raw.clarification_message ?? null,
    };
  }

  // Rama 2: Plazo Fijo (`fixed_term_deposit`)
  if (intent === 'fixed_term_deposit') {
    const rawPrincipal =
      typeof raw.principal_amount === 'number'
        ? raw.principal_amount
        : typeof raw.amount === 'number'
          ? raw.amount
          : null;
    const principalAmount =
      rawPrincipal !== null &&
      Number.isFinite(rawPrincipal) &&
      rawPrincipal >= 0.01 &&
      rawPrincipal <= MAX_MONEY
        ? roundCurrency(rawPrincipal)
        : null;

    const institution =
      typeof raw.institution === 'string' && raw.institution.trim().length >= 2
        ? raw.institution.trim().slice(0, 100)
        : 'Plazo Fijo';

    const startDate = isIsoDate(raw.start_date) ? raw.start_date : todayLocal;
    const termDaysInput =
      typeof raw.term_days === 'number' &&
      Number.isInteger(raw.term_days) &&
      raw.term_days >= 1 &&
      raw.term_days <= 3650
        ? raw.term_days
        : null;

    let maturityDate: string | null = null;
    if (isIsoDate(raw.maturity_date) && raw.maturity_date > startDate) {
      maturityDate = raw.maturity_date;
    } else if (termDaysInput !== null) {
      maturityDate = addDaysToISODate(startDate, termDaysInput);
    }

    const effectiveTermDays =
      termDaysInput ??
      (maturityDate !== null ? Math.max(1, diffDaysIso(startDate, maturityDate)) : null);

    const yieldPercent =
      typeof raw.yield_percent === 'number' &&
      Number.isFinite(raw.yield_percent) &&
      raw.yield_percent >= 0 &&
      raw.yield_percent <= 10000
        ? raw.yield_percent
        : null;

    const ratePeriod: 'period' | 'annual' | null =
      raw.rate_period === 'annual' || raw.rate_period === 'period'
        ? raw.rate_period
        : null;

    const rawExpectedReturn =
      typeof raw.expected_return_amount === 'number' &&
      Number.isFinite(raw.expected_return_amount) &&
      raw.expected_return_amount >= 0.01 &&
      raw.expected_return_amount <= MAX_MONEY
        ? roundCurrency(raw.expected_return_amount)
        : null;

    let computedExpectedReturn: number | null = rawExpectedReturn;
    let returnCalcError: string | undefined;

    if (principalAmount !== null) {
      const calc = computeFixedTermReturn({
        principalAmount,
        expectedReturnAmount: rawExpectedReturn,
        yieldPercent,
        ratePeriod,
        termDays: effectiveTermDays,
      });
      computedExpectedReturn = calc.expectedReturnAmount;
      returnCalcError = calc.error;
    }

    const origin =
      raw.fixed_term_origin === 'monthly_available' ||
      raw.fixed_term_origin === 'savings_fund'
        ? raw.fixed_term_origin
        : null;

    const missingFields: MissingField[] = [];
    if (!principalAmount || !computedExpectedReturn || !maturityDate) {
      missingFields.push('fixed_term_return');
    }
    if (!origin) {
      missingFields.push('fixed_term_origin');
    }

    let clarificationMessage = raw.clarification_message ?? null;
    if (returnCalcError) {
      clarificationMessage = returnCalcError;
    } else if (!principalAmount) {
      clarificationMessage =
        '¿Cuánto capital invertiste en el plazo fijo, a cuántos días (o fecha de vencimiento) y cuánto vas a recibir?';
    } else if (!maturityDate) {
      clarificationMessage =
        '¿A cuántos días es el plazo fijo o en qué fecha vence? (ej. "a 30 días")';
    } else if (!computedExpectedReturn) {
      clarificationMessage =
        '¿Cuánto dinero vas a recibir al vencimiento o qué porcentaje de rendimiento tiene? (ej. "recibo 103.500" o "3,5% de rendimiento")';
    }

    return {
      ...emptyParsedIntent(
        missingFields.length > 0 ? 'needs_clarification' : 'complete',
      ),
      intent: 'fixed_term_deposit',
      institution,
      principal_amount: principalAmount,
      expected_return_amount: computedExpectedReturn,
      yield_percent: yieldPercent,
      rate_period: ratePeriod,
      term_days: effectiveTermDays,
      start_date: startDate,
      maturity_date: maturityDate,
      fixed_term_origin: origin,
      missing_fields: missingFields,
      clarification_message: clarificationMessage,
    };
  }

  // Rama 3: Movimientos y Compras en Cuotas (Fase 2)
  const expectedCatType: 'expense' | 'income' =
    intent === 'income' ? 'income' : 'expense';
  const matchedCategory = categories.find(
    (c) => c.id === raw.category_id && c.type === expectedCatType,
  );

  const validCategoryId =
    matchedCategory && raw.category_confidence === 'high'
      ? matchedCategory.id
      : null;

  const parsedAmount =
    typeof raw.amount === 'number' &&
    Number.isFinite(raw.amount) &&
    raw.amount >= 0.01 &&
    raw.amount <= MAX_MONEY
      ? roundCurrency(raw.amount)
      : null;

  const description =
    typeof raw.description === 'string' && raw.description.trim().length >= 2
      ? raw.description.trim().slice(0, 150)
      : null;

  const txDate = isIsoDate(raw.transaction_date) ? raw.transaction_date : todayLocal;

  const installmentsCount =
    typeof raw.installments_count === 'number' &&
    Number.isInteger(raw.installments_count) &&
    raw.installments_count >= 1 &&
    raw.installments_count <= 120
      ? raw.installments_count
      : null;

  const firstInstallmentDate = isIsoDate(raw.first_installment_date)
    ? raw.first_installment_date
    : null;

  const missingSet = new Set<MissingField>(
    Array.isArray(raw.missing_fields) ? raw.missing_fields : [],
  );

  if (!parsedAmount) {
    missingSet.add(
      intent === 'installment_purchase' ? 'installment_amount' : 'amount',
    );
  }
  if (!description) {
    missingSet.add('description');
  }
  if (!validCategoryId) {
    missingSet.add('category');
  }

  if (intent === 'installment_purchase') {
    if (!installmentsCount) {
      missingSet.add('installments_count');
    }
    if (!firstInstallmentDate) {
      missingSet.add('first_installment_date');
    }
    if (
      parsedAmount !== null &&
      installmentsCount !== null &&
      roundCurrency(parsedAmount * installmentsCount) > MAX_MONEY
    ) {
      missingSet.add('installment_amount');
    }
  }

  const missingFields = Array.from(missingSet);
  const resolvedStatus: ParsedStatus =
    missingFields.length > 0 ? 'needs_clarification' : 'complete';

  return {
    ...emptyParsedIntent(resolvedStatus),
    intent,
    amount: parsedAmount,
    description,
    category_id: validCategoryId,
    category_confidence: validCategoryId ? 'high' : 'low',
    is_gustito: intent === 'income' ? false : Boolean(raw.is_gustito),
    save_to_savings: intent === 'income' ? Boolean(raw.save_to_savings) : false,
    transaction_date: txDate,
    installments_count: installmentsCount,
    first_installment_date: firstInstallmentDate,
    missing_fields: missingFields,
    clarification_message: raw.clarification_message ?? null,
  };
}

function mergeWithActiveSessionDraft(
  activeSession: ConversationSession | null,
  rawParsed: Partial<GeminiParsedIntent>,
): Partial<GeminiParsedIntent> {
  if (!activeSession) {
    // Seguridad: sin confirmación previa de botón inline, fixed_term_origin siempre inicia null
    if (rawParsed.intent === 'fixed_term_deposit') {
      return { ...rawParsed, fixed_term_origin: null };
    }
    return rawParsed;
  }

  const prev = activeSession.draft_json ?? {};
  const mergedIntent = rawParsed.intent ?? prev.intent ?? activeSession.intent;

  // Para plazos fijos en texto antes del botón inline, mantenemos el origen del draft (solo seteado por callback)
  const preservedFtOrigin =
    activeSession.pending_step === 'awaiting_fixed_term_origin'
      ? (rawParsed.fixed_term_origin ?? prev.fixed_term_origin ?? null)
      : (prev.fixed_term_origin ?? null);

  if (mergedIntent === 'pay_installments') {
    const rawCountFallback =
      typeof rawParsed.installments_to_pay === 'number'
        ? rawParsed.installments_to_pay
        : activeSession.pending_step === 'awaiting_installment_count' &&
            typeof rawParsed.amount === 'number' &&
            Number.isInteger(rawParsed.amount) &&
            rawParsed.amount >= 1 &&
            rawParsed.amount <= 120
          ? rawParsed.amount
          : null;

    return {
      ...rawParsed,
      status:
        rawParsed.status === 'unrecognized' ? 'needs_clarification' : rawParsed.status,
      intent: 'pay_installments',
      purchase_id: rawParsed.purchase_id ?? prev.purchase_id ?? null,
      purchase_query: rawParsed.purchase_query ?? prev.purchase_query ?? null,
      installments_to_pay: rawCountFallback ?? prev.installments_to_pay ?? null,
      total_paid_amount: rawParsed.total_paid_amount ?? prev.total_paid_amount ?? null,
    };
  }

  if (mergedIntent === 'fixed_term_deposit') {
    return {
      ...rawParsed,
      status:
        rawParsed.status === 'unrecognized' ? 'needs_clarification' : rawParsed.status,
      intent: 'fixed_term_deposit',
      institution:
        rawParsed.institution && rawParsed.institution !== 'Plazo Fijo'
          ? rawParsed.institution
          : (prev.institution ?? rawParsed.institution ?? 'Plazo Fijo'),
      principal_amount:
        rawParsed.principal_amount ?? prev.principal_amount ?? null,
      expected_return_amount:
        rawParsed.expected_return_amount ?? prev.expected_return_amount ?? null,
      yield_percent: rawParsed.yield_percent ?? prev.yield_percent ?? null,
      rate_period: rawParsed.rate_period ?? prev.rate_period ?? null,
      term_days: rawParsed.term_days ?? prev.term_days ?? null,
      start_date: isIsoDate(rawParsed.start_date)
        ? rawParsed.start_date
        : (prev.start_date ?? null),
      maturity_date: isIsoDate(rawParsed.maturity_date)
        ? rawParsed.maturity_date
        : (prev.maturity_date ?? null),
      fixed_term_origin: preservedFtOrigin,
    };
  }

  const hasRawAmount =
    typeof rawParsed.amount === 'number' &&
    Number.isFinite(rawParsed.amount) &&
    rawParsed.amount >= 0.01;
  const mergedAmount = hasRawAmount ? rawParsed.amount : (prev.amount ?? null);

  const hasRawDescription =
    typeof rawParsed.description === 'string' &&
    rawParsed.description.trim().length >= 2;
  const mergedDescription = hasRawDescription
    ? rawParsed.description
    : (prev.description ?? null);

  const mergedCategoryId = rawParsed.category_id ?? prev.category_id ?? null;
  const mergedCategoryConfidence: 'high' | 'low' = rawParsed.category_id
    ? (rawParsed.category_confidence ?? 'high')
    : prev.category_id
      ? (prev.category_confidence ?? 'high')
      : 'low';

  const mergedIsGustito =
    Boolean(rawParsed.is_gustito) || Boolean(prev.is_gustito);
  const mergedSaveToSavings =
    Boolean(rawParsed.save_to_savings) || Boolean(prev.save_to_savings);
  const mergedTxDate = isIsoDate(rawParsed.transaction_date)
    ? rawParsed.transaction_date
    : (prev.transaction_date ?? null);
  const mergedInstallmentsCount =
    typeof rawParsed.installments_count === 'number' &&
    Number.isInteger(rawParsed.installments_count)
      ? rawParsed.installments_count
      : (prev.installments_count ?? null);
  const mergedFirstInstallmentDate = isIsoDate(rawParsed.first_installment_date)
    ? rawParsed.first_installment_date
    : (prev.first_installment_date ?? null);

  const rawMissing = Array.isArray(rawParsed.missing_fields)
    ? rawParsed.missing_fields
    : [];
  const filteredMissing = rawMissing.filter((field) => {
    if (field === 'amount' || field === 'installment_amount') {
      return mergedAmount === null;
    }
    if (field === 'description') {
      return mergedDescription === null;
    }
    if (field === 'category') {
      return !(mergedCategoryId !== null && mergedCategoryConfidence === 'high');
    }
    if (field === 'installments_count') {
      return mergedInstallmentsCount === null;
    }
    if (field === 'first_installment_date') {
      return mergedFirstInstallmentDate === null;
    }
    return true;
  });

  const mergedStatus: ParsedStatus =
    rawParsed.status === 'unrecognized' && mergedIntent
      ? 'needs_clarification'
      : (rawParsed.status ?? 'needs_clarification');

  return {
    ...rawParsed,
    status: mergedStatus,
    intent: mergedIntent,
    amount: mergedAmount,
    description: mergedDescription,
    category_id: mergedCategoryId,
    category_confidence: mergedCategoryConfidence,
    is_gustito: mergedIsGustito,
    save_to_savings: mergedSaveToSavings,
    transaction_date: mergedTxDate,
    installments_count: mergedInstallmentsCount,
    first_installment_date: mergedFirstInstallmentDate,
    missing_fields: filteredMissing,
  };
}

async function callGeminiFlash(
  geminiApiKey: string,
  params: {
    userText: string | null;
    audioBase64: string | null;
    audioMimeType: string | null;
    todayLocal: string;
    timezone: string;
    categories: ActiveCategory[];
    activeSession: ConversationSession | null;
    pendingPurchases?: PendingPurchaseCandidate[];
    supabaseAdmin?: SupabaseAdminLike;
    userId?: string;
  },
): Promise<GeminiParsedIntent> {
  const {
    userText,
    audioBase64,
    audioMimeType,
    todayLocal,
    timezone,
    categories,
    activeSession,
    pendingPurchases,
    supabaseAdmin,
    userId,
  } = params;

  const effectivePendingPurchases =
    pendingPurchases !== undefined
      ? pendingPurchases
      : supabaseAdmin && userId
        ? await fetchPendingPurchasesForUser(supabaseAdmin, userId)
        : [];

  const categoriesSummary = categories.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
  }));

  const pendingPurchasesSummary = effectivePendingPurchases.map((p) => ({
    id: p.id,
    description: p.description,
    pending_installments: p.pendingCount,
    total_installments: p.installments_count,
    installment_amount: p.installment_amount ?? null,
  }));

  const systemInstruction = `Sos el asistente financiero de SB-Finance para parsear mensajes de texto y notas de voz en español argentino/latinoamericano.
Tu salida debe ser ÚNICAMENTE un JSON válido respetando exactamente este esquema:
{
  "status": "complete" | "needs_clarification" | "unrecognized",
  "intent": "expense" | "income" | "installment_purchase" | "pay_installments" | "fixed_term_deposit" | null,
  "amount": number | null,
  "description": string | null,
  "category_id": string | null,
  "category_confidence": "high" | "low",
  "is_gustito": boolean,
  "save_to_savings": boolean,
  "transaction_date": "YYYY-MM-DD" | null,
  "installments_count": number | null,
  "first_installment_date": "YYYY-MM-DD" | null,
  "purchase_query": string | null,
  "purchase_id": string | null,
  "installments_to_pay": number | null,
  "total_paid_amount": number | null,
  "institution": string | null,
  "principal_amount": number | null,
  "expected_return_amount": number | null,
  "yield_percent": number | null,
  "rate_period": "period" | "annual" | null,
  "term_days": number | null,
  "start_date": "YYYY-MM-DD" | null,
  "maturity_date": "YYYY-MM-DD" | null,
  "fixed_term_origin": null,
  "missing_fields": Array<"category" | "installment_amount" | "installments_count" | "first_installment_date" | "amount" | "description" | "purchase_selection" | "installments_to_pay" | "fixed_term_return" | "fixed_term_origin">,
  "clarification_message": string | null
}

Reglas estrictas:
1. Fecha local del usuario hoy: ${todayLocal} (zona horaria: ${timezone}). Calculá cualquier fecha relativa ("hoy", "ayer") en formato YYYY-MM-DD respecto a ${todayLocal}.
2. Si NO hay sesión activa y el mensaje es un saludo o frase ambigua sin monto ni intención financiera clara (ej: "hola", "gasté plata", "compré algo"): devolvé status="unrecognized", intent=null.
3. Catálogo de categorías activas del usuario (usá EXCLUSIVAMENTE uno de estos UUID exactos para expense/income/installment_purchase):
${JSON.stringify(categoriesSummary)}
   - Para "income" elegí solo categorías con type="income".
   - Para "expense" o "installment_purchase" elegí solo categorías con type="expense".
   - Si no estás altamente seguro de qué categoría corresponde, devolvé category_id=null, category_confidence="low", incluí "category" en missing_fields.
4. Bolsa de Gustitos ("is_gustito"): poné true cuando el usuario diga explícitamente que fue un gusto/gustito/antojo/capricho. De lo contrario false.
5. Ingreso extra directo a ahorros ("save_to_savings"): cuando intent="income" y el usuario especifique que quiere que vaya directo al ahorro/bóveda, poné true.
6. REGLA CRÍTICA DE NUEVA COMPRA EN CUOTAS ("installment_purchase"):
   - "amount" debe ser SIEMPRE el monto de CADA CUOTA, JAMÁS el precio total ni una división calculada por vos.
   - Si dio el precio total en vez del valor por cuota, dejá amount=null, agregá "installment_amount" en missing_fields y preguntá cuánto paga por cuota.
   - "first_installment_date" (YYYY-MM-DD) es OBLIGATORIA.
7. REGLA DE ADELANTO / PAGO MÚLTIPLE DE CUOTAS ("pay_installments"):
   - Compras en cuotas pendientes del usuario: ${JSON.stringify(pendingPurchasesSummary)}
   - Usalo cuando el usuario diga que pagó o adelantó cuotas de una compra ya existente (ej. "Pagué 2 cuotas de las zapatillas por un total de 65.000", "Adelanté 3 cuotas del monitor", "Pagué las cuotas restantes de zapatillas", "Liquidé todas las cuotas de las zapas").
   - Si identificás con claridad una compra de la lista de compras pendientes, devolvé su UUID exacto en "purchase_id" y el nombre clave del producto (sin artículos ni preposiciones como "de", "la", "las") en "purchase_query".
   - Si el usuario pide pagar "todas las cuotas restantes", "las cuotas que faltan", "el resto de las cuotas" o "liquidar/terminar de pagar" una compra de la lista sin decir un dígito explícito, usá el valor entero de "pending_installments" de esa compra en "installments_to_pay". Si dijo un número explícito (ej. "las 2 cuotas restantes"), usá ese número entero.
   - Dejá "total_paid_amount": null salvo que el usuario informe explícitamente un monto total distinto (NO dividas ni calcules montos).
8. REGLA DE PLAZO FIJO ("fixed_term_deposit"):
   - Usalo cuando el usuario mencione constituir o poner un plazo fijo (ej. "Puse un plazo fijo de 100.000 en Banco Nación a 30 días con 3,5% de rendimiento", "Armé plazo fijo de 200 lucas, recibo 208.000 en 30 días").
   - Extraé "institution" (si la menciona, sino null), "principal_amount" (capital invertido), "expected_return_amount" (solo si indicó el monto exacto a recibir), "yield_percent" (solo el número porcentual si dio tasa/rendimiento), "rate_period" ("annual" si dijo TNA o anual; "period" si es del período/mensual/rendimiento del plazo), "term_days" (cantidad entera de días si la dijo), "start_date" (YYYY-MM-DD o null), "maturity_date" (YYYY-MM-DD solo si dijo fecha exacta).
   - PROHIBIDO calcular rendimientos matemáticamente vos mismo. Dejá el cálculo al servidor.
   - Dejá siempre "fixed_term_origin": null (el usuario confirmará el origen con botones interactivos).
9. Si existe una SESIÓN ACTIVA previa, combiná los datos ya recolectados en draft_json con la nueva respuesta del usuario sin perder los campos previos.`;

  const contextParts: Array<Record<string, unknown>> = [];
  if (activeSession) {
    contextParts.push({
      text: `SESIÓN MULTI-TURNO ACTIVA (pending_step=${activeSession.pending_step}):\nBorrador previo: ${JSON.stringify(activeSession.draft_json)}`,
    });
  }
  if (userText && userText.trim().length > 0) {
    contextParts.push({ text: `Mensaje del usuario: "${userText.trim()}"` });
  }
  if (audioBase64 && audioMimeType) {
    contextParts.push({
      inline_data: {
        mime_type: audioMimeType,
        data: audioBase64,
      },
    });
    if (!userText) {
      contextParts.push({
        text: 'Escuchá el audio del usuario y extraé el JSON financiero siguiendo todas las reglas.',
      });
    }
  }

  const requestBody = JSON.stringify({
    system_instruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: 'user',
        parts: contextParts,
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  const geminiModels = resolveGeminiModels();
  let response: Response | null = null;
  let lastTransientError: TransientAiError | null = null;
  let lastPermanentError: Error | null = null;

  for (let mIdx = 0; mIdx < geminiModels.length && !response; mIdx += 1) {
    const modelName = geminiModels[mIdx];
    const endpoint = buildGeminiEndpoint(modelName);
    const hasFallback = mIdx < geminiModels.length - 1;
    const maxAttempts = mIdx === 0 ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const candidateResponse = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiApiKey,
          },
          body: requestBody,
          signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        });

        if (candidateResponse.ok) {
          response = candidateResponse;
          break;
        }

        const errText = await candidateResponse.text();
        console.warn(
          `Gemini HTTP ${candidateResponse.status} (${modelName}, intento ${attempt}):`,
          errText.slice(0, 400),
        );

        if (isTransientStatusCode(candidateResponse.status)) {
          lastTransientError = new TransientAiError(
            `Gemini API HTTP ${candidateResponse.status} (${modelName}): ${errText}`,
            candidateResponse.status,
          );
          if (attempt < maxAttempts) {
            await delayMs(GEMINI_FAST_RETRY_DELAY_MS);
            continue;
          }
          if (hasFallback) {
            break;
          }
          throw lastTransientError;
        }

        if (candidateResponse.status === 404 && hasFallback) {
          lastPermanentError = new Error(
            `Gemini API HTTP 404 (${modelName}): ${errText}`,
          );
          break;
        }

        throw new Error(
          `Gemini API HTTP ${candidateResponse.status} (${modelName}): ${errText}`,
        );
      } catch (fetchErr) {
        if (fetchErr instanceof TransientAiError) {
          lastTransientError = fetchErr;
          if (hasFallback) {
            break;
          }
          throw fetchErr;
        }

        const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (errMsg.startsWith('Gemini API HTTP ')) {
          throw fetchErr;
        }

        const isTimeout =
          fetchErr instanceof Error &&
          (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError');
        lastTransientError = new TransientAiError(
          isTimeout
            ? `Timeout consultando Gemini (${modelName}) tras ${GEMINI_TIMEOUT_MS} ms`
            : `Error de red con Gemini API (${modelName}): ${errMsg}`,
        );

        console.warn(
          `Error de red/timeout consultando Gemini (${modelName}, intento ${attempt}): ${errMsg}`,
        );
        if (attempt < maxAttempts) {
          await delayMs(GEMINI_FAST_RETRY_DELAY_MS);
          continue;
        }
        if (hasFallback) {
          break;
        }
        throw lastTransientError;
      }
    }
  }

  if (!response) {
    if (lastTransientError) {
      throw lastTransientError;
    }
    if (lastPermanentError) {
      throw lastPermanentError;
    }
    throw new TransientAiError('No se obtuvo respuesta de Gemini API tras reintentos.');
  }

  let result: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  try {
    result = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
  } catch (envelopeErr) {
    console.error('Error leyendo respuesta JSON de Gemini:', envelopeErr);
    throw new Error('Gemini devolvió un envoltorio JSON ilegible.');
  }

  const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini no devolvió contenido JSON.');
  }

  const cleanedJson = rawText
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let rawParsed: Partial<GeminiParsedIntent>;
  try {
    const parsedUnknown = JSON.parse(cleanedJson) as unknown;
    if (
      !parsedUnknown ||
      typeof parsedUnknown !== 'object' ||
      Array.isArray(parsedUnknown)
    ) {
      throw new Error('El JSON devuelto no es un objeto.');
    }
    rawParsed = parsedUnknown as Partial<GeminiParsedIntent>;
  } catch (parseErr) {
    console.error(
      'Error al parsear JSON de Gemini:',
      parseErr,
      'Contenido recibido:',
      cleanedJson.slice(0, 500),
    );
    throw new Error('Gemini devolvió un JSON inválido.');
  }

  const mergedParsed = mergeWithActiveSessionDraft(activeSession, rawParsed);
  const validated = normalizeAndValidateParsedIntent(
    mergedParsed,
    categories,
    todayLocal,
  );

  return resolvePayInstallmentsFromContext(
    validated,
    effectivePendingPurchases,
    userText,
  );
}

const PURCHASE_SEARCH_STOP_WORDS = new Set([
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'lo',
  'en',
  'por',
  'para',
  'con',
  'sin',
  'sobre',
  'una',
  'uno',
  'unos',
  'unas',
  'un',
  'al',
  'me',
  'te',
  'se',
  'le',
  'les',
  'mi',
  'mis',
  'tu',
  'tus',
  'su',
  'sus',
  'que',
  'cuota',
  'cuotas',
  'restante',
  'restantes',
  'pendiente',
  'pendientes',
  'pagar',
  'pague',
  'adelantar',
  'adelante',
  'abonar',
  'abone',
  'liquidar',
  'liquide',
  'terminar',
  'termine',
  'todas',
  'todos',
  'todo',
  'toda',
  'resto',
]);

function extractMeaningfulSearchWords(value: string): string[] {
  return normalizeSearchToken(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !PURCHASE_SEARCH_STOP_WORDS.has(w));
}

function tokenMatches(queryWord: string, targetWord: string): boolean {
  if (targetWord === queryWord) return true;
  if (queryWord.length >= 3 && targetWord.length >= 3) {
    return targetWord.startsWith(queryWord) || queryWord.startsWith(targetWord);
  }
  return false;
}

function resolvePayInstallmentsFromContext(
  parsed: GeminiParsedIntent,
  pendingPurchases: PendingPurchaseCandidate[],
  userText: string | null,
): GeminiParsedIntent {
  if (parsed.intent !== 'pay_installments' || pendingPurchases.length === 0) {
    return parsed;
  }

  let resolvedPurchaseId = parsed.purchase_id;
  if (
    resolvedPurchaseId &&
    !pendingPurchases.some((p) => p.id === resolvedPurchaseId)
  ) {
    resolvedPurchaseId = null;
  }

  if (!resolvedPurchaseId && parsed.purchase_query) {
    const matches = findMatchingPurchases(pendingPurchases, parsed.purchase_query);
    if (matches.length === 1) {
      resolvedPurchaseId = matches[0].id;
    }
  }

  if (!resolvedPurchaseId && userText) {
    const matches = findMatchingPurchases(pendingPurchases, userText);
    if (matches.length === 1) {
      resolvedPurchaseId = matches[0].id;
    }
  }

  let installmentsToPay = parsed.installments_to_pay;
  const matchedPurchase = resolvedPurchaseId
    ? pendingPurchases.find((p) => p.id === resolvedPurchaseId)
    : undefined;

  if (!installmentsToPay && matchedPurchase && userText) {
    const normalizedText = normalizeSearchToken(userText);
    if (
      /\b(restantes?|resto|faltan|todas?|completar|liquidar|terminar)\b/.test(
        normalizedText,
      )
    ) {
      installmentsToPay = matchedPurchase.pendingCount;
    }
  }

  const missingFields = parsed.missing_fields.filter((f) => {
    if (f === 'purchase_selection' && resolvedPurchaseId) return false;
    if (f === 'installments_to_pay' && installmentsToPay !== null) return false;
    return true;
  });

  return {
    ...parsed,
    purchase_id: resolvedPurchaseId,
    installments_to_pay: installmentsToPay,
    missing_fields: missingFields,
    status: missingFields.length === 0 ? 'complete' : 'needs_clarification',
  };
}

async function fetchPendingPurchasesForUser(
  supabaseAdmin: SupabaseAdminLike,
  userId: string,
): Promise<PendingPurchaseCandidate[]> {
  const { data: pendingRows, error: pendingError } = await supabaseAdmin
    .from('monthly_commitments')
    .select(
      'installment_purchase_id, installment_purchase:installment_purchases(id, description, installments_count, installment_amount)',
    )
    .eq('user_id', userId)
    .eq('commitment_type', 'installment')
    .eq('is_paid', false)
    .not('installment_purchase_id', 'is', null);

  if (pendingError) {
    console.error('Error consultando cuotas pendientes:', pendingError);
    throw new Error(
      `No se pudieron consultar las cuotas pendientes: ${pendingError.message ?? 'desconocido'}`,
    );
  }

  const byId = new Map<string, PendingPurchaseCandidate>();
  for (const row of (pendingRows ?? []) as Array<{
    installment_purchase_id: string | null;
    installment_purchase:
      | {
          id: string;
          description: string;
          installments_count: number;
          installment_amount?: number;
        }
      | Array<{
          id: string;
          description: string;
          installments_count: number;
          installment_amount?: number;
        }>
      | null;
  }>) {
    const purchaseRel = Array.isArray(row.installment_purchase)
      ? row.installment_purchase[0]
      : row.installment_purchase;
    const pid = row.installment_purchase_id ?? purchaseRel?.id;
    if (!pid || !purchaseRel) continue;
    const existing = byId.get(pid);
    if (existing) {
      existing.pendingCount += 1;
    } else {
      byId.set(pid, {
        id: pid,
        description: purchaseRel.description,
        installments_count: Number(purchaseRel.installments_count ?? 1),
        installment_amount:
          purchaseRel.installment_amount !== undefined
            ? Number(purchaseRel.installment_amount)
            : undefined,
        pendingCount: 1,
      });
    }
  }

  return Array.from(byId.values());
}

function normalizeSearchToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function findMatchingPurchases(
  candidates: PendingPurchaseCandidate[],
  query: string | null,
): PendingPurchaseCandidate[] {
  if (!query || query.trim().length < 2) return [];
  const words = extractMeaningfulSearchWords(query);
  if (words.length === 0) return [];

  const cleanedQuery = words.join(' ');
  const exact = candidates.filter((c) => {
    const normalizedDesc = normalizeSearchToken(c.description)
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalizedDesc.includes(cleanedQuery);
  });
  if (exact.length > 0) return exact;

  const scored = candidates
    .map((candidate) => {
      const targetWords = extractMeaningfulSearchWords(candidate.description);
      const matchCount = words.filter((qw) =>
        targetWords.some((tw) => tokenMatches(qw, tw)),
      ).length;
      return { candidate, matchCount };
    })
    .filter((item) => item.matchCount > 0);

  if (scored.length === 0) return [];

  const maxScore = Math.max(...scored.map((item) => item.matchCount));
  return scored
    .filter((item) => item.matchCount === maxScore)
    .map((item) => item.candidate);
}

async function upsertConversationSession(
  supabaseAdmin: SupabaseAdminLike,
  params: {
    userId: string;
    chatId: number;
    intent: ParsedIntent;
    pendingStep: PendingStep;
    draftJson: Partial<GeminiParsedIntent>;
  },
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_MINUTES * 60 * 1000,
  ).toISOString();

  const { error: sessionError } = await supabaseAdmin
    .from('telegram_conversation_sessions')
    .upsert(
      {
        user_id: params.userId,
        chat_id: params.chatId,
        intent: params.intent,
        pending_step: params.pendingStep,
        draft_json: params.draftJson,
        expires_at: expiresAt,
      },
      { onConflict: 'chat_id' },
    );

  if (sessionError) {
    console.error('Error guardando telegram_conversation_sessions:', sessionError);
    throw new Error(
      `No se pudo guardar el estado de la conversación: ${sessionError.message ?? 'desconocido'}`,
    );
  }
}

async function deleteConversationSession(
  supabaseAdmin: SupabaseAdminLike,
  chatId: number,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('telegram_conversation_sessions')
    .delete()
    .eq('chat_id', chatId);
  if (error) {
    console.error('Error eliminando telegram_conversation_sessions:', error);
  }
}

async function updateActionLogMessageId(
  supabaseAdmin: SupabaseAdminLike,
  actionLogId: unknown,
  messageId: number,
): Promise<void> {
  if (!actionLogId) return;
  const { error } = await supabaseAdmin
    .from('telegram_action_logs')
    .update({ telegram_message_id: messageId })
    .eq('id', actionLogId);
  if (error) {
    console.error('Error actualizando telegram_message_id en telegram_action_logs:', error);
  }
}

async function handlePayInstallmentsIntent(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  userId: string;
  chatId: number;
  currency: string;
  todayLocal: string;
  categories: ActiveCategory[];
  parsed: GeminiParsedIntent;
  headerPrefix?: string;
}): Promise<void> {
  const {
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    currency,
    todayLocal,
    categories,
    parsed,
    headerPrefix,
  } = params;
  const prefixBlock = headerPrefix ? `${headerPrefix}\n` : '';

  const candidates = await fetchPendingPurchasesForUser(supabaseAdmin, userId);
  if (candidates.length === 0) {
    await deleteConversationSession(supabaseAdmin, chatId);
    await sendTelegramMessage(
      botToken,
      chatId,
      `${prefixBlock}No tenés compras en cuotas con cuotas pendientes en este momento.`,
      headerPrefix ? { parseMode: 'HTML' } : undefined,
    );
    return;
  }

  let resolvedPurchaseId =
    parsed.purchase_id && candidates.some((c) => c.id === parsed.purchase_id)
      ? parsed.purchase_id
      : null;
  if (!resolvedPurchaseId && parsed.purchase_query) {
    const matches = findMatchingPurchases(candidates, parsed.purchase_query);
    if (matches.length === 1) {
      resolvedPurchaseId = matches[0].id;
    }
  }

  if (!resolvedPurchaseId) {
    const matches = parsed.purchase_query
      ? findMatchingPurchases(candidates, parsed.purchase_query)
      : [];
    const displayOptions = matches.length > 1 ? matches : candidates;
    const draftWithMissing: GeminiParsedIntent = {
      ...parsed,
      purchase_id: null,
      missing_fields: Array.from(
        new Set([...parsed.missing_fields, 'purchase_selection']),
      ),
    };

    await upsertConversationSession(supabaseAdmin, {
      userId,
      chatId,
      intent: 'pay_installments',
      pendingStep: 'awaiting_purchase_selection',
      draftJson: draftWithMissing,
    });

    await sendTelegramMessage(
      botToken,
      chatId,
      `${prefixBlock}¿De qué compra querés adelantar cuotas? Elegí una opción:`,
      {
        parseMode: 'HTML',
        replyMarkup: { inline_keyboard: buildPurchaseSelectionButtons(displayOptions) },
      },
    );
    return;
  }

  const chosenPurchase = candidates.find((c) => c.id === resolvedPurchaseId);
  if (!chosenPurchase) {
    await deleteConversationSession(supabaseAdmin, chatId);
    await sendTelegramMessage(
      botToken,
      chatId,
      `${prefixBlock}Esa compra ya no tiene cuotas pendientes o no fue encontrada.`,
      headerPrefix ? { parseMode: 'HTML' } : undefined,
    );
    return;
  }

  if (!parsed.installments_to_pay) {
    const draftWithPurchase: GeminiParsedIntent = {
      ...parsed,
      purchase_id: resolvedPurchaseId,
      missing_fields: ['installments_to_pay'],
    };

    await upsertConversationSession(supabaseAdmin, {
      userId,
      chatId,
      intent: 'pay_installments',
      pendingStep: 'awaiting_installment_count',
      draftJson: draftWithPurchase,
    });

    await sendTelegramMessage(
      botToken,
      chatId,
      `${prefixBlock}Elegiste <b>${escapeHtml(chosenPurchase.description)}</b> (${chosenPurchase.pendingCount} cuota(s) pendiente(s)).\n\n¿Cuántas cuotas querés adelantar?`,
      {
        parseMode: 'HTML',
        replyMarkup: {
          inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancel_session' }]],
        },
      },
    );
    return;
  }

  const currentMonth = normalizeMonthStart(todayLocal);
  await ensureMonthlyPeriodForUser(supabaseAdmin, userId, currentMonth);

  const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
    'advance_installments',
    {
      p_purchase_id: resolvedPurchaseId,
      p_count: parsed.installments_to_pay,
      p_target_month_date: currentMonth,
      p_total_amount: parsed.total_paid_amount ?? null,
      p_source: 'telegram',
      p_actor_user_id: userId,
    },
  );

  if (rpcError || !rpcResult) {
    const msg = rpcError?.message ?? 'No se pudieron adelantar las cuotas.';
    await upsertConversationSession(supabaseAdmin, {
      userId,
      chatId,
      intent: 'pay_installments',
      pendingStep: 'awaiting_installment_count',
      draftJson: {
        ...parsed,
        purchase_id: resolvedPurchaseId,
        installments_to_pay: null,
        missing_fields: ['installments_to_pay'],
      },
    });
    await sendTelegramMessage(
      botToken,
      chatId,
      `${prefixBlock}⚠️ ${escapeHtml(msg)}\n\nIndicame cuántas cuotas querés adelantar (hasta ${chosenPurchase.pendingCount}) o usá /cancelar.`,
      {
        parseMode: 'HTML',
        replyMarkup: {
          inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancel_session' }]],
        },
      },
    );
    return;
  }

  const res = rpcResult as {
    batch_id: string;
    purchase_id: string;
    purchase_description: string;
    category_id: string;
    is_gustito: boolean;
    target_month_date: string;
    installments_count: number;
    total_paid_amount: number;
    installments: Array<{
      installment_number: number;
      total_installments: number;
      amount: number;
    }>;
  };

  const { data: actionLog, error: logError } = await supabaseAdmin
    .from('telegram_action_logs')
    .insert({
      user_id: userId,
      chat_id: chatId,
      action_type: 'pay_installments',
      target_table: 'installment_payment_batches',
      target_id: res.batch_id,
      rollback_payload: res,
    })
    .select('id')
    .single();

  if (logError || !actionLog) {
    console.error('No se pudo guardar telegram_action_logs (pay_installments):', logError);
  }

  await deleteConversationSession(supabaseAdmin, chatId);

  const installmentLabels = (res.installments ?? [])
    .map((inst) => `${inst.installment_number}/${inst.total_installments}`)
    .join(', ');

  const lines: string[] = [];
  if (headerPrefix) lines.push(headerPrefix);
  lines.push(
    `✅ <b>Adelanto de cuotas registrado</b> en <b>${escapeHtml(res.purchase_description)}</b>`,
  );
  lines.push(
    `• Cuotas adelantadas al mes actual: <b>${escapeHtml(installmentLabels || String(res.installments_count))}</b>`,
  );
  lines.push(
    `• Total abonado: <b>${escapeHtml(formatCurrencyARS(Number(res.total_paid_amount), currency))}</b>`,
  );

  const category = categories.find((c) => c.id === res.category_id);
  const { data: catSnap, error: catSnapError } = await supabaseAdmin
    .from('monthly_category_snapshots')
    .select('is_gustito')
    .eq('user_id', userId)
    .eq('month_date', currentMonth)
    .eq('category_id', res.category_id)
    .maybeSingle();

  if (catSnapError) {
    console.error('Error consultando monthly_category_snapshots (pay_installments):', catSnapError);
  }

  const categoryIsGustito = catSnap
    ? Boolean(catSnap.is_gustito)
    : Boolean(category?.is_gustito);
  const affectsGustitos = Boolean(res.is_gustito) || categoryIsGustito;

  let shouldSendRealTimeGustitoAlert = false;
  let gustitosStatusForAlert: Awaited<ReturnType<typeof computeGustitosStatus>> | null =
    null;

  if (affectsGustitos) {
    const gustitosStatus = await computeGustitosStatus(
      supabaseAdmin,
      userId,
      currentMonth,
    );
    if (gustitosStatus.budget > 0) {
      if (gustitosStatus.remaining > 0) {
        lines.push(
          `🍿 Bolsa de Gustitos: te quedan <b>${escapeHtml(formatCurrencyARS(gustitosStatus.remaining, currency))}</b> este mes.`,
        );
      } else {
        lines.push(
          `🔴 Bolsa de Gustitos: saldo restante <b>${escapeHtml(formatCurrencyARS(gustitosStatus.remaining, currency))}</b> (presupuesto agotado/superado).`,
        );
        shouldSendRealTimeGustitoAlert = true;
        gustitosStatusForAlert = gustitosStatus;
      }
    }
  }

  const catLimitStatus = await computeCategoryLimitStatus(
    supabaseAdmin,
    userId,
    currentMonth,
    res.category_id,
  );
  if (
    catLimitStatus.monthlyLimit !== null &&
    catLimitStatus.monthlyLimit > 0 &&
    catLimitStatus.remaining !== null
  ) {
    const prefix =
      catLimitStatus.remaining <= 0
        ? '🔴'
        : (catLimitStatus.usagePercent ?? 0) > 80
          ? '⚠️'
          : '📊';
    lines.push(
      `${prefix} Límite de ${escapeHtml(catLimitStatus.categoryName)}: te quedan <b>${escapeHtml(formatCurrencyARS(catLimitStatus.remaining, currency))}</b> de ${escapeHtml(formatCurrencyARS(catLimitStatus.monthlyLimit, currency))}.`,
    );
  }

  const replyMarkup = actionLog?.id
    ? {
        inline_keyboard: [
          [{ text: '❌ Anular', callback_data: `void:${actionLog.id as string}` }],
        ],
      }
    : undefined;

  const sent = await sendTelegramMessage(botToken, chatId, lines.join('\n'), {
    parseMode: 'HTML',
    replyMarkup,
  });

  if (sent.message_id && actionLog?.id) {
    await updateActionLogMessageId(supabaseAdmin, actionLog.id, sent.message_id);
  }

  if (shouldSendRealTimeGustitoAlert && gustitosStatusForAlert) {
    try {
      await sendTelegramMessage(
        botToken,
        chatId,
        `🚨 <b>Alerta inmediata — Bolsa de Gustitos</b>\n\nCon este adelanto de cuotas tu saldo restante de Gustitos está en <b>${escapeHtml(
          formatCurrencyARS(gustitosStatusForAlert.remaining, currency),
        )}</b> (Presupuesto: ${escapeHtml(
          formatCurrencyARS(gustitosStatusForAlert.budget, currency),
        )} | Gastado: ${escapeHtml(
          formatCurrencyARS(gustitosStatusForAlert.spent, currency),
        )}).`,
        { parseMode: 'HTML' },
      );
    } catch (alertErr) {
      console.error('Error enviando alerta inmediata de Gustitos (pay_installments):', alertErr);
    }
  }
}

async function handleFixedTermDepositIntent(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  userId: string;
  chatId: number;
  currency: string;
  todayLocal: string;
  parsed: GeminiParsedIntent;
  headerPrefix?: string;
}): Promise<void> {
  const {
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    currency,
    todayLocal,
    parsed,
    headerPrefix,
  } = params;
  const prefixBlock = headerPrefix ? `${headerPrefix}\n` : '';

  const principal = parsed.principal_amount;
  const expectedReturn = parsed.expected_return_amount;
  const startDate = parsed.start_date ?? todayLocal;
  const maturityDate = parsed.maturity_date;

  if (!principal || !expectedReturn || !maturityDate) {
    await upsertConversationSession(supabaseAdmin, {
      userId,
      chatId,
      intent: 'fixed_term_deposit',
      pendingStep: 'awaiting_fixed_term_return',
      draftJson: parsed,
    });

    const question =
      parsed.clarification_message?.trim() ||
      'Indicame el capital invertido, el plazo en días (o fecha de vencimiento) y el monto a recibir o % de rendimiento.';

    await sendTelegramMessage(botToken, chatId, `${prefixBlock}${escapeHtml(question)}`, {
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancel_session' }]],
      },
    });
    return;
  }

  if (!parsed.fixed_term_origin) {
    await upsertConversationSession(supabaseAdmin, {
      userId,
      chatId,
      intent: 'fixed_term_deposit',
      pendingStep: 'awaiting_fixed_term_origin',
      draftJson: parsed,
    });

    const institutionLabel = parsed.institution || 'Plazo Fijo';
    const interest = roundCurrency(expectedReturn - principal);

    const summaryText = `${prefixBlock}🏦 <b>Plazo Fijo preparado: ${escapeHtml(institutionLabel)}</b>\n\n• Capital: <b>${escapeHtml(
      formatCurrencyARS(principal, currency),
    )}</b>\n• A recibir al vencer: <b>${escapeHtml(
      formatCurrencyARS(expectedReturn, currency),
    )}</b> (+${escapeHtml(formatCurrencyARS(interest, currency))})\n• Inicio: <b>${escapeHtml(
      startDate,
    )}</b> · Vence: <b>${escapeHtml(
      maturityDate,
    )}</b>\n\n¿De dónde sale el capital invertido?`;

    await sendTelegramMessage(botToken, chatId, summaryText, {
      parseMode: 'HTML',
      replyMarkup: { inline_keyboard: buildFixedTermOriginButtons() },
    });
    return;
  }

  const startMonth = normalizeMonthStart(startDate);
  const currentMonth = normalizeMonthStart(todayLocal);
  if (startMonth <= currentMonth) {
    await ensureMonthlyPeriodForUser(supabaseAdmin, userId, startMonth);
  }

  const { data: createdFt, error: rpcError } = await supabaseAdmin.rpc(
    'create_fixed_term_deposit',
    {
      p_institution: parsed.institution || 'Plazo Fijo',
      p_principal_amount: principal,
      p_expected_return_amount: expectedReturn,
      p_start_date: startDate,
      p_maturity_date: maturityDate,
      p_origin: parsed.fixed_term_origin,
      p_source: 'telegram',
      p_notes: null,
      p_actor_user_id: userId,
    },
  );

  if (rpcError || !createdFt) {
    const errMsg = rpcError?.message ?? 'No se pudo constituir el plazo fijo.';
    await upsertConversationSession(supabaseAdmin, {
      userId,
      chatId,
      intent: 'fixed_term_deposit',
      pendingStep: 'awaiting_fixed_term_origin',
      draftJson: {
        ...parsed,
        fixed_term_origin: null,
      },
    });

    await sendTelegramMessage(
      botToken,
      chatId,
      `${prefixBlock}⚠️ ${escapeHtml(errMsg)}\n\nPodés elegir otro origen para el capital:`,
      {
        parseMode: 'HTML',
        replyMarkup: { inline_keyboard: buildFixedTermOriginButtons() },
      },
    );
    return;
  }

  const ft = createdFt as {
    id: string;
    institution: string;
    principal_amount: number;
    expected_return_amount: number;
    start_date: string;
    maturity_date: string;
    origin: 'monthly_available' | 'savings_fund';
  };

  const { data: actionLog, error: logError } = await supabaseAdmin
    .from('telegram_action_logs')
    .insert({
      user_id: userId,
      chat_id: chatId,
      action_type: 'fixed_term_deposit',
      target_table: 'fixed_term_deposits',
      target_id: ft.id,
      rollback_payload: ft,
    })
    .select('id')
    .single();

  if (logError || !actionLog) {
    console.error('No se pudo guardar telegram_action_logs (fixed_term_deposit):', logError);
  }

  await deleteConversationSession(supabaseAdmin, chatId);

  const originText =
    ft.origin === 'savings_fund'
      ? 'Bóveda de Ahorros (capital inmovilizado)'
      : 'Disponible Real del Mes';

  const confirmMsg = [
    headerPrefix ? headerPrefix : '',
    `✅ <b>Plazo Fijo registrado: ${escapeHtml(ft.institution)}</b>`,
    `• Capital invertido: <b>${escapeHtml(formatCurrencyARS(Number(ft.principal_amount), currency))}</b>`,
    `• Retorno esperado: <b>${escapeHtml(formatCurrencyARS(Number(ft.expected_return_amount), currency))}</b>`,
    `• Vencimiento: <b>${escapeHtml(ft.maturity_date)}</b>`,
    `• Origen: ${escapeHtml(originText)}`,
    '<i>Te avisaremos por acá 3 días antes y el día del vencimiento.</i>',
  ]
    .filter(Boolean)
    .join('\n');

  const replyMarkup = actionLog?.id
    ? {
        inline_keyboard: [
          [{ text: '❌ Anular', callback_data: `void:${actionLog.id as string}` }],
        ],
      }
    : undefined;

  const sent = await sendTelegramMessage(botToken, chatId, confirmMsg, {
    parseMode: 'HTML',
    replyMarkup,
  });

  if (sent.message_id && actionLog?.id) {
    await updateActionLogMessageId(supabaseAdmin, actionLog.id, sent.message_id);
  }
}

async function persistCompleteIntent(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  userId: string;
  chatId: number;
  currency: string;
  todayLocal: string;
  categories: ActiveCategory[];
  parsed: GeminiParsedIntent;
  headerPrefix?: string;
}): Promise<void> {
  const {
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    currency,
    todayLocal,
    categories,
    parsed,
    headerPrefix,
  } = params;

  const intent = parsed.intent!;

  if (intent === 'pay_installments') {
    await handlePayInstallmentsIntent(params);
    return;
  }

  if (intent === 'fixed_term_deposit') {
    await handleFixedTermDepositIntent(params);
    return;
  }

  const amount = roundCurrency(parsed.amount!);
  const description = (parsed.description ?? 'Movimiento').trim();
  const categoryId = parsed.category_id!;
  const category = categories.find((c) => c.id === categoryId);
  const categoryName = category?.name ?? 'Categoría';

  let actionType: ParsedIntent = intent;
  let targetTable: 'transactions' | 'installment_purchases' = 'transactions';
  let targetId = '';
  const currentMonth = normalizeMonthStart(todayLocal);
  let affectedMonth = currentMonth;
  let isGustitoApplied = false;

  if (intent === 'expense' || intent === 'income') {
    const txDate = parsed.transaction_date ?? todayLocal;
    affectedMonth = normalizeMonthStart(txDate);
    if (affectedMonth <= currentMonth) {
      await ensureMonthlyPeriodForUser(supabaseAdmin, userId, affectedMonth);
    }

    const saveToSavings =
      intent === 'income' ? Boolean(parsed.save_to_savings) : false;

    const { data: txInserted, error: txError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        category_id: categoryId,
        type: intent,
        amount,
        transaction_date: txDate,
        description,
        notes: null,
        source: 'telegram',
        is_gustito: intent === 'expense' ? Boolean(parsed.is_gustito) : false,
        save_to_savings: saveToSavings,
      })
      .select('id, is_gustito, save_to_savings')
      .single();

    if (txError || !txInserted) {
      throw new Error(`Error al insertar transacción: ${txError?.message ?? 'desconocido'}`);
    }

    if (saveToSavings) {
      const { error: savingsError } = await supabaseAdmin
        .from('savings_entries')
        .insert({
          user_id: userId,
          month_date: affectedMonth,
          entry_type: 'deposit',
          amount,
          entry_date: txDate,
          description: `Ingreso directo a ahorro: ${description}`.slice(0, 150),
          notes:
            'Apartado automáticamente desde ingreso extra registrado en Telegram.',
          source_transaction_id: txInserted.id,
          source_type: 'direct_income',
        });

      if (savingsError) {
        const { error: rollbackTxError } = await supabaseAdmin
          .from('transactions')
          .delete()
          .eq('id', txInserted.id);
        if (rollbackTxError) {
          console.error('Error al revertir transacción tras fallo de savings_entries:', rollbackTxError);
        }
        throw new Error(
          `Error al registrar el ingreso en Bóveda de Ahorros: ${savingsError.message}`,
        );
      }
    }

    targetTable = 'transactions';
    targetId = txInserted.id as string;
    isGustitoApplied = intent === 'expense' && Boolean(txInserted.is_gustito);
  } else {
    const installmentsCount = parsed.installments_count!;
    const firstInstallmentDate = parsed.first_installment_date!;
    const purchaseDate =
      parsed.transaction_date && isIsoDate(parsed.transaction_date)
        ? parsed.transaction_date
        : todayLocal;
    const totalAmount = roundCurrency(amount * installmentsCount);
    affectedMonth = normalizeMonthStart(firstInstallmentDate);

    if (affectedMonth <= currentMonth) {
      await ensureMonthlyPeriodForUser(supabaseAdmin, userId, affectedMonth);
    }

    const { data: purchaseInserted, error: purchaseError } = await supabaseAdmin
      .from('installment_purchases')
      .insert({
        user_id: userId,
        category_id: categoryId,
        description,
        installment_amount: amount,
        installments_count: installmentsCount,
        total_amount: totalAmount,
        purchase_date: purchaseDate,
        first_installment_date: firstInstallmentDate,
        notes: null,
        is_gustito: Boolean(parsed.is_gustito),
        source: 'telegram',
      })
      .select('id, is_gustito')
      .single();

    if (purchaseError || !purchaseInserted) {
      throw new Error(
        `Error al insertar compra en cuotas: ${purchaseError?.message ?? 'desconocido'}`,
      );
    }

    const commitmentsRows = Array.from({ length: installmentsCount }, (_, idx) => {
      const installmentNumber = idx + 1;
      const dueDate = addMonthsClamped(firstInstallmentDate, idx);
      return {
        user_id: userId,
        month_date: normalizeMonthStart(dueDate),
        category_id: categoryId,
        commitment_type: 'installment',
        installment_purchase_id: purchaseInserted.id,
        name: `${description} (${installmentNumber}/${installmentsCount})`,
        amount,
        due_date: dueDate,
        installment_number: installmentNumber,
        total_installments: installmentsCount,
        is_paid: false,
        notes: null,
      };
    });

    const { error: commInsertError } = await supabaseAdmin
      .from('monthly_commitments')
      .insert(commitmentsRows);

    if (commInsertError) {
      const { error: rollbackPurchaseError } = await supabaseAdmin
        .from('installment_purchases')
        .delete()
        .eq('id', purchaseInserted.id);
      if (rollbackPurchaseError) {
        console.error('Error al revertir compra en cuotas tras fallo de monthly_commitments:', rollbackPurchaseError);
      }
      throw new Error(`Error al generar cuotas mensuales: ${commInsertError.message}`);
    }

    actionType = 'installment_purchase';
    targetTable = 'installment_purchases';
    targetId = purchaseInserted.id as string;
    isGustitoApplied = Boolean(purchaseInserted.is_gustito);
  }

  const { data: actionLog, error: logError } = await supabaseAdmin
    .from('telegram_action_logs')
    .insert({
      user_id: userId,
      chat_id: chatId,
      action_type: actionType,
      target_table: targetTable,
      target_id: targetId,
    })
    .select('id')
    .single();

  if (logError || !actionLog) {
    console.error('No se pudo guardar telegram_action_logs:', logError);
  }

  await deleteConversationSession(supabaseAdmin, chatId);

  const { data: catSnap, error: catSnapError } = await supabaseAdmin
    .from('monthly_category_snapshots')
    .select('is_gustito')
    .eq('user_id', userId)
    .eq('month_date', affectedMonth)
    .eq('category_id', categoryId)
    .maybeSingle();

  if (catSnapError) {
    console.error('Error consultando monthly_category_snapshots (persistCompleteIntent):', catSnapError);
  }

  const categoryIsGustito = catSnap
    ? Boolean(catSnap.is_gustito)
    : Boolean(category?.is_gustito);
  const affectsGustitos =
    intent !== 'income' && (isGustitoApplied || categoryIsGustito);

  const lines: string[] = [];
  if (headerPrefix) {
    lines.push(headerPrefix);
  }
  if (intent === 'income') {
    lines.push(
      `✅ Ingreso extra registrado: <b>${escapeHtml(
        formatCurrencyARS(amount, currency),
      )}</b> en <b>${escapeHtml(categoryName)}</b> (${escapeHtml(description)}).`,
    );
    if (parsed.save_to_savings) {
      lines.push(
        '🏦 <b>Enviado directamente a tu Bóveda de Ahorros</b> (apartado del Disponible Real del mes).',
      );
    }
  } else if (intent === 'expense') {
    lines.push(
      `✅ Gasto registrado: <b>${escapeHtml(
        formatCurrencyARS(amount, currency),
      )}</b> en <b>${escapeHtml(categoryName)}</b> (${escapeHtml(description)}).`,
    );
  } else {
    const count = parsed.installments_count!;
    const total = roundCurrency(amount * count);
    lines.push(
      `✅ Compra en cuotas registrada: <b>${count} cuotas de ${escapeHtml(
        formatCurrencyARS(amount, currency),
      )}</b> (Total: ${escapeHtml(formatCurrencyARS(total, currency))}) en <b>${escapeHtml(
        categoryName,
      )}</b> (${escapeHtml(description)}).`,
    );
    lines.push(
      `📅 1.ª cuota: <b>${escapeHtml(parsed.first_installment_date!)}</b>`,
    );
  }

  let shouldSendRealTimeGustitoAlert = false;
  let gustitosStatusForAlert: Awaited<ReturnType<typeof computeGustitosStatus>> | null =
    null;

  if (affectsGustitos) {
    const gustitosStatus = await computeGustitosStatus(
      supabaseAdmin,
      userId,
      affectedMonth,
    );
    if (gustitosStatus.budget > 0) {
      if (gustitosStatus.remaining > 0) {
        lines.push(
          `🍿 Bolsa de Gustitos: te quedan <b>${escapeHtml(
            formatCurrencyARS(gustitosStatus.remaining, currency),
          )}</b> disponibles este mes.`,
        );
      } else {
        lines.push(
          `🔴 Bolsa de Gustitos: saldo restante <b>${escapeHtml(
            formatCurrencyARS(gustitosStatus.remaining, currency),
          )}</b> (presupuesto agotado/superado).`,
        );
        shouldSendRealTimeGustitoAlert = true;
        gustitosStatusForAlert = gustitosStatus;
      }
    }
  }

  if (intent !== 'income') {
    const catLimitStatus = await computeCategoryLimitStatus(
      supabaseAdmin,
      userId,
      affectedMonth,
      categoryId,
    );
    if (
      catLimitStatus.monthlyLimit !== null &&
      catLimitStatus.monthlyLimit > 0 &&
      catLimitStatus.remaining !== null
    ) {
      const prefix =
        catLimitStatus.remaining <= 0
          ? '🔴'
          : (catLimitStatus.usagePercent ?? 0) > 80
            ? '⚠️'
            : '📊';
      lines.push(
        `${prefix} Límite de ${escapeHtml(catLimitStatus.categoryName)}: te quedan <b>${escapeHtml(
          formatCurrencyARS(catLimitStatus.remaining, currency),
        )}</b> de ${escapeHtml(formatCurrencyARS(catLimitStatus.monthlyLimit, currency))}.`,
      );
    }
  }

  const replyMarkup = actionLog?.id
    ? {
        inline_keyboard: [
          [{ text: '❌ Anular', callback_data: `void:${actionLog.id as string}` }],
        ],
      }
    : undefined;

  const sent = await sendTelegramMessage(botToken, chatId, lines.join('\n'), {
    parseMode: 'HTML',
    replyMarkup,
  });

  if (sent.message_id && actionLog?.id) {
    await updateActionLogMessageId(supabaseAdmin, actionLog.id, sent.message_id);
  }

  if (shouldSendRealTimeGustitoAlert && gustitosStatusForAlert) {
    try {
      await sendTelegramMessage(
        botToken,
        chatId,
        `🚨 <b>Alerta inmediata — Bolsa de Gustitos</b>\n\nCon este movimiento tu saldo restante de Gustitos está en <b>${escapeHtml(
          formatCurrencyARS(gustitosStatusForAlert.remaining, currency),
        )}</b> (Presupuesto: ${escapeHtml(
          formatCurrencyARS(gustitosStatusForAlert.budget, currency),
        )} | Gastado: ${escapeHtml(
          formatCurrencyARS(gustitosStatusForAlert.spent, currency),
        )}).`,
        { parseMode: 'HTML' },
      );
    } catch (alertErr) {
      console.error('Error enviando alerta inmediata de Gustitos (persistCompleteIntent):', alertErr);
    }
  }
}

async function promptForClarification(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  userId: string;
  chatId: number;
  categories: ActiveCategory[];
  parsed: GeminiParsedIntent;
  headerPrefix?: string;
}): Promise<void> {
  const {
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    categories,
    parsed,
    headerPrefix,
  } = params;
  const intent = parsed.intent ?? 'expense';
  const pendingStep = resolvePendingStep(intent, parsed.missing_fields);

  await upsertConversationSession(supabaseAdmin, {
    userId,
    chatId,
    intent,
    pendingStep,
    draftJson: parsed,
  });

  const prefixBlock = headerPrefix ? `${headerPrefix}\n` : '';

  if (pendingStep === 'awaiting_category') {
    const expectedType = intent === 'income' ? 'income' : 'expense';
    const matchingCategories = categories.filter((c) => c.type === expectedType);
    const amountStr = parsed.amount ? formatCurrencyARS(parsed.amount) : '';
    const descStr = parsed.description ? ` (${escapeHtml(parsed.description)})` : '';

    const messageText = `${prefixBlock}No estoy seguro a qué categoría pertenece${
      amountStr ? ` <b>${escapeHtml(amountStr)}</b>` : ''
    }${descStr}. Elegí una de la lista o respondé con el nombre:`;

    await sendTelegramMessage(botToken, chatId, messageText, {
      parseMode: 'HTML',
      replyMarkup: { inline_keyboard: buildCategoryButtons(matchingCategories) },
    });
    return;
  }

  const defaultQuestion =
    pendingStep === 'awaiting_first_installment_date'
      ? '¿En qué fecha vence o impacta la primera cuota? (ej. 10/12/2026)'
      : pendingStep === 'awaiting_installment_details'
        ? '¿Cuánto vas a pagar en cada cuota y en qué fecha vence la primera?'
        : pendingStep === 'awaiting_amount'
          ? '¿Cuál fue el monto exacto?'
          : '¿Qué descripción querés guardar para este movimiento?';

  const question = parsed.clarification_message?.trim() || defaultQuestion;

  await sendTelegramMessage(botToken, chatId, `${prefixBlock}${escapeHtml(question)}`, {
    parseMode: 'HTML',
    replyMarkup: {
      inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancel_session' }]],
    },
  });
}

async function dispatchParsedIntent(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  userId: string;
  chatId: number;
  currency: string;
  todayLocal: string;
  categories: ActiveCategory[];
  parsed: GeminiParsedIntent;
  headerPrefix?: string;
}): Promise<void> {
  const {
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    currency,
    todayLocal,
    categories,
    parsed,
    headerPrefix,
  } = params;

  const prefixBlock = headerPrefix ? `${headerPrefix}\n` : '';

  if (parsed.status === 'unrecognized') {
    await sendTelegramMessage(
      botToken,
      chatId,
      `${prefixBlock}No pude identificar el monto o tipo de movimiento. Enviame los datos completos por texto o audio.\n\n<b>Ejemplos válidos:</b>\n• <i>Gasté 15.000 en delivery, me di un gustito hoy</i>\n• <i>Cobré 40.000 de un diseño freelance y mandalo directo a ahorros</i>\n• <i>Compré auriculares en 3 cuotas de 25.000, primera cuota el 10/12/2026</i>\n• <i>Pagué 2 cuotas de las zapatillas por 55.000</i>\n• <i>Puse un plazo fijo de 100.000 a 30 días con 3,5% de rendimiento</i>`,
      { parseMode: 'HTML' },
    );
    return;
  }

  // Los flujos multi-turno nuevos resuelven su propia consulta a BD y botones inline
  if (parsed.intent === 'pay_installments') {
    await handlePayInstallmentsIntent({
      supabaseAdmin,
      botToken,
      userId,
      chatId,
      currency,
      todayLocal,
      categories,
      parsed,
      headerPrefix,
    });
    return;
  }

  if (parsed.intent === 'fixed_term_deposit') {
    await handleFixedTermDepositIntent({
      supabaseAdmin,
      botToken,
      userId,
      chatId,
      currency,
      todayLocal,
      parsed,
      headerPrefix,
    });
    return;
  }

  if (parsed.status === 'needs_clarification') {
    await promptForClarification({
      supabaseAdmin,
      botToken,
      userId,
      chatId,
      categories,
      parsed,
      headerPrefix,
    });
    return;
  }

  await persistCompleteIntent({
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    currency,
    todayLocal,
    categories,
    parsed,
    headerPrefix,
  });
}

// ----------------------------------------------------------------------------
// Módulo: supabase/functions/telegram-webhook/index.ts
// ----------------------------------------------------------------------------
/**
 * Supabase Edge Function (Deno): telegram-webhook
 *
 * Arquitectura y decisiones técnicas:
 * - Autenticación obligatoria del webhook: validamos `X-Telegram-Bot-Api-Secret-Token`
 *   con comparación en tiempo constante (`timingSafeEqualStr`) antes de leer o mutar datos.
 * - Fast-ack con `EdgeRuntime.waitUntil` y deduplicación atómica segura: insertamos
 *   `update.update_id` en `telegram_processed_updates` al aceptar el update y devolvemos
 *   `200 OK` inmediato a Telegram para evitar timeouts/reintentos mientras descarga audio
 *   o responde Gemini; si ocurre un error sin poder notificar al usuario, liberamos el
 *   lock de `update_id` para no silenciar futuros reintentos.
 * - Verificación estricta de `.error` en todas las consultas DB y notificación
 *   garantizada al usuario ante cualquier falla (incluyendo fallback a texto plano).
 * - Parseo HTML seguro en mensajes al bot: escapamos caracteres especiales HTML en
 *   descripciones y nombres de categorías para evitar que un guion bajo (`_`) o asterisco
 *   (`*`) del usuario haga fallar `sendMessage` de Telegram.
 * - Degradación elegante y cola persistente ante saturación de IA (`503`):
 *   si Gemini falla tras 1 reintento rápido con un error transitorio (`TransientAiError`),
 *   guardamos los datos recolectados en `telegram_pending_requests` y avisamos al usuario;
 *   el worker `process-telegram-queue` completa la carga automáticamente al restablecerse.
 * - Anulación atómica vía RPC (`cancel_fixed_term_deposit` / `revert_installment_payment_batch`):
 *   evitamos `DELETE` directo sobre tablas contables endurecidas por RLS para garantizar
 *   lock transaccional (`pg_advisory_xact_lock`) y validación de estado `active`.
 */

const MAX_AUDIO_DURATION_SECONDS = 60;
const MAX_AUDIO_FILE_BYTES = 5 * 1024 * 1024;
const VOID_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUEUE_INITIAL_RETRY_MS = 60 * 1000;
const QUEUE_TTL_MS = 2 * 60 * 60 * 1000;

interface TelegramAudioLike {
  file_id: string;
  duration?: number;
  file_size?: number;
  mime_type?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    caption?: string;
    voice?: TelegramAudioLike;
    audio?: TelegramAudioLike;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
}

function jsonOk(payload: Record<string, unknown> = { ok: true }): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sendMessageChecked(
  botToken: string,
  chatId: number | string,
  text: string,
  options: TelegramSendOptions = {},
): Promise<boolean> {
  try {
    await sendTelegramMessage(botToken, chatId, text, options);
    return true;
  } catch (err) {
    console.error('Error en sendTelegramMessage:', {
      chatId,
      preview: text.slice(0, 80),
      error: err,
    });
    return false;
  }
}

async function answerCallbackSafely(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<boolean> {
  try {
    await answerCallbackQuery(botToken, callbackQueryId, text, showAlert);
    return true;
  } catch (err) {
    console.error('Error en answerCallbackQuery:', err);
    return false;
  }
}

async function releaseProcessedUpdateLock(
  supabaseAdmin: SupabaseAdminLike,
  updateId: number,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('telegram_processed_updates')
    .delete()
    .eq('update_id', updateId);
  if (error) {
    console.error('Error al liberar update_id en telegram_processed_updates:', {
      updateId,
      error,
    });
  }
}

async function markActionLogVoided(
  supabaseAdmin: SupabaseAdminLike,
  logId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('telegram_action_logs')
    .update({ voided_at: new Date().toISOString() })
    .eq('id', logId);
  if (error) {
    console.error('Error al marcar telegram_action_logs como anulado:', {
      logId,
      error,
    });
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');

  if (
    !supabaseUrl ||
    !supabaseServiceRoleKey ||
    !botToken ||
    !webhookSecret ||
    !geminiApiKey
  ) {
    console.error('Faltan variables de entorno requeridas en telegram-webhook.');
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 1. Validación obligatoria de firma del Webhook de Telegram
  const incomingSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!incomingSecret || !timingSafeEqualStr(incomingSecret, webhookSecret)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!update || typeof update.update_id !== 'number') {
    return jsonOk({ ok: true, ignored: true });
  }

  if (!update.callback_query && !update.message) {
    return jsonOk({ ok: true, ignored: true });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const supabaseAdminLike = supabaseAdmin as unknown as SupabaseAdminLike;

  // 2. Deduplicación atómica de update_id
  const { error: dedupError } = await supabaseAdmin
    .from('telegram_processed_updates')
    .insert({ update_id: update.update_id });

  if (dedupError) {
    if (dedupError.code === '23505') {
      return jsonOk({ ok: true, deduplicated: true });
    }
    console.error('Error al registrar update_id:', dedupError);
    return new Response(JSON.stringify({ error: 'Database error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const workPromise = processTelegramUpdate({
    supabaseAdmin: supabaseAdminLike,
    botToken,
    geminiApiKey,
    update,
  });

  const edgeRuntime = (
    globalThis as {
      EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
    }
  ).EdgeRuntime;

  if (edgeRuntime && typeof edgeRuntime.waitUntil === 'function') {
    edgeRuntime.waitUntil(workPromise);
    return jsonOk({ ok: true, accepted: true });
  }

  const processedCleanly = await workPromise;
  return processedCleanly ? jsonOk() : jsonOk({ ok: true, handled_error: true });
});

async function processTelegramUpdate(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  geminiApiKey: string;
  update: TelegramUpdate;
}): Promise<boolean> {
  const { supabaseAdmin, botToken, geminiApiKey, update } = params;

  if (update.callback_query) {
    const ok = await processCallbackQuery(supabaseAdmin, botToken, update.callback_query);
    if (!ok) {
      await releaseProcessedUpdateLock(supabaseAdmin, update.update_id);
    }
    return ok;
  }

  if (update.message) {
    const ok = await processIncomingMessage(
      supabaseAdmin,
      botToken,
      geminiApiKey,
      update.message,
    );
    if (!ok) {
      await releaseProcessedUpdateLock(supabaseAdmin, update.update_id);
    }
    return ok;
  }

  return true;
}

async function processCallbackQuery(
  supabaseAdmin: SupabaseAdminLike,
  botToken: string,
  cb: NonNullable<TelegramUpdate['callback_query']>,
): Promise<boolean> {
  const cbId = cb.id;
  const data = cb.data ?? '';
  const chatId = cb.message?.chat?.id ?? cb.from.id;
  const messageId = cb.message?.message_id;
  const originalText = cb.message?.text ?? '';
  let callbackAnswered = false;

  const replyCallback = async (
    text?: string,
    showAlert = false,
  ): Promise<boolean> => {
    const ok = await answerCallbackSafely(botToken, cbId, text, showAlert);
    if (ok) callbackAnswered = true;
    return ok;
  };

  try {
    if (data.startsWith('void:')) {
      const logId = data.slice('void:'.length).trim();
      const { data: log, error: logFetchError } = await supabaseAdmin
        .from('telegram_action_logs')
        .select('*')
        .eq('id', logId)
        .eq('chat_id', chatId)
        .maybeSingle();

      if (logFetchError) {
        console.error('Error al consultar telegram_action_logs:', logFetchError);
        await replyCallback('No se pudo consultar el registro. Intentá nuevamente.', true);
        return true;
      }

      if (!log) {
        await replyCallback('Registro no encontrado.');
        return true;
      }

      const { data: activeLink, error: linkCheckError } = await supabaseAdmin
        .from('telegram_links')
        .select('user_id')
        .eq('user_id', log.user_id)
        .eq('telegram_chat_id', chatId)
        .maybeSingle();

      if (linkCheckError) {
        console.error('Error al verificar vinculación en void:', linkCheckError);
        await replyCallback('Error al verificar tu cuenta. Intentá nuevamente.', true);
        return true;
      }

      if (!activeLink) {
        await replyCallback(
          'Este chat ya no está vinculado a la cuenta. Anulá el registro desde la app web.',
          true,
        );
        return true;
      }

      if (log.voided_at !== null) {
        await replyCallback('Este registro ya fue anulado.');
        if (messageId) {
          const updatedText = originalText.includes('Anulado')
            ? originalText
            : `${originalText}\n\n❌ Anulado`;
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            escapeHtml(updatedText),
            { parseMode: 'HTML' },
          );
        }
        return true;
      }

      const ageMs = Date.now() - new Date(log.created_at as string).getTime();
      if (ageMs > VOID_WINDOW_MS) {
        await replyCallback(
          'El botón Anular solo es válido por 24 horas. Podés eliminarlo desde la app web.',
          true,
        );
        if (messageId) {
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            `${escapeHtml(originalText)}\n\n⏰ <i>Ventana de anulación (24 h) expirada.</i>`,
            { parseMode: 'HTML' },
          );
        }
        return true;
      }

      if (log.target_table === 'installment_payment_batches') {
        const { data: revertResult, error: revertError } = await supabaseAdmin.rpc(
          'revert_installment_payment_batch',
          {
            p_batch_id: log.target_id,
            p_actor_user_id: log.user_id,
          },
        );

        if (revertError) {
          console.error('Error en revert_installment_payment_batch:', revertError);
          await replyCallback(
            'No se pudo revertir el adelanto de cuotas. Intentá desde la app web.',
            true,
          );
          return true;
        }

        await markActionLogVoided(supabaseAdmin, log.id as string);

        const typedRevert = (revertResult ?? {}) as {
          reverted?: boolean;
          reason?: string;
          restored_count?: number;
        };

        const suffix = typedRevert.reverted
          ? `❌ Adelanto anulado (${typedRevert.restored_count ?? 0} cuota(s) devuelta(s) a pendiente).`
          : typedRevert.reason === 'already_reverted'
            ? '❌ Anulado (este lote ya había sido revertido desde la web).'
            : '❌ Anulado (el lote ya no existía en la base de datos).';

        if (messageId) {
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            `${escapeHtml(originalText)}\n\n<b>${escapeHtml(suffix)}</b>`,
            { parseMode: 'HTML' },
          );
        }

        await replyCallback(suffix);
        return true;
      }

      if (log.target_table === 'fixed_term_deposits') {
        const { data: cancelResult, error: ftCancelError } = await supabaseAdmin.rpc(
          'cancel_fixed_term_deposit',
          {
            p_fixed_term_id: log.target_id,
            p_actor_user_id: log.user_id,
          },
        );

        if (ftCancelError) {
          console.error('Error en cancel_fixed_term_deposit:', ftCancelError);
          await replyCallback(
            'No se pudo anular el plazo fijo. Intentá desde la web.',
            true,
          );
          return true;
        }

        const typedCancel = (cancelResult ?? {}) as {
          cancelled?: boolean;
          reason?: string;
          status?: string;
        };

        if (!typedCancel.cancelled && typedCancel.reason === 'not_active') {
          await replyCallback(
            'Este plazo fijo ya fue acreditado o cerrado en la web y no puede anularse desde Telegram.',
            true,
          );
          return true;
        }

        await markActionLogVoided(supabaseAdmin, log.id as string);

        const suffix = typedCancel.cancelled
          ? '❌ Plazo fijo anulado correctamente.'
          : '❌ Anulado (el plazo fijo ya había sido eliminado desde la web).';

        if (messageId) {
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            `${escapeHtml(originalText)}\n\n<b>${escapeHtml(suffix)}</b>`,
            { parseMode: 'HTML' },
          );
        }

        await replyCallback(suffix);
        return true;
      }

      if (log.target_table === 'installment_purchases') {
        const { count: paidCount, error: paidCountError } = await supabaseAdmin
          .from('monthly_commitments')
          .select('id', { count: 'exact', head: true })
          .eq('installment_purchase_id', log.target_id)
          .eq('is_paid', true);

        if (paidCountError) {
          console.error('Error al verificar cuotas pagadas antes de anular:', paidCountError);
          await replyCallback(
            'No se pudo verificar el estado de las cuotas. Intentá nuevamente.',
            true,
          );
          return true;
        }

        if ((paidCount ?? 0) > 0) {
          await replyCallback(
            'Esta compra en cuotas ya tiene pagos marcados en la web. Para anularla hacelo desde Compromisos en la app.',
            true,
          );
          return true;
        }
      }

      const targetTable =
        log.target_table === 'installment_purchases'
          ? 'installment_purchases'
          : 'transactions';

      if (targetTable === 'transactions') {
        const { error: savingsDeleteError } = await supabaseAdmin
          .from('savings_entries')
          .delete()
          .eq('source_transaction_id', log.target_id)
          .eq('user_id', log.user_id);

        if (savingsDeleteError) {
          console.error(
            'Error al eliminar movimiento vinculado en savings_entries:',
            savingsDeleteError,
          );
          await replyCallback(
            'No se pudo revertir el ahorro vinculado en la base de datos. Intentá desde la web.',
            true,
          );
          return true;
        }
      }

      const { data: deletedRows, error: deleteError } = await supabaseAdmin
        .from(targetTable)
        .delete()
        .eq('id', log.target_id)
        .eq('user_id', log.user_id)
        .select('id');

      if (deleteError) {
        console.error(`Error al eliminar en ${targetTable}:`, deleteError);
        await replyCallback(
          'No se pudo anular en la base de datos. Intentá desde la web.',
          true,
        );
        return true;
      }

      await markActionLogVoided(supabaseAdmin, log.id as string);

      const alreadyDeletedInWeb = !deletedRows || deletedRows.length === 0;
      const suffix = alreadyDeletedInWeb
        ? '❌ Anulado (el registro ya había sido eliminado desde la web).'
        : '❌ Anulado correctamente.';

      if (messageId) {
        await editTelegramMessage(
          botToken,
          chatId,
          messageId,
          `${escapeHtml(originalText)}\n\n<b>${escapeHtml(suffix)}</b>`,
          { parseMode: 'HTML' },
        );
      }

      await replyCallback(suffix);
      return true;
    }

    if (data === 'cancel_session') {
      const [sessionDelRes, pendingDelRes] = await Promise.all([
        supabaseAdmin
          .from('telegram_conversation_sessions')
          .delete()
          .eq('chat_id', chatId),
        supabaseAdmin
          .from('telegram_pending_requests')
          .delete()
          .eq('chat_id', chatId)
          .eq('status', 'pending'),
      ]);

      if (sessionDelRes.error || pendingDelRes.error) {
        console.error('Error al cancelar sesión/solicitudes pendientes:', {
          sessionError: sessionDelRes.error,
          pendingError: pendingDelRes.error,
        });
        await replyCallback('No se pudo cancelar en este momento. Intentá nuevamente.', true);
        return true;
      }

      if (messageId) {
        await editTelegramMessage(
          botToken,
          chatId,
          messageId,
          'Operación cancelada. Podés enviarme otro movimiento cuando quieras.',
        );
      }
      await replyCallback('Operación cancelada.');
      return true;
    }

    if (
      data.startsWith('pick_cat:') ||
      data.startsWith('pick_purchase:') ||
      data.startsWith('pick_ft_origin:')
    ) {
      const { data: session, error: sessionFetchError } = await supabaseAdmin
        .from('telegram_conversation_sessions')
        .select('*')
        .eq('chat_id', chatId)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (sessionFetchError) {
        console.error('Error al consultar sesión en callback:', sessionFetchError);
        await replyCallback('Error al consultar la sesión. Intentá nuevamente.', true);
        return true;
      }

      if (!session) {
        await replyCallback(
          'La sesión expiró o ya fue procesada. Enviá tu mensaje nuevamente.',
          true,
        );
        if (messageId) {
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            '⏰ Esta conversación expiró o ya fue completada. Enviá tu mensaje nuevamente.',
          );
        }
        return true;
      }

      const typedSession = session as ConversationSession;

      // Verificar pertenencia activa chat_id <-> user_id antes de ejecutar RPCs con service_role
      const { data: activeLink, error: activeLinkError } = await supabaseAdmin
        .from('telegram_links')
        .select('user_id')
        .eq('user_id', typedSession.user_id)
        .eq('telegram_chat_id', chatId)
        .maybeSingle();

      if (activeLinkError) {
        console.error('Error al verificar telegram_links en callback:', activeLinkError);
        await replyCallback('Error al verificar tu cuenta. Intentá nuevamente.', true);
        return true;
      }

      if (!activeLink) {
        await replyCallback('Este chat ya no está vinculado a la cuenta.', true);
        return true;
      }

      const [settingsRes, catsRes] = await Promise.all([
        supabaseAdmin
          .from('user_settings')
          .select('currency, timezone')
          .eq('user_id', typedSession.user_id)
          .maybeSingle(),
        supabaseAdmin
          .from('categories')
          .select('id, name, type, is_gustito, monthly_limit')
          .eq('user_id', typedSession.user_id)
          .eq('is_active', true),
      ]);

      if (settingsRes.error || catsRes.error) {
        console.error('Error al cargar configuración o categorías en callback:', {
          settingsError: settingsRes.error,
          categoriesError: catsRes.error,
        });
        await replyCallback('Error al cargar tus datos. Intentá nuevamente.', true);
        return true;
      }

      const currency = (settingsRes.data?.currency as string | undefined) ?? 'ARS';
      const localParts = getLocalDateParts(settingsRes.data?.timezone as string | undefined);
      const categories = (catsRes.data ?? []) as ActiveCategory[];

      if (data.startsWith('pick_cat:')) {
        const categoryId = data.slice('pick_cat:'.length).trim();
        const chosenCat = categories.find((c) => c.id === categoryId);

        if (!chosenCat) {
          await replyCallback('Categoría inválida o archivada.', true);
          return true;
        }

        const mergedDraft: Partial<GeminiParsedIntent> = {
          ...typedSession.draft_json,
          intent: typedSession.intent,
          category_id: chosenCat.id,
          category_confidence: 'high',
          missing_fields: (typedSession.draft_json.missing_fields ?? []).filter(
            (f) => f !== 'category',
          ),
        };

        const validated = normalizeAndValidateParsedIntent(
          mergedDraft,
          categories,
          localParts.yyyyMmDd,
        );

        await replyCallback(`Categoría: ${chosenCat.name}`);
        if (messageId) {
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            `Categoría elegida: <b>${escapeHtml(chosenCat.name)}</b>.`,
            { parseMode: 'HTML' },
          );
        }

        await dispatchParsedIntent({
          supabaseAdmin,
          botToken,
          userId: typedSession.user_id,
          chatId,
          currency,
          todayLocal: localParts.yyyyMmDd,
          categories,
          parsed: validated,
        });

        return true;
      }

      if (data.startsWith('pick_purchase:')) {
        const purchaseId = data.slice('pick_purchase:'.length).trim();
        const { data: purchaseRow, error: purchaseError } = await supabaseAdmin
          .from('installment_purchases')
          .select('id, description')
          .eq('id', purchaseId)
          .eq('user_id', typedSession.user_id)
          .maybeSingle();

        if (purchaseError) {
          console.error('Error al consultar compra en cuotas:', purchaseError);
          await replyCallback('No se pudo consultar la compra. Intentá nuevamente.', true);
          return true;
        }

        if (!purchaseRow) {
          await replyCallback('Compra no encontrada.', true);
          return true;
        }

        const mergedDraft: Partial<GeminiParsedIntent> = {
          ...typedSession.draft_json,
          intent: 'pay_installments',
          purchase_id: purchaseRow.id as string,
          missing_fields: (typedSession.draft_json.missing_fields ?? []).filter(
            (f) => f !== 'purchase_selection',
          ),
        };

        const validated = normalizeAndValidateParsedIntent(
          mergedDraft,
          categories,
          localParts.yyyyMmDd,
        );

        await replyCallback(`Compra: ${purchaseRow.description as string}`);
        if (messageId) {
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            `Compra seleccionada: <b>${escapeHtml(purchaseRow.description as string)}</b>.`,
            { parseMode: 'HTML' },
          );
        }

        await dispatchParsedIntent({
          supabaseAdmin,
          botToken,
          userId: typedSession.user_id,
          chatId,
          currency,
          todayLocal: localParts.yyyyMmDd,
          categories,
          parsed: validated,
        });

        return true;
      }

      if (data.startsWith('pick_ft_origin:')) {
        const rawOrigin = data.slice('pick_ft_origin:'.length).trim();
        if (rawOrigin !== 'monthly_available' && rawOrigin !== 'savings_fund') {
          await replyCallback('Origen inválido.', true);
          return true;
        }

        const originLabel =
          rawOrigin === 'savings_fund'
            ? '🏦 Bóveda de Ahorros'
            : '💰 Disponible del Mes';

        const mergedDraft: Partial<GeminiParsedIntent> = {
          ...typedSession.draft_json,
          intent: 'fixed_term_deposit',
          fixed_term_origin: rawOrigin,
          missing_fields: (typedSession.draft_json.missing_fields ?? []).filter(
            (f) => f !== 'fixed_term_origin',
          ),
        };

        const validated = normalizeAndValidateParsedIntent(
          mergedDraft,
          categories,
          localParts.yyyyMmDd,
        );

        await replyCallback(`Origen: ${originLabel}`);
        if (messageId) {
          await editTelegramMessage(
            botToken,
            chatId,
            messageId,
            `Origen seleccionado: <b>${escapeHtml(originLabel)}</b>.`,
            { parseMode: 'HTML' },
          );
        }

        await dispatchParsedIntent({
          supabaseAdmin,
          botToken,
          userId: typedSession.user_id,
          chatId,
          currency,
          todayLocal: localParts.yyyyMmDd,
          categories,
          parsed: validated,
        });

        return true;
      }
    }

    await replyCallback();
    return true;
  } catch (err) {
    console.error('Error en callback_query:', err);
    if (!callbackAnswered) {
      const answered = await answerCallbackSafely(
        botToken,
        cbId,
        'Ocurrió un error al procesar tu acción. Intentá nuevamente.',
        true,
      );
      if (answered) return true;
    }
    return await sendMessageChecked(
      botToken,
      chatId,
      '❌ Ocurrió un error al completar tu acción. Intentá nuevamente en unos segundos.',
    );
  }
}

async function processIncomingMessage(
  supabaseAdmin: SupabaseAdminLike,
  botToken: string,
  geminiApiKey: string,
  message: NonNullable<TelegramUpdate['message']>,
): Promise<boolean> {
  const chatId = message.chat.id;
  const username = message.from?.username ?? null;
  const text = (message.text ?? message.caption ?? '').trim();

  try {
    // 4.1 Comando /vincular <CODIGO>
    if (/^\/vincular\b/i.test(text)) {
      const codeInput = text.replace(/^\/vincular\b/i, '').trim().toUpperCase();
      if (!codeInput) {
        return await sendMessageChecked(
          botToken,
          chatId,
          'Indicá tu código después del comando. Ejemplo:\n<code>/vincular A7K9M2</code>',
          { parseMode: 'HTML' },
        );
      }

      const nowIso = new Date().toISOString();
      const { data: codeRow, error: codeFetchError } = await supabaseAdmin
        .from('telegram_link_codes')
        .select('id, user_id, code, expires_at, used_at')
        .eq('code', codeInput)
        .is('used_at', null)
        .gt('expires_at', nowIso)
        .maybeSingle();

      if (codeFetchError) {
        console.error('Error al consultar telegram_link_codes:', codeFetchError);
        throw new Error(`Error al validar código de vinculación: ${codeFetchError.message}`);
      }

      if (!codeRow) {
        return await sendMessageChecked(
          botToken,
          chatId,
          'El código es inválido o expiró (dura 15 minutos). Generá uno nuevo desde <b>Configuración (/settings)</b> en SB-Finance.',
          { parseMode: 'HTML' },
        );
      }

      const targetUserId = codeRow.user_id as string;

      // Verificar restricción estricta 1:1 (chat_id no pertenece a otra cuenta)
      const [byChatRes, byUserRes] = await Promise.all([
        supabaseAdmin
          .from('telegram_links')
          .select('user_id')
          .eq('telegram_chat_id', chatId)
          .maybeSingle(),
        supabaseAdmin
          .from('telegram_links')
          .select('telegram_chat_id')
          .eq('user_id', targetUserId)
          .maybeSingle(),
      ]);

      if (byChatRes.error || byUserRes.error) {
        console.error('Error al verificar vinculaciones existentes:', {
          byChatError: byChatRes.error,
          byUserError: byUserRes.error,
        });
        throw new Error('Error al verificar vinculaciones de Telegram.');
      }

      const existingByChat = byChatRes.data;
      const existingByUser = byUserRes.data;

      if (existingByChat && existingByChat.user_id !== targetUserId) {
        return await sendMessageChecked(
          botToken,
          chatId,
          'Este Telegram ya está vinculado a otra cuenta de SB-Finance. Desvinculalo primero desde Configuración de esa cuenta.',
        );
      }

      if (existingByUser && Number(existingByUser.telegram_chat_id) !== chatId) {
        return await sendMessageChecked(
          botToken,
          chatId,
          'Esta cuenta de SB-Finance ya tiene otro chat de Telegram vinculado. Desvinculalo primero desde Configuración (/settings).',
        );
      }

      if (existingByChat && existingByChat.user_id === targetUserId) {
        const { error: codeMarkErr } = await supabaseAdmin
          .from('telegram_link_codes')
          .update({ used_at: nowIso })
          .eq('id', codeRow.id);

        if (codeMarkErr) {
          console.error('Error al marcar código como usado (re-vinculación):', codeMarkErr);
        }

        return await sendMessageChecked(
          botToken,
          chatId,
          '✅ Tu cuenta de SB-Finance ya estaba vinculada a este chat. Podés enviarme tus gastos por texto o nota de voz.',
        );
      }

      const { error: linkError } = await supabaseAdmin.from('telegram_links').insert({
        user_id: targetUserId,
        telegram_chat_id: chatId,
        telegram_username: username,
      });

      if (linkError) {
        console.error('Error al insertar en telegram_links:', linkError);
        return await sendMessageChecked(
          botToken,
          chatId,
          'No se pudo completar la vinculación en este momento. Generá un nuevo código e intentá otra vez.',
        );
      }

      const { error: codeUsedError } = await supabaseAdmin
        .from('telegram_link_codes')
        .update({ used_at: nowIso })
        .eq('id', codeRow.id);

      if (codeUsedError) {
        console.error('Error al marcar código como usado:', codeUsedError);
      }

      return await sendMessageChecked(
        botToken,
        chatId,
        '✅ <b>Cuenta vinculada correctamente.</b> Ya podés enviarme tus gastos, ingresos o compras en cuotas por texto o nota de voz (hasta 60 s).',
        { parseMode: 'HTML' },
      );
    }

    // 4.2 Consultar si el chat está vinculado
    const { data: linkRow, error: linkFetchError } = await supabaseAdmin
      .from('telegram_links')
      .select('user_id')
      .eq('telegram_chat_id', chatId)
      .maybeSingle();

    if (linkFetchError) {
      console.error('Error al consultar telegram_links:', linkFetchError);
      throw new Error(`Error al consultar vinculación del chat: ${linkFetchError.message}`);
    }

    if (/^\/(start|ayuda)\b/i.test(text)) {
      if (!linkRow) {
        return await sendMessageChecked(
          botToken,
          chatId,
          '👋 ¡Hola! Soy el asistente de <b>SB-Finance</b>.\n\nTu chat aún no está vinculado. Generá un código en <b>Configuración (/settings)</b> de la app web y enviame:\n<code>/vincular TU_CODIGO</code>',
          { parseMode: 'HTML' },
        );
      }
      return await sendMessageChecked(
        botToken,
        chatId,
        '👋 <b>SB-Finance listo.</b> Enviame un texto o nota de voz (hasta 60 s) con tu movimiento.\n\n<b>Ejemplos:</b>\n• <i>Gasté 15.000 en delivery, me di un gustito hoy</i>\n• <i>Cobré 40.000 de un diseño freelance y mandalo directo a ahorros</i>\n• <i>Compré auriculares en 3 cuotas de 25.000, primera cuota el 10/12/2026</i>\n• <i>Pagué 2 cuotas de las zapatillas por un total de 55.000</i>\n• <i>Puse un plazo fijo de 100.000 a 30 días con 3,5% de rendimiento</i>\n\nUsá /cancelar para cancelar una carga en curso.',
        { parseMode: 'HTML' },
      );
    }

    if (!linkRow) {
      return await sendMessageChecked(
        botToken,
        chatId,
        'Tu chat aún no está vinculado. Generá un código en Configuraciones de SB-Finance y enviá <code>/vincular TU_CODIGO</code>.',
        { parseMode: 'HTML' },
      );
    }

    const userId = linkRow.user_id as string;

    if (/^\/cancelar\b/i.test(text)) {
      const [sessionDelRes, pendingDelRes] = await Promise.all([
        supabaseAdmin
          .from('telegram_conversation_sessions')
          .delete()
          .eq('chat_id', chatId),
        supabaseAdmin
          .from('telegram_pending_requests')
          .delete()
          .eq('chat_id', chatId)
          .eq('status', 'pending'),
      ]);

      if (sessionDelRes.error || pendingDelRes.error) {
        console.error('Error al ejecutar /cancelar:', {
          sessionError: sessionDelRes.error,
          pendingError: pendingDelRes.error,
        });
        throw new Error('No se pudo cancelar la operación pendiente.');
      }

      return await sendMessageChecked(
        botToken,
        chatId,
        'Operación cancelada. Podés enviarme un nuevo gasto, ingreso o compra en cuotas cuando quieras.',
      );
    }

    // 4.3 Validación estricta de audio ANTES de descargar + Acuse de recibo inmediato
    const audioObj = message.voice ?? message.audio ?? null;
    let audioBase64: string | null = null;
    let audioMimeType: string | null = null;

    if (audioObj) {
      if ((audioObj.duration ?? 0) > MAX_AUDIO_DURATION_SECONDS) {
        return await sendMessageChecked(
          botToken,
          chatId,
          'El audio no puede durar más de 60 segundos. Enviá uno más corto o escribilo por texto.',
        );
      }
      if ((audioObj.file_size ?? 0) > MAX_AUDIO_FILE_BYTES) {
        return await sendMessageChecked(
          botToken,
          chatId,
          'El audio supera el tamaño máximo permitido (5 MB). Enviá uno más corto o escribilo por texto.',
        );
      }
    }

    if (!text && !audioObj) {
      return await sendMessageChecked(
        botToken,
        chatId,
        'Enviame un mensaje de texto o una nota de voz (hasta 60 segundos) para registrar tu movimiento.',
      );
    }

    // Primer mensaje inmediato de acuse de recibo para evitar silencio mientras se descarga el audio / procesa Gemini
    const ackSent = await sendMessageChecked(
      botToken,
      chatId,
      '⏳ Mensaje recibido, estamos procesando la transacción...',
    );
    if (!ackSent) {
      console.warn('No se pudo enviar el acuse inicial ⏳; continuando procesamiento.', {
        chatId,
      });
    }

    if (audioObj) {
      const downloaded = await getTelegramFileBytes(botToken, audioObj.file_id);
      if (downloaded.bytes.byteLength > MAX_AUDIO_FILE_BYTES) {
        return await sendMessageChecked(
          botToken,
          chatId,
          'El audio supera el tamaño máximo permitido (5 MB). Enviá uno más corto o escribilo por texto.',
        );
      }
      audioBase64 = downloaded.base64;
      audioMimeType = normalizeAudioMimeType(audioObj.mime_type);
    }

    // 4.4 Cargar contexto del usuario: settings, categorías activas y sesión multi-turno
    const nowIso = new Date().toISOString();
    const [settingsRes, categoriesRes, sessionRes] = await Promise.all([
      supabaseAdmin
        .from('user_settings')
        .select('currency, timezone')
        .eq('user_id', userId)
        .maybeSingle(),
      supabaseAdmin
        .from('categories')
        .select('id, name, type, is_gustito, monthly_limit')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('name', { ascending: true }),
      supabaseAdmin
        .from('telegram_conversation_sessions')
        .select('*')
        .eq('chat_id', chatId)
        .gt('expires_at', nowIso)
        .maybeSingle(),
    ]);

    if (settingsRes.error || categoriesRes.error || sessionRes.error) {
      console.error('Error al cargar contexto del usuario en telegram-webhook:', {
        userId,
        settingsError: settingsRes.error,
        categoriesError: categoriesRes.error,
        sessionError: sessionRes.error,
      });
      throw new Error('Error al cargar la configuración y categorías del usuario.');
    }

    const currency = (settingsRes.data?.currency as string | undefined) ?? 'ARS';
    const timezone =
      (settingsRes.data?.timezone as string | undefined) ??
      'America/Argentina/Buenos_Aires';
    const localParts = getLocalDateParts(timezone);
    const categories = (categoriesRes.data ?? []) as ActiveCategory[];
    const activeSession = (sessionRes.data as ConversationSession | null) ?? null;

    // Atajo determinístico si estaba esperando categoría y el usuario escribió el nombre exacto o número
    if (activeSession && activeSession.pending_step === 'awaiting_category' && text && !audioBase64) {
      const expectedType = activeSession.intent === 'income' ? 'income' : 'expense';
      const expectedCats = categories.filter((c) => c.type === expectedType);
      const normalizedInput = text.trim().toLowerCase();
      const indexAttempt = Number(normalizedInput);
      const matchedCat =
        (Number.isInteger(indexAttempt) &&
        indexAttempt >= 1 &&
        indexAttempt <= expectedCats.length
          ? expectedCats[indexAttempt - 1]
          : undefined) ??
        expectedCats.find((c) => c.name.toLowerCase() === normalizedInput);

      if (matchedCat) {
        const mergedDraft: Partial<GeminiParsedIntent> = {
          ...activeSession.draft_json,
          intent: activeSession.intent,
          category_id: matchedCat.id,
          category_confidence: 'high',
          missing_fields: (activeSession.draft_json.missing_fields ?? []).filter(
            (f) => f !== 'category',
          ),
        };
        const validated = normalizeAndValidateParsedIntent(
          mergedDraft,
          categories,
          localParts.yyyyMmDd,
        );

        await dispatchParsedIntent({
          supabaseAdmin,
          botToken,
          userId,
          chatId,
          currency,
          todayLocal: localParts.yyyyMmDd,
          categories,
          parsed: validated,
        });
        return true;
      }
    }

    // Atajo determinístico si estaba esperando cantidad de cuotas a adelantar
    if (
      activeSession &&
      activeSession.pending_step === 'awaiting_installment_count' &&
      text &&
      !audioBase64
    ) {
      const countAttempt = Number(text.trim());
      if (Number.isInteger(countAttempt) && countAttempt >= 1 && countAttempt <= 120) {
        const mergedDraft: Partial<GeminiParsedIntent> = {
          ...activeSession.draft_json,
          intent: 'pay_installments',
          installments_to_pay: countAttempt,
          missing_fields: (activeSession.draft_json.missing_fields ?? []).filter(
            (f) => f !== 'installments_to_pay',
          ),
        };
        const validated = normalizeAndValidateParsedIntent(
          mergedDraft,
          categories,
          localParts.yyyyMmDd,
        );

        await dispatchParsedIntent({
          supabaseAdmin,
          botToken,
          userId,
          chatId,
          currency,
          todayLocal: localParts.yyyyMmDd,
          categories,
          parsed: validated,
        });
        return true;
      }
    }

    // 4.5 Procesamiento multimodal con Gemini Flash (con respaldo en cola ante error transitorio)
    let parsed: GeminiParsedIntent;
    try {
      parsed = await callGeminiFlash(geminiApiKey, {
        userText: text || null,
        audioBase64,
        audioMimeType,
        todayLocal: localParts.yyyyMmDd,
        timezone,
        categories,
        activeSession,
        supabaseAdmin,
        userId,
      });
    } catch (aiErr) {
      if (aiErr instanceof TransientAiError) {
        const nowMs = Date.now();
        const nextRetryIso = new Date(nowMs + QUEUE_INITIAL_RETRY_MS).toISOString();
        const expiresAtIso = new Date(nowMs + QUEUE_TTL_MS).toISOString();

        const { error: enqueueError } = await supabaseAdmin
          .from('telegram_pending_requests')
          .insert({
            user_id: userId,
            chat_id: chatId,
            message_text: text || null,
            audio_base64: audioBase64,
            audio_mime_type: audioMimeType,
            local_date: localParts.yyyyMmDd,
            timezone,
            currency,
            session_draft_json: activeSession?.draft_json ?? null,
            session_pending_step: activeSession?.pending_step ?? null,
            session_intent: activeSession?.intent ?? null,
            status: 'pending',
            attempts: 1,
            next_retry_at: nextRetryIso,
            expires_at: expiresAtIso,
            last_error: aiErr.message.slice(0, 500),
          });

        if (enqueueError) {
          console.error(
            'Error al guardar solicitud en telegram_pending_requests:',
            enqueueError,
          );
          throw aiErr;
        }

        const queuedNotified = await sendMessageChecked(
          botToken,
          chatId,
          '⚠️ <b>Problema temporal en el servicio de IA</b>\n\nEn este momento estoy teniendo un problema de alta demanda y no puedo procesar tu solicitud ahora mismo.\n\n💾 <b>Tus datos quedaron guardados:</b> apenas se habilite el servicio voy a realizar la carga automáticamente en el sistema y te enviaré la confirmación por acá.',
          { parseMode: 'HTML' },
        );
        if (!queuedNotified) {
          console.error(
            'Solicitud encolada pero falló el aviso de cola por Telegram:',
            { chatId, userId },
          );
        }
        return true;
      }
      throw aiErr;
    }

    await dispatchParsedIntent({
      supabaseAdmin,
      botToken,
      userId,
      chatId,
      currency,
      todayLocal: localParts.yyyyMmDd,
      categories,
      parsed,
    });

    return true;
  } catch (err) {
    console.error('Error procesando telegram-webhook:', err);
    return await sendMessageChecked(
      botToken,
      chatId,
      '❌ No pude procesar tu mensaje en este momento. Intentá nuevamente en unos segundos.',
    );
  }
}
