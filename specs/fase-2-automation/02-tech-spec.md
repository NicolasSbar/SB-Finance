# Especificación Técnica — Fase 2 (Automatización e Inteligencia) — SB-Finance

> **Versión:** 1.0.0  
> **Estado:** Aprobado para implementación  
> **Documentos base:** `specs/constitution.md`, `specs/product_roadmap.md`, `specs/fase-1-core/02-tech-spec.md`, `specs/fase-2-automation/01-functional-spec.md`

---

## 1. Migración Incremental SQL (`supabase/migrations/20261116000001_phase2_automation.sql`)

La migración extiende el esquema de Fase 1 de forma no destructiva (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), agrega las tablas de automatización/Telegram con RLS estricto, actualiza las funciones RPC manteniendo retrocompatibilidad con Fase 1 y configura `pg_cron` + `pg_net`.

```sql
-- ============================================================================
-- MIGRACIÓN FASE 2 (AUTOMATIZACIÓN E INTELIGENCIA) — SB-FINANCE
-- Motor: PostgreSQL 15+ (Supabase)
-- Reglas: NUMERIC(12,2) para dinero, DATE para fechas, RLS estricto por auth.uid()
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

-- 1.4 transactions: marca puntual de Gustito y flag de Ingreso Directo a Ahorro
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_gustito BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS save_to_savings BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS chk_transactions_expense_no_save_to_savings,
  ADD CONSTRAINT chk_transactions_expense_no_save_to_savings
    CHECK (type = 'income' OR save_to_savings = false);

-- 1.4b savings_entries: referencia opcional a un ingreso extra apartado directamente a ahorros
ALTER TABLE public.savings_entries
  ADD COLUMN IF NOT EXISTS source_transaction_id UUID NULL
    REFERENCES public.transactions(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_savings_entries_source_tx
  ON public.savings_entries (source_transaction_id)
  WHERE source_transaction_id IS NOT NULL;

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

-- 3.7 telegram_pending_requests: Cola persistente para reintentos ante 503/429/5xx de Gemini
CREATE TABLE IF NOT EXISTS public.telegram_pending_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  message_text TEXT NULL,
  audio_base64 TEXT NULL,
  audio_mime_type VARCHAR(60) NULL,
  local_date DATE NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  currency VARCHAR(10) NOT NULL DEFAULT 'ARS',
  session_draft_json JSONB NULL,
  session_pending_step VARCHAR(40) NULL,
  session_intent VARCHAR(30) NULL,
  status VARCHAR(25) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed_permanent')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 hours'),
  last_error TEXT NULL,
  processed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_requests_queue
  ON public.telegram_pending_requests (status, next_retry_at ASC, created_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_telegram_pending_requests_chat
  ON public.telegram_pending_requests (chat_id, status);

CREATE TRIGGER trg_telegram_pending_requests_updated_at
  BEFORE UPDATE ON public.telegram_pending_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

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
ALTER TABLE public.telegram_pending_requests ENABLE ROW LEVEL SECURITY;

-- monthly_category_snapshots
CREATE POLICY "monthly_cat_snapshots_select_own" ON public.monthly_category_snapshots
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "monthly_cat_snapshots_insert_own" ON public.monthly_category_snapshots
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "monthly_cat_snapshots_update_own" ON public.monthly_category_snapshots
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "monthly_cat_snapshots_delete_own" ON public.monthly_category_snapshots
  FOR DELETE USING (auth.uid() = user_id);

-- telegram_links (el cliente puede consultar y desvincular; la vinculación la realiza la Edge Function con service_role)
CREATE POLICY "telegram_links_select_own" ON public.telegram_links
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "telegram_links_delete_own" ON public.telegram_links
  FOR DELETE USING (auth.uid() = user_id);

-- telegram_link_codes (el usuario autenticado puede ver, crear e invalidar sus códigos)
CREATE POLICY "telegram_link_codes_select_own" ON public.telegram_link_codes
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "telegram_link_codes_insert_own" ON public.telegram_link_codes
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "telegram_link_codes_update_own" ON public.telegram_link_codes
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- telegram_conversation_sessions (lectura/limpieza propia; gestionada principalmente por service_role en webhook)
CREATE POLICY "telegram_sessions_select_own" ON public.telegram_conversation_sessions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "telegram_sessions_delete_own" ON public.telegram_conversation_sessions
  FOR DELETE USING (auth.uid() = user_id);

-- telegram_action_logs (solo lectura propia; escritura vía service_role)
CREATE POLICY "telegram_action_logs_select_own" ON public.telegram_action_logs
  FOR SELECT USING (auth.uid() = user_id);

-- notification_logs (solo lectura propia; escritura vía service_role)
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

-- 5.2 create_installment_purchase: agrega p_is_gustito y p_source con defaults retrocompatibles
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

-- 6.3 Job por minuto para procesar cola pendiente de Telegram (process-telegram-queue)
SELECT cron.unschedule('sb-finance-process-telegram-queue')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sb-finance-process-telegram-queue');

SELECT cron.schedule(
  'sb-finance-process-telegram-queue',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_project_url' LIMIT 1) || '/functions/v1/process-telegram-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_internal_secret' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', NOW())
  );
  $$
);
```

