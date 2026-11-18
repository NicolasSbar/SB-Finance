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

export const TELEGRAM_API_TIMEOUT_MS = 10_000;
export const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 20_000;

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramSendOptions {
  parseMode?: 'Markdown' | 'HTML';
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramSentMessage {
  message_id: number;
}

export interface TelegramFileDownload {
  bytes: Uint8Array;
  base64: string;
  filePath: string;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
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

export function uint8ArrayToBase64(bytes: Uint8Array): string {
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

export async function sendTelegramMessage(
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

export async function editTelegramMessage(
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

export async function answerCallbackQuery(
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

export async function getTelegramFileBytes(
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
