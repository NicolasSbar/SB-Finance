-- ============================================================================
-- MIGRACIÓN DE ENDURECIMIENTO FASE 2 — SB-FINANCE
-- ============================================================================
-- Decisiones de Arquitectura:
-- 1. Drop previo de sobrecarga en `update_installment_purchase`:
--    PostgreSQL distingue funciones por su lista de argumentos; eliminar la
--    firma previa de 8 parámetros antes de crear la de 9 (`p_is_gustito`)
--    evita ambigüedades en PostgREST al invocar la RPC desde el cliente.
-- 2. Restricciones CHECK de defensa en profundidad para ingresos:
--    Además de la validación en Zod y la UI, PostgreSQL garantiza a nivel de
--    motor que ninguna categoría o transacción `type = 'income'` pueda tener
--    `is_gustito = true` o `monthly_limit` asignado, saneando filas previas
--    antes de aplicar cada constraint.
-- 3. Higiene de cron legado:
--    Desagenda de forma idempotente el job legado `'sb-finance-keep-alive-daily'`
--    si aún conviviera con `'sb-finance-keep-alive-dev'`.
-- 4. Ingreso extra directo a Bóveda de Ahorros (`save_to_savings` + `source_transaction_id`):
--    Permite marcar un ingreso (`type = 'income'`) para que se aparte automáticamente
--    en `savings_entries` mediante una FK `source_transaction_id` con `ON DELETE CASCADE`,
--    de modo que anular o eliminar el ingreso revierta también el depósito en ahorros.
-- 5. Cola persistente de solicitudes Telegram (`telegram_pending_requests`) y `pg_cron`:
--    Resguarda texto, audio en Base64 y `local_date` cuando Gemini devuelve 503/429/5xx,
--    reintentando cada 1 minuto hasta un máximo de 2 horas desde `process-telegram-queue`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. RPC `update_installment_purchase` con soporte para `p_is_gustito`
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.update_installment_purchase(
  UUID,
  UUID,
  VARCHAR,
  NUMERIC,
  SMALLINT,
  DATE,
  DATE,
  TEXT
);

CREATE OR REPLACE FUNCTION public.update_installment_purchase(
  p_purchase_id UUID,
  p_category_id UUID,
  p_description VARCHAR,
  p_installment_amount NUMERIC(12, 2),
  p_installments_count SMALLINT,
  p_purchase_date DATE,
  p_first_installment_date DATE,
  p_notes TEXT DEFAULT NULL,
  p_is_gustito BOOLEAN DEFAULT false
)
RETURNS public.installment_purchases
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_paid_count INT;
  v_purchase public.installment_purchases;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.installment_purchases ip
    WHERE ip.id = p_purchase_id
      AND ip.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Compra en cuotas no encontrada o sin permisos';
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

  SELECT COUNT(*) INTO v_paid_count
  FROM public.monthly_commitments
  WHERE installment_purchase_id = p_purchase_id
    AND user_id = v_user_id
    AND is_paid = true;

  IF v_paid_count = 0 THEN
    -- Si ninguna cuota fue pagada aún, se puede regenerar la estructura completa
    UPDATE public.installment_purchases
    SET
      category_id = p_category_id,
      description = trim(p_description),
      installment_amount = p_installment_amount,
      installments_count = p_installments_count,
      total_amount = ROUND(p_installment_amount * p_installments_count, 2),
      purchase_date = p_purchase_date,
      first_installment_date = p_first_installment_date,
      notes = p_notes,
      is_gustito = COALESCE(p_is_gustito, is_gustito)
    WHERE id = p_purchase_id AND user_id = v_user_id
    RETURNING * INTO v_purchase;

    DELETE FROM public.monthly_commitments
    WHERE installment_purchase_id = p_purchase_id AND user_id = v_user_id;

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
  ELSE
    -- Si ya hay cuotas pagadas, se preservan intactas las pagadas y se actualizan las pendientes
    UPDATE public.monthly_commitments
    SET
      category_id = p_category_id,
      name = trim(p_description) || ' (' || installment_number || '/' || total_installments || ')',
      amount = CASE WHEN is_paid = false THEN p_installment_amount ELSE amount END,
      notes = p_notes
    WHERE installment_purchase_id = p_purchase_id
      AND user_id = v_user_id;

    UPDATE public.installment_purchases
    SET
      category_id = p_category_id,
      description = trim(p_description),
      installment_amount = p_installment_amount,
      total_amount = (
        SELECT COALESCE(SUM(amount), 0.00)
        FROM public.monthly_commitments
        WHERE installment_purchase_id = p_purchase_id AND user_id = v_user_id
      ),
      purchase_date = p_purchase_date,
      notes = p_notes,
      is_gustito = COALESCE(p_is_gustito, is_gustito)
    WHERE id = p_purchase_id AND user_id = v_user_id
    RETURNING * INTO v_purchase;
  END IF;

  RETURN v_purchase;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Restricciones CHECK defensivas para evitar marcas de Gustito/Límite en ingresos