> **Nota sobre `handle_new_user()` y migración incremental de endurecimiento (`20261116000002_phase2_audit_fixes.sql`):**
> - `handle_new_user()` no requiere cambios respecto a Fase 1 porque las nuevas columnas `user_settings.gustitos_budget` (`0.00`), `user_settings.timezone` (`'America/Argentina/Buenos_Aires'`) y `categories.is_gustito` (`false`) tienen valores por defecto en motor; todas las categorías base creadas automáticamente iniciarán con `is_gustito = false` y `monthly_limit = NULL`.
> - Tras la auditoría SDD y evoluciones de Fase 2, se incorpora la migración incremental `supabase/migrations/20261116000002_phase2_audit_fixes.sql` para: (1) extender `update_installment_purchase` con `p_is_gustito BOOLEAN DEFAULT false` manteniendo paridad con `create_installment_purchase`; (2) agregar restricciones `CHECK` defensivas (`categories`: `type = 'expense' OR (is_gustito = false AND monthly_limit IS NULL)`; `transactions`: `type = 'expense' OR is_gustito = false`, `type = 'income' OR save_to_savings = false`); (3) desagendar si existe el job legado `'sb-finance-keep-alive-daily'`; (4) agregar soporte de ingresos directos a ahorros (`save_to_savings` + `savings_entries.source_transaction_id`); y (5) crear `telegram_pending_requests` junto al job `pg_cron` `'sb-finance-process-telegram-queue'` (`* * * * *`).

---

## 2. Arquitectura de Supabase Edge Functions (Deno)

Todas las Edge Functions viven en `supabase/functions/` en runtime **Deno** con importaciones aisladas vía `deno.json` (sin usar `package.json` del frontend).

### 2.1 Variables de Entorno / Secretos de Edge Functions (Supabase Cloud)
Configurados mediante `supabase secrets set` (nunca expuestos en React/Vite):
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (inyectadas por Supabase).
- `SUPABASE_ANON_KEY` (para validar JWT en `notify-gustitos-alert`).
- `TELEGRAM_BOT_TOKEN`: Token privado del bot obtenido con `@BotFather`.
- `TELEGRAM_WEBHOOK_SECRET`: Token secreto aleatorio configurado al registrar el webhook (`setWebhook(..., secret_token)`).
- `GEMINI_API_KEY`: Clave de Google AI Studio para `gemini-3.8-flash` (vía REST `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`, enviada en header `x-goog-api-key`).
- `CRON_INTERNAL_SECRET`: Secreto compartido entre Supabase Vault (`cron_internal_secret`), `daily-alerts` y `process-telegram-queue`.

### 2.2 Módulo Compartido de Edge Functions (`supabase/functions/_shared/`)
Para evitar duplicar lógica entre `telegram-webhook`, `process-telegram-queue`, `notify-gustitos-alert` y `daily-alerts`, creamos helpers puros en Deno:
- `supabase/functions/_shared/telegramApi.ts`:
  - `sendTelegramMessage(botToken, chatId, text, replyMarkup?)`
  - `editTelegramMessage(botToken, chatId, messageId, text)`
  - `answerCallbackQuery(botToken, callbackQueryId, text?, showAlert?)`
  - `getTelegramFileBytes(botToken, fileId)` (descarga binaria vía `getFile` + `/file/bot<token>/<file_path>`)
- `supabase/functions/_shared/financeHelpers.ts`:
  - `getLocalDateParts(timezone, date?)` usando `Intl.DateTimeFormat('en-CA', { timeZone: timezone, ... })` para obtener `yyyyMmDd`, `monthStart` (`YYYY-MM-01`), `hour` (`0..23`), `day` (`1..31`) y `daysInMonth` sin desfases UTC.
  - `computeGustitosStatus(supabaseAdmin, userId, monthDate)`: calcula `gustitosBudget`, `gustitosSpent` (excluyendo `fixed_expense`, sumando variables con `tx.is_gustito OR snap.is_gustito` + cuotas de categorías gustito o `installment_purchase.is_gustito`) y `remaining`.
  - `computeCategoryLimitStatus(supabaseAdmin, userId, monthDate, categoryId)`: calcula `monthlyLimit` del snapshot/categoría y `spent` (variables `expense` + compromisos `fixed_expense` + `installment` de esa categoría en el mes).
  - `formatCurrencyARS(amount, currency)`: formato legible `$ 15.000,00`.
