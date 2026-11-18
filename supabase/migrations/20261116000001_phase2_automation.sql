-- ============================================================================
-- MIGRACIÓN FASE 2 (AUTOMATIZACIÓN E INTELIGENCIA) — SB-FINANCE
-- Motor: PostgreSQL 15+ (Supabase)
-- Reglas: NUMERIC(12,2) para dinero, DATE para fechas, RLS estricto por auth.uid()
-- ============================================================================
-- Decisiones de Arquitectura:
-- 1. Inmutabilidad histórica de categorías por mes (`monthly_category_snapshots`):
--    Congela `is_gustito` y `monthly_limit` en `YYYY-MM-01` al inicializar cada
--    período. Así, cambiar si una categoría es "Gustito" o modificar su límite en
--    diciembre nunca altera las métricas históricas de noviembre.
-- 2. Deduplicación atómica de Webhook (`telegram_processed_updates`):
--    Telegram entrega mensajes con garantía at-least-once. Al usar `update_id`
--    como PRIMARY KEY sin políticas públicas, PostgreSQL actúa como cerrojo atómico
--    evitando registros duplicados si Telegram reintenta tras una demora de red.
-- 3. Drop previo de sobrecarga en `create_installment_purchase`:
--    PostgreSQL considera funciones con distinta cantidad de parámetros como
--    sobrecargas diferentes; eliminar la firma de 7 parámetros de Fase 1 evita
--    ambigüedad en PostgREST al invocar la nueva firma de 9 parámetros con defaults.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXTENSIONES DE TABLAS EXISTENTES (FASE 1 -> FASE 2)
-- ----------------------------------------------------------------------------

-- 1.1 user_settings: presupuesto base de Gustitos y zona horaria IANA
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS gustitos_budget NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (gustitos_budget >= 0 AND gustitos_budget <= 9999999999.99),
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires'
    CHECK (char_length(trim(timezone)) >= 3);

-- 1.2 monthly_budgets: snapshot mensual de presupuesto de Gustitos
ALTER TABLE public.monthly_budgets
  ADD COLUMN IF NOT EXISTS gustitos_budget NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (gustitos_budget >= 0 AND gustitos_budget <= 9999999999.99);

-- 1.3 categories: pertenencia a bolsa de Gustitos (default false) y límite mensual opcional
ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS is_gustito BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monthly_limit NUMERIC(12, 2) NULL
    CHECK (monthly_limit IS NULL OR (monthly_limit > 0 AND monthly_limit <= 9999999999.99));

-- 1.4 transactions: marca puntual de Gustito (permite "me di un gustito" por chat o web)
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_gustito BOOLEAN NOT NULL DEFAULT false;

-- 1.5 installment_purchases: origen ('web' | 'telegram') y marca opcional de Gustito
ALTER TABLE public.installment_purchases
  ADD COLUMN IF NOT EXISTS is_gustito BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source VARCHAR(15) NOT NULL DEFAULT 'web'
    CHECK (source IN ('web', 'telegram'));

