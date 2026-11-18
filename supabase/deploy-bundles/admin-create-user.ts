// ============================================================================
// ARCHIVO AUTOGENERADO PARA DEPLOY MANUAL EN SUPABASE EDITOR: admin-create-user
// NO EDITAR ESTE ARCHIVO DIRECTAMENTE.
// Editá supabase/functions/admin-create-user/index.ts o supabase/functions/_shared/*
// y luego ejecutá: npm run bundle:functions
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

// ----------------------------------------------------------------------------
// Módulo: supabase/functions/admin-create-user/index.ts
// ----------------------------------------------------------------------------
/**
 * Supabase Edge Function (Deno): admin-create-user
 *
 * Arquitectura y decisiones técnicas:
 * - Runtime Deno aislado: importa @supabase/supabase-js vía `deno.json` (`npm:`)
 *   sin depender jamás del `package.json` del frontend.
 * - Privilegios en servidor: crear usuarios confirmados con `auth.admin.createUser`
 *   requiere `SUPABASE_SERVICE_ROLE_KEY`, llave que nunca debe viajar al navegador.
 * - Doble verificación de identidad y rol: primero validamos el JWT entrante con
 *   un cliente estándar usando `SUPABASE_ANON_KEY`, y luego consultamos
 *   `public.user_settings.is_admin = true` en base de datos antes de crear cuentas.
 * - Endurecimiento HTTP: restringimos CORS vía `ALLOWED_ORIGINS` (con fallback
 *   a orígenes localhost de desarrollo) y nunca exponemos `err.message` o errores crudos
 *   de Supabase Auth al cliente, devolviendo mensajes seguros en español.
 */

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

interface CreateUserPayload {
  email?: unknown;
  password?: unknown;
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

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error('Missing required Supabase environment variables in admin-create-user.');
      return jsonResponse(
        { error: 'Configuración incompleta de variables de entorno en la función.' },
        500,
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

    // Cliente contextualizado con el JWT del llamante para validar sesión sin privilegios admin
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

    // Cliente administrativo (service_role) únicamente en memoria del servidor
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: callerSettings, error: settingsError } = await supabaseAdmin
      .from('user_settings')
      .select('is_admin')
      .eq('user_id', callerUser.id)
      .maybeSingle();

    if (settingsError) {
      console.error(
        'Error checking admin permissions in admin-create-user:',
        settingsError.message,
      );
      return jsonResponse(
        { error: 'No se pudo verificar el permiso de administrador.' },
        500,
        cors.headers,
      );
    }

    if (!callerSettings || callerSettings.is_admin !== true) {
      return jsonResponse(
        { error: 'Acceso denegado: solo el administrador puede dar de alta usuarios.' },
        403,
        cors.headers,
      );
    }

    let payload: CreateUserPayload;
    try {
      payload = (await req.json()) as CreateUserPayload;
    } catch {
      return jsonResponse({ error: 'Cuerpo JSON inválido.' }, 400, cors.headers);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse({ error: 'Cuerpo JSON inválido.' }, 400, cors.headers);
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const password = typeof payload.password === 'string' ? payload.password : '';

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return jsonResponse(
        { error: 'El correo electrónico ingresado no es válido.' },
        400,
        cors.headers,
      );
    }

    if (password.length < 8) {
      return jsonResponse(
        { error: 'La contraseña inicial debe tener al menos 8 caracteres.' },
        400,
        cors.headers,
      );
    }

    const { data: createdData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createError || !createdData.user) {
      console.error(
        'Supabase Auth createUser error in admin-create-user:',
        createError?.message ?? 'missing user object',
      );
      const rawAuthMsg = createError?.message ?? '';
      const isDuplicateEmail =
        createError?.code === 'email_exists' ||
        /already\s+(?:been\s+)?registered|already\s+exists/i.test(rawAuthMsg);

      return jsonResponse(
        {
          error: isDuplicateEmail
            ? 'Ya existe una cuenta registrada con ese correo electrónico.'
            : 'No se pudo crear la cuenta en Supabase Auth.',
        },
        400,
        cors.headers,
      );
    }

    return jsonResponse(
      {
        user: {
          id: createdData.user.id,
          email: createdData.user.email,
        },
        message: 'Usuario creado y aprovisionado correctamente.',
      },
      201,
      cors.headers,
    );
  } catch (err) {
    console.error('Unexpected error in admin-create-user:', err);
    return jsonResponse(
      { error: 'Ocurrió un error interno inesperado al crear el usuario.' },
      500,
      cors.headers,
    );
  }
});