- `supabase/functions/_shared/telegramIntentProcessor.ts`:
  - Tipos compartidos (`GeminiParsedIntent`, `ActiveCategory`, `ConversationSession`), clase `TransientAiError` (`429, 500, 502, 503, 504` o error de red) y `isTransientStatusCode`.
  - `callGeminiFlash(...)`: invoca `gemini-3.8-flash` con **1 reintento rápido** (`1500 ms`) ante errores transitorios antes de lanzar `TransientAiError`.
  - `mergeWithActiveSessionDraft`, `normalizeAndValidateParsedIntent`, `persistCompleteIntent`, `promptForClarification` y `dispatchParsedIntent` (con soporte de `headerPrefix` opcional para mensajes diferidos desde la cola).

### 2.3 Edge Function: `supabase/functions/telegram-webhook/index.ts`
Flujo paso a paso de ejecución:
1. **Autenticación del Webhook (`constitution.md`):**
   - Rechaza métodos distintos a `POST` (`405`).
   - Compara `req.headers.get('X-Telegram-Bot-Api-Secret-Token')` contra `TELEGRAM_WEBHOOK_SECRET` usando comparación de tiempo constante; si falta o no coincide, retorna `401 Unauthorized`.
2. **Deduplicación de Reintentos (`update_id`):**
   - Inserta `update.update_id` en `telegram_processed_updates`. Si falla por clave duplicada (`23505`), responde `200 OK` inmediatamente sin reprocesar.
3. **Router de Eventos (`message` vs. `callback_query`):**
   - **Rama A — `callback_query`:**
     - `data.startsWith('void:')`: ejecuta flujo de `[❌ Anular]`:
       1. Busca `telegram_action_logs` por `id` y verifica que `chat_id` pertenezca al usuario **y** que el vínculo siga activo en `telegram_links`.
       2. Si `voided_at !== null`, responde `"Este registro ya fue anulado."`, edita el mensaje quitando el teclado inline (pasando `{ parseMode: 'HTML' }`) y termina (idempotente).
       3. Verifica ventana de 24 horas: `Date.now() - new Date(log.created_at).getTime() <= 24 * 60 * 60 * 1000`. Si venció, responde alerta `"El botón Anular solo es válido por 24 horas. Podés eliminarlo desde la app web."` y quita el botón.
       4. Si `target_table === 'installment_purchases'`, consulta `monthly_commitments` buscando filas con `installment_purchase_id = log.target_id` y `is_paid = true`. Si existe alguna (`count > 0`), bloquea y responde `"No se puede anular desde Telegram porque ya tiene cuotas pagadas en la web."`
       5. Ejecuta `DELETE` en `transactions` (que también dispara `ON DELETE CASCADE` sobre `savings_entries` si era un ingreso con `save_to_savings = true`) o `installment_purchases` (que dispara `ON DELETE CASCADE` sobre `monthly_commitments`). Si ya no existía (`0` filas), igualmente marca `voided_at` e informa que ya había sido eliminado.
       6. Actualiza `telegram_action_logs.voided_at = NOW()`, edita el mensaje original agregando `"\n\n❌ *Anulado*"` sin botones y llama a `answerCallbackQuery`.
     - `data.startsWith('pick_cat:')`: completa una sesión multi-turno `awaiting_category` eligiendo `category_id`, valida sesión vigente y persiste el movimiento.
     - `data === 'cancel_session'`: borra la sesión de `telegram_conversation_sessions`, cancela/limpia solicitudes `pending` en `telegram_pending_requests` para ese `chat_id` y confirma `"Operación cancelada."`.
   - **Rama B — Comandos (`/start`, `/ayuda`, `/cancelar`, `/vincular <CODE>`):**
     - `/vincular <CODE>`: normaliza el código (`trim().toUpperCase()`), busca en `telegram_link_codes` con `used_at IS NULL` y `expires_at > NOW()`. Verifica si `chat_id` ya existe en `telegram_links`:
       - Si existe para **otro `user_id`**: rechaza pidiendo desvincular primero la cuenta original.
       - Si existe para el **mismo `user_id`**: informa que la cuenta ya está vinculada.
       - Si está libre: inserta/vincula en `telegram_links`, marca `used_at = NOW()` y responde confirmación.
     - `/cancelar`: elimina sesión activa en `telegram_conversation_sessions` y solicitudes `pending` en `telegram_pending_requests` para ese `chat_id`, y confirma.
     - Para cualquier otro mensaje: exige que exista `telegram_links` para `chat_id`. Si no existe, responde pidiendo vincular desde `/settings`.
