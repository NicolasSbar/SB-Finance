/**
 * Cliente singleton de Supabase para el frontend (SPA).
 *
 * Arquitectura y decisiones técnicas:
 * - Únicamente lee `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` desde `import.meta.env`.
 *   La llave `anon` es pública y segura en el navegador porque el acceso real a los datos
 *   está protegido por las políticas Row Level Security (RLS) en PostgreSQL (`auth.uid()`).
 * - Tipamos explícitamente `createClient<Database>` con el esquema de `database.types.ts`
 *   para detectar en compilación (`tsc`) cualquier desfasaje en tablas, columnas o RPCs.
 * - Si el proyecto se ejecuta antes de crear `.env`, exponemos `isSupabaseConfigured`
 *   para mostrar una guía amigable en lugar de provocar un pantallazo blanco en tiempo de arranque.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types';

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const rawAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured: boolean = Boolean(
  rawUrl && rawUrl.trim().length > 0 && rawAnonKey && rawAnonKey.trim().length > 0,
);

const FALLBACK_URL = 'https://placeholder.supabase.co';
const FALLBACK_ANON_KEY = 'placeholder-anon-key';

export const supabase: SupabaseClient<Database> = createClient<Database>(
  isSupabaseConfigured && rawUrl ? rawUrl.trim() : FALLBACK_URL,
  isSupabaseConfigured && rawAnonKey ? rawAnonKey.trim() : FALLBACK_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
