/**
 * Vercel Serverless Function (Etapa 2 — Producción): /api/keep-alive
 *
 * Arquitectura y decisiones técnicas:
 * - Usamos la firma Web estándar (`GET(request: Request): Promise<Response>`) soportada
 *   nativamente por Vercel Functions sin instalar dependencias externas (`@vercel/node`).
 * - Ejecuta un ping HTTP liviano contra la API REST de Supabase (`/rest/v1/user_settings`)
 *   para generar actividad real en el API Gateway y evitar la pausa por inactividad del plan gratuito.
 * - Soporta verificación opcional de `CRON_SECRET` para proteger el endpoint en producción.
 */

declare const process: {
  env: Record<string, string | undefined>;
};

export async function GET(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const supabaseUrl = (
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    ''
  ).trim();
  const supabaseAnonKey = (
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    ''
  ).trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Faltan variables de entorno SUPABASE_URL/VITE_SUPABASE_URL o ANON_KEY.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const targetUrl = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/user_settings?select=user_id&limit=1`;

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
    });

    return new Response(
      JSON.stringify({
        ok: upstreamResponse.ok,
        status: upstreamResponse.status,
        checkedAt: new Date().toISOString(),
      }),
      {
        status: upstreamResponse.ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error de red en keep-alive';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