4. **Acuse de Recibo Inmediato + Validación Previa de Audio:**
   - Si viene `message.voice` o `message.audio`, verifica primero `duration > 60` o `file_size > 5 * 1024 * 1024`. Si excede, responde `"El audio no puede durar más de 60 segundos. Por favor enviá uno más corto o escribilo por texto."` y termina con `200 OK`.
   - Una vez verificado que el mensaje (texto o nota de voz dentro del límite) es procesable, el bot envía **de inmediato** un primer mensaje de acuse de recibo: `"⏳ Mensaje recibido, estamos procesando la transacción..."`. Posteriormente, el resultado final (confirmación, solicitud de aclaración o error) se envía como un **segundo mensaje separado** debajo.
   - Si es audio válido, descarga los bytes del `.ogg`/audio y los convierte a Base64 en bloques de 8192 bytes (`btoa` sobre chunks de `Uint8Array`) para enviar como `inline_data` (`mime_type` normalizado a `'audio/ogg'` o el MIME reportado) a Gemini Flash.
5. **Sesión Multi-Turno + Extracción con Gemini Flash:**
   - Consulta si existe una sesión activa en `telegram_conversation_sessions` (`expires_at > NOW()`).
   - Obtiene el `timezone` del usuario y calcula su `todayLocal` (`YYYY-MM-DD`).
   - Carga las categorías activas del usuario (`id`, `name`, `type`).
   - Envía a Gemini Flash con `generationConfig: { responseMimeType: "application/json", temperature: 0.1 }` (autenticado vía header `x-goog-api-key`) el texto o audio + contexto de categorías + `draft_json` si existe sesión activa. Al recibir la respuesta en flujo multi-turno, aplica un **merge defensivo en TypeScript** conservando los campos no nulos ya capturados en `activeSession.draft_json` (incluyendo `save_to_savings`) si el LLM omitió repetirlos.
   - **Esquema JSON estricto esperado de Gemini:**
     ```typescript
     interface GeminiParsedIntent {
       status: 'complete' | 'needs_clarification' | 'unrecognized' | 'out_of_scope_fixed_term';
       intent: 'expense' | 'income' | 'installment_purchase' | null;
       amount: number | null; // En cuotas: DEBE ser el monto de CADA cuota, nunca el total dividido
       description: string | null;
       category_id: string | null;
       category_confidence: 'high' | 'low';
       is_gustito: boolean; // true si el usuario dijo "me di un gustito" o similar
       save_to_savings: boolean; // true cuando intent === 'income' y el usuario pide enviarlo directo a ahorros
       transaction_date: string | null; // YYYY-MM-DD en hora local
       installments_count: number | null;
       first_installment_date: string | null; // YYYY-MM-DD obligatoria en cuotas
       missing_fields: Array<'category' | 'installment_amount' | 'installments_count' | 'first_installment_date' | 'amount' | 'description'>;
       clarification_message: string | null;
     }
     ```
   - **Reglas del prompt de sistema hacia Gemini:**
     - Si el usuario menciona Plazo Fijo -> `status = 'out_of_scope_fixed_term'`.
     - Si es mensaje casual sin monto ni descripción clara (y sin sesión activa) -> `status = 'unrecognized'`.
     - Si es compra en cuotas y el usuario dio el **precio total** en vez del **valor por cuota**, o no especificó `first_installment_date` -> `status = 'needs_clarification'`, **prohibido dividir automáticamente**.
     - Si no tiene certeza alta sobre qué categoría elegir entre las disponibles -> `category_id = null`, `category_confidence = 'low'`, `status = 'needs_clarification'`.
     - Si es un ingreso extra (`intent = 'income'`) y el usuario indica en el mismo mensaje o audio que quiere destinarlo directamente a ahorros (*"mandalo a ahorro"*, *"directo a ahorros"*, *"para el fondo de ahorro"*, etc.) -> `save_to_savings = true` (en cualquier otro caso `false`).
