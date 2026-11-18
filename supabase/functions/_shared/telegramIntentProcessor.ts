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
import {
  addDaysToISODate,
  computeCategoryLimitStatus,
  computeFixedTermReturn,
  computeGustitosStatus,
  ensureMonthlyPeriodForUser,
  formatCurrencyARS,
  normalizeMonthStart,
  roundCurrency,
  type SupabaseAdminLike,
} from './financeHelpers.ts';
import {
  sendTelegramMessage,
  type TelegramInlineButton,
} from './telegramApi.ts';

export const SESSION_TTL_MINUTES = 15;
export const MAX_MONEY = 9999999999.99;
export const GEMINI_FAST_RETRY_DELAY_MS = 1500;
export const GEMINI_TIMEOUT_MS = 25_000;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_FALLBACK_GEMINI_MODEL = 'gemini-2.5-flash';

export function buildGeminiEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export function resolveGeminiModels(): string[] {
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

export const GEMINI_FLASH_ENDPOINT = buildGeminiEndpoint(DEFAULT_GEMINI_MODEL);

export type ParsedStatus = 'complete' | 'needs_clarification' | 'unrecognized';

export type ParsedIntent =
  | 'expense'
  | 'income'
  | 'installment_purchase'
  | 'pay_installments'
  | 'fixed_term_deposit';

export type MissingField =
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

export type PendingStep =
  | 'awaiting_category'
  | 'awaiting_amount'
  | 'awaiting_description'
  | 'awaiting_installment_details'
  | 'awaiting_first_installment_date'
  | 'awaiting_purchase_selection'
  | 'awaiting_installment_count'
  | 'awaiting_fixed_term_origin'
  | 'awaiting_fixed_term_return';

export interface GeminiParsedIntent {
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

export interface ActiveCategory {
  id: string;
  name: string;
  type: 'expense' | 'income';
  is_gustito: boolean;
  monthly_limit: number | null;
}

export interface ConversationSession {
  id: string;
  user_id: string;
  chat_id: number;
  intent: ParsedIntent;
  pending_step: PendingStep;
  draft_json: Partial<GeminiParsedIntent>;
  expires_at: string;
}

export interface PendingPurchaseCandidate {
  id: string;
  description: string;
  installments_count: number;
  installment_amount?: number;
  pendingCount: number;
}

export class TransientAiError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'TransientAiError';
    this.statusCode = statusCode;
  }
}

export function isTransientStatusCode(status: number): boolean {
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

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function normalizeAudioMimeType(rawMime?: string | null): string {
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

export function isIsoDate(value: unknown): value is string {
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

export function addMonthsClamped(isoDate: string, monthsToAdd: number): string {
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

export function buildCategoryButtons(
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

export function buildFixedTermOriginButtons(): TelegramInlineButton[][] {
  return [
    [
      { text: '💰 Disponible del Mes', callback_data: 'pick_ft_origin:monthly_available' },
      { text: '🏦 Bóveda de Ahorros', callback_data: 'pick_ft_origin:savings_fund' },
    ],
    [{ text: '❌ Cancelar', callback_data: 'cancel_session' }],
  ];
}

export function buildPurchaseSelectionButtons(
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

export function resolvePendingStep(
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

export function normalizeAndValidateParsedIntent(
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

export function mergeWithActiveSessionDraft(
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

export async function callGeminiFlash(
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

export async function fetchPendingPurchasesForUser(
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

export function findMatchingPurchases(
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

export async function persistCompleteIntent(params: {
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

export async function promptForClarification(params: {
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

export async function dispatchParsedIntent(params: {
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
