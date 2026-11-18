-- ============================================================================
-- MIGRACIÓN FASE 3 (HERRAMIENTAS DE DECISIÓN, INVERSIONES Y REFINAMIENTO)
-- Motor: PostgreSQL 15+ (Supabase)
-- Reglas: NUMERIC(12,2) para dinero, DATE para fechas, RLS estricto por auth.uid()
-- ============================================================================
-- Decisiones de Arquitectura:
-- 1. Separación contable con `savings_entries.source_type`: distinguir aportes
--    operativos (`manual`, `direct_income`) de traslados internos (`cap_surplus_fixed`,
--    `cap_surplus_gustitos`, `fixed_term_return`) evita el doble descuento en el
--    `Disponible Real` del mes.
-- 2. Aislamiento de inversiones en `fixed_term_deposits`: mantiene los plazos fijos
--    separados de `transactions` para no contaminar categorías de gasto, enlazando
--    con `savings_entries` vía `ON DELETE CASCADE` cuando operan con la Bóveda.
-- 3. RPCs duales (`authenticated` + `service_role` con `p_actor_user_id`): permiten
--    compartir lógica transaccional atómica (`FOR UPDATE` y `pg_advisory_xact_lock`)
--    entre el frontend React y las Edge Functions de Telegram.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXTENSIONES A TABLAS EXISTENTES (FASE 2 -> FASE 3)
-- ----------------------------------------------------------------------------

-- 1.1 user_settings: día habitual de cobro del sueldo fijo (1..31)
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS salary_payday SMALLINT NOT NULL DEFAULT 1
    CHECK (salary_payday >= 1 AND salary_payday <= 31);

-- 1.2 monthly_budgets: control de revisión de cierre/sobrante del período
ALTER TABLE public.monthly_budgets
  ADD COLUMN IF NOT EXISTS surplus_review_completed_at TIMESTAMPTZ NULL;

-- 1.2b installment_purchases: flag explícito para aislar cuotas de Gustitos del tope fijo
ALTER TABLE public.installment_purchases
  ADD COLUMN IF NOT EXISTS is_gustito BOOLEAN NOT NULL DEFAULT false;

-- 1.3 installment_payment_batches: registro por lote de adelantos de N cuotas
CREATE TABLE IF NOT EXISTS public.installment_payment_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  installment_purchase_id UUID NOT NULL REFERENCES public.installment_purchases(id) ON DELETE CASCADE,
  target_month_date DATE NOT NULL CHECK (EXTRACT(DAY FROM target_month_date) = 1),
  installments_count SMALLINT NOT NULL CHECK (installments_count >= 1 AND installments_count <= 120),
  total_paid_amount NUMERIC(12, 2) NOT NULL CHECK (total_paid_amount > 0 AND total_paid_amount <= 9999999999.99),
  source VARCHAR(15) NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'telegram')),
  reverted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_installment_batches_purchase
  ON public.installment_payment_batches (user_id, installment_purchase_id, created_at DESC);

-- 1.4 monthly_commitments: columnas de auditoría/reversión para adelanto de cuotas
ALTER TABLE public.monthly_commitments
  ADD COLUMN IF NOT EXISTS original_month_date DATE NULL
    CHECK (original_month_date IS NULL OR EXTRACT(DAY FROM original_month_date) = 1),
  ADD COLUMN IF NOT EXISTS original_due_date DATE NULL,
  ADD COLUMN IF NOT EXISTS original_amount NUMERIC(12, 2) NULL
    CHECK (original_amount IS NULL OR (original_amount > 0 AND original_amount <= 9999999999.99)),
  ADD COLUMN IF NOT EXISTS payment_batch_id UUID NULL
    REFERENCES public.installment_payment_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_monthly_commitments_batch
  ON public.monthly_commitments (payment_batch_id)
  WHERE payment_batch_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. NUEVAS TABLAS: fixed_term_deposits y priority_items
-- ----------------------------------------------------------------------------

