/**
 * Supabase Edge Function (Deno): process-telegram-queue
 *
 * Arquitectura y decisiones técnicas:
 * - Cola persistente desacoplada vía `pg_cron` (`* * * * *`): como las Edge Functions
 *   tienen una vida corta durante el webhook HTTP, guardar los mensajes que sufrieron
 *   HTTP 503/429 en `telegram_pending_requests` permite que este worker los retome cada
 *   minuto hasta un máximo de 2 horas con backoff progresivo sin bloquear a Telegram.
 * - Bloqueo optimista (`UPDATE ... WHERE status = 'pending'` o `'processing'` > 2 min):
 *   evita duplicar cargas si dos ejecuciones del cron se solapan y recupera filas
 *   atascadas en `'processing'` si un worker previo cayó por timeout.
 * - Preservación temporal y de sesión: al reintentar enviamos a Gemini `todayLocal` con
 *   el `local_date` en que el usuario envió el mensaje originalmente, y reconstruimos
 *   en memoria la sesión multi-turno desde `session_draft_json` si la de 15 minutos
 *   expiró mientras el servicio de IA estuvo caído.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type SupabaseAdminLike } from '../_shared/financeHelpers.ts';
import { sendTelegramMessage, timingSafeEqualStr } from '../_shared/telegramApi.ts';
import {
  type ActiveCategory,
  callGeminiFlash,
  type ConversationSession,
  dispatchParsedIntent,
  type GeminiParsedIntent,
  type ParsedIntent,
  type PendingStep,
  TransientAiError,
} from '../_shared/telegramIntentProcessor.ts';

const BATCH_LIMIT = 10;
const EXPIRED_BATCH_LIMIT = 20;
const STALE_PROCESSING_MS = 2 * 60 * 1000;
const BACKOFF_MINUTES = [1, 2, 5, 10, 15];

class RecoverableQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoverableQueueError';
  }
}

interface PendingRequestRow {
  id: string;
  user_id: string;
  chat_id: number;
  message_text: string | null;
  audio_base64: string | null;
  audio_mime_type: string | null;
  local_date: string;
  timezone: string;
  currency: string;
  session_draft_json: Partial<GeminiParsedIntent> | null;
  session_pending_step: string | null;
  session_intent: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed_permanent';
  attempts: number;
  next_retry_at: string;
  expires_at: string;
  processing_started_at?: string | null;
  updated_at?: string;
  last_error: string | null;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sendQueueNotificationSafely(
  botToken: string,
  chatId: number,
  message: string,
  requestId: string,
): Promise<boolean> {
  try {
    const sent = await sendTelegramMessage(botToken, chatId, message, {
      parseMode: 'HTML',
    });
    if (!sent) {
      console.error('sendTelegramMessage devolvió null en process-telegram-queue:', {
        requestId,
        chatId,
      });
      return false;
    }
    return true;
  } catch (sendErr) {
    console.error('Error al enviar notificación de cola por Telegram:', {
      requestId,
      chatId,
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
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');

  if (
    !supabaseUrl ||
    !supabaseServiceRoleKey ||
    !botToken ||
    !cronInternalSecret ||
    !geminiApiKey
  ) {
    return jsonResponse(
      { error: 'Configuración incompleta en process-telegram-queue.' },
      500,
    );
  }

  const incomingSecret = req.headers.get('X-Cron-Secret') ?? '';
  if (!incomingSecret || !timingSafeEqualStr(incomingSecret, cronInternalSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const staleBeforeIso = new Date(nowMs - STALE_PROCESSING_MS).toISOString();
  const eligibleStatusFilter =
    `status.eq.pending,and(status.eq.processing,processing_started_at.lt.${staleBeforeIso}),and(status.eq.processing,processing_started_at.is.null,updated_at.lt.${staleBeforeIso})`;

  let expiredCount = 0;
  let completedCount = 0;
  let rescheduledCount = 0;
  let failedCount = 0;

  try {
    // Paso A: Expirar solicitudes que superaron la ventana máxima de 2 horas (incluye filas atascadas en 'processing' > 2 min)
    const { data: expiredCandidates, error: expiredSelectErr } = await supabaseAdmin
      .from('telegram_pending_requests')
      .select('id, chat_id')
      .or(eligibleStatusFilter)
      .lte('expires_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(EXPIRED_BATCH_LIMIT);

    if (expiredSelectErr) {
      console.error('Error al consultar solicitudes expiradas:', expiredSelectErr);
      return jsonResponse({ error: 'Error al consultar solicitudes expiradas.' }, 500);
    }

    for (const candidate of (expiredCandidates ?? []) as Array<{
      id: string;
      chat_id: number;
    }>) {
      const { data: claimedExpired, error: claimExpiredErr } = await supabaseAdmin
        .from('telegram_pending_requests')
        .update({
          status: 'failed_permanent',
          processing_started_at: null,
          audio_base64: null,
          last_error: 'Tiempo máximo de espera (2 horas) agotado.',
        })
        .eq('id', candidate.id)
        .or(eligibleStatusFilter)
        .select('id, chat_id')
        .maybeSingle();

      if (claimExpiredErr) {
        console.error('Error al reclamar solicitud expirada:', {
          id: candidate.id,
          error: claimExpiredErr,
        });
        continue;
      }

      if (claimedExpired) {
        expiredCount += 1;
        await sendQueueNotificationSafely(
          botToken,
          Number(claimedExpired.chat_id),
          '❌ <b>No se pudo procesar tu solicitud pendiente</b>\n\nEl servicio de IA estuvo con inconvenientes durante más de 2 horas. Por favor reenviá tu movimiento cuando quieras.',
          claimedExpired.id as string,
        );
      }
    }

    // Paso B: Consultar solicitudes listas para reintento en orden cronológico (incluye filas atascadas en 'processing' > 2 min)
    const { data: readyRows, error: readyErr } = await supabaseAdmin
      .from('telegram_pending_requests')
      .select('*')
      .or(eligibleStatusFilter)
      .lte('next_retry_at', nowIso)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(BATCH_LIMIT);

    if (readyErr) {
      console.error('Error al consultar solicitudes listas para reintento:', readyErr);
      return jsonResponse({ error: 'Error al consultar cola de reintentos.' }, 500);
    }

    // Paso C: Reclamar cada fila con bloqueo optimista y procesarla
    for (const row of (readyRows ?? []) as PendingRequestRow[]) {
      const claimStartedIso = new Date().toISOString();
      const { data: claimedRow, error: claimErr } = await supabaseAdmin
        .from('telegram_pending_requests')
        .update({
          status: 'processing',
          processing_started_at: claimStartedIso,
        })
        .eq('id', row.id)
        .or(eligibleStatusFilter)
        .select('*')
        .maybeSingle();

      if (claimErr) {
        console.error('Error al reclamar fila en process-telegram-queue:', {
          id: row.id,
          error: claimErr,
        });
        continue;
      }

      if (!claimedRow) {
        continue;
      }

      const claimed = claimedRow as PendingRequestRow;
      const chatId = Number(claimed.chat_id);
      const userId = claimed.user_id;

      try {
        // Verificar que la cuenta de Telegram siga vinculada al usuario
        const { data: linkRow, error: linkErr } = await supabaseAdmin
          .from('telegram_links')
          .select('user_id')
          .eq('user_id', userId)
          .eq('telegram_chat_id', chatId)
          .maybeSingle();

        if (linkErr) {
          throw new RecoverableQueueError(
            `Error al verificar vinculación de Telegram: ${linkErr.message}`,
          );
        }

        if (!linkRow) {
          const { error: unlinkUpdateErr } = await supabaseAdmin
            .from('telegram_pending_requests')
            .update({
              status: 'failed_permanent',
              processing_started_at: null,
              audio_base64: null,
              last_error: 'Chat desvinculado antes de completar la solicitud.',
            })
            .eq('id', claimed.id);

          if (unlinkUpdateErr) {
            console.error('Error al marcar solicitud desvinculada:', {
              id: claimed.id,
              error: unlinkUpdateErr,
            });
          }
          failedCount += 1;
          continue;
        }

        const currentNowIso = new Date().toISOString();
        const [categoriesRes, sessionRes] = await Promise.all([
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
            .gt('expires_at', currentNowIso)
            .maybeSingle(),
        ]);

        if (categoriesRes.error) {
          throw new RecoverableQueueError(
            `Error al cargar categorías del usuario: ${categoriesRes.error.message}`,
          );
        }
        if (sessionRes.error) {
          throw new RecoverableQueueError(
            `Error al consultar sesión de conversación: ${sessionRes.error.message}`,
          );
        }

        const categories = (categoriesRes.data ?? []) as ActiveCategory[];
        const liveSession = (sessionRes.data as ConversationSession | null) ?? null;

        const effectiveSession: ConversationSession | null =
          liveSession ??
          (claimed.session_draft_json &&
          claimed.session_intent &&
          claimed.session_pending_step
            ? {
                id: `queued-${claimed.id}`,
                user_id: userId,
                chat_id: chatId,
                intent: claimed.session_intent as ParsedIntent,
                pending_step: claimed.session_pending_step as PendingStep,
                draft_json: claimed.session_draft_json,
                expires_at: claimed.expires_at,
              }
            : null);

        const parsed = await callGeminiFlash(geminiApiKey, {
          userText: claimed.message_text ?? null,
          audioBase64: claimed.audio_base64 ?? null,
          audioMimeType: claimed.audio_mime_type ?? null,
          todayLocal: claimed.local_date,
          timezone: claimed.timezone || 'America/Argentina/Buenos_Aires',
          categories,
          activeSession: effectiveSession,
          supabaseAdmin: supabaseAdmin as unknown as SupabaseAdminLike,
          userId,
        });

        await dispatchParsedIntent({
          supabaseAdmin: supabaseAdmin as unknown as SupabaseAdminLike,
          botToken,
          userId,
          chatId,
          currency: claimed.currency || 'ARS',
          todayLocal: claimed.local_date,
          categories,
          parsed,
          headerPrefix: '🔄 <b>Solicitud pendiente procesada:</b>',
        });

        const { error: completeErr } = await supabaseAdmin
          .from('telegram_pending_requests')
          .update({
            status: 'completed',
            processing_started_at: null,
            processed_at: new Date().toISOString(),
            audio_base64: null,
            last_error: null,
          })
          .eq('id', claimed.id);

        if (completeErr) {
          console.error('Error al marcar solicitud como completed:', {
            id: claimed.id,
            error: completeErr,
          });
        }

        completedCount += 1;
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const nextAttempts = Number(claimed.attempts ?? 1) + 1;

        if (err instanceof TransientAiError || err instanceof RecoverableQueueError) {
          const backoffIdx = Math.min(
            Math.max(nextAttempts - 1, 0),
            BACKOFF_MINUTES.length - 1,
          );
          const backoffMinutes = BACKOFF_MINUTES[backoffIdx];
          const nextRetryMs = Date.now() + backoffMinutes * 60 * 1000;
          const expiresAtMs = new Date(claimed.expires_at).getTime();

          if (nextRetryMs > expiresAtMs) {
            const { error: failExpireErr } = await supabaseAdmin
              .from('telegram_pending_requests')
              .update({
                status: 'failed_permanent',
                processing_started_at: null,
                attempts: nextAttempts,
                audio_base64: null,
                last_error: errMessage.slice(0, 500),
              })
              .eq('id', claimed.id);

            if (failExpireErr) {
              console.error('Error al marcar failed_permanent por vencimiento:', {
                id: claimed.id,
                error: failExpireErr,
              });
            }

            await sendQueueNotificationSafely(
              botToken,
              chatId,
              '❌ <b>No se pudo procesar tu solicitud pendiente</b>\n\nEl servicio de IA continuó con alta demanda durante las últimas 2 horas. Por favor reenviá tu movimiento cuando quieras.',
              claimed.id,
            );
            failedCount += 1;
          } else {
            const { error: rescheduleErr } = await supabaseAdmin
              .from('telegram_pending_requests')
              .update({
                status: 'pending',
                processing_started_at: null,
                attempts: nextAttempts,
                next_retry_at: new Date(nextRetryMs).toISOString(),
                last_error: errMessage.slice(0, 500),
              })
              .eq('id', claimed.id);

            if (rescheduleErr) {
              console.error('Error al reprogramar solicitud en cola:', {
                id: claimed.id,
                error: rescheduleErr,
              });
            }
            rescheduledCount += 1;
          }
        } else {
          const { error: failPermErr } = await supabaseAdmin
            .from('telegram_pending_requests')
            .update({
              status: 'failed_permanent',
              processing_started_at: null,
              attempts: nextAttempts,
              audio_base64: null,
              last_error: errMessage.slice(0, 500),
            })
            .eq('id', claimed.id);

          if (failPermErr) {
            console.error('Error al marcar failed_permanent:', {
              id: claimed.id,
              error: failPermErr,
            });
          }

          await sendQueueNotificationSafely(
            botToken,
            chatId,
            '❌ <b>No pude procesar tu solicitud pendiente</b>\n\nOcurrió un error al interpretar los datos guardados. Por favor reenviá tu movimiento por texto o nota de voz.',
            claimed.id,
          );
          failedCount += 1;
        }
      }
    }

    return jsonResponse(
      {
        ok: true,
        expired: expiredCount,
        completed: completedCount,
        rescheduled: rescheduledCount,
        failed: failedCount,
      },
      200,
    );
  } catch (fatalErr) {
    console.error('Error fatal en process-telegram-queue:', fatalErr);
    return jsonResponse(
      {
        error: 'Error interno al procesar la cola de Telegram.',
      },
      500,
    );
  }
});
