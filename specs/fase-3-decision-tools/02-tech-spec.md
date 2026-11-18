# Especificación Técnica — Fase 3 (Herramientas de Decisión, Inversiones y Refinamiento Core) — SB-Finance

> **Versión:** 1.0.0  
> **Estado:** Aprobado para implementación  
> **Documentos base:** `specs/constitution.md`, `specs/product_roadmap.md`, `specs/fase-2-automation/02-tech-spec.md`, `specs/fase-3-decision-tools/01-functional-spec.md`

---

## 1. Migración Incremental SQL (`supabase/migrations/20261117000001_phase3_decision_tools.sql`)

La migración extiende el esquema de Fases 1 y 2 de manera no destructiva, agrega `fixed_term_deposits`, `priority_items` e `installment_payment_batches` con RLS estricto, e implementa RPCs atómicas reutilizables tanto por el frontend (`authenticated`) como por las Edge Functions (`service_role`).

```sql
-- ============================================================================
-- MIGRACIÓN FASE 3 (HERRAMIENTAS DE DECISIÓN, INVERSIONES Y REFINAMIENTO)
-- Motor: PostgreSQL 15+ (Supabase)
-- Reglas: NUMERIC(12,2) para dinero, DATE para fechas, RLS estricto por auth.uid()
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
```

---

## 2. Arquitectura de Supabase Edge Functions (Deno)

Todas las Edge Functions viven aisladas en `supabase/functions/`, usando exclusivamente importaciones compatibles con Deno (`npm:@supabase/supabase-js@2` o `deno.json` de cada función) y secretos de entorno (`GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_INTERNAL_SECRET`).

### 2.1 Actualización de `_shared/financeHelpers.ts`
1. **Exclusión de cuotas Gustito en Límite de Fijos:**
   - Añadir `computeFixedLimitStatus(supabaseAdmin, userId, monthDate)` que suma `monthly_commitments` donde `commitment_type = 'fixed_expense'` o (`commitment_type = 'installment'` con `is_gustito = false` tanto en `installment_purchases` como en `monthly_category_snapshots` / `categories`).
2. **Cálculo determinístico de rendimiento de Plazo Fijo (`computeFixedTermReturn`):**
   - Función pura:
     - Si `expectedReturnAmount` explícito: valida `>= principalAmount`.
     - Si `yieldPercent` con `ratePeriod = 'period'`: `roundCurrency(principal * (1 + yieldPercent / 100))`.
     - Si `yieldPercent` con `ratePeriod = 'annual'` (TNA) y `termDays`: `roundCurrency(principal * (1 + (yieldPercent / 100) * (termDays / 365)))`.

### 2.2 Actualización de `_shared/telegramIntentProcessor.ts` y `telegram-webhook/index.ts`
1. **Nuevas intenciones en el esquema JSON de Gemini Flash (`gemini-3.8-flash`):**
   - `ParsedIntent`: `'expense' | 'income' | 'installment_purchase' | 'pay_installments' | 'fixed_term_deposit'`.
   - Campos nuevos en `GeminiParsedIntent`:
     - Para `pay_installments`: `purchase_query` (texto descriptivo para buscar la compra activa), `purchase_id` (si ya fue elegida), `installments_to_pay` (entero `N >= 1`), `total_paid_amount` (`$X` opcional si difiere del original).
     - Para `fixed_term_deposit`: `institution` (default `'Plazo Fijo'`), `principal_amount`, `expected_return_amount`, `yield_percent`, `rate_period` (`'period' | 'annual' | null`), `term_days`, `start_date`, `maturity_date`, `fixed_term_origin` (`'monthly_available' | 'savings_fund' | null`).