6. **Ejecución de Persistencia y Respuesta Enriquecida:**
   - Si `status === 'unrecognized'`: responde pidiendo reenviar los datos completos y adjunta ejemplos de texto/audio válidos.
   - Si `status === 'needs_clarification'`: guarda/actualiza `telegram_conversation_sessions` (`expires_at = NOW() + 15 min`). Si falta categoría, envía teclado inline con botones de categorías activas (`pick_cat:<uuid>`) + botón `Cancelar`; si falta dato de cuota, envía pregunta puntual.
   - Si `status === 'complete'`:
     - Inicializa `monthly_budgets` y `monthly_category_snapshots` del mes correspondiente **únicamente si `affectedMonth <= currentMonth`** (evitando congelar prematuramente snapshots de meses futuros ante cuotas adelantadas; usando helper SQL/service_role equivalente a `ensure_monthly_period` para ese `user_id`).
     - Inserta en `transactions` (`source: 'telegram'`, incluyendo `save_to_savings: intent === 'income' ? Boolean(parsed.save_to_savings) : false`) o crea `installment_purchases` + `N` `monthly_commitments` (`source: 'telegram'`).
     - Si `intent === 'income'` y `save_to_savings === true`, inserta simultáneamente una entrada `entry_type = 'deposit'` en `savings_entries` vinculada mediante `source_transaction_id = transaction.id` (si falla la inserción en `savings_entries`, revierte la fila de `transactions`). Así la ecuación del Dashboard suma `+$X` en Ingresos Extra y resta `-$X` en Ahorro Extra del mes, manteniendo intacto el `Disponible Real` gastable mientras incrementa la Bóveda de Ahorros.
     - Registra fila en `telegram_action_logs` y borra cualquier sesión multi-turno previa.
     - Calcula saldo restante de Gustitos (si `gustitos_budget > 0` y el gasto es gustito) y saldo restante del límite de categoría (si `monthly_limit > 0`).
     - Envía un segundo mensaje enriquecido + botón inline `[❌ Anular]` (`void:<action_log_id>`), indicando explícitamente cuando un ingreso extra fue enviado directamente a la Bóveda de Ahorros.
     - Si es gasto de Gustitos, `gustitos_budget > 0` y `remaining <= 0`, agrega/dispara el aviso inmediato de alerta en rojo/emergencia.
   - **Resiliencia ante `TransientAiError` (`503`, `429`, `5xx`, timeout):** si `callGeminiFlash` agota su reintento rápido y lanza `TransientAiError`, el webhook inserta los datos recolectados (`user_id`, `chat_id`, `message_text`, `audio_base64`, `audio_mime_type`, `local_date`, `timezone`, `currency`, `session_draft_json`, `session_pending_step`, `session_intent`) en `telegram_pending_requests` (`status = 'pending'`, `expires_at = NOW() + 2 hours`) y responde al usuario con el aviso personalizado informando que sus datos quedaron guardados y se procesarán automáticamente apenas se restablezca el servicio.

### 2.4 Edge Function: `supabase/functions/notify-gustitos-alert/index.ts`
- **Propósito:** Disparar la alerta en tiempo real a Telegram cuando el usuario registra o edita un gasto desde la **Web** que deja la bolsa de Gustitos en `<= $0`.
- **Seguridad:** Valida el `Authorization: Bearer <jwt>` del usuario con `SUPABASE_ANON_KEY`, obtiene `callerUser.id` y luego opera con `SUPABASE_SERVICE_ROLE_KEY`.
- **Lógica:**
  1. Recibe `{ monthDate: string, transactionId?: string, purchaseId?: string }`.
  2. Verifica si el usuario tiene chat en `telegram_links` y si `gustitos_budget > 0` en ese mes.
  3. Verifica que el movimiento consultado pertenezca a Gustitos (por `tx.is_gustito` o `snapshot.is_gustito` de su categoría; nunca `fixed_expense`).
  4. Calcula `computeGustitosStatus(supabaseAdmin, callerUser.id, monthDate)`.
  5. Si `remaining <= 0`, envía mensaje inmediato al Telegram del usuario informando que la bolsa de Gustitos alcanzó/superó el límite (`remaining <= 0`).

### 2.5 Edge Function: `supabase/functions/daily-alerts/index.ts`
- **Propósito:** Ejecutada cada hora por `pg_cron` + `pg_net`.
- **Seguridad:** Valida header `X-Cron-Secret === Deno.env.get('CRON_INTERNAL_SECRET')`. Rechaza con `401` si no coincide.
- **Lógica:**
  1. Obtiene todos los registros de `telegram_links` unidos a `user_settings`.
  2. Para cada usuario, calcula `localParts = getLocalDateParts(user.timezone)`:
     - Si `localParts.hour !== 8`, lo salta (solo procesa usuarios cuya hora local actual sea las **08:00 AM**).
  3. Para los usuarios en ventana `08:00 AM`:
     - **A. Límites individuales por categoría (`> 80%` y `>= 100%`):**
       - Obtiene `monthly_category_snapshots` del `monthStart` local (o `categories` si no existe snapshot) donde `monthly_limit > 0`.
       - Suma `transactions` (`type = 'expense'`) + `monthly_commitments` por categoría del mes local.
       - Si `% >= 100`: evalúa `alert_type = 'category_exceeded_100'`. Si `% > 80 && % < 100`: evalúa `alert_type = 'category_warning_80'`.
       - Consulta `notification_logs` para `(user_id, month_date, alert_type, reference_id = category_id)` en los últimos **7 días**. Si no hay envío reciente, envía alerta a Telegram e inserta log.
     - **B. Límite mensual de gastos fijos + cuotas (`> 80%` y `>= 100%`):**
       - Toma `fixed_expenses_limit` de `monthly_budgets` (o `user_settings`).
       - Suma `monthly_commitments` del `monthStart` local.
       - Aplica la misma lógica `> 80%` / `>= 100%` con cooldown de **7 días** en `notification_logs` (`fixed_limit_warning_80` / `fixed_limit_exceeded_100`).
     - **C. Recordatorios de compromisos pendientes (`is_paid = false`):**
       - Si `localParts.day === 15`: `alert_type = 'mid_month_pending_reminder'`.
       - Si `localParts.day === (localParts.daysInMonth - 7)`: `alert_type = 'end_of_month_pending_reminder'`.
       - Si coincide con alguno de esos días, existen compromisos del mes con `is_paid = false` y no existe log previo de ese `alert_type` en `month_date`, envía resumen con cantidad y monto total pendiente e inserta en `notification_logs`.