-- 2.1 Plazos Fijos conectados a Bóveda de Ahorros y Disponible Real
CREATE TABLE IF NOT EXISTS public.fixed_term_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution VARCHAR(100) NOT NULL DEFAULT 'Plazo Fijo'
    CHECK (char_length(trim(institution)) >= 2),
  principal_amount NUMERIC(12, 2) NOT NULL
    CHECK (principal_amount > 0 AND principal_amount <= 9999999999.99),
  expected_return_amount NUMERIC(12, 2) NOT NULL
    CHECK (expected_return_amount >= principal_amount AND expected_return_amount <= 9999999999.99),
  actual_return_amount NUMERIC(12, 2) NULL
    CHECK (actual_return_amount IS NULL OR (actual_return_amount > 0 AND actual_return_amount <= 9999999999.99)),
  start_date DATE NOT NULL,
  maturity_date DATE NOT NULL,
  origin VARCHAR(20) NOT NULL CHECK (origin IN ('monthly_available', 'savings_fund')),
  status VARCHAR(25) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'accredited_savings', 'accredited_available', 'cancelled')),
  accredited_at TIMESTAMPTZ NULL,
  accredited_month_date DATE NULL
    CHECK (accredited_month_date IS NULL OR EXTRACT(DAY FROM accredited_month_date) = 1),
  source VARCHAR(15) NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'telegram')),
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fixed_term_dates CHECK (maturity_date > start_date)
);

CREATE INDEX IF NOT EXISTS idx_fixed_terms_user_status_maturity
  ON public.fixed_term_deposits (user_id, status, maturity_date ASC);

CREATE INDEX IF NOT EXISTS idx_fixed_terms_user_start
  ON public.fixed_term_deposits (user_id, start_date DESC);

DROP TRIGGER IF EXISTS trg_fixed_term_deposits_updated_at ON public.fixed_term_deposits;
CREATE TRIGGER trg_fixed_term_deposits_updated_at
  BEFORE UPDATE ON public.fixed_term_deposits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2.2 Extensión de savings_entries: origen contable y vínculo con Plazos Fijos