2. **Flujos multi-turno nuevos:**
   - **`pay_installments`:**
     - Busca compras en cuotas del usuario que tengan al menos 1 cuota con `is_paid = false`.
     - Filtra por similitud con `purchase_query`. Si hay `0` o `> 1` coincidencias, guarda sesión en `awaiting_purchase_selection` y muestra botones inline (`pick_purchase:<id>`) con nombre y cuotas pendientes (`"Zapatillas Nike (4 pend.)"`).
     - Si falta `N`, pasa a `awaiting_installment_count`.
     - Al completarse, invoca `supabaseAdmin.rpc('advance_installments', { p_purchase_id, p_count, p_target_month_date: currentMonth, p_total_amount, p_source: 'telegram', p_actor_user_id: userId })`.
     - Guarda en `telegram_action_logs` (`action_type = 'pay_installments'`, `target_table = 'installment_payment_batches'`, `target_id = batch_id`, `rollback_payload = resultado_rpc`).
     - Responde con detalle de cuotas adelantadas, saldo restante de Gustitos/Categoría si corresponde, y botón inline `[❌ Anular]`.
   - **`fixed_term_deposit`:**
     - Elimina el antiguo estado `out_of_scope_fixed_term`.
     - Si falta `principal_amount` o (`expected_return_amount` y `yield_percent`), entra en `awaiting_fixed_term_return` preguntando el monto a recibir o `%` de rendimiento.
     - Si falta `fixed_term_origin`, entra en `awaiting_fixed_term_origin` enviando 2 botones inline:
       - `💰 Disponible del Mes` (`callback_data: 'pick_ft_origin:monthly_available'`)
       - `🏦 Bóveda de Ahorros` (`callback_data: 'pick_ft_origin:savings_fund'`)
     - Al completarse, invoca `supabaseAdmin.rpc('create_fixed_term_deposit', { ..., p_source: 'telegram', p_actor_user_id: userId })`. Si devuelve error de saldo insuficiente en Bóveda, informa al usuario claramente sin romper la sesión.
     - Registra en `telegram_action_logs` (`action_type = 'fixed_term_deposit'`, `target_table = 'fixed_term_deposits'`, `target_id = ft.id`) con botón `[❌ Anular]`.
3. **Resolución de `[❌ Anular]` (`void:<logId>`):**
   - Si `target_table = 'installment_payment_batches'`: invoca `supabaseAdmin.rpc('revert_installment_payment_batch', { p_batch_id: log.target_id, p_actor_user_id: log.user_id })` y actualiza `voided_at`.
   - Si `target_table = 'fixed_term_deposits'`: verifica que siga en `status = 'active'` (si ya fue acreditado en web, bloquea la anulación rápida por seguridad igual que las cuotas pagadas) e invoca la RPC transaccional `cancel_fixed_term_deposit` (que elimina el registro y propaga en cascada cualquier retiro en `savings_entries`, reemplazando el `DELETE` directo restringido por RLS en `20261117000002_phase3_audit_fixes.sql`).

### 2.3 Actualización de `daily-alerts/index.ts`
1. **Sección B (`fixed_limit_*`):** Usar `computeFixedLimitStatus` excluyendo cuotas de Gustitos para que coincida 100% con el Dashboard y `useDashboardData`.
2. **Sección D — Alertas de Vencimiento de Plazos Fijos:**
   - Para cada usuario con `local.hour === 8`: consultar `fixed_term_deposits` con `status = 'active'` y `maturity_date IN (local.yyyyMmDd, localPlus3Days)`.
   - Para `maturity_date === localPlus3Days`: `alert_type = 'fixed_term_due_3d'`, máximo 1 envío por `reference_id = ft.id`.
   - Para `maturity_date === local.yyyyMmDd`: `alert_type = 'fixed_term_due_today'`, máximo 1 envío por `reference_id = ft.id`.
   - Mensaje incluye entidad, capital invertido, monto a recibir y recordatorio de ingresar a `/fixed-terms` para acreditar en Bóveda o Disponible Real.
3. **Sección E — Alerta de Revisión de Cierre de Gastos Fijos (`<= 3` días para fin de mes):**
   - Cuando `local.daysInMonth - local.day <= 3` y `fixedStatus.fixedLimit > 0`: consulta `monthly_budgets.surplus_review_completed_at`, `savings_entries` (`source_type = 'cap_surplus_fixed'`) y `notification_logs` (`alert_type = 'fixed_cap_surplus_closing'`).
   - Si el mes no está revisado, no se envió la alerta este mes y `fixedCapSurplus > 0`, envía un mensaje recordatorio por Telegram para revisar gastos olvidados y enviar el sobrante a Bóveda o liberarlo al Disponible Real (registrando `'fixed_cap_surplus_closing'`).