-- ----------------------------------------------------------------------------
-- 2. NUEVA TABLA: monthly_category_snapshots (Inmutabilidad Histórica)
-- Congela is_gustito y monthly_limit por categoría y mes al inicializar el período.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.monthly_category_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_date DATE NOT NULL CHECK (EXTRACT(DAY FROM month_date) = 1),
  category_id UUID NOT NULL,
  is_gustito BOOLEAN NOT NULL DEFAULT false,
  monthly_limit NUMERIC(12, 2) NULL
    CHECK (monthly_limit IS NULL OR (monthly_limit > 0 AND monthly_limit <= 9999999999.99)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_monthly_category_snapshot UNIQUE (user_id, month_date, category_id),
  CONSTRAINT fk_monthly_cat_snapshots_category_user
    FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_monthly_cat_snapshots_user_month
  ON public.monthly_category_snapshots (user_id, month_date DESC);

DROP TRIGGER IF EXISTS trg_monthly_category_snapshots_updated_at ON public.monthly_category_snapshots;
CREATE TRIGGER trg_monthly_category_snapshots_updated_at
  BEFORE UPDATE ON public.monthly_category_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. NUEVAS TABLAS DE VINCULACIÓN Y SESIONES DE TELEGRAM
-- ----------------------------------------------------------------------------

-- 3.1 telegram_links: Relación estricta 1:1 user_id <-> telegram_chat_id
CREATE TABLE IF NOT EXISTS public.telegram_links (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_chat_id BIGINT NOT NULL UNIQUE,
  telegram_username VARCHAR(100),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_telegram_links_updated_at ON public.telegram_links;
CREATE TRIGGER trg_telegram_links_updated_at
  BEFORE UPDATE ON public.telegram_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3.2 telegram_link_codes: Códigos alfanuméricos temporales (TTL 15 min)
CREATE TABLE IF NOT EXISTS public.telegram_link_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code VARCHAR(12) NOT NULL UNIQUE CHECK (char_length(trim(code)) >= 6),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user_active
  ON public.telegram_link_codes (user_id, expires_at DESC)
  WHERE used_at IS NULL;

-- 3.3 telegram_conversation_sessions: Máquina de estados multi-turno del bot
CREATE TABLE IF NOT EXISTS public.telegram_conversation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL UNIQUE,
  intent VARCHAR(30) NOT NULL CHECK (intent IN ('expense', 'income', 'installment_purchase')),
  pending_step VARCHAR(40) NOT NULL
    CHECK (pending_step IN (
      'awaiting_category',
      'awaiting_amount',
      'awaiting_description',
      'awaiting_installment_details',
      'awaiting_first_installment_date'
    )),
  draft_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_sessions_expires
  ON public.telegram_conversation_sessions (expires_at);

DROP TRIGGER IF EXISTS trg_telegram_sessions_updated_at ON public.telegram_conversation_sessions;
CREATE TRIGGER trg_telegram_sessions_updated_at
  BEFORE UPDATE ON public.telegram_conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3.4 telegram_action_logs: Trazabilidad para [❌ Anular] (ventana 24h e idempotencia)
CREATE TABLE IF NOT EXISTS public.telegram_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  action_type VARCHAR(30) NOT NULL
    CHECK (action_type IN ('expense', 'income', 'installment_purchase')),
  target_table VARCHAR(30) NOT NULL
    CHECK (target_table IN ('transactions', 'installment_purchases')),
  target_id UUID NOT NULL,
  telegram_message_id BIGINT,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_action_logs_user_created
  ON public.telegram_action_logs (user_id, created_at DESC);

-- 3.5 telegram_processed_updates: Deduplicación atómica de updates de Telegram Webhook
CREATE TABLE IF NOT EXISTS public.telegram_processed_updates (
  update_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.6 notification_logs: Control anti-spam semanal (7 días) e hitos mensuales
CREATE TABLE IF NOT EXISTS public.notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_date DATE NOT NULL CHECK (EXTRACT(DAY FROM month_date) = 1),
  alert_type VARCHAR(50) NOT NULL CHECK (alert_type IN (
    'category_warning_80',
    'category_exceeded_100',
    'fixed_limit_warning_80',
    'fixed_limit_exceeded_100',
    'mid_month_pending_reminder',
    'end_of_month_pending_reminder'
  )),
  reference_id UUID,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_lookup
  ON public.notification_logs (user_id, month_date, alert_type, reference_id, sent_at DESC);

-- ----------------------------------------------------------------------------
-- 4. POLÍTICAS ROW LEVEL SECURITY (RLS) PARA NUEVAS TABLAS
-- ----------------------------------------------------------------------------
ALTER TABLE public.monthly_category_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_conversation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_action_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_processed_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

-- monthly_category_snapshots
DROP POLICY IF EXISTS "monthly_cat_snapshots_select_own" ON public.monthly_category_snapshots;
CREATE POLICY "monthly_cat_snapshots_select_own" ON public.monthly_category_snapshots
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "monthly_cat_snapshots_insert_own" ON public.monthly_category_snapshots;
CREATE POLICY "monthly_cat_snapshots_insert_own" ON public.monthly_category_snapshots
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "monthly_cat_snapshots_update_own" ON public.monthly_category_snapshots;
CREATE POLICY "monthly_cat_snapshots_update_own" ON public.monthly_category_snapshots
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "monthly_cat_snapshots_delete_own" ON public.monthly_category_snapshots;
CREATE POLICY "monthly_cat_snapshots_delete_own" ON public.monthly_category_snapshots
  FOR DELETE USING (auth.uid() = user_id);

-- telegram_links (el cliente puede consultar y desvincular; la vinculación la realiza la Edge Function con service_role)
DROP POLICY IF EXISTS "telegram_links_select_own" ON public.telegram_links;
CREATE POLICY "telegram_links_select_own" ON public.telegram_links
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "telegram_links_delete_own" ON public.telegram_links;
CREATE POLICY "telegram_links_delete_own" ON public.telegram_links
  FOR DELETE USING (auth.uid() = user_id);

-- telegram_link_codes (el usuario autenticado puede ver, crear e invalidar sus códigos)
DROP POLICY IF EXISTS "telegram_link_codes_select_own" ON public.telegram_link_codes;
CREATE POLICY "telegram_link_codes_select_own" ON public.telegram_link_codes
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "telegram_link_codes_insert_own" ON public.telegram_link_codes;
CREATE POLICY "telegram_link_codes_insert_own" ON public.telegram_link_codes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "telegram_link_codes_update_own" ON public.telegram_link_codes;
CREATE POLICY "telegram_link_codes_update_own" ON public.telegram_link_codes
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- telegram_conversation_sessions (lectura/limpieza propia; gestionada principalmente por service_role en webhook)
DROP POLICY IF EXISTS "telegram_sessions_select_own" ON public.telegram_conversation_sessions;
CREATE POLICY "telegram_sessions_select_own" ON public.telegram_conversation_sessions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "telegram_sessions_delete_own" ON public.telegram_conversation_sessions;
CREATE POLICY "telegram_sessions_delete_own" ON public.telegram_conversation_sessions
  FOR DELETE USING (auth.uid() = user_id);

-- telegram_action_logs (solo lectura propia; escritura vía service_role)
DROP POLICY IF EXISTS "telegram_action_logs_select_own" ON public.telegram_action_logs;
CREATE POLICY "telegram_action_logs_select_own" ON public.telegram_action_logs
  FOR SELECT USING (auth.uid() = user_id);

-- notification_logs (solo lectura propia; escritura vía service_role)
DROP POLICY IF EXISTS "notification_logs_select_own" ON public.notification_logs;
CREATE POLICY "notification_logs_select_own" ON public.notification_logs
  FOR SELECT USING (auth.uid() = user_id);

-- telegram_processed_updates: sin políticas para anon/authenticated (exclusiva de service_role)

-- ----------------------------------------------------------------------------
-- 5. ACTUALIZACIÓN DE FUNCIONES RPC (SNAPSHOTS Y CUOTAS)
-- ----------------------------------------------------------------------------

-- 5.1 ensure_monthly_period: agrega gustitos_budget y snapshots por categoría
CREATE OR REPLACE FUNCTION public.ensure_monthly_period(p_month_date DATE)
RETURNS public.monthly_budgets
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_normalized_month DATE := date_trunc('month', p_month_date)::DATE;
  v_settings public.user_settings;
  v_budget public.monthly_budgets;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_settings
  FROM public.user_settings
  WHERE user_id = v_user_id;

  -- 1. Crear snapshot en monthly_budgets si no existe
  INSERT INTO public.monthly_budgets (
    user_id,
    month_date,
    fixed_salary,
    monthly_savings_target,
    fixed_expenses_limit,
    gustitos_budget
  )
  VALUES (
    v_user_id,
    v_normalized_month,
    COALESCE(v_settings.fixed_salary, 0.00),
    COALESCE(v_settings.monthly_savings_target, 0.00),
    COALESCE(v_settings.fixed_expenses_limit, 0.00),
    COALESCE(v_settings.gustitos_budget, 0.00)
  )
  ON CONFLICT (user_id, month_date) DO NOTHING;

  -- 2. Congelar snapshot de categorías de gasto para ese mes (si no existe aún)
  INSERT INTO public.monthly_category_snapshots (
    user_id,
    month_date,
    category_id,
    is_gustito,
    monthly_limit
  )
  SELECT
    v_user_id,
    v_normalized_month,
    c.id,
    c.is_gustito,
    c.monthly_limit
  FROM public.categories c
  WHERE c.user_id = v_user_id
    AND c.type = 'expense'
  ON CONFLICT (user_id, month_date, category_id) DO NOTHING;

  -- 3. Instanciar gastos fijos activos que aún no estén en ese mes
  INSERT INTO public.monthly_commitments (
    user_id,
    month_date,
    category_id,
    commitment_type,
    fixed_expense_template_id,
    name,
    amount,
    due_date,
    is_paid,
    notes
  )
  SELECT
    v_user_id,
    v_normalized_month,
    t.category_id,
    'fixed_expense',
    t.id,
    t.name,
    t.default_amount,
    CASE
      WHEN t.due_day IS NOT NULL THEN
        (v_normalized_month + (LEAST(t.due_day, EXTRACT(DAY FROM (v_normalized_month + INTERVAL '1 month - 1 day'))::INT) - 1) * INTERVAL '1 day')::DATE
      ELSE NULL
    END,
    false,
    t.notes
  FROM public.fixed_expense_templates t
  WHERE t.user_id = v_user_id
    AND t.is_active = true
  ON CONFLICT (user_id, fixed_expense_template_id, month_date)
  WHERE fixed_expense_template_id IS NOT NULL
  DO NOTHING;

  SELECT * INTO v_budget
  FROM public.monthly_budgets
  WHERE user_id = v_user_id AND month_date = v_normalized_month;

  RETURN v_budget;
END;
$$;

-- 5.2 create_installment_purchase: reemplaza firma previa y agrega p_is_gustito y p_source
DROP FUNCTION IF EXISTS public.create_installment_purchase(
  UUID,
  VARCHAR,
  NUMERIC,
  SMALLINT,
  DATE,
  DATE,
  TEXT
);

CREATE OR REPLACE FUNCTION public.create_installment_purchase(
  p_category_id UUID,
  p_description VARCHAR,
  p_installment_amount NUMERIC(12, 2),
  p_installments_count SMALLINT,
  p_purchase_date DATE,
  p_first_installment_date DATE,
  p_notes TEXT DEFAULT NULL,
  p_is_gustito BOOLEAN DEFAULT false,
  p_source VARCHAR DEFAULT 'web'
)
RETURNS public.installment_purchases
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_total_amount NUMERIC(12, 2);
  v_purchase public.installment_purchases;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.categories c
    WHERE c.id = p_category_id
      AND c.user_id = v_user_id
      AND c.type = 'expense'
  ) THEN
    RAISE EXCEPTION 'La categoría seleccionada no existe, no pertenece al usuario o no es de tipo gasto.';
  END IF;

  v_total_amount := ROUND(p_installment_amount * p_installments_count, 2);

  INSERT INTO public.installment_purchases (
    user_id,
    category_id,
    description,
    installment_amount,
    installments_count,
    total_amount,
    purchase_date,
    first_installment_date,
    notes,
    is_gustito,
    source
  )
  VALUES (
    v_user_id,
    p_category_id,
    trim(p_description),
    p_installment_amount,
    p_installments_count,
    v_total_amount,
    p_purchase_date,
    p_first_installment_date,
    p_notes,
    COALESCE(p_is_gustito, false),
    CASE WHEN p_source IN ('web', 'telegram') THEN p_source ELSE 'web' END
  )
  RETURNING * INTO v_purchase;

  INSERT INTO public.monthly_commitments (
    user_id,
    month_date,
    category_id,
    commitment_type,
    installment_purchase_id,
    name,
    amount,
    due_date,
    installment_number,
    total_installments,
    is_paid,
    notes
  )
  SELECT
    v_user_id,
    date_trunc('month', (p_first_installment_date + (i - 1) * INTERVAL '1 month'))::DATE,
    p_category_id,
    'installment',
    v_purchase.id,
    trim(p_description) || ' (' || i || '/' || p_installments_count || ')',
    p_installment_amount,
    (p_first_installment_date + (i - 1) * INTERVAL '1 month')::DATE,
    i::SMALLINT,
    p_installments_count,
    false,
    p_notes
  FROM generate_series(1, p_installments_count) AS s(i);

  RETURN v_purchase;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. CONFIGURACIÓN DE pg_cron + pg_net (ALERTAS DIARIAS Y KEEP-ALIVE)
-- Nota operativa: En Supabase Cloud se debe habilitar pg_cron y pg_net desde
-- Database -> Extensions, y almacenar `supabase_project_url`, `supabase_anon_key`
-- y `cron_internal_secret` en Supabase Vault (`vault.secrets`).
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 6.1 Job horario para alertas diarias a las 08:00 AM según timezone de cada usuario
-- Ejecuta en minuto 0 de cada hora; `daily-alerts` filtra usuarios cuya hora local == 08.
SELECT cron.unschedule('sb-finance-daily-alerts')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sb-finance-daily-alerts');

SELECT cron.schedule(
  'sb-finance-daily-alerts',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_project_url' LIMIT 1) || '/functions/v1/daily-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_internal_secret' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', NOW())
  );
  $$
);

-- 6.2 Keep-alive diario (Etapa 1 — Desarrollo): petición HTTP liviana diaria a Supabase REST
SELECT cron.unschedule('sb-finance-keep-alive-dev')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sb-finance-keep-alive-dev');

SELECT cron.schedule(
  'sb-finance-keep-alive-dev',
  '0 12 * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_project_url' LIMIT 1) || '/rest/v1/',
    headers := jsonb_build_object(
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key' LIMIT 1)
    )
  );
  $$
);
