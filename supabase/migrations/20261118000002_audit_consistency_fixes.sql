-- ============================================================================
-- MIGRACIÓN DE CONSISTENCIA, SEGURIDAD INVOKER Y RESILIENCIA
-- Archivo: supabase/migrations/20261118000002_audit_consistency_fixes.sql
-- Motor: PostgreSQL 15+ (Supabase)
-- ============================================================================
-- Decisiones de Arquitectura:
-- 1. RPCs duales en `SECURITY INVOKER` + `sb_finance.allow_system_dml`:
--    Las claves nuevas `sb_secret_...` de Supabase ejecutan PostgREST bajo el rol
--    `service_role` sin poblar `request.jwt.claim.role`. Al convertir las 4 RPCs
--    duales (`advance_installments`, `revert_installment_payment_batch`,
--    `create_fixed_term_deposit`, `cancel_fixed_term_deposit`) a `SECURITY INVOKER`
--    y validar `current_user = 'service_role'` además del claim JWT legado,
--    mantenemos el contexto real del llamador. Para los usuarios `authenticated`,
--    habilitamos políticas RLS de escritura en `installment_payment_batches` y
--    `fixed_term_deposits` condicionadas al flag transaccional local
--    `sb_finance.allow_system_dml = 'true'`, bloqueando escrituras directas por
--    PostgREST sin abrir la base a mutaciones arbitrarias del cliente.
-- 2. Restricción estricta de `reconcile_cap_surplus`:
--    Como la Bolsa de Gustitos permanece en el `Disponible Real` hasta gastarse,
--    aceptar `p_bucket = 'gustitos'` generaba ingresos fantasma duplicados.
--    Se restringe `p_bucket` exclusivamente a `'fixed_limit'` y se bloquea
--    cualquier período futuro (`v_month > v_current_local_month`) según la
--    zona horaria configurada del usuario.
-- 3. Recuperación de cola atascada en Telegram:
--    Se agrega `processing_started_at` con índice parcial en
--    `telegram_pending_requests` para detectar y reencolar filas cuya ejecución
--    en Edge Function haya caído por timeout (> 2 minutos en `'processing'`).
-- 4. Mutaciones multi-paso atómicas y privilegios explícitos:
--    Se crean RPCs `SECURITY INVOKER` (`create_transaction_with_savings`,
--    `update_transaction_with_savings`, `create_savings_entry_with_credit`,
--    `sync_gustito_categories_selection`) con `pg_advisory_xact_lock` y validación
--    estricta de `auth.uid()`, y se endurecen `REVOKE`/`GRANT` + `search_path`
--    en las RPCs del sistema.
-- 5. Observabilidad segura de Cron + Vault:
--    Los jobs de `pg_cron` validan de forma explícita la presencia de los
--    secretos en Vault sin exponer valores, normalizan URLs/secretos y suman
--    una función diagnóstica (`get_cron_vault_diagnostics`) restringida a
--    `service_role` que reporta únicamente flags booleanos de existencia.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. RECUPERACIÓN DE FILAS ATASCADAS EN `telegram_pending_requests`
-- ----------------------------------------------------------------------------
ALTER TABLE public.telegram_pending_requests
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ NULL;

-- Backfill seguro por si existieran filas previas ya trabadas en 'processing'
UPDATE public.telegram_pending_requests
SET processing_started_at = COALESCE(updated_at, created_at, NOW())
WHERE status = 'processing'
  AND processing_started_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_pending_requests_processing
  ON public.telegram_pending_requests (processing_started_at ASC)
  WHERE status = 'processing';

-- ----------------------------------------------------------------------------
-- 2. RLS CONTROLADA POR FLAG TRANSACCIONAL `sb_finance.allow_system_dml`
-- ----------------------------------------------------------------------------

-- 2.1 installment_payment_batches: INSERT y UPDATE solo desde RPC autorizada o service_role
DROP POLICY IF EXISTS "installment_batches_insert_own" ON public.installment_payment_batches;
DROP POLICY IF EXISTS "installment_batches_update_own" ON public.installment_payment_batches;
DROP POLICY IF EXISTS "installment_batches_delete_own" ON public.installment_payment_batches;
DROP POLICY IF EXISTS "installment_batches_insert_system" ON public.installment_payment_batches;
DROP POLICY IF EXISTS "installment_batches_update_system" ON public.installment_payment_batches;

CREATE POLICY "installment_batches_insert_system" ON public.installment_payment_batches
  FOR INSERT WITH CHECK (
    (
      auth.uid() = user_id
      AND COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
    )
    OR current_user = 'service_role'
    OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  );

CREATE POLICY "installment_batches_update_system" ON public.installment_payment_batches
  FOR UPDATE
  USING (
    (
      auth.uid() = user_id
      AND COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
    )
    OR current_user = 'service_role'
    OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  )
  WITH CHECK (
    (
      auth.uid() = user_id
      AND COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
    )
    OR current_user = 'service_role'
    OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  );

-- 2.2 fixed_term_deposits: INSERT, UPDATE y DELETE solo desde RPC autorizada o service_role
DROP POLICY IF EXISTS "fixed_terms_insert_own" ON public.fixed_term_deposits;
DROP POLICY IF EXISTS "fixed_terms_update_own" ON public.fixed_term_deposits;
DROP POLICY IF EXISTS "fixed_terms_delete_own" ON public.fixed_term_deposits;
DROP POLICY IF EXISTS "fixed_terms_insert_system" ON public.fixed_term_deposits;
DROP POLICY IF EXISTS "fixed_terms_update_system" ON public.fixed_term_deposits;
DROP POLICY IF EXISTS "fixed_terms_delete_system" ON public.fixed_term_deposits;

CREATE POLICY "fixed_terms_insert_system" ON public.fixed_term_deposits
  FOR INSERT WITH CHECK (
    (
      auth.uid() = user_id
      AND COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
    )
    OR current_user = 'service_role'
    OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  );

CREATE POLICY "fixed_terms_update_system" ON public.fixed_term_deposits
  FOR UPDATE
  USING (
    (
      auth.uid() = user_id
      AND COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
    )
    OR current_user = 'service_role'
    OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  )
  WITH CHECK (
    (
      auth.uid() = user_id
      AND COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
    )
    OR current_user = 'service_role'
    OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  );

CREATE POLICY "fixed_terms_delete_system" ON public.fixed_term_deposits
  FOR DELETE USING (
    (
      auth.uid() = user_id
      AND COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
    )
    OR current_user = 'service_role'
    OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  );