### 2.4 Edge Function: `supabase/functions/budget-assistant/index.ts`
- **Seguridad, Cuota y Resiliencia:**
  - Método `POST` + manejo `OPTIONS` (CORS con allowlist configurable mediante `ALLOWED_ORIGINS`).
  - Valida JWT (`Authorization: Bearer <jwt>`) mediante `SUPABASE_ANON_KEY` (`callerClient.auth.getUser()`), rechazando con `401` si no hay sesión válida.
  - Consulta datos únicamente del `callerUser.id` y verifica `.error` en las consultas críticas antes de procesar.
  - **Rate limit y límites de payload:** Registra invocaciones en `public.budget_assistant_logs` (máx. 10 llamadas por hora por usuario), exige `<= 4 KB` para consultas solo de texto y hasta `4,8 MB` (`<= 3,5 MB` binarios, `<= 60` segundos, MIME permitido `audio/webm|ogg|mp4|mpeg|wav`) cuando incluye audio grabado con micrófono; aplica `AbortSignal.timeout(15000)` en texto y `30000` con audio, sanitiza `userGoal` y textos de `priority_items`, envuelve `JSON.parse` en `try/catch` (sin exponer `errBody` crudo ni stacktraces), y usa `roundCurrency` basado en centavos enteros.
  - **Reintento y fallback de modelo:** Ante respuestas transitorias de Gemini (`429`/`5xx`), reintenta sobre el modelo principal (`GEMINI_MODEL`, default `gemini-3.8-flash`) y realiza fallback automático a `GEMINI_FALLBACK_MODEL` (default `gemini-2.5-flash`).
- **Contexto enviado a Gemini Flash (Multimodal Texto + Audio `inline_data`):**
  - `user_settings`: `fixed_salary`, `monthly_savings_target`, `fixed_expenses_limit`, `gustitos_budget`, `currency`.
  - Plantillas activas de `fixed_expense_templates` + cuotas vigentes del mes actual en `monthly_commitments` (discriminando `is_gustito`).
  - Categorías activas (`type = 'expense'`) con su `is_gustito` y `monthly_limit` actual.
  - **Últimos 3 meses con actividad registrada** en `transactions` y `monthly_commitments` (agrupados por mes y categoría en Deno).
  - **`priorityMatrix` (`priority_items`) y `liquidSavingsBalance`:** hasta 40 ítems deseados sanitizados (`title`, `estimated_cost`, `quadrant`, `category_name`, `notes`) + saldo líquido actual en Bóveda obtenido vía `callerClient.rpc('get_liquid_savings_balance', { p_user_id: userId })` para evaluar viabilidad y planes de compra en $X$ meses dentro de `summary_reasoning`.
  - `userGoal?: string` (máx. 500 caracteres) y/o `audioBase64` (`inline_data`, máx. 60 segundos).
- **Salida JSON Estructurada y Guardrails Determinísticos:**
  ```typescript
  export interface BudgetAssistantProposal {
    summary_reasoning: string;
    recommended_fixed_expenses_limit: number;
    recommended_gustitos_budget: number;
    recommended_monthly_savings_target: number;
    category_limits: Array<{
      category_id: string;
      category_name: string;
      current_limit: number | null;
      suggested_limit: number | null;
      reason: string;
    }>;
    warnings: string[];
    disclaimer: string;
  }
  ```
  - El servidor filtra `category_limits` verificando que cada `category_id` exista en el catálogo real del usuario, redondea con `roundCurrency`, impide montos negativos y adjunta el disclaimer fijo de guía orientativa (no asesoramiento financiero profesional).

---

## 3. Contratos TypeScript (`strict: true`), Validaciones Zod y Servicios (`src/`)

