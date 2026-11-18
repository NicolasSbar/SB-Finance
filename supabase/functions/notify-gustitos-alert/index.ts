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
import { createClient } from '@supabase/supabase-js';
import {
  computeGustitosStatus,
  formatCurrencyARS,
  getLocalDateParts,
  normalizeMonthStart,
  type SupabaseAdminLike,
} from '../_shared/financeHelpers.ts';
import { sendTelegramMessage } from '../_shared/telegramApi.ts';

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