### 2.6 Edge Function: `supabase/functions/process-telegram-queue/index.ts`
- **Propósito:** Worker automático ejecutado cada 1 minuto por `pg_cron` + `pg_net` para procesar solicitudes de Telegram encoladas tras fallas transitorias (`503`, `429`, `5xx`, red).
- **Seguridad:** Valida método `POST` y header `X-Cron-Secret === Deno.env.get('CRON_INTERNAL_SECRET')` usando `timingSafeEqualStr` (`401` si no coincide).
- **Lógica:**
  1. **Expiración (> 2 horas):** Marca como `status = 'failed_permanent'` y limpia `audio_base64` en las filas `pending` con `expires_at <= NOW()`, enviando un único aviso final al chat del usuario para que reenvíe el movimiento.
  2. **Selección y bloqueo optimista:** Obtiene hasta 10 filas `pending` con `next_retry_at <= NOW()` ordenadas cronológicamente (`created_at ASC`). Para cada fila ejecuta un `UPDATE ... SET status = 'processing' WHERE id = row.id AND status = 'pending' RETURNING *` para evitar procesamientos duplicados entre ejecuciones concurrentes.
  3. **Reconstrucción de contexto y ejecución:** Verifica que el vínculo en `telegram_links` siga activo, carga categorías activas y la sesión multi-turno (o reconstruye la sesión desde `session_draft_json` si la de 15 min venció durante la caída), e invoca `callGeminiFlash` usando `todayLocal = row.local_date` (preservando la fecha original del mensaje).
  4. **Resultado:**
     - Si Gemini responde: ejecuta `dispatchParsedIntent` con `headerPrefix: '🔄 <b>Solicitud pendiente procesada:</b>'`, actualiza a `status = 'completed'`, `processed_at = NOW()` y limpia `audio_base64 = null`.
     - Si vuelve a lanzar `TransientAiError`: aplica *backoff* en minutos (`[1, 2, 5, 10, 15]`) según `attempts + 1`. Si la próxima fecha superaría `expires_at`, marca `failed_permanent` y notifica una sola vez; de lo contrario, reprograma `next_retry_at` devolviendo `status = 'pending'` en silencio.

---

## 3. Tipos TypeScript (`strict: true`) y Esquemas `zod`

### 3.1 Nuevos Tipos en `src/types/database.types.ts`
- Extender `UserSettings` con `gustitos_budget: number` y `timezone: string`.
- Extender `MonthlyBudget` con `gustitos_budget: number`.
- Extender `Category` con `is_gustito: boolean` y `monthly_limit: number | null`.
- Extender `Transaction` y `TransactionInput` con `is_gustito: boolean` y `save_to_savings?: boolean`.
- Extender `SavingsEntry` con `source_transaction_id?: string | null`.
- Extender `InstallmentPurchase` y `InstallmentPurchaseInput` con `is_gustito?: boolean`.
- Nuevas interfaces:
  - `MonthlyCategorySnapshot`: `{ id, user_id, month_date, category_id, is_gustito, monthly_limit, created_at, updated_at }`
  - `TelegramLink`: `{ user_id, telegram_chat_id, telegram_username, linked_at, updated_at }`
  - `TelegramLinkCode`: `{ id, user_id, code, expires_at, used_at, created_at }`
  - `CategoryLimitProgress`: `{ categoryId, categoryName, icon, isGustito, monthlyLimit, spent, usagePercent, remaining }`
  - `GustitosSummary`: `{ isConfigured: boolean; budget: number; spent: number; remaining: number; gustitoCategoriesCount: number; isExceeded: boolean }`
- Extender `MonthlyFinancialSummary` con `gustitos: GustitosSummary` y `categoryLimits: CategoryLimitProgress[]`.

### 3.2 Nuevos/Actualizados Esquemas `zod` en `src/lib/validations.ts`
- `userSettingsSchema` y `monthlyBudgetSnapshotSchema`: agregan `gustitos_budget` (`>= 0` y `<= MAX_MONEY`) y `timezone` (`string().trim().min(3).max(64)`).
- `categorySchema`: agrega `is_gustito: z.boolean().default(false)` y `monthly_limit`: número opcional (`null` o `>= 0.01 && <= MAX_MONEY`).
- `transactionSchema`: agrega `is_gustito: z.boolean().default(false)` y `save_to_savings: z.boolean().optional().default(false)`.