### 3.1 Nuevas Interfaces en `src/types/database.types.ts`
- `SavingsSourceType = 'manual' | 'direct_income' | 'cap_surplus_fixed' | 'cap_surplus_gustitos' | 'fixed_term_constitution' | 'fixed_term_return'`
- `FixedTermOrigin = 'monthly_available' | 'savings_fund'`
- `FixedTermStatus = 'active' | 'accredited_savings' | 'accredited_available' | 'cancelled'`
- `PriorityQuadrant = 'high_impact_low_cost' | 'high_impact_high_cost' | 'low_impact_low_cost' | 'low_impact_high_cost'`
- `FixedTermDeposit`, `FixedTermDepositInput`, `AccreditFixedTermInput`
- `PriorityItem`, `PriorityItemInput`
- `InstallmentPaymentBatch`, `AdvanceInstallmentsInput`, `AdvanceInstallmentsResult`
- `BudgetAssistantProposal`, `SimulatedExpenseItem`
- Actualización de `MonthlyFinancialSummary`:
  - `fixedAndNonGustitoInstallmentsTotal`, `gustitosInstallmentsTotal`
  - `fixedCapTransferredToSavings`, `gustitosTransferredToSavings`
  - `fixedCapSurplus`, `gustitosSurplus`
  - `fixedTermsInvestedFromAvailable`, `fixedTermsReturnedToAvailable`
  - `surplusReviewCompletedAt: string | null`
- Actualización de `AccumulatedSavingsSummary`:
  - `liquidBalance`, `immobilizedInFixedTerms`, `totalPatrimony`

### 3.2 Nuevos Esquemas Zod (`src/lib/validations.ts`) y Utilidades (`src/lib/formatters.ts`)
- `formatters.ts`: aritmética monetaria en centavos enteros (`toCents` / `roundCurrency`) para evitar desviaciones IEEE-754 frente a `NUMERIC(12,2)` de PostgreSQL; helpers `getLastBusinessDayOfMonth` y `resolveEffectivePayday`; cuadrante `high_impact_high_cost` con badge `'neutral'` (reservando `'green'` exclusivamente para ingresos/saldo positivo).
- `isoDateSchema`: validación de fecha de calendario real (`isValidCalendarDate`, rechazando fechas inexistentes como `2026-02-31`).
- Extender `userSettingsSchema` con `salary_payday: z.coerce.number().int().min(0).max(31).default(1)` (`0` = último día hábil del mes lun–vie).
- `advanceInstallmentsSchema`: `count` (`1..120`), `custom_total_amount` opcional (`>= count * 0.01`).
- `reconcileSurplusSchema`: `bucket` (`'fixed_limit' | 'gustitos'`), `action` (`'to_savings' | 'to_available'`), `amount` (`> 0`).
- `fixedTermDepositSchema`: `institution`, `principal_amount`, `expected_return_amount` (`>= principal_amount`), `start_date`, `maturity_date` (`> start_date`), `origin`, `notes`.
- `accreditFixedTermSchema`: `destination` (`'savings_fund' | 'monthly_available'`), `actual_return_amount`, `accredited_date` (`>= start_date`).
- `priorityItemSchema`: `title`, `estimated_cost`, `category_id` nullable, `quadrant`, `notes`.
- `simulatorItemSchema`: monto (`>= 0.01`, `<= MAX_MONEY`), cuotas (`1..60`) y total combinado `<= MAX_MONEY`.
- `budgetAssistantProposalSchema`: valida la propuesta antes de invocar la RPC atómica `apply_budget_assistant_limits`.

### 3.3 Servicios Nuevos y Actualizados (`src/services/`)
- `src/services/fixedTermsService.ts`: `getFixedTermDeposits`, `createFixedTermDeposit` (RPC), `accreditFixedTermDeposit` (RPC), `deleteFixedTermDeposit` (vía RPC `cancel_fixed_term_deposit`).
- `src/services/priorityMatrixService.ts`: `getPriorityItems`, `createPriorityItem`, `updatePriorityItem`, `movePriorityItemQuadrant`, `deletePriorityItem`, `convertPriorityItemToPurchase` (RPC atómica).
- `src/services/budgetAssistantService.ts`: `generateBudgetProposal(input?)` (soporta `userGoal` hasta 500 chars y `{ audioBase64, audioMimeType, audioDurationSeconds }`, parseando el body JSON de errores HTTP non-2xx), `applySuggestedLimits(proposal, applyToCurrentMonth)` (vía RPC transaccional `apply_budget_assistant_limits`).
- Actualización de `commitmentsService.ts`: `advanceInstallments`, `revertInstallmentPaymentBatch`, `getRecentInstallmentBatches`.
- Actualización de `settingsService.ts`: `salary_payday`, `reconcileCapSurplus`.
- Actualización de `savingsService.ts`: cálculo de `liquidBalance`, `immobilizedInFixedTerms` y `totalPatrimony`, y exclusión de `cap_surplus_*` / `fixed_term_return` en `extraSavingsDeposits` operativos del mes.
- Actualización de `transactionsService.ts`: `getSixMonthsEvolution` alineado con la nueva fórmula de `Disponible Real`.