ALTER TABLE public.savings_entries
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(30) NOT NULL DEFAULT 'manual'
    CHECK (source_type IN (
      'manual',
      'direct_income',
      'cap_surplus_fixed',
      'cap_surplus_gustitos',
      'fixed_term_constitution',
      'fixed_term_return'
    )),
  ADD COLUMN IF NOT EXISTS fixed_term_id UUID NULL
    REFERENCES public.fixed_term_deposits(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_month_date DATE NULL
    CHECK (source_month_date IS NULL OR EXTRACT(DAY FROM source_month_date) = 1);

UPDATE public.savings_entries
SET source_type = 'direct_income'
WHERE source_transaction_id IS NOT NULL
  AND source_type = 'manual';

CREATE INDEX IF NOT EXISTS idx_savings_entries_fixed_term
  ON public.savings_entries (fixed_term_id)
  WHERE fixed_term_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_savings_entries_source_type
  ON public.savings_entries (user_id, month_date, source_type);

-- 2.3 Matriz de Prioridad Interactiva (Cuadrantes discretos)
CREATE TABLE IF NOT EXISTS public.priority_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL CHECK (char_length(trim(title)) >= 2),
  estimated_cost NUMERIC(12, 2) NOT NULL
    CHECK (estimated_cost > 0 AND estimated_cost <= 9999999999.99),
  category_id UUID NULL,
  quadrant VARCHAR(30) NOT NULL CHECK (quadrant IN (
    'high_impact_low_cost',
    'high_impact_high_cost',
    'low_impact_low_cost',
    'low_impact_high_cost'
  )),
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_priority_items_category_user
    FOREIGN KEY (category_id, user_id)
    REFERENCES public.categories (id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_priority_items_user_quadrant
  ON public.priority_items (user_id, quadrant, sort_order ASC, created_at DESC);

DROP TRIGGER IF EXISTS trg_priority_items_updated_at ON public.priority_items;
CREATE TRIGGER trg_priority_items_updated_at
  BEFORE UPDATE ON public.priority_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. ACTUALIZACIÓN SEGURA DE RESTRICCIONES CHECK EN TABLAS TELEGRAM / ALERTAS
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  -- 3.1 telegram_conversation_sessions (intent y pending_step)
  FOR v_conname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.telegram_conversation_sessions'::regclass
      AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%intent%' OR pg_get_constraintdef(oid) ILIKE '%pending_step%')
  LOOP
    EXECUTE format('ALTER TABLE public.telegram_conversation_sessions DROP CONSTRAINT %I', v_conname);
  END LOOP;

  ALTER TABLE public.telegram_conversation_sessions
    ADD CONSTRAINT chk_tg_sessions_intent CHECK (
      intent IN ('expense', 'income', 'installment_purchase', 'pay_installments', 'fixed_term_deposit')
    ),
    ADD CONSTRAINT chk_tg_sessions_pending_step CHECK (
      pending_step IN (
        'awaiting_category',
        'awaiting_amount',
        'awaiting_description',
        'awaiting_installment_details',
        'awaiting_first_installment_date',
        'awaiting_purchase_selection',
        'awaiting_installment_count',
        'awaiting_fixed_term_origin',
        'awaiting_fixed_term_return'
      )
    );

  -- 3.2 telegram_action_logs (action_type, target_table + rollback_payload)
  FOR v_conname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.telegram_action_logs'::regclass
      AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%action_type%' OR pg_get_constraintdef(oid) ILIKE '%target_table%')
  LOOP
    EXECUTE format('ALTER TABLE public.telegram_action_logs DROP CONSTRAINT %I', v_conname);
  END LOOP;

  ALTER TABLE public.telegram_action_logs
    ADD CONSTRAINT chk_tg_action_logs_action_type CHECK (
      action_type IN ('expense', 'income', 'installment_purchase', 'pay_installments', 'fixed_term_deposit')
    ),
    ADD CONSTRAINT chk_tg_action_logs_target_table CHECK (
      target_table IN ('transactions', 'installment_purchases', 'installment_payment_batches', 'fixed_term_deposits')
    );

  -- 3.3 notification_logs (alert_type)
  FOR v_conname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.notification_logs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%alert_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.notification_logs DROP CONSTRAINT %I', v_conname);
  END LOOP;

  ALTER TABLE public.notification_logs
    ADD CONSTRAINT chk_notification_logs_alert_type CHECK (
      alert_type IN (
        'category_warning_80',
        'category_exceeded_100',
        'fixed_limit_warning_80',
        'fixed_limit_exceeded_100',
        'mid_month_pending_reminder',
        'end_of_month_pending_reminder',
        'fixed_term_due_3d',
        'fixed_term_due_today'
      )
    );
END $$;

ALTER TABLE public.telegram_action_logs
  ADD COLUMN IF NOT EXISTS rollback_payload JSONB NULL;

-- ----------------------------------------------------------------------------
-- 4. POLÍTICAS ROW LEVEL SECURITY (RLS) ESTRICTAS POR auth.uid()
-- ----------------------------------------------------------------------------
ALTER TABLE public.installment_payment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixed_term_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.priority_items ENABLE ROW LEVEL SECURITY;

-- installment_payment_batches
DROP POLICY IF EXISTS "installment_batches_select_own" ON public.installment_payment_batches;
CREATE POLICY "installment_batches_select_own" ON public.installment_payment_batches
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "installment_batches_insert_own" ON public.installment_payment_batches;
CREATE POLICY "installment_batches_insert_own" ON public.installment_payment_batches
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "installment_batches_update_own" ON public.installment_payment_batches;
CREATE POLICY "installment_batches_update_own" ON public.installment_payment_batches
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "installment_batches_delete_own" ON public.installment_payment_batches;
CREATE POLICY "installment_batches_delete_own" ON public.installment_payment_batches
  FOR DELETE USING (auth.uid() = user_id);

-- fixed_term_deposits
DROP POLICY IF EXISTS "fixed_terms_select_own" ON public.fixed_term_deposits;
CREATE POLICY "fixed_terms_select_own" ON public.fixed_term_deposits
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "fixed_terms_insert_own" ON public.fixed_term_deposits;
CREATE POLICY "fixed_terms_insert_own" ON public.fixed_term_deposits
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "fixed_terms_update_own" ON public.fixed_term_deposits;
CREATE POLICY "fixed_terms_update_own" ON public.fixed_term_deposits
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "fixed_terms_delete_own" ON public.fixed_term_deposits;
CREATE POLICY "fixed_terms_delete_own" ON public.fixed_term_deposits
  FOR DELETE USING (auth.uid() = user_id);

-- priority_items
DROP POLICY IF EXISTS "priority_items_select_own" ON public.priority_items;
CREATE POLICY "priority_items_select_own" ON public.priority_items
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "priority_items_insert_own" ON public.priority_items;
CREATE POLICY "priority_items_insert_own" ON public.priority_items
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "priority_items_update_own" ON public.priority_items;
CREATE POLICY "priority_items_update_own" ON public.priority_items
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "priority_items_delete_own" ON public.priority_items;
CREATE POLICY "priority_items_delete_own" ON public.priority_items
  FOR DELETE USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 5. FUNCIONES RPC TRANSACCIONALES DE NEGOCIO (WEB + SERVICE_ROLE)
-- ----------------------------------------------------------------------------

-- 5.1 RPC: Adelanto / pago múltiple de N cuotas pendientes más próximas
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
SET search_path = public
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_user_id UUID;
  v_target_month DATE := date_trunc('month', p_target_month_date)::DATE;
  v_purchase public.installment_purchases;
  v_pending_ids UUID[];
  v_pending_count INT;
  v_batch_id UUID;
  v_base_unit NUMERIC(12, 2);
  v_remainder NUMERIC(12, 2);
  v_final_total NUMERIC(12, 2);
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
  ELSIF p_actor_user_id IS NOT NULL AND current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    v_user_id := p_actor_user_id;
  ELSE
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_count IS NULL OR p_count < 1 OR p_count > 120 THEN
    RAISE EXCEPTION 'La cantidad de cuotas a adelantar debe estar entre 1 y 120.';
  END IF;

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
    IF p_total_amount <= 0 THEN
      RAISE EXCEPTION 'El monto total abonado debe ser mayor a cero.';
    END IF;
    v_final_total := ROUND(p_total_amount, 2);
    v_base_unit := TRUNC(v_final_total / p_count, 2);
    v_remainder := ROUND(v_final_total - (v_base_unit * p_count), 2);
  ELSE
    SELECT COALESCE(SUM(amount), 0.00) INTO v_final_total
    FROM public.monthly_commitments
    WHERE id = ANY(v_pending_ids);
  END IF;

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

-- 5.2 RPC: Revertir lote de adelanto de cuotas (Web y Telegram [❌ Anular])
CREATE OR REPLACE FUNCTION public.revert_installment_payment_batch(
  p_batch_id UUID,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_user_id UUID;
  v_batch public.installment_payment_batches;
  v_restored_count INT;
BEGIN
  IF v_caller_uid IS NOT NULL THEN
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'Sin permisos para operar sobre otro usuario.';
    END IF;
    v_user_id := v_caller_uid;
  ELSIF p_actor_user_id IS NOT NULL AND current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    v_user_id := p_actor_user_id;
  ELSE
    RAISE EXCEPTION 'No autenticado';
  END IF;

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

  UPDATE public.monthly_commitments
  SET
    month_date = COALESCE(original_month_date, month_date),
    due_date = COALESCE(original_due_date, due_date),
    amount = COALESCE(original_amount, amount),
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

  RETURN jsonb_build_object(
    'reverted', true,
    'batch_id', p_batch_id,
    'restored_count', v_restored_count
  );
END;
$$;

-- 5.3 RPC: Calcular saldo líquido actual de Bóveda de Ahorros (reutilizable por Plazos Fijos)
CREATE OR REPLACE FUNCTION public.get_liquid_savings_balance(p_user_id UUID)
RETURNS NUMERIC(12, 2)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tz TEXT;
  v_local_month DATE;
  v_frozen_targets NUMERIC(12, 2);
  v_deposits NUMERIC(12, 2);
  v_withdrawals NUMERIC(12, 2);
BEGIN
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

-- 5.4 RPC: Constituir Plazo Fijo con validación atómica de origen
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
SET search_path = public
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_user_id UUID;
  v_liquid_balance NUMERIC(12, 2);
  v_created public.fixed_term_deposits;
BEGIN
  IF v_caller_uid IS NOT NULL THEN
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'Sin permisos para operar sobre otro usuario.';
    END IF;
    v_user_id := v_caller_uid;
  ELSIF p_actor_user_id IS NOT NULL AND current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    v_user_id := p_actor_user_id;
  ELSE
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Serializar mutaciones patrimoniales del mismo usuario para evitar race conditions
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  IF p_maturity_date <= p_start_date THEN
    RAISE EXCEPTION 'La fecha de vencimiento debe ser posterior a la fecha de inicio.';
  END IF;

  IF p_expected_return_amount < p_principal_amount THEN
    RAISE EXCEPTION 'El monto a recibir no puede ser menor al capital invertido.';
  END IF;

  IF p_origin = 'savings_fund' THEN
    v_liquid_balance := public.get_liquid_savings_balance(v_user_id);
    IF p_principal_amount > v_liquid_balance THEN
      RAISE EXCEPTION 'Saldo líquido insuficiente en la Bóveda de Ahorros (disponible: $%).', v_liquid_balance;
    END IF;
  END IF;

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
    COALESCE(NULLIF(trim(p_institution), ''), 'Plazo Fijo'),
    ROUND(p_principal_amount, 2),
    ROUND(p_expected_return_amount, 2),
    p_start_date,
    p_maturity_date,
    p_origin,
    'active',
    CASE WHEN p_source IN ('web', 'telegram') THEN p_source ELSE 'web' END,
    NULLIF(trim(COALESCE(p_notes, '')), '')
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
      ROUND(p_principal_amount, 2),
      p_start_date,
      ('Constitución Plazo Fijo: ' || v_created.institution)::VARCHAR(150),
      'Capital trasladado de ahorro líquido a inversión inmovilizada.',
      'fixed_term_constitution',
      v_created.id
    );
  END IF;

  RETURN v_created;
END;
$$;

-- 5.5 RPC: Acreditar Plazo Fijo al vencer (Bóveda de Ahorros por defecto o Disponible Real)
CREATE OR REPLACE FUNCTION public.accredit_fixed_term_deposit(
  p_fixed_term_id UUID,
  p_destination VARCHAR DEFAULT 'savings_fund',
  p_actual_return_amount NUMERIC(12, 2) DEFAULT NULL,
  p_accredited_date DATE DEFAULT NULL
)
RETURNS public.fixed_term_deposits
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_ft public.fixed_term_deposits;
  v_final_amount NUMERIC(12, 2);
  v_acc_date DATE;
  v_acc_month DATE;
  v_new_status VARCHAR(25);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT * INTO v_ft
  FROM public.fixed_term_deposits
  WHERE id = p_fixed_term_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plazo fijo no encontrado o sin permisos.';
  END IF;

  IF v_ft.status <> 'active' THEN
    RAISE EXCEPTION 'Este plazo fijo ya fue acreditado o anulado.';
  END IF;

  IF p_destination NOT IN ('savings_fund', 'monthly_available') THEN
    RAISE EXCEPTION 'Destino inválido. Debe ser savings_fund o monthly_available.';
  END IF;

  v_final_amount := ROUND(COALESCE(p_actual_return_amount, v_ft.expected_return_amount), 2);
  IF v_final_amount <= 0 THEN
    RAISE EXCEPTION 'El monto acreditado debe ser mayor a cero.';
  END IF;

  v_acc_date := COALESCE(p_accredited_date, GREATEST(v_ft.maturity_date, CURRENT_DATE));
  v_acc_month := date_trunc('month', v_acc_date)::DATE;
  v_new_status := CASE WHEN p_destination = 'savings_fund' THEN 'accredited_savings' ELSE 'accredited_available' END;

  UPDATE public.fixed_term_deposits
  SET
    status = v_new_status,
    actual_return_amount = v_final_amount,
    accredited_at = NOW(),
    accredited_month_date = v_acc_month
  WHERE id = p_fixed_term_id AND user_id = v_user_id
  RETURNING * INTO v_ft;

  IF p_destination = 'savings_fund' THEN
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
      v_acc_month,
      'deposit',
      v_final_amount,
      v_acc_date,
      ('Vencimiento Plazo Fijo: ' || v_ft.institution)::VARCHAR(150),
      'Capital + rendimiento acreditado directamente en Bóveda de Ahorros.',
      'fixed_term_return',
      v_ft.id
    );
  END IF;

  RETURN v_ft;
END;
$$;

-- 5.6 RPC: Reconciliar sobrante de topes (Enviar a Ahorros o Liberar al Disponible Real)
CREATE OR REPLACE FUNCTION public.reconcile_cap_surplus(
  p_month_date DATE,
  p_bucket VARCHAR,              -- 'fixed_limit' | 'gustitos'
  p_action VARCHAR,              -- 'to_savings' | 'to_available' | 'mark_reviewed'
  p_amount NUMERIC(12, 2) DEFAULT 0.00,
  p_target_income_month DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_month DATE := date_trunc('month', p_month_date)::DATE;
  v_month_end DATE := (v_month + INTERVAL '1 month - 1 day')::DATE;
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

  IF p_action = 'mark_reviewed' THEN
    UPDATE public.monthly_budgets
    SET surplus_review_completed_at = NOW()
    WHERE user_id = v_user_id AND month_date = v_month;
    RETURN jsonb_build_object('ok', true, 'action', 'mark_reviewed');
  END IF;

  IF p_bucket NOT IN ('fixed_limit', 'gustitos') OR p_action NOT IN ('to_savings', 'to_available') THEN
    RAISE EXCEPTION 'Parámetros inválidos para conciliación de sobrante.';
  END IF;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a cero.';
  END IF;

  SELECT * INTO v_budget
  FROM public.monthly_budgets
  WHERE user_id = v_user_id AND month_date = v_month
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El período % no está inicializado.', v_month;
  END IF;

  IF p_bucket = 'fixed_limit' THEN
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
  ELSE
    SELECT (
      COALESCE((
        SELECT SUM(t.amount)
        FROM public.transactions t
        LEFT JOIN public.monthly_category_snapshots mcs
          ON mcs.user_id = v_user_id AND mcs.month_date = v_month AND mcs.category_id = t.category_id
        LEFT JOIN public.categories c ON c.id = t.category_id
        WHERE t.user_id = v_user_id
          AND t.type = 'expense'
          AND t.transaction_date BETWEEN v_month AND v_month_end
          AND (t.is_gustito = true OR COALESCE(mcs.is_gustito, c.is_gustito, false) = true)
      ), 0.00)
      +
      COALESCE((
        SELECT SUM(mc.amount)
        FROM public.monthly_commitments mc
        LEFT JOIN public.installment_purchases ip ON ip.id = mc.installment_purchase_id
        LEFT JOIN public.monthly_category_snapshots mcs
          ON mcs.user_id = v_user_id AND mcs.month_date = v_month AND mcs.category_id = mc.category_id
        LEFT JOIN public.categories c ON c.id = mc.category_id
        WHERE mc.user_id = v_user_id
          AND mc.month_date = v_month
          AND mc.commitment_type = 'installment'
          AND (COALESCE(ip.is_gustito, false) = true OR COALESCE(mcs.is_gustito, c.is_gustito, false) = true)
      ), 0.00)
    ) INTO v_spent;

    SELECT COALESCE(SUM(amount), 0.00) INTO v_transferred
    FROM public.savings_entries
    WHERE user_id = v_user_id AND month_date = v_month AND source_type = 'cap_surplus_gustitos';

    v_surplus := GREATEST(0.00, ROUND(v_budget.gustitos_budget - v_spent - v_transferred, 2));
  END IF;

  IF v_surplus <= 0 THEN
    RAISE EXCEPTION 'No hay sobrante disponible para trasladar en este rubro.';
  END IF;

  IF v_amount > v_surplus THEN
    RAISE EXCEPTION 'El monto solicitado ($%) supera el sobrante disponible ($%).', v_amount, v_surplus;
  END IF;

  IF p_action = 'to_savings' THEN
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
      LEAST(CURRENT_DATE, v_month_end),
      CASE WHEN p_bucket = 'fixed_limit' THEN 'Sobrante de Límite Fijos a Ahorros' ELSE 'Sobrante de Gustitos a Ahorros' END,
      'Traslado manual de sobrante de tope mensual sin doble descuento.',
      CASE WHEN p_bucket = 'fixed_limit' THEN 'cap_surplus_fixed' ELSE 'cap_surplus_gustitos' END,
      v_month
    );
  ELSE
    -- Liberar al Disponible Real: reducir el tope del período para evitar reclamarlo dos veces
    IF p_bucket = 'fixed_limit' THEN
      UPDATE public.monthly_budgets
      SET fixed_expenses_limit = GREATEST(0.00, ROUND(fixed_expenses_limit - v_amount, 2))
      WHERE id = v_budget.id;
    ELSE
      UPDATE public.monthly_budgets
      SET gustitos_budget = GREATEST(0.00, ROUND(gustitos_budget - v_amount, 2))
      WHERE id = v_budget.id;
    END IF;

    -- Si se libera desde el cierre de un mes pasado hacia el mes actual nuevo, acreditar ingreso trazable en el mes destino
    IF p_target_income_month IS NOT NULL AND date_trunc('month', p_target_income_month)::DATE > v_month THEN
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
        date_trunc('month', p_target_income_month)::DATE,
        CASE WHEN p_bucket = 'fixed_limit' THEN 'Remanente Límite Fijos mes anterior' ELSE 'Remanente Gustitos mes anterior' END,
        'Sobrante genuino liberado al Disponible Real al cierre del período previo.',
        'web'
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'bucket', p_bucket,
    'action', p_action,
    'amount', v_amount,
    'remaining_surplus', ROUND(v_surplus - v_amount, 2)
  );
END;
$$;