---

## 4. Estructura de Archivos Nuevos / Modificados en `src/` y Lineamientos UI

### 4.1 Árbol Incremental Fase 2
```text
SB-Finance/
├── supabase/
│   ├── migrations/
│   │   ├── 20261116000001_phase2_automation.sql
│   │   └── 20261116000002_phase2_audit_fixes.sql (hardening RPC/CHECK/cron)
│   └── functions/
│       ├── _shared/
│       │   ├── telegramApi.ts
│       │   ├── financeHelpers.ts
│       │   └── telegramIntentProcessor.ts
│       ├── telegram-webhook/
│       │   ├── deno.json
│       │   └── index.ts
│       ├── process-telegram-queue/
│       │   ├── deno.json
│       │   └── index.ts
│       ├── notify-gustitos-alert/
│       │   ├── deno.json
│       │   └── index.ts
│       └── daily-alerts/
│           ├── deno.json
│           └── index.ts
└── src/
    ├── types/
    │   └── database.types.ts (modificado)
    ├── lib/
    │   ├── formatters.ts (modificado: helpers de timezone y opciones IANA)
    │   └── validations.ts (modificado)
    ├── services/
    │   ├── settingsService.ts (modificado: gustitos_budget, timezone)
    │   ├── categoriesService.ts (modificado: is_gustito, monthly_limit y sync mes actual)
    │   ├── transactionsService.ts (modificado: is_gustito + invocación async notify-gustitos-alert)
    │   ├── commitmentsService.ts (modificado: is_gustito en cuotas + invocación async notify-gustitos-alert)
    │   └── telegramService.ts (nuevo: generar código, consultar vínculo, desvincular)
    ├── hooks/
    │   └── useDashboardData.ts (modificado: cálculo de Gustitos y límites por categoría)
    └── features/
        ├── settings/
        │   ├── SettingsPage.tsx (modificado)
        │   ├── BudgetSettingsForm.tsx (modificado: gustitos_budget + timezone + selector rápido Gustitos)
        │   └── TelegramLinkCard.tsx (nuevo: generación de código, countdown, estado, desvincular)
        ├── categories/
        │   ├── CategoriesPage.tsx (modificado: barra de progreso de límite e insignia Gustito)
        │   └── CategoryFormModal.tsx (modificado: toggle is_gustito y campo monthly_limit)
        ├── commitments/
        │   ├── InstallmentFormModal.tsx (modificado: checkbox "Contar esta compra en la bolsa de Gustitos")
        │   └── InstallmentsList.tsx (modificado: badges "Gustito" y "Telegram")
        ├── transactions/
        │   ├── TransactionFormModal.tsx (modificado: checkbox "Contar en bolsa de Gustitos")
        │   └── TransactionsTable.tsx (modificado: badges "Gustito" / "Telegram" y aria-label por fila)
        └── dashboard/
            ├── DashboardPage.tsx (modificado: integra widgets Gustitos y Límites)
            ├── GustitosProgressWidget.tsx (nuevo: barra regresiva o aviso de configuración)
            ├── CategoryLimitsWidget.tsx (nuevo: barras de progreso de categorías con límite)
            └── PendingCommitmentsWidget.tsx (modificado: copy "Marcar pendiente" y loadingText)
```

### 4.2 Lineamientos UI (Paleta Amarillo/Negro)
- **Barra Regresiva de Gustitos (`GustitosProgressWidget.tsx`):**
  - Contenedor `#121212` con borde `#262626`, radio `8px` (`rounded-lg`), cifras en `.tabular-nums`.
  - **Estado sin configurar (`gustitos_budget <= 0 || (gustitoCategoriesCount === 0 && spent <= 0)`):** Borde sutil en `#FACC15/40`, texto claro indicando qué falta configurar (`Presupuesto de Gustitos` y/o `Categorías de Gustitos`) con enlaces directos a `/settings` y `/categories`. Nunca en rojo.
  - **Estado activo saludable (`remaining > 0`):** Barra que representa el **saldo restante** (`(remaining / budget) * 100%`) decreciendo de izquierda a derecha en amarillo marca `#FACC15` sobre fondo `#262626`.
  - **Estado agotado/excedido (`remaining <= 0`):** Barra completa en **rojo semántico `#EF4444`**, borde `#EF4444/60`, fondo tintado `rgba(239, 68, 68, 0.12)` y texto de alerta en `#F87171` mostrando el monto restante (`$ 0,00` o negativo).
- **Límites por Categoría (`CategoryLimitsWidget.tsx` y `CategoriesPage.tsx`):**
  - `<= 80%`: barra `#FACC15`.
  - `> 80% y < 100%`: barra `#EAB308` con badge de advertencia `"Cerca del tope"`.
  - `>= 100%`: barra `#EF4444` con badge `"Límite superado"`.