### 3.4 Hooks (`src/hooks/`)
- **`useDashboardData.ts`:**
  - Incorpora `fixed_term_deposits` (filtrando constituidos desde `monthly_available` en el mes y acreditados a `monthly_available` en el mes).
  - Separa `fixedAndNonGustitoInstallmentsTotal` de `gustitosInstallmentsTotal` y expone `gustitoCategoryIds` al widget de pendientes.
  - Calcula `daysRemainingInMonth = daysInCurrentMonth - todayDayOfMonth` para disparar `shouldPromptSurplusReview` en el mes en curso únicamente cuando faltan `<= 3` días para fin de mes (o en meses pasados sin revisar) y `fixedCapSurplus > 0`.
  - Aplica exactamente la fórmula vigente de Fase 3 (con Gustitos dentro del Disponible Real):
    `realAvailable = totalIncomeWithFixedReturns - Math.max(fixedExpensesLimit, fixedAndNonGustito + fixedSurplusTransferred) - (gustitosSpent + gustitosSurplusTransferred) - (monthlySavingsTarget + operationalSavingsDeposits) - variableNonGustitoExpenses - fixedTermsFromAvailable`.
  - Calcula `fixedCapSurplus` transferible (dejando `gustitosSurplus = 0` ya que Gustitos forma parte del Disponible Real).
- **`useExpenseSimulator.ts`:**
  - Hook puramente en memoria (sin llamadas de escritura a Supabase) que recibe el `summary` y `categories` reales del mes actual (y proyección del mes siguiente), valida montos `>= 0.01`, unifica umbrales `>= 100%` (`exceedsFixedLimit`), usa la misma fórmula de `Disponible Real` (descontando los Gustitos simulados al gastarse) y calcula el delta acumulado sobre `SimulatedExpenseItem[]`.
- **`useRovingTabs.ts`:**
  - Hook accesible compartido para navegación con teclado (`ArrowLeft`, `ArrowRight`, `Home`, `End`) y gestión de `tabIndex` en todos los `role="tablist"`.

---

## 4. Estructura de Archivos y Refactorización Visual

### 4.1 Lineamientos Visuales Obligatorios
Criterios de diseño aplicados en la Fase 3:
- **Paleta:** Fondo primario `#0A0A0A`, superficies `#121212` / `#1A1A1A`, bordes `#262626`, acento primario **Amarillo `#FACC15`**, texto `#FAFAFA` / `#A3A3A3`. Semánticos `#22C55E` y `#EF4444` únicamente para estado positivo/negativo o tope alcanzado (`>= 100%`).
- **Dashboard Ejecutivo Mínimo y Limpieza Visual:**
  - Reduce la densidad vertical inicial para que **`Disponible Real del Mes` sea visible arriba del pliegue incluso en mobile `390×844`**, eliminando el subtítulo redundante de cabecera, agrupando acciones secundarias en mobile (`grid-cols-2`), reubicando `"Ajustar presupuesto del mes"` dentro de `Ingresos y Flujo`, evitando duplicar el CTA de cierre y mostrando el desglose numérico en una sola lista contable (sin repetir la fórmula de 4 líneas; detalle algebraico bajo demanda).
  - Cabecera ejecutiva limpia:
    1. Título + Acciones rápidas (`+ Movimiento`, `+ Cuota`, `+ Plazo Fijo` con estado `loading` explícito al consultar Bóveda).
    2. `MonthSelectorBar` limpio + banner no bloqueante de cierre de Gastos Fijos únicamente cuando faltan `<= 3` días para fin de mes (o cierre pasado pendiente) y `fixedCapSurplus > 0`.
    3. Tarjeta protagonista **`Disponible Real del Mes`** (indicando cuánto margen de Gustitos incluye el saldo y fórmula actualizada sin apartar el tope de Gustitos) + Resumen compacto de **Ingresos y Flujo del Mes** (con `"Ajustar presupuesto del mes"`).
    4. Las **2 barras consistentes `0% → 100%`**: `Comprometido (Fijos + Cuotas No-Gustito)` (incluyendo el acceso manual discreto `"Revisar sobrante"` cuando hay sobrante fijo) y `Bolsa de Gustitos` (creciente `0% → 100%`, rojo `#EF4444` al llegar a `>= 100%`).
  - Debajo, barra de **3 sub-pestañas accesibles (`role="tablist"` con `useRovingTabs` y `role="tabpanel"`)**:
    - `Resumen y Gráficos`: `CategoryLimitsWidget` emparejado 50/50 (`lg:grid-cols-2`) junto al Donut de gastos, y `Evolución 6 meses` a ancho completo debajo.
    - `Pendientes de Pago`: `PendingCommitmentsWidget` (incluyendo badge `Gustito` en cuotas discrecionales y acceso directo a adelantar cuotas).
    - `Movimientos del Mes` (y `/transactions`): buscador rápido + pills de tipo (`Todos | Gastos | Ingresos`) junto a `TransactionsTable`, integrando también los compromisos abonados del mes (`monthly_commitments` con `is_paid = true`) en modo solo lectura con badge `Cuota pagada` / `Fijo pagado` y enlace a `/commitments`, sin sumarlos a `Gastos Variables` ni duplicar su descuento en `Disponible Real`.