-- 2.3 Guard de `savings_entries`: aceptar `current_user = 'service_role'` y `sb_finance.allow_system_dml = 'true'`
CREATE OR REPLACE FUNCTION public.guard_savings_entries_system_dml()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Edge Functions (service_role con sb_secret_ o JWT) y administración no pasan por este bloqueo
  IF current_user IN ('service_role', 'postgres', 'supabase_admin')
     OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
     OR COALESCE(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Contexto RPC autorizado dentro de la misma transacción
  IF COALESCE(current_setting('sb_finance.allow_system_dml', true), '') = 'true'
     OR COALESCE(current_setting('sb_finance.allow_savings_system_dml', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source_type = 'manual' THEN
      IF NEW.fixed_term_id IS NOT NULL
         OR NEW.source_month_date IS NOT NULL
         OR NEW.source_transaction_id IS NOT NULL THEN
        RAISE EXCEPTION 'Un movimiento manual de ahorro no puede incluir referencias contables internas.';
      END IF;
      RETURN NEW;
    ELSIF NEW.source_type = 'direct_income' THEN
      IF NEW.source_transaction_id IS NOT NULL
         AND NEW.fixed_term_id IS NULL
         AND NEW.source_month_date IS NULL
         AND NEW.entry_type = 'deposit'
         AND EXISTS (
           SELECT 1
           FROM public.transactions t
           WHERE t.id = NEW.source_transaction_id
             AND t.user_id = NEW.user_id
             AND t.type = 'income'
             AND t.save_to_savings = true
             AND t.amount = NEW.amount
             AND t.transaction_date = NEW.entry_date
         ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Un aporte de ingreso directo requiere una transacción de ingreso vinculada con save_to_savings = true.';
    ELSE
      RAISE EXCEPTION 'No está permitido crear directamente movimientos de ahorro de tipo % fuera de las operaciones autorizadas.', NEW.source_type;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.source_type IS DISTINCT FROM OLD.source_type THEN
      RAISE EXCEPTION 'No está permitido cambiar el origen contable (source_type) de un movimiento de ahorro.';
    END IF;

    IF OLD.source_type = 'manual' THEN
      IF NEW.fixed_term_id IS NOT NULL
         OR NEW.source_month_date IS NOT NULL
         OR NEW.source_transaction_id IS NOT NULL THEN
        RAISE EXCEPTION 'Un movimiento manual de ahorro no puede incluir referencias contables internas.';
      END IF;
      RETURN NEW;
    ELSIF OLD.source_type = 'direct_income' THEN
      IF NEW.source_transaction_id = OLD.source_transaction_id
         AND NEW.source_transaction_id IS NOT NULL
         AND NEW.fixed_term_id IS NULL
         AND NEW.source_month_date IS NULL
         AND NEW.entry_type = 'deposit'
         AND EXISTS (
           SELECT 1
           FROM public.transactions t
           WHERE t.id = NEW.source_transaction_id
             AND t.user_id = NEW.user_id
             AND t.type = 'income'
             AND t.save_to_savings = true
             AND t.amount = NEW.amount
             AND t.transaction_date = NEW.entry_date
         ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'No está permitido alterar un aporte de ingreso directo sin una transacción de ingreso coincidente.';
    ELSE
      RAISE EXCEPTION 'No está permitido modificar directamente movimientos de ahorro generados por el sistema (%).', OLD.source_type;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.source_type IN ('manual', 'direct_income') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'No está permitido eliminar directamente movimientos de ahorro generados por el sistema (%).', OLD.source_type;
  END IF;

  RETURN NULL;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. CONVERSIÓN DE LAS 4 RPCs DUALES A `SECURITY INVOKER` + `get_liquid_savings_balance`
-- ----------------------------------------------------------------------------

-- 3.1 get_liquid_savings_balance: incluir `'service_role'` en `current_user`
CREATE OR REPLACE FUNCTION public.get_liquid_savings_balance(p_user_id UUID)
RETURNS NUMERIC(12, 2)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_tz TEXT;
  v_local_month DATE;
  v_frozen_targets NUMERIC(12, 2);
  v_deposits NUMERIC(12, 2);
  v_withdrawals NUMERIC(12, 2);
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'El identificador de usuario es obligatorio.';
  END IF;

  IF v_caller_uid IS NOT NULL THEN
    IF p_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'Sin permisos para consultar el saldo de ahorros de otro usuario.';
    END IF;
  ELSIF v_jwt_role <> 'service_role'
        AND current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings WHERE user_id = p_user_id;

  v_local_month := date_trunc('month', (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE)::DATE;

  SELECT COALESCE(SUM(monthly_savings_target), 0.00) INTO v_frozen_targets
  FROM public.monthly_budgets
  WHERE user_id = p_user_id AND month_date <= v_local_month;

  SELECT
    COALESCE(SUM(CASE WHEN entry_type = 'deposit' THEN amount ELSE 0 END), 0.00),
    COALESCE(SUM(CASE WHEN entry_type = 'withdrawal' THEN amount ELSE 0 END), 0.00)
  INTO v_deposits, v_withdrawals
  FROM public.savings_entries
  WHERE user_id = p_user_id;

  RETURN GREATEST(0.00, ROUND(v_frozen_targets + v_deposits - v_withdrawals, 2));
END;
$$;

-- 3.2 advance_installments: SECURITY INVOKER + dual service_role (sb_secret_ y JWT)
CREATE OR REPLACE FUNCTION public.advance_installments(
  p_purchase_id UUID,
  p_count SMALLINT,
  p_target_month_date DATE,
  p_total_amount NUMERIC(12, 2) DEFAULT NULL,
  p_source VARCHAR DEFAULT 'web',
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_is_service_role BOOLEAN := (current_user = 'service_role' OR v_jwt_role = 'service_role');
  v_user_id UUID;
  v_target_month DATE;
  v_purchase public.installment_purchases;
  v_pending_ids UUID[];
  v_pending_count INT;
  v_batch_id UUID;
  v_base_unit NUMERIC(12, 2);
  v_remainder NUMERIC(12, 2);
  v_final_total NUMERIC(12, 2);
  v_min_total NUMERIC(12, 2);
  v_updated_installments JSONB;
  v_idx INT;
  v_comm_id UUID;
  v_unit_amount NUMERIC(12, 2);
BEGIN
  IF v_caller_uid IS NOT NULL THEN
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'Sin permisos para operar sobre otro usuario.';
    END IF;
    v_user_id := v_caller_uid;
  ELSIF p_actor_user_id IS NOT NULL AND v_is_service_role THEN
    v_user_id := p_actor_user_id;
  ELSE
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_target_month_date IS NULL THEN
    RAISE EXCEPTION 'El mes destino del adelanto es obligatorio.';
  END IF;
  v_target_month := date_trunc('month', p_target_month_date)::DATE;

  IF p_count IS NULL OR p_count < 1 OR p_count > 120 THEN
    RAISE EXCEPTION 'La cantidad de cuotas a adelantar debe estar entre 1 y 120.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  SELECT * INTO v_purchase
  FROM public.installment_purchases
  WHERE id = p_purchase_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Compra en cuotas no encontrada o sin permisos.';
  END IF;

  SELECT ARRAY_AGG(id ORDER BY installment_number ASC) INTO v_pending_ids
  FROM (
    SELECT id, installment_number
    FROM public.monthly_commitments
    WHERE installment_purchase_id = p_purchase_id
      AND user_id = v_user_id
      AND is_paid = false
    ORDER BY installment_number ASC
    LIMIT p_count
    FOR UPDATE
  ) sub;

  v_pending_count := COALESCE(array_length(v_pending_ids, 1), 0);
  IF v_pending_count < p_count THEN
    RAISE EXCEPTION 'Solo quedan % cuota(s) pendiente(s) para "%".', v_pending_count, v_purchase.description;
  END IF;

  IF p_total_amount IS NOT NULL THEN
    v_final_total := ROUND(p_total_amount, 2);
    v_min_total := ROUND(p_count * 0.01, 2);
    IF v_final_total < v_min_total THEN
      RAISE EXCEPTION 'El monto total abonado debe ser de al menos $% para % cuota(s).',
        TO_CHAR(v_min_total, 'FM9999999990.00'), p_count;
    END IF;
    IF v_final_total > 9999999999.99 THEN
      RAISE EXCEPTION 'El monto total abonado supera el máximo permitido.';
    END IF;
    v_base_unit := TRUNC(v_final_total / p_count, 2);
    v_remainder := ROUND(v_final_total - (v_base_unit * p_count), 2);
  ELSE
    SELECT COALESCE(SUM(amount), 0.00) INTO v_final_total
    FROM public.monthly_commitments
    WHERE id = ANY(v_pending_ids);
  END IF;

  PERFORM set_config('sb_finance.allow_system_dml', 'true', true);

  INSERT INTO public.installment_payment_batches (
    user_id,
    installment_purchase_id,
    target_month_date,
    installments_count,
    total_paid_amount,
    source
  )
  VALUES (
    v_user_id,
    p_purchase_id,
    v_target_month,
    p_count,
    v_final_total,
    CASE WHEN p_source IN ('web', 'telegram') THEN p_source ELSE 'web' END
  )
  RETURNING id INTO v_batch_id;

  FOR v_idx IN 1..v_pending_count LOOP
    v_comm_id := v_pending_ids[v_idx];
    IF p_total_amount IS NOT NULL THEN
      v_unit_amount := CASE WHEN v_idx = v_pending_count THEN ROUND(v_base_unit + v_remainder, 2) ELSE v_base_unit END;
    ELSE
      SELECT amount INTO v_unit_amount FROM public.monthly_commitments WHERE id = v_comm_id;
    END IF;

    UPDATE public.monthly_commitments
    SET
      original_month_date = COALESCE(original_month_date, month_date),
      original_due_date = COALESCE(original_due_date, due_date),
      original_amount = COALESCE(original_amount, amount),
      month_date = v_target_month,
      amount = v_unit_amount,
      is_paid = true,
      paid_at = NOW(),
      payment_batch_id = v_batch_id
    WHERE id = v_comm_id AND user_id = v_user_id;
  END LOOP;

  UPDATE public.installment_purchases
  SET total_amount = (
    SELECT COALESCE(SUM(amount), 0.00)
    FROM public.monthly_commitments
    WHERE installment_purchase_id = p_purchase_id AND user_id = v_user_id
  )
  WHERE id = p_purchase_id AND user_id = v_user_id;

  PERFORM set_config('sb_finance.allow_system_dml', 'false', true);

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'installment_number', installment_number,
      'total_installments', total_installments,
      'amount', amount,
      'original_month_date', original_month_date,
      'month_date', month_date
    ) ORDER BY installment_number ASC
  ) INTO v_updated_installments
  FROM public.monthly_commitments
  WHERE id = ANY(v_pending_ids);

  RETURN jsonb_build_object(
    'batch_id', v_batch_id,
    'purchase_id', p_purchase_id,
    'purchase_description', v_purchase.description,
    'category_id', v_purchase.category_id,
    'is_gustito', v_purchase.is_gustito,
    'target_month_date', v_target_month,
    'installments_count', p_count,
    'total_paid_amount', v_final_total,
    'installments', v_updated_installments
  );
END;
$$;

-- 3.3 revert_installment_payment_batch: SECURITY INVOKER + dual service_role
CREATE OR REPLACE FUNCTION public.revert_installment_payment_batch(
  p_batch_id UUID,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_is_service_role BOOLEAN := (current_user = 'service_role' OR v_jwt_role = 'service_role');
  v_user_id UUID;
  v_batch public.installment_payment_batches;
  v_restored_count INT;
BEGIN
  IF v_caller_uid IS NOT NULL THEN
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'Sin permisos para operar sobre otro usuario.';
    END IF;
    v_user_id := v_caller_uid;
  ELSIF p_actor_user_id IS NOT NULL AND v_is_service_role THEN
    v_user_id := p_actor_user_id;
  ELSE
    RAISE EXCEPTION 'No autenticado';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  SELECT * INTO v_batch
  FROM public.installment_payment_batches
  WHERE id = p_batch_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('reverted', false, 'reason', 'batch_not_found');
  END IF;

  IF v_batch.reverted_at IS NOT NULL THEN
    RETURN jsonb_build_object('reverted', false, 'reason', 'already_reverted');
  END IF;

  PERFORM set_config('sb_finance.allow_system_dml', 'true', true);

  UPDATE public.monthly_commitments
  SET
    month_date = COALESCE(original_month_date, month_date),
    due_date = COALESCE(original_due_date, due_date),
    amount = COALESCE(original_amount, amount),
    original_month_date = NULL,
    original_due_date = NULL,
    original_amount = NULL,
    is_paid = false,
    paid_at = NULL,
    payment_batch_id = NULL
  WHERE payment_batch_id = p_batch_id
    AND user_id = v_user_id;

  GET DIAGNOSTICS v_restored_count = ROW_COUNT;

  UPDATE public.installment_purchases
  SET total_amount = (
    SELECT COALESCE(SUM(amount), 0.00)
    FROM public.monthly_commitments
    WHERE installment_purchase_id = v_batch.installment_purchase_id AND user_id = v_user_id
  )
  WHERE id = v_batch.installment_purchase_id AND user_id = v_user_id;

  UPDATE public.installment_payment_batches
  SET reverted_at = NOW()
  WHERE id = p_batch_id AND user_id = v_user_id;

  PERFORM set_config('sb_finance.allow_system_dml', 'false', true);

  RETURN jsonb_build_object(
    'reverted', true,
    'batch_id', p_batch_id,
    'restored_count', v_restored_count
  );
END;
$$;

-- 3.4 create_fixed_term_deposit: SECURITY INVOKER + dual service_role + allow_system_dml
CREATE OR REPLACE FUNCTION public.create_fixed_term_deposit(
  p_institution VARCHAR,
  p_principal_amount NUMERIC(12, 2),
  p_expected_return_amount NUMERIC(12, 2),
  p_start_date DATE,
  p_maturity_date DATE,
  p_origin VARCHAR,
  p_source VARCHAR DEFAULT 'web',
  p_notes TEXT DEFAULT NULL,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS public.fixed_term_deposits
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_is_service_role BOOLEAN := (current_user = 'service_role' OR v_jwt_role = 'service_role');
  v_user_id UUID;
  v_institution TEXT;
  v_principal NUMERIC(12, 2);
  v_expected_return NUMERIC(12, 2);
  v_clean_notes TEXT;
  v_liquid_balance NUMERIC(12, 2);
  v_created public.fixed_term_deposits;
BEGIN
  IF v_caller_uid IS NOT NULL THEN
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'Sin permisos para operar sobre otro usuario.';
    END IF;
    v_user_id := v_caller_uid;
  ELSIF p_actor_user_id IS NOT NULL AND v_is_service_role THEN
    v_user_id := p_actor_user_id;
  ELSE
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_origin IS NULL OR p_origin NOT IN ('monthly_available', 'savings_fund') THEN
    RAISE EXCEPTION 'Origen inválido. Debe ser monthly_available o savings_fund.';
  END IF;

  IF p_start_date IS NULL OR p_maturity_date IS NULL OR p_maturity_date <= p_start_date THEN
    RAISE EXCEPTION 'La fecha de vencimiento debe ser posterior a la fecha de inicio.';
  END IF;

  v_institution := COALESCE(NULLIF(trim(p_institution), ''), 'Plazo Fijo');
  IF char_length(v_institution) < 2 OR char_length(v_institution) > 100 THEN
    RAISE EXCEPTION 'El nombre de la entidad debe tener entre 2 y 100 caracteres.';
  END IF;

  v_principal := ROUND(COALESCE(p_principal_amount, 0.00), 2);
  v_expected_return := ROUND(COALESCE(p_expected_return_amount, 0.00), 2);

  IF v_principal <= 0 OR v_principal > 9999999999.99 THEN
    RAISE EXCEPTION 'El capital invertido debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  IF v_expected_return < v_principal OR v_expected_return > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto a recibir no puede ser menor al capital invertido ni superar el máximo permitido.';
  END IF;

  v_clean_notes := NULLIF(trim(COALESCE(p_notes, '')), '');
  IF v_clean_notes IS NOT NULL AND char_length(v_clean_notes) > 500 THEN
    RAISE EXCEPTION 'Las notas no pueden superar los 500 caracteres.';
  END IF;

  -- Serializar mutaciones patrimoniales del mismo usuario para evitar race conditions
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  IF p_origin = 'savings_fund' THEN
    v_liquid_balance := public.get_liquid_savings_balance(v_user_id);
    IF v_principal > v_liquid_balance THEN
      RAISE EXCEPTION 'Saldo líquido insuficiente en la Bóveda de Ahorros (disponible: $%).', v_liquid_balance;
    END IF;
  END IF;

  PERFORM set_config('sb_finance.allow_system_dml', 'true', true);
  PERFORM set_config('sb_finance.allow_savings_system_dml', 'on', true);

  INSERT INTO public.fixed_term_deposits (
    user_id,
    institution,
    principal_amount,
    expected_return_amount,
    start_date,
    maturity_date,
    origin,
    status,
    source,
    notes
  )
  VALUES (
    v_user_id,
    v_institution,
    v_principal,
    v_expected_return,
    p_start_date,
    p_maturity_date,
    p_origin,
    'active',
    CASE WHEN p_source IN ('web', 'telegram') THEN p_source ELSE 'web' END,
    v_clean_notes
  )
  RETURNING * INTO v_created;

  IF p_origin = 'savings_fund' THEN
    INSERT INTO public.savings_entries (
      user_id,
      month_date,
      entry_type,
      amount,
      entry_date,
      description,
      notes,
      source_type,
      fixed_term_id
    )
    VALUES (
      v_user_id,
      date_trunc('month', p_start_date)::DATE,
      'withdrawal',
      v_principal,
      p_start_date,
      left('Constitución Plazo Fijo: ' || v_created.institution, 150)::VARCHAR(150),
      'Capital trasladado de ahorro líquido a inversión inmovilizada.',
      'fixed_term_constitution',
      v_created.id
    );
  END IF;

  PERFORM set_config('sb_finance.allow_savings_system_dml', 'off', true);
  PERFORM set_config('sb_finance.allow_system_dml', 'false', true);

  RETURN v_created;
END;
$$;

-- 3.5 cancel_fixed_term_deposit: SECURITY INVOKER + dual service_role + allow_system_dml
CREATE OR REPLACE FUNCTION public.cancel_fixed_term_deposit(
  p_fixed_term_id UUID,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_is_service_role BOOLEAN := (current_user = 'service_role' OR v_jwt_role = 'service_role');
  v_user_id UUID;
  v_ft public.fixed_term_deposits;
BEGIN
  IF v_caller_uid IS NOT NULL THEN
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'Sin permisos para operar sobre otro usuario.';
    END IF;
    v_user_id := v_caller_uid;
  ELSIF p_actor_user_id IS NOT NULL AND v_is_service_role THEN
    v_user_id := p_actor_user_id;
  ELSE
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_fixed_term_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del plazo fijo es obligatorio.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  SELECT * INTO v_ft
  FROM public.fixed_term_deposits
  WHERE id = p_fixed_term_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'cancelled', false,
      'reason', 'not_found',
      'fixed_term_id', p_fixed_term_id
    );
  END IF;

  IF v_ft.status <> 'active' THEN
    RETURN jsonb_build_object(
      'cancelled', false,
      'reason', 'not_active',
      'fixed_term_id', p_fixed_term_id,
      'status', v_ft.status
    );
  END IF;

  PERFORM set_config('sb_finance.allow_system_dml', 'true', true);
  PERFORM set_config('sb_finance.allow_savings_system_dml', 'on', true);

  DELETE FROM public.savings_entries
  WHERE fixed_term_id = p_fixed_term_id
    AND user_id = v_user_id;

  DELETE FROM public.fixed_term_deposits
  WHERE id = p_fixed_term_id
    AND user_id = v_user_id
    AND status = 'active';

  PERFORM set_config('sb_finance.allow_savings_system_dml', 'off', true);
  PERFORM set_config('sb_finance.allow_system_dml', 'false', true);

  RETURN jsonb_build_object(
    'cancelled', true,
    'fixed_term_id', p_fixed_term_id,
    'origin', v_ft.origin,
    'principal_amount', v_ft.principal_amount
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. RESTRICCIÓN ESTRICTA DE `reconcile_cap_surplus`
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_cap_surplus(
  p_month_date DATE,
  p_bucket VARCHAR,              -- únicamente 'fixed_limit'
  p_action VARCHAR,              -- 'to_savings' | 'to_available' | 'mark_reviewed'
  p_amount NUMERIC(12, 2) DEFAULT 0.00,
  p_target_income_month DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_month DATE;
  v_month_end DATE;
  v_tz TEXT;
  v_local_today DATE;
  v_current_local_month DATE;
  v_target_income_month DATE;
  v_budget public.monthly_budgets;
  v_spent NUMERIC(12, 2) := 0.00;
  v_transferred NUMERIC(12, 2) := 0.00;
  v_surplus NUMERIC(12, 2) := 0.00;
  v_amount NUMERIC(12, 2) := ROUND(COALESCE(p_amount, 0.00), 2);
  v_income_cat_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_month_date IS NULL THEN
    RAISE EXCEPTION 'El período a conciliar es obligatorio.';
  END IF;
  v_month := date_trunc('month', p_month_date)::DATE;
  v_month_end := (v_month + INTERVAL '1 month - 1 day')::DATE;

  IF p_bucket IS DISTINCT FROM 'fixed_limit' THEN
    RAISE EXCEPTION 'Solo se permite conciliar sobrantes del límite de gastos fijos (fixed_limit).';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('to_savings', 'to_available', 'mark_reviewed') THEN
    RAISE EXCEPTION 'Parámetros inválidos para conciliación de sobrante.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings
  WHERE user_id = v_user_id;

  v_local_today := (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE;
  v_current_local_month := date_trunc('month', v_local_today)::DATE;

  -- Bloquear conciliación o cierre de períodos futuros
  IF v_month > v_current_local_month THEN
    RAISE EXCEPTION 'No se puede conciliar el sobrante de un período futuro (%).', v_month;
  END IF;

  IF p_action = 'mark_reviewed' THEN
    UPDATE public.monthly_budgets
    SET surplus_review_completed_at = NOW()
    WHERE user_id = v_user_id AND month_date = v_month;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'El período % no está inicializado.', v_month;
    END IF;

    RETURN jsonb_build_object('ok', true, 'action', 'mark_reviewed');
  END IF;

  IF v_amount <= 0 OR v_amount > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  IF p_action = 'to_available' AND p_target_income_month IS NOT NULL THEN
    v_target_income_month := date_trunc('month', p_target_income_month)::DATE;
    IF v_target_income_month > v_current_local_month THEN
      RAISE EXCEPTION 'El mes destino del remanente (%) no puede ser posterior al mes actual (%).',
        v_target_income_month, v_current_local_month;
    END IF;
    IF v_target_income_month < v_month THEN
      RAISE EXCEPTION 'El mes destino del remanente (%) no puede ser anterior al período conciliado (%).',
        v_target_income_month, v_month;
    END IF;
    IF v_target_income_month > v_month AND NOT EXISTS (
      SELECT 1
      FROM public.monthly_budgets mb
      WHERE mb.user_id = v_user_id
        AND mb.month_date = v_target_income_month
    ) THEN
      RAISE EXCEPTION 'El período destino % no está inicializado.', v_target_income_month;
    END IF;
  END IF;

  SELECT * INTO v_budget
  FROM public.monthly_budgets
  WHERE user_id = v_user_id AND month_date = v_month
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El período % no está inicializado.', v_month;
  END IF;

  SELECT COALESCE(SUM(mc.amount), 0.00) INTO v_spent
  FROM public.monthly_commitments mc
  LEFT JOIN public.installment_purchases ip ON ip.id = mc.installment_purchase_id
  LEFT JOIN public.monthly_category_snapshots mcs
    ON mcs.user_id = v_user_id AND mcs.month_date = v_month AND mcs.category_id = mc.category_id
  LEFT JOIN public.categories c ON c.id = mc.category_id
  WHERE mc.user_id = v_user_id
    AND mc.month_date = v_month
    AND (
      mc.commitment_type = 'fixed_expense'
      OR (
        mc.commitment_type = 'installment'
        AND COALESCE(ip.is_gustito, false) = false
        AND COALESCE(mcs.is_gustito, c.is_gustito, false) = false
      )
    );

  SELECT COALESCE(SUM(amount), 0.00) INTO v_transferred
  FROM public.savings_entries
  WHERE user_id = v_user_id AND month_date = v_month AND source_type = 'cap_surplus_fixed';

  v_surplus := GREATEST(0.00, ROUND(v_budget.fixed_expenses_limit - v_spent - v_transferred, 2));

  IF v_surplus <= 0 THEN
    RAISE EXCEPTION 'No hay sobrante disponible para trasladar en este rubro.';
  END IF;

  IF v_amount > v_surplus THEN
    RAISE EXCEPTION 'El monto solicitado ($%) supera el sobrante disponible ($%).', v_amount, v_surplus;
  END IF;

  IF p_action = 'to_savings' THEN
    PERFORM set_config('sb_finance.allow_system_dml', 'true', true);
    PERFORM set_config('sb_finance.allow_savings_system_dml', 'on', true);
    INSERT INTO public.savings_entries (
      user_id,
      month_date,
      entry_type,
      amount,
      entry_date,
      description,
      notes,
      source_type,
      source_month_date
    )
    VALUES (
      v_user_id,
      v_month,
      'deposit',
      v_amount,
      LEAST(v_local_today, v_month_end),
      'Sobrante de Límite Fijos a Ahorros',
      'Traslado manual de sobrante de tope mensual sin doble descuento.',
      'cap_surplus_fixed',
      v_month
    );
    PERFORM set_config('sb_finance.allow_savings_system_dml', 'off', true);
    PERFORM set_config('sb_finance.allow_system_dml', 'false', true);
  ELSE
    -- Liberar al Disponible Real: reducir el tope del período para evitar reclamarlo dos veces
    UPDATE public.monthly_budgets
    SET fixed_expenses_limit = GREATEST(0.00, ROUND(fixed_expenses_limit - v_amount, 2))
    WHERE id = v_budget.id;

    -- Si se libera desde el cierre de un mes pasado hacia el mes actual inicializado, acreditar ingreso trazable
    IF v_target_income_month IS NOT NULL AND v_target_income_month > v_month THEN
      SELECT id INTO v_income_cat_id
      FROM public.categories
      WHERE user_id = v_user_id AND type = 'income' AND is_active = true
      ORDER BY (name ILIKE '%extra%') DESC, created_at ASC
      LIMIT 1;

      IF v_income_cat_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró categoría de ingreso activa para trasladar el remanente.';
      END IF;

      INSERT INTO public.transactions (
        user_id, category_id, type, amount, transaction_date, description, notes, source
      )
      VALUES (
        v_user_id,
        v_income_cat_id,
        'income',
        v_amount,
        v_target_income_month,
        'Remanente Límite Fijos mes anterior',
        'Sobrante genuino liberado al Disponible Real al cierre del período previo.',
        'web'
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'bucket', 'fixed_limit',
    'action', p_action,
    'amount', v_amount,
    'remaining_surplus', ROUND(v_surplus - v_amount, 2)
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. NUEVAS RPCs ATÓMICAS PARA MUTACIONES MULTI-PASO DEL CLIENTE
-- ----------------------------------------------------------------------------

-- 5.1 create_transaction_with_savings: crea movimiento (+ ingreso directo a ahorro atómico)
CREATE OR REPLACE FUNCTION public.create_transaction_with_savings(
  p_type VARCHAR,
  p_category_id UUID,
  p_amount NUMERIC(12, 2),
  p_transaction_date DATE,
  p_description VARCHAR,
  p_notes TEXT DEFAULT NULL,
  p_is_gustito BOOLEAN DEFAULT false,
  p_save_to_savings BOOLEAN DEFAULT false,
  p_source VARCHAR DEFAULT 'web'
)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_amount NUMERIC(12, 2);
  v_desc TEXT;
  v_notes TEXT;
  v_is_gustito BOOLEAN;
  v_save_to_savings BOOLEAN;
  v_source VARCHAR(15);
  v_tz TEXT;
  v_local_month DATE;
  v_tx_month DATE;
  v_tx public.transactions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('expense', 'income') THEN
    RAISE EXCEPTION 'Tipo de movimiento inválido. Debe ser expense o income.';
  END IF;

  IF p_transaction_date IS NULL THEN
    RAISE EXCEPTION 'La fecha del movimiento es obligatoria.';
  END IF;

  v_amount := ROUND(COALESCE(p_amount, 0.00), 2);
  IF v_amount < 0.01 OR v_amount > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  v_desc := trim(COALESCE(p_description, ''));
  IF char_length(v_desc) < 2 OR char_length(v_desc) > 150 THEN
    RAISE EXCEPTION 'La descripción debe tener entre 2 y 150 caracteres.';
  END IF;

  v_notes := NULLIF(trim(COALESCE(p_notes, '')), '');
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION 'Las notas no pueden superar los 500 caracteres.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.categories c
    WHERE c.id = p_category_id
      AND c.user_id = v_user_id
      AND c.type = p_type
  ) THEN
    RAISE EXCEPTION 'La categoría seleccionada no existe, no pertenece al usuario o no coincide con el tipo de movimiento.';
  END IF;

  v_is_gustito := CASE WHEN p_type = 'expense' THEN COALESCE(p_is_gustito, false) ELSE false END;
  v_save_to_savings := CASE WHEN p_type = 'income' THEN COALESCE(p_save_to_savings, false) ELSE false END;
  v_source := CASE WHEN p_source IN ('web', 'telegram') THEN p_source ELSE 'web' END;
  v_tx_month := date_trunc('month', p_transaction_date)::DATE;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings
  WHERE user_id = v_user_id;

  v_local_month := date_trunc('month', (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE)::DATE;

  IF v_tx_month >= v_local_month THEN
    PERFORM public.ensure_monthly_period(v_tx_month);
  END IF;

  INSERT INTO public.transactions (
    user_id,
    category_id,
    type,
    amount,
    transaction_date,
    description,
    notes,
    source,
    is_gustito,
    save_to_savings
  )
  VALUES (
    v_user_id,
    p_category_id,
    p_type,
    v_amount,
    p_transaction_date,
    v_desc,
    v_notes,
    v_source,
    v_is_gustito,
    v_save_to_savings
  )
  RETURNING * INTO v_tx;

  IF v_tx.type = 'income' AND v_save_to_savings THEN
    INSERT INTO public.savings_entries (
      user_id,
      month_date,
      entry_type,
      amount,
      entry_date,
      description,
      notes,
      source_type,
      source_transaction_id
    )
    VALUES (
      v_user_id,
      v_tx_month,
      'deposit',
      v_amount,
      p_transaction_date,
      left('Ingreso directo a ahorro: ' || v_desc, 150)::VARCHAR(150),
      COALESCE(v_notes, 'Apartado automáticamente desde ingreso extra registrado en la web.'),
      'direct_income',
      v_tx.id
    );
  END IF;

  RETURN v_tx;
END;
$$;

-- 5.2 update_transaction_with_savings: actualiza movimiento y sincroniza `savings_entries` atómicamente
CREATE OR REPLACE FUNCTION public.update_transaction_with_savings(
  p_transaction_id UUID,
  p_type VARCHAR,
  p_category_id UUID,
  p_amount NUMERIC(12, 2),
  p_transaction_date DATE,
  p_description VARCHAR,
  p_notes TEXT DEFAULT NULL,
  p_is_gustito BOOLEAN DEFAULT false,
  p_save_to_savings BOOLEAN DEFAULT false
)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_amount NUMERIC(12, 2);
  v_desc TEXT;
  v_notes TEXT;
  v_is_gustito BOOLEAN;
  v_save_to_savings BOOLEAN;
  v_tz TEXT;
  v_local_month DATE;
  v_tx_month DATE;
  v_existing public.transactions;
  v_tx public.transactions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del movimiento es obligatorio.';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('expense', 'income') THEN
    RAISE EXCEPTION 'Tipo de movimiento inválido. Debe ser expense o income.';
  END IF;

  IF p_transaction_date IS NULL THEN
    RAISE EXCEPTION 'La fecha del movimiento es obligatoria.';
  END IF;

  v_amount := ROUND(COALESCE(p_amount, 0.00), 2);
  IF v_amount < 0.01 OR v_amount > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  v_desc := trim(COALESCE(p_description, ''));
  IF char_length(v_desc) < 2 OR char_length(v_desc) > 150 THEN
    RAISE EXCEPTION 'La descripción debe tener entre 2 y 150 caracteres.';
  END IF;

  v_notes := NULLIF(trim(COALESCE(p_notes, '')), '');
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION 'Las notas no pueden superar los 500 caracteres.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.categories c
    WHERE c.id = p_category_id
      AND c.user_id = v_user_id
      AND c.type = p_type
  ) THEN
    RAISE EXCEPTION 'La categoría seleccionada no existe, no pertenece al usuario o no coincide con el tipo de movimiento.';
  END IF;

  v_is_gustito := CASE WHEN p_type = 'expense' THEN COALESCE(p_is_gustito, false) ELSE false END;
  v_save_to_savings := CASE WHEN p_type = 'income' THEN COALESCE(p_save_to_savings, false) ELSE false END;
  v_tx_month := date_trunc('month', p_transaction_date)::DATE;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  SELECT * INTO v_existing
  FROM public.transactions
  WHERE id = p_transaction_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movimiento no encontrado o sin permisos.';
  END IF;

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings
  WHERE user_id = v_user_id;

  v_local_month := date_trunc('month', (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE)::DATE;

  IF v_tx_month >= v_local_month THEN
    PERFORM public.ensure_monthly_period(v_tx_month);
  END IF;

  UPDATE public.transactions
  SET
    category_id = p_category_id,
    type = p_type,
    amount = v_amount,
    transaction_date = p_transaction_date,
    description = v_desc,
    notes = v_notes,
    is_gustito = v_is_gustito,
    save_to_savings = v_save_to_savings
  WHERE id = p_transaction_id AND user_id = v_user_id
  RETURNING * INTO v_tx;

  IF v_tx.type = 'income' AND v_save_to_savings THEN
    INSERT INTO public.savings_entries (
      user_id,
      month_date,
      entry_type,
      amount,
      entry_date,
      description,
      notes,
      source_type,
      source_transaction_id
    )
    VALUES (
      v_user_id,
      v_tx_month,
      'deposit',
      v_amount,
      p_transaction_date,
      left('Ingreso directo a ahorro: ' || v_desc, 150)::VARCHAR(150),
      COALESCE(v_notes, 'Apartado automáticamente desde ingreso extra.'),
      'direct_income',
      v_tx.id
    )
    ON CONFLICT (source_transaction_id) WHERE source_transaction_id IS NOT NULL
    DO UPDATE SET
      month_date = EXCLUDED.month_date,
      amount = EXCLUDED.amount,
      entry_date = EXCLUDED.entry_date,
      description = EXCLUDED.description,
      notes = EXCLUDED.notes;
  ELSE
    DELETE FROM public.savings_entries
    WHERE source_transaction_id = v_tx.id
      AND user_id = v_user_id;
  END IF;

  RETURN v_tx;
END;
$$;

-- 5.3 create_savings_entry_with_credit: aporte o retiro con validación atómica de saldo y acreditación opcional
CREATE OR REPLACE FUNCTION public.create_savings_entry_with_credit(
  p_entry_type VARCHAR,
  p_amount NUMERIC(12, 2),
  p_entry_date DATE,
  p_description VARCHAR,
  p_notes TEXT DEFAULT NULL,
  p_credit_to_available BOOLEAN DEFAULT false,
  p_compensatory_category_id UUID DEFAULT NULL
)
RETURNS public.savings_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_amount NUMERIC(12, 2);
  v_desc TEXT;
  v_notes TEXT;
  v_should_credit BOOLEAN;
  v_entry_month DATE;
  v_tz TEXT;
  v_local_month DATE;
  v_liquid_balance NUMERIC(12, 2);
  v_comp_cat_id UUID;
  v_entry public.savings_entries;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_entry_type IS NULL OR p_entry_type NOT IN ('deposit', 'withdrawal') THEN
    RAISE EXCEPTION 'Tipo de movimiento de ahorro inválido. Debe ser deposit o withdrawal.';
  END IF;

  IF p_entry_date IS NULL THEN
    RAISE EXCEPTION 'La fecha del movimiento de ahorro es obligatoria.';
  END IF;

  v_amount := ROUND(COALESCE(p_amount, 0.00), 2);
  IF v_amount < 0.01 OR v_amount > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  v_desc := trim(COALESCE(p_description, ''));
  IF char_length(v_desc) < 2 OR char_length(v_desc) > 150 THEN
    RAISE EXCEPTION 'La descripción debe tener entre 2 y 150 caracteres.';
  END IF;

  v_notes := NULLIF(trim(COALESCE(p_notes, '')), '');
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION 'Las notas no pueden superar los 500 caracteres.';
  END IF;

  v_should_credit := (p_entry_type = 'withdrawal' AND COALESCE(p_credit_to_available, false));
  v_entry_month := date_trunc('month', p_entry_date)::DATE;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  IF p_entry_type = 'withdrawal' THEN
    v_liquid_balance := public.get_liquid_savings_balance(v_user_id);
    IF v_amount > v_liquid_balance THEN
      RAISE EXCEPTION 'El monto a retirar supera el saldo líquido disponible en tu Bóveda de Ahorros (disponible: $%).', v_liquid_balance;
    END IF;
  END IF;

  IF v_should_credit THEN
    IF p_compensatory_category_id IS NOT NULL THEN
      SELECT id INTO v_comp_cat_id
      FROM public.categories
      WHERE id = p_compensatory_category_id
        AND user_id = v_user_id
        AND type = 'income';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'La categoría de ingreso compensatorio no existe o no pertenece al usuario.';
      END IF;
    ELSE
      SELECT id INTO v_comp_cat_id
      FROM public.categories
      WHERE user_id = v_user_id AND type = 'income'
      ORDER BY is_active DESC,
               (lower(name) IN ('ventas / reintegros', 'ingresos extra')) DESC,
               created_at ASC
      LIMIT 1;
    END IF;

    IF v_comp_cat_id IS NULL THEN
      RAISE EXCEPTION 'No se encontró ninguna categoría de ingresos para acreditar el retiro al Disponible del mes.';
    END IF;
  END IF;

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings
  WHERE user_id = v_user_id;

  v_local_month := date_trunc('month', (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE)::DATE;

  IF v_entry_month >= v_local_month AND (p_entry_type = 'deposit' OR v_should_credit) THEN
    PERFORM public.ensure_monthly_period(v_entry_month);
  END IF;

  INSERT INTO public.savings_entries (
    user_id,
    month_date,
    entry_type,
    amount,
    entry_date,
    description,
    notes,
    source_type
  )
  VALUES (
    v_user_id,
    v_entry_month,
    p_entry_type,
    v_amount,
    p_entry_date,
    v_desc,
    v_notes,
    'manual'
  )
  RETURNING * INTO v_entry;

  IF v_should_credit THEN
    INSERT INTO public.transactions (
      user_id,
      category_id,
      type,
      amount,
      transaction_date,
      description,
      notes,
      source,
      is_gustito,
      save_to_savings
    )
    VALUES (
      v_user_id,
      v_comp_cat_id,
      'income',
      v_amount,
      p_entry_date,
      left('Retiro de ahorros: ' || v_desc, 150)::VARCHAR(150),
      COALESCE(v_notes, 'Ingreso compensatorio generado automáticamente desde Bóveda de Ahorros.'),
      'web',
      false,
      false
    );
  END IF;

  RETURN v_entry;
END;
$$;

-- 5.4 sync_gustito_categories_selection: actualiza categorías Gustito + snapshot mensual en 1 transacción
CREATE OR REPLACE FUNCTION public.sync_gustito_categories_selection(
  p_selected_category_ids UUID[],
  p_update_current_month BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_selected_ids UUID[] := COALESCE(p_selected_category_ids, ARRAY[]::UUID[]);
  v_tz TEXT;
  v_local_month DATE := NULL;
  v_updated_categories INT := 0;
  v_synced_snapshots INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  IF EXISTS (
    SELECT 1
    FROM unnest(v_selected_ids) AS sel(id)
    WHERE sel.id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.categories c
        WHERE c.id = sel.id
          AND c.user_id = v_user_id
          AND c.type = 'expense'
      )
  ) THEN
    RAISE EXCEPTION 'Una o más categorías seleccionadas no existen, no pertenecen al usuario o no son de tipo gasto.';
  END IF;

  UPDATE public.categories
  SET is_gustito = (id = ANY(v_selected_ids))
  WHERE user_id = v_user_id
    AND type = 'expense'
    AND is_gustito IS DISTINCT FROM (id = ANY(v_selected_ids));

  GET DIAGNOSTICS v_updated_categories = ROW_COUNT;

  IF COALESCE(p_update_current_month, false) THEN
    SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
    FROM public.user_settings
    WHERE user_id = v_user_id;

    v_local_month := date_trunc('month', (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE)::DATE;

    PERFORM public.ensure_monthly_period(v_local_month);

    INSERT INTO public.monthly_category_snapshots (
      user_id,
      month_date,
      category_id,
      is_gustito,
      monthly_limit
    )
    SELECT
      v_user_id,
      v_local_month,
      c.id,
      c.is_gustito,
      c.monthly_limit
    FROM public.categories c
    WHERE c.user_id = v_user_id
      AND c.type = 'expense'
    ON CONFLICT (user_id, month_date, category_id)
    DO UPDATE SET
      is_gustito = EXCLUDED.is_gustito,
      monthly_limit = EXCLUDED.monthly_limit;

    GET DIAGNOSTICS v_synced_snapshots = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'updated_categories', v_updated_categories,
    'synced_snapshots', v_synced_snapshots,
    'month_date', v_local_month
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. HARDENING `search_path` Y `REVOKE`/`GRANT` EN RPCs DEL SISTEMA
-- ----------------------------------------------------------------------------

-- Triggers internos: bloquear ejecución directa desde PUBLIC y anon, y fijar search_path
ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_is_admin_escalation() SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prevent_is_admin_escalation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guard_savings_entries_system_dml() FROM PUBLIC, anon;

-- RPCs de Fase 1/2
ALTER FUNCTION public.ensure_monthly_period(DATE) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.ensure_monthly_period(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_monthly_period(DATE) TO authenticated, service_role;

ALTER FUNCTION public.create_installment_purchase(UUID, VARCHAR, NUMERIC, SMALLINT, DATE, DATE, TEXT, BOOLEAN, VARCHAR) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.create_installment_purchase(UUID, VARCHAR, NUMERIC, SMALLINT, DATE, DATE, TEXT, BOOLEAN, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_installment_purchase(UUID, VARCHAR, NUMERIC, SMALLINT, DATE, DATE, TEXT, BOOLEAN, VARCHAR) TO authenticated, service_role;

ALTER FUNCTION public.update_installment_purchase(UUID, UUID, VARCHAR, NUMERIC, SMALLINT, DATE, DATE, TEXT, BOOLEAN) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.update_installment_purchase(UUID, UUID, VARCHAR, NUMERIC, SMALLINT, DATE, DATE, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_installment_purchase(UUID, UUID, VARCHAR, NUMERIC, SMALLINT, DATE, DATE, TEXT, BOOLEAN) TO authenticated, service_role;

-- RPCs de Fase 3 actualizadas y restantes
ALTER FUNCTION public.accredit_fixed_term_deposit(UUID, VARCHAR, NUMERIC, DATE) SET search_path = public, pg_temp;
ALTER FUNCTION public.apply_budget_assistant_limits(NUMERIC, NUMERIC, NUMERIC, JSONB, BOOLEAN, DATE) SET search_path = public, pg_temp;
ALTER FUNCTION public.convert_priority_item_to_purchase(UUID, VARCHAR, UUID, VARCHAR, NUMERIC, DATE, SMALLINT, DATE, TEXT, BOOLEAN) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.get_liquid_savings_balance(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_liquid_savings_balance(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.advance_installments(UUID, SMALLINT, DATE, NUMERIC, VARCHAR, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_installments(UUID, SMALLINT, DATE, NUMERIC, VARCHAR, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.revert_installment_payment_batch(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_installment_payment_batch(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_fixed_term_deposit(VARCHAR, NUMERIC, NUMERIC, DATE, DATE, VARCHAR, VARCHAR, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_fixed_term_deposit(VARCHAR, NUMERIC, NUMERIC, DATE, DATE, VARCHAR, VARCHAR, TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.cancel_fixed_term_deposit(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_fixed_term_deposit(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reconcile_cap_surplus(DATE, VARCHAR, VARCHAR, NUMERIC, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_cap_surplus(DATE, VARCHAR, VARCHAR, NUMERIC, DATE) TO authenticated, service_role;

-- Nuevas RPCs atómicas de sincronización y ahorro directo
REVOKE ALL ON FUNCTION public.create_transaction_with_savings(VARCHAR, UUID, NUMERIC, DATE, VARCHAR, TEXT, BOOLEAN, BOOLEAN, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_transaction_with_savings(VARCHAR, UUID, NUMERIC, DATE, VARCHAR, TEXT, BOOLEAN, BOOLEAN, VARCHAR) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_transaction_with_savings(UUID, VARCHAR, UUID, NUMERIC, DATE, VARCHAR, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_transaction_with_savings(UUID, VARCHAR, UUID, NUMERIC, DATE, VARCHAR, TEXT, BOOLEAN, BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_savings_entry_with_credit(VARCHAR, NUMERIC, DATE, VARCHAR, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_savings_entry_with_credit(VARCHAR, NUMERIC, DATE, VARCHAR, TEXT, BOOLEAN, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.sync_gustito_categories_selection(UUID[], BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_gustito_categories_selection(UUID[], BOOLEAN) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. CRON DE `process-telegram-queue` Y `daily-alerts` + DIAGNÓSTICO VAULT
-- ----------------------------------------------------------------------------
-- Nota operativa CRÍTICA:
-- 1. En Supabase Cloud, las Edge Functions `process-telegram-queue`, `daily-alerts`
--    y `telegram-webhook` DEBEN desplegarse con `Verify JWT = OFF` (`--no-verify-jwt`),
--    ya que `pg_cron` autentica mediante `X-Cron-Secret` (sin header `Authorization`)
--    y Telegram autentica mediante `X-Telegram-Bot-Api-Secret-Token`.
-- 2. En Supabase Vault (`vault.secrets`) deben existir exactamente los nombres:
--      - `supabase_project_url` (ej. `https://<project-ref>.supabase.co`, sin `/` final)
--      - `cron_internal_secret` (idéntico al secreto `CRON_INTERNAL_SECRET` de Edge Functions)
--      - `supabase_anon_key` (para `sb-finance-keep-alive-dev`)
--    Jamás guardes secretos en texto plano dentro de migraciones ni del repositorio.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sb-finance-process-telegram-queue') THEN
      PERFORM cron.unschedule('sb-finance-process-telegram-queue');
    END IF;

    PERFORM cron.schedule(
      'sb-finance-process-telegram-queue',
      '* * * * *',
      $cron$
      DO $job$
      DECLARE
        v_base_url TEXT;
        v_cron_secret TEXT;
      BEGIN
        SELECT rtrim(trim(decrypted_secret), '/') INTO v_base_url
        FROM vault.decrypted_secrets
        WHERE name = 'supabase_project_url'
        LIMIT 1;

        SELECT trim(decrypted_secret) INTO v_cron_secret
        FROM vault.decrypted_secrets
        WHERE name = 'cron_internal_secret'
        LIMIT 1;

        IF COALESCE(v_base_url, '') = '' OR COALESCE(v_cron_secret, '') = '' THEN
          RAISE EXCEPTION 'Faltan secretos en Supabase Vault: supabase_project_url o cron_internal_secret.';
        END IF;

        PERFORM net.http_post(
          url := v_base_url || '/functions/v1/process-telegram-queue',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Cron-Secret', v_cron_secret
          ),
          body := jsonb_build_object('triggered_at', NOW())
        );
      END
      $job$;
      $cron$
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sb-finance-daily-alerts') THEN
      PERFORM cron.unschedule('sb-finance-daily-alerts');
    END IF;

    PERFORM cron.schedule(
      'sb-finance-daily-alerts',
      '0 * * * *',
      $cron$
      DO $job$
      DECLARE
        v_base_url TEXT;
        v_cron_secret TEXT;
      BEGIN
        SELECT rtrim(trim(decrypted_secret), '/') INTO v_base_url
        FROM vault.decrypted_secrets
        WHERE name = 'supabase_project_url'
        LIMIT 1;

        SELECT trim(decrypted_secret) INTO v_cron_secret
        FROM vault.decrypted_secrets
        WHERE name = 'cron_internal_secret'
        LIMIT 1;

        IF COALESCE(v_base_url, '') = '' OR COALESCE(v_cron_secret, '') = '' THEN
          RAISE EXCEPTION 'Faltan secretos en Supabase Vault: supabase_project_url o cron_internal_secret.';
        END IF;

        PERFORM net.http_post(
          url := v_base_url || '/functions/v1/daily-alerts',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Cron-Secret', v_cron_secret
          ),
          body := jsonb_build_object('triggered_at', NOW())
        );
      END
      $job$;
      $cron$
    );
  END IF;
END $$;

-- Helper diagnóstico seguro (nunca devuelve valores de secretos; acceso exclusivo service_role)
CREATE OR REPLACE FUNCTION public.get_cron_vault_diagnostics()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_has_vault BOOLEAN := (to_regclass('vault.secrets') IS NOT NULL);
  v_has_cron BOOLEAN := (to_regclass('cron.job') IS NOT NULL);
  v_has_url BOOLEAN := false;
  v_has_cron_secret BOOLEAN := false;
  v_has_anon_key BOOLEAN := false;
  v_jobs JSONB := '[]'::jsonb;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin')
     AND v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Sin permisos para consultar diagnósticos de Cron/Vault.';
  END IF;

  IF v_has_vault THEN
    SELECT
      EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'supabase_project_url'),
      EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_internal_secret'),
      EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'supabase_anon_key')
    INTO v_has_url, v_has_cron_secret, v_has_anon_key;
  END IF;

  IF v_has_cron THEN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'jobname', jobname,
          'schedule', schedule,
          'active', active
        ) ORDER BY jobname
      ),
      '[]'::jsonb
    )
    INTO v_jobs
    FROM cron.job
    WHERE jobname IN (
      'sb-finance-process-telegram-queue',
      'sb-finance-daily-alerts',
      'sb-finance-keep-alive-dev'
    );
  END IF;

  RETURN jsonb_build_object(
    'vault_available', v_has_vault,
    'cron_available', v_has_cron,
    'has_supabase_project_url', v_has_url,
    'has_cron_internal_secret', v_has_cron_secret,
    'has_supabase_anon_key', v_has_anon_key,
    'jobs', v_jobs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_cron_vault_diagnostics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cron_vault_diagnostics() TO service_role;

-- ----------------------------------------------------------------------------
-- GUÍA DE VERIFICACIÓN MANUAL EN SUPABASE SQL EDITOR (SIN SECRETOS)
-- ----------------------------------------------------------------------------
-- 1) Verificar existencia de secretos en Vault (solo nombres, nunca valores):
--    SELECT name, created_at, updated_at
--    FROM vault.secrets
--    WHERE name IN ('supabase_project_url', 'cron_internal_secret', 'supabase_anon_key');
--
-- 2) Verificar estado de jobs pg_cron y últimas ejecuciones:
--    SELECT public.get_cron_vault_diagnostics();
--    SELECT jobid, status, return_message, start_time, end_time
--    FROM cron.job_run_details
--    ORDER BY start_time DESC
--    LIMIT 15;
--
-- 3) Verificar respuestas HTTP de pg_net (deben ser 200, nunca 401):
--    SELECT id, status_code, error_msg, created
--    FROM net._http_response
--    ORDER BY created DESC
--    LIMIT 15;
-- ============================================================================