- **Tarjetas de Telegram (`TelegramLinkCard.tsx`):**
  - Código alfanumérico mostrado en tipografía monoespaciada (`font-mono tracking-widest text-2xl text-[#FACC15]`) con botón `"Copiar comando"` (`Verbo + Objeto`), contador regresivo en vivo de los 15 minutos (deteniendo el intervalo al expirar), refresco automático al recuperar foco de ventana (`focus`/`visibilitychange`) y touch targets `>= 44px`.
- **Visibilidad y Accesibilidad en Tablas y Formularios:**
  - `TransactionsTable.tsx` e `InstallmentsList.tsx` muestran `<Badge variant="yellow">Gustito</Badge>` en gastos incluidos en Gustitos y `<Badge variant="neutral">Telegram</Badge>` cuando `source === 'telegram'`.
  - Selector rápido de categorías Gustito en `BudgetSettingsForm.tsx` envuelto en `role="group" aria-labelledby` con ítems de `min-h-[44px]`.

---

## 5. Decisiones de Arquitectura

Los siguientes cuatro puntos explican el fundamento técnico de las decisiones tomadas en la Fase 2:

### 5.1 ¿Por qué deduplicar `update_id` en el Webhook de Telegram (`telegram_processed_updates`)?
Telegram garantiza entrega *at-least-once* (al menos una vez). Si la Edge Function demora más de unos segundos en llamar a Gemini Flash y responder HTTP `200`, o si ocurre un microcorte de red justo antes de que Telegram reciba el `200 OK`, Telegram **reintentará enviar exactamente el mismo JSON** varias veces.
- Sin deduplicación, ese reintento volvería a registrar el mismo gasto 2 o 3 veces.
- Al insertar `update_id` como `PRIMARY KEY` en `telegram_processed_updates` al principio del webhook, PostgreSQL actúa como un cerrojo atómico: si llega un duplicado, la inserción falla por clave única (`23505`) y se devuelve `200 OK` sin volver a ejecutar la IA ni insertar gastos repetidos.

### 5.2 ¿Por qué procesamos el audio `.ogg` en Deno con `Uint8Array` por bloques en lugar de `Buffer` o `ffmpeg`?
En Node.js existe la clase global `Buffer`, y suele recurrirse a convertir `.ogg` a `.mp3` ejecutando binarios como `ffmpeg`.
- En **Supabase Edge Functions (Deno)** no hay `ffmpeg` instalado ni runtime de Node.js por defecto, y usar `String.fromCharCode(...bytes)` con spread operator sobre un archivo de 1 MB provoca un error `RangeError: Maximum call stack size exceeded` porque excede el límite de argumentos en la pila de llamadas de V8.
- **Solución:** Gemini Flash soporta nativamente audio **`audio/ogg` (Opus)** sin transcodificar. Se convierte el `ArrayBuffer` a Base64 recorriendo el `Uint8Array` en bloques de 8 KB (`chunkSize = 8192`). Es rápido, sin dependencias externas y funciona en el sandbox estricto de Deno.

### 5.3 ¿Por qué `pg_cron` corre cada hora (`0 * * * *`) en vez de una vez al día a las 11:00 UTC?
Argentina (`America/Argentina/Buenos_Aires`) es `UTC-3`, por lo que las 08:00 AM locales equivalen a las 11:00 UTC. Si se fijara el cron a las `11:00 UTC`, cuando un usuario configure su `timezone` en `/settings` a España (`UTC+1`) o México (`UTC-6`), recibiría sus alertas matutinas de madrugada o al mediodía.
- Ejecutando el cron cada hora y filtrando en `daily-alerts` con `Intl.DateTimeFormat` qué usuarios están cursando su hora local `08`, se respeta el huso horario individual de cada usuario sin crear un cron job separado por persona.

### 5.4 ¿Por qué combinar `monthly_category_snapshots` con `transactions.is_gustito`?
Conviven dos requerimientos reales:
1. **Reglas por categoría con historia inmutable:** Si en Noviembre la categoría *"Compras"* tenía límite `$ 50.000` y pertenecía a Gustitos, y en Diciembre se retira de Gustitos o se sube su límite a `$ 80.000`, al consultar Noviembre en el historial deben aplicarse las reglas que regían en Noviembre (`monthly_category_snapshots`).
2. **Excepciones puntuales por movimiento:** Al cargar un gasto puntual en una categoría que *no* es de Gustitos (ej. un taxi extra en *"Transporte"*) indicando por Telegram *"me di un gustito hoy"*, guardar `is_gustito` también en la fila de `transactions` permite capturar esa excepción sin contaminar toda la categoría *"Transporte"* en el mes.