- **Navegación Superior (`TopNavbar.tsx`) y Sub-navegación Contextual (`PageSubnav.tsx`):**
  - 6 elementos de primer nivel (`Dashboard`, `Movimientos`, `Fijos y Cuotas`, `Inversiones ▾`, `Decisión ▾`, `Herramientas ▾`) con gestión completa de teclado (`Tab`, `Escape` con retorno de foco, panel móvil con `role="dialog"` y alineación `right-0` en el menú derecho).
  - Barra liviana `PageSubnav` (`min-h-[44px]`) en módulos emparejados (`Bóveda ↔ Plazos Fijos`, `Matriz ↔ Simulador`, `Asistente IA ↔ Categorías ↔ Configuración`).
- **Organización de Módulos de Decisión e Inversiones:**
  - `SimulatorPage`: disposición *workbench* en 2 columnas (`lg:col-span-5` constructor + lista, `lg:col-span-7 lg:sticky` comparativa en vivo) y resumen compacto superior en `390px`, con barras `role="progressbar"` y errores por campo.
  - `PriorityMatrixPage` + `PriorityItemFormModal`: matriz cartesiana 2×2 con eje Y (`Impacto`) a la izquierda, eje X (`Costo`) abajo, marcas de agua translúcidas con nombres de acción y tarjetas compactas arrastrables (solo grip + título + costo estimado) que al clickearse abren el modal unificado (`actions` → `Comprar` con monto real pagado / `Editar` / `Mover` / `Eliminar`); `FixedTermsPage`: pestañas `grid-cols-2 w-full sm:inline-flex` sin desborde en `390px` y barra de progreso temporal; `BudgetAssistantPage`: chips de contexto previo (incluyendo `En matriz: X ítems`), chips de meta rápida, grabador de audio nativo `MediaRecorder` (`<= 60s`), botón alineado al input y delta pills en la tabla comparativa; `BudgetSettingsForm`: selector entre `Último día hábil del mes (lun–vie)` y `Día fijo del mes (1–31)`.
  - Accesibilidad transversal: placeholders `>= 4.5:1` (`#8A8A8A`), botones-enlace unificados (`linkButtonClasses`), `scope="col"` en tablas y `prefers-reduced-motion` preservando feedback visible de carga.

