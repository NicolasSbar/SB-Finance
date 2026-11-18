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
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  getLocalDateParts,
  type SupabaseAdminLike,
} from '../_shared/financeHelpers.ts';
import {
  answerCallbackQuery,
  editTelegramMessage,
  getTelegramFileBytes,
  sendTelegramMessage,
  type TelegramSendOptions,
  timingSafeEqualStr,
} from '../_shared/telegramApi.ts';
import {
  type ActiveCategory,
  callGeminiFlash,
  type ConversationSession,
  dispatchParsedIntent,
  escapeHtml,
  type GeminiParsedIntent,
  normalizeAndValidateParsedIntent,
  normalizeAudioMimeType,
  TransientAiError,
} from '../_shared/telegramIntentProcessor.ts';

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
