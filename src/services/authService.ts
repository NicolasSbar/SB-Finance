/**
 * Servicio de autenticación privada y alta de usuarios administrados.
 *
 * Arquitectura y decisiones técnicas:
 * - Encapsulamos todas las llamadas a `supabase.auth` y a la Edge Function
 *   `admin-create-user` en este servicio para que los componentes de React nunca
 *   manipulen tokens ni respuestas crudas del SDK directamente.
 * - Traducimos los errores técnicos de GoTrue/Edge Functions a mensajes claros
 *   en español para notificar al usuario con `react-hot-toast`.
 */
import type { AuthChangeEvent, Session, Subscription } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import type { AdminCreateUserResponse } from '../types/database.types';

function ensureConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Faltan las variables VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en el archivo .env.',
    );
  }
}

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  ensureConfigured();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error) {
    if (error.message.toLowerCase().includes('invalid login credentials')) {
      throw new Error('Correo electrónico o contraseña incorrectos.');
    }
    if (error.message.toLowerCase().includes('email not confirmed')) {
      throw new Error('Tu cuenta aún no fue confirmada. Contactá al administrador.');
    }
    throw new Error(`No se pudo iniciar sesión: ${error.message}`);
  }

  if (!data.session) {
    throw new Error('No se recibió una sesión válida desde el servidor.');
  }

  return data.session;
}

export async function signOut(): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new Error(`Error al cerrar sesión: ${error.message}`);
  }
}

export async function getCurrentSession(): Promise<Session | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new Error(`No se pudo verificar la sesión actual: ${error.message}`);
  }
  return data.session;
}

export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): Subscription {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return data.subscription;
}

export async function adminCreateUser(
  email: string,
  password: string,
): Promise<AdminCreateUserResponse> {
  ensureConfigured();

  const { data, error } = await supabase.functions.invoke<AdminCreateUserResponse>(
    'admin-create-user',
    {
      body: {
        email: email.trim().toLowerCase(),
        password,
      },
    },
  );

  if (error) {
    // Intentar extraer el mensaje JSON devuelto por la Edge Function si está disponible
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      try {
        const body = (await context.json()) as { error?: string };
        if (body.error) {
          throw new Error(body.error);
        }
      } catch (innerErr) {
        if (innerErr instanceof Error && innerErr.message !== error.message) {
          throw innerErr;
        }
      }
    }
    throw new Error(error.message || 'No se pudo dar de alta el usuario.');
  }

  if (!data || !data.user) {
    throw new Error('Respuesta inesperada al crear el usuario.');
  }

  return data;
}