-- ----------------------------------------------------------------------------
UPDATE public.categories
SET
  is_gustito = false,
  monthly_limit = NULL
WHERE type = 'income'
  AND (is_gustito = true OR monthly_limit IS NOT NULL);

ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS chk_categories_income_no_gustito_or_limit,
  ADD CONSTRAINT chk_categories_income_no_gustito_or_limit
    CHECK (type = 'expense' OR (is_gustito = false AND monthly_limit IS NULL));

UPDATE public.transactions
SET is_gustito = false
WHERE type = 'income'
  AND is_gustito = true;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS chk_transactions_income_no_gustito,
  ADD CONSTRAINT chk_transactions_income_no_gustito
    CHECK (type = 'expense' OR is_gustito = false);

-- ----------------------------------------------------------------------------
-- 3. Limpieza idempotente de job cron legado de Fase 1
-- ----------------------------------------------------------------------------
SELECT cron.unschedule('sb-finance-keep-alive-daily')
WHERE EXISTS (
  SELECT 1
  FROM cron.job
  WHERE jobname = 'sb-finance-keep-alive-daily'
);

-- ----------------------------------------------------------------------------
-- 4. Soporte para Ingreso Extra Directo a Bóveda de Ahorros (Telegram + Web)
-- ----------------------------------------------------------------------------
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS save_to_savings BOOLEAN NOT NULL DEFAULT false;

UPDATE public.transactions
SET save_to_savings = false
WHERE type = 'expense'
  AND save_to_savings = true;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS chk_transactions_expense_no_save_to_savings,
  ADD CONSTRAINT chk_transactions_expense_no_save_to_savings
    CHECK (type = 'income' OR save_to_savings = false);

ALTER TABLE public.savings_entries
  ADD COLUMN IF NOT EXISTS source_transaction_id UUID NULL
    REFERENCES public.transactions(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_savings_entries_source_tx
  ON public.savings_entries (source_transaction_id)
  WHERE source_transaction_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 5. Cola persistente de resiliencia ante errores transitorios de Gemini (503/429)
-- ----------------------------------------------------------------------------
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

DROP TRIGGER IF EXISTS trg_telegram_pending_requests_updated_at ON public.telegram_pending_requests;
CREATE TRIGGER trg_telegram_pending_requests_updated_at
  BEFORE UPDATE ON public.telegram_pending_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.telegram_pending_requests ENABLE ROW LEVEL SECURITY;
-- Sin políticas para anon/authenticated: tabla operativa exclusiva de Edge Functions con service_role.

SELECT cron.unschedule('sb-finance-process-telegram-queue')
WHERE EXISTS (
  SELECT 1
  FROM cron.job
  WHERE jobname = 'sb-finance-process-telegram-queue'
);

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
