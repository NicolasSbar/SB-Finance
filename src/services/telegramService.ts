/**
 * Servicio de vinculación privada multi-usuario con el Bot de Telegram (`telegram_links`
 * y `telegram_link_codes`).
 *
 * Arquitectura y decisiones técnicas:
 * - Cero secretos del bot en el navegador: el frontend nunca conoce `TELEGRAM_BOT_TOKEN`
 *   ni consulta la API de Telegram directamente. Solo genera códigos temporales en
 *   PostgreSQL protegidos por RLS (`auth.uid() = user_id`), y la Edge Function verifica
 *   y consolida la relación 1:1 usando `service_role`.
 * - Generación criptográficamente segura sin caracteres ambiguos: usamos `crypto.getRandomValues`
 *   y excluimos `0/O`, `1/I/L` para evitar errores al tipear el código en el celular.
 */
import { supabase } from '../lib/supabaseClient';
import type { TelegramLink, TelegramLinkCode } from '../types/database.types';

const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LINK_CODE_LENGTH = 6;
const LINK_CODE_TTL_MS = 15 * 60 * 1000;

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

function buildRandomLinkCode(): string {
  const bytes = new Uint32Array(LINK_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    result += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  }
  return result;
}

export async function getTelegramLink(userId: string): Promise<TelegramLink | null> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para consultar la vinculación de otra cuenta.');
  }

  const { data, error } = await supabase
    .from('telegram_links')
    .select('*')
    .eq('user_id', sessionUserId)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo consultar el estado de Telegram: ${error.message}`);
  }

  return (data as TelegramLink | null) ?? null;
}

export async function getActiveLinkCode(
  userId: string,
): Promise<TelegramLinkCode | null> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para consultar códigos de otra cuenta.');
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('telegram_link_codes')
    .select('*')
    .eq('user_id', sessionUserId)
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo consultar el código activo: ${error.message}`);
  }

  return (data as TelegramLinkCode | null) ?? null;
}

export async function generateTelegramLinkCode(
  userId: string,
): Promise<TelegramLinkCode> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para generar códigos para otra cuenta.');
  }

  const nowIso = new Date().toISOString();

  // Invalida códigos vigentes previos del mismo usuario (regla de código único vigente)
  const { error: invalidateError } = await supabase
    .from('telegram_link_codes')
    .update({ used_at: nowIso })
    .eq('user_id', sessionUserId)
    .is('used_at', null);

  if (invalidateError) {
    throw new Error(
      `No se pudieron invalidar códigos previos: ${invalidateError.message}`,
    );
  }

  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = buildRandomLinkCode();
    const { data, error } = await supabase
      .from('telegram_link_codes')
      .insert({
        user_id: sessionUserId,
        code,
        expires_at: expiresAt,
      })
      .select('*')
      .single();

    if (!error && data) {
      return data as TelegramLinkCode;
    }

    if (error?.code !== '23505') {
      throw new Error(
        `No se pudo generar el código de vinculación: ${error?.message ?? 'Error desconocido'}`,
      );
    }
  }

  throw new Error(
    'No se pudo generar un código único de vinculación. Intentá nuevamente.',
  );
}

export async function unlinkTelegram(userId: string): Promise<void> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para desvincular otra cuenta.');
  }

  await supabase
    .from('telegram_conversation_sessions')
    .delete()
    .eq('user_id', sessionUserId);

  const { error } = await supabase
    .from('telegram_links')
    .delete()
    .eq('user_id', sessionUserId);

  if (error) {
    throw new Error(`No se pudo desvincular Telegram: ${error.message}`);
  }
}