### 4.2 Mapa de Archivos Nuevos, Modificados y Plan de Endurecimiento
*(Ver migraciones incrementales `supabase/migrations/20261117000002_phase3_audit_fixes.sql` y `supabase/migrations/20261118000001_closing_alerts_and_payday.sql`, además del desglose atómico de 18 tareas en [04-audit-fixes.md](./04-audit-fixes.md)).*
- **Nuevos:**
  - `src/services/fixedTermsService.ts`
  - `src/services/priorityMatrixService.ts`
  - `src/services/budgetAssistantService.ts`
  - `src/hooks/useExpenseSimulator.ts`
  - `src/features/dashboard/SurplusCloseModal.tsx`
  - `src/features/commitments/AdvanceInstallmentsModal.tsx`
  - `src/features/priority-matrix/PriorityMatrixPage.tsx`
  - `src/features/priority-matrix/PriorityItemFormModal.tsx`
  - `src/features/simulator/SimulatorPage.tsx`
  - `src/features/fixed-terms/FixedTermsPage.tsx`
  - `src/features/fixed-terms/FixedTermFormModal.tsx`
  - `src/features/fixed-terms/AccreditFixedTermModal.tsx`
  - `src/features/budget-assistant/BudgetAssistantPage.tsx`
- **Modificados:**
  - `src/App.tsx`, `src/components/layout/TopNavbar.tsx`
  - `src/types/database.types.ts`, `src/lib/validations.ts`, `src/lib/formatters.ts`
  - `src/services/commitmentsService.ts`, `src/services/savingsService.ts`, `src/services/settingsService.ts`, `src/services/transactionsService.ts`
  - `src/hooks/useDashboardData.ts`
  - `src/features/dashboard/DashboardPage.tsx`, `src/features/dashboard/KpiSummaryGrid.tsx`, `src/features/dashboard/GustitosProgressWidget.tsx`, `src/features/dashboard/PendingCommitmentsWidget.tsx`
  - `src/features/commitments/CommitmentsPage.tsx`, `src/features/commitments/InstallmentsList.tsx`
  - `src/features/savings/SavingsPage.tsx`, `src/features/settings/BudgetSettingsForm.tsx`

---

## 5. Decisiones de Arquitectura

1. **Separación contable mediante `savings_entries.source_type` (Cero doble descuento):**
   En lugar de mezclar todos los depósitos de ahorro en una misma bolsa al restar del `Disponible Real`, etiquetar cada movimiento con `source_type` distingue entre *dinero operativo apartado este mes* (`manual`, `direct_income`) y *movimientos patrimoniales internos* (`cap_surplus_fixed`, `cap_surplus_gustitos`, `fixed_term_return`). Así, trasladar un sobrante de tope a la Bóveda aumenta el patrimonio ahorrado sin volver a restarse del `Disponible Real`.
2. **Aislamiento de inversiones en `fixed_term_deposits` en lugar de crear `transactions` ficticias:**
   Registrar un Plazo Fijo como una transacción `expense` contaminaría los gráficos de gastos por categoría y las alertas de límites. Mantener `fixed_term_deposits` como entidad independiente conectada por FK (`ON DELETE CASCADE`) a `savings_entries` cuando opera con la Bóveda preserva la pureza contable entre *consumo operativo* e *inversión financiera*.
3. **RPCs duales (`authenticated` + `service_role`) para lógica crítica:**
   Tanto la Web como el bot de Telegram comparten `advance_installments`, `revert_installment_payment_batch` y `create_fixed_term_deposit` en PostgreSQL usando `pg_advisory_xact_lock` y `FOR UPDATE`. Esto evita condiciones de carrera si dos acciones ocurren a la vez y elimina la duplicación de lógica transaccional entre React y Deno.
4. **Cálculo determinístico de tasas en Deno en lugar de delegarlo al LLM:**
   Los modelos de lenguaje pueden cometer errores aritméticos con porcentajes y redondeos decimales. Gemini Flash extrae únicamente los parámetros estructurados (`principal_amount`, `yield_percent`, `rate_period`, `term_days`), y el código TypeScript en `_shared/financeHelpers.ts` ejecuta la matemática financiera exacta con `roundCurrency`.
5. **Matriz de Prioridad con paridad táctil sin dependencias externas:**
   HTML5 Drag & Drop nativo (`draggable`) ofrece fluidez inmediata con mouse en desktop, pero carece de soporte consistente en navegadores móviles táctiles. Combinar zonas `ondragover`/`ondrop` con pestañas de cuadrante y botones/selectores nativos `>= 44px` cumple `constitution.md` (cero librerías externas) y garantiza accesibilidad total en teclado y celulares.
