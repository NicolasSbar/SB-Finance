-- ============================================================================
-- MIGRACIÓN DE ENDURECIMIENTO FASE 3 — SB-FINANCE
-- Motor: PostgreSQL 15+ (Supabase)
-- ============================================================================
-- Decisiones de Arquitectura:
-- 1. Seguridad BaaS estricta (`SELECT`-only RLS + `SECURITY DEFINER` controlado):
--    `installment_payment_batches` y `fixed_term_deposits` dejan únicamente
--    políticas `SELECT` para `authenticated`. Todas las mutaciones contables
--    pasan por RPCs `SECURITY DEFINER` con `SET search_path = public`, validación
--    explícita de `auth.uid()` / `service_role` y `pg_advisory_xact_lock`,
--    impidiendo que un cliente manipule estados o saldos vía PostgREST directo.
-- 2. Trigger de resguardo en `savings_entries` con GUC local (`set_config`):
--    Los movimientos generados por RPCs de Fase 3 (`cap_surplus_fixed`,
--    `cap_surplus_gustitos`, `fixed_term_constitution`, `fixed_term_return`)
--    solo pueden insertarse/modificarse/eliminarse cuando la transacción activa
--    habilita el flag local `sb_finance.allow_savings_system_dml = 'on'`. Para no
--    romper el flujo existente de `transactionsService` (`direct_income`), este
--    origen solo se acepta desde `authenticated` cuando existe una transacción
--    `income` con `save_to_savings = true` coincidente en usuario, monto y fecha.
-- 3. Consistencia temporal según `user_settings.timezone`:
--    Reemplazamos `CURRENT_DATE` (UTC) en `accredit_fixed_term_deposit` y
--    `reconcile_cap_surplus` por la fecha local del usuario, evitando desfases
--    después de las 21:00 ART y acotando `p_target_income_month` al mes local
--    actual ya inicializado.
-- 4. Atomicidad en decisiones multi-tabla (`apply_budget_assistant_limits` y
--    `convert_priority_item_to_purchase`):
--    Consolidan en una sola transacción SQL actualizaciones de topes/snapshots
--    y conversión de deseos de la matriz en gastos o cuotas sin dejar estados a medias.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLA DE RATE LIMITING PARA ASISTENTE IA (`budget_assistant_logs`)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.budget_assistant_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  goal_length INTEGER NOT NULL DEFAULT 0 CHECK (goal_length >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_assistant_logs_user_created
  ON public.budget_assistant_logs (user_id, created_at DESC);

ALTER TABLE public.budget_assistant_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "budget_assistant_logs_select_own" ON public.budget_assistant_logs;
CREATE POLICY "budget_assistant_logs_select_own" ON public.budget_assistant_logs
  FOR SELECT USING (auth.uid() = user_id);
-- Sin políticas INSERT/UPDATE/DELETE para anon/authenticated: escritura exclusiva vía service_role.

-- ----------------------------------------------------------------------------
-- 2. RESTRICCIONES CHECK DE LONGITUD DE NOTAS (<= 500) EN FASE 3
-- ----------------------------------------------------------------------------
UPDATE public.fixed_term_deposits
SET notes = left(notes, 500)
WHERE notes IS NOT NULL AND char_length(notes) > 500;

ALTER TABLE public.fixed_term_deposits
  DROP CONSTRAINT IF EXISTS chk_fixed_term_deposits_notes_length;
ALTER TABLE public.fixed_term_deposits
  ADD CONSTRAINT chk_fixed_term_deposits_notes_length
    CHECK (notes IS NULL OR char_length(notes) <= 500) NOT VALID;
ALTER TABLE public.fixed_term_deposits
  VALIDATE CONSTRAINT chk_fixed_term_deposits_notes_length;

UPDATE public.priority_items
SET notes = left(notes, 500)
WHERE notes IS NOT NULL AND char_length(notes) > 500;

ALTER TABLE public.priority_items
  DROP CONSTRAINT IF EXISTS chk_priority_items_notes_length;
ALTER TABLE public.priority_items
  ADD CONSTRAINT chk_priority_items_notes_length
    CHECK (notes IS NULL OR char_length(notes) <= 500) NOT VALID;
ALTER TABLE public.priority_items
  VALIDATE CONSTRAINT chk_priority_items_notes_length;

-- ----------------------------------------------------------------------------
-- 3. ENDURECIMIENTO RLS Y GUARD DE `savings_entries`
-- ----------------------------------------------------------------------------

-- 3.1 installment_payment_batches: solo SELECT para authenticated (mutaciones vía RPC)
DROP POLICY IF EXISTS "installment_batches_select_own" ON public.installment_payment_batches;
CREATE POLICY "installment_batches_select_own" ON public.installment_payment_batches
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "installment_batches_insert_own" ON public.installment_payment_batches;
DROP POLICY IF EXISTS "installment_batches_update_own" ON public.installment_payment_batches;
DROP POLICY IF EXISTS "installment_batches_delete_own" ON public.installment_payment_batches;

-- 3.2 fixed_term_deposits: solo SELECT para authenticated (mutaciones vía RPC)
DROP POLICY IF EXISTS "fixed_terms_select_own" ON public.fixed_term_deposits;
CREATE POLICY "fixed_terms_select_own" ON public.fixed_term_deposits
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "fixed_terms_insert_own" ON public.fixed_term_deposits;
DROP POLICY IF EXISTS "fixed_terms_update_own" ON public.fixed_term_deposits;
DROP POLICY IF EXISTS "fixed_terms_delete_own" ON public.fixed_term_deposits;

-- 3.3 Trigger/guard en savings_entries contra DML directo de authenticated en filas de sistema
CREATE OR REPLACE FUNCTION public.guard_savings_entries_system_dml()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Edge Functions (service_role) y migraciones/administración no pasan por este bloqueo
  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Contexto RPC autorizado dentro de la misma transacción
  IF COALESCE(current_setting('sb_finance.allow_savings_system_dml', true), '') = 'on' THEN
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

DROP TRIGGER IF EXISTS trg_savings_entries_guard_system_dml ON public.savings_entries;
CREATE TRIGGER trg_savings_entries_guard_system_dml
  BEFORE INSERT OR UPDATE OR DELETE ON public.savings_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_savings_entries_system_dml();

-- ----------------------------------------------------------------------------
-- 4. REFINAMIENTO DE RPCs DE FASE 3
-- ----------------------------------------------------------------------------

-- 4.1 get_liquid_savings_balance: exigir pertenencia auth.uid() o service_role
CREATE OR REPLACE FUNCTION public.get_liquid_savings_balance(p_user_id UUID)
RETURNS NUMERIC(12, 2)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
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
  ELSIF v_jwt_role <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
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

-- 4.2 advance_installments: validar p_total_amount >= p_count * 0.01 y SECURITY DEFINER
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
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
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
  ELSIF p_actor_user_id IS NOT NULL AND current_setting('request.jwt.claim.role', true) = 'service_role' THEN
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

-- 4.3 revert_installment_payment_batch: limpiar original_* = NULL al revertir y SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.revert_installment_payment_batch(
  p_batch_id UUID,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
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

  RETURN jsonb_build_object(
    'reverted', true,
    'batch_id', p_batch_id,
    'restored_count', v_restored_count
  );
END;
$$;

-- 4.4 create_fixed_term_deposit: SECURITY DEFINER + contexto local para savings_entries
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
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_user_id UUID;
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
  ELSIF p_actor_user_id IS NOT NULL AND current_setting('request.jwt.claim.role', true) = 'service_role' THEN
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
      fixed_term_id
    )
    VALUES (
      v_user_id,
      date_trunc('month', p_start_date)::DATE,
      'withdrawal',
      v_principal,
      p_start_date,
      ('Constitución Plazo Fijo: ' || v_created.institution)::VARCHAR(150),
      'Capital trasladado de ahorro líquido a inversión inmovilizada.',
      'fixed_term_constitution',
      v_created.id
    );
    PERFORM set_config('sb_finance.allow_savings_system_dml', 'off', true);
  END IF;

  RETURN v_created;
END;
$$;

-- 4.5 accredit_fixed_term_deposit: lock, timezone local, v_acc_date >= start_date, SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.accredit_fixed_term_deposit(
  p_fixed_term_id UUID,
  p_destination VARCHAR DEFAULT 'savings_fund',
  p_actual_return_amount NUMERIC(12, 2) DEFAULT NULL,
  p_accredited_date DATE DEFAULT NULL
)
RETURNS public.fixed_term_deposits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_ft public.fixed_term_deposits;
  v_final_amount NUMERIC(12, 2);
  v_tz TEXT;
  v_local_today DATE;
  v_acc_date DATE;
  v_acc_month DATE;
  v_new_status VARCHAR(25);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_destination IS NULL OR p_destination NOT IN ('savings_fund', 'monthly_available') THEN
    RAISE EXCEPTION 'Destino inválido. Debe ser savings_fund o monthly_available.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

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

  v_final_amount := ROUND(COALESCE(p_actual_return_amount, v_ft.expected_return_amount), 2);
  IF v_final_amount <= 0 OR v_final_amount > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto acreditado debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings
  WHERE user_id = v_user_id;

  v_local_today := (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE;
  v_acc_date := COALESCE(p_accredited_date, GREATEST(v_ft.maturity_date, v_local_today));

  IF v_acc_date < v_ft.start_date THEN
    RAISE EXCEPTION 'La fecha de acreditación (%) no puede ser anterior a la fecha de inicio del plazo fijo (%).',
      v_acc_date, v_ft.start_date;
  END IF;

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
    PERFORM set_config('sb_finance.allow_savings_system_dml', 'off', true);
  END IF;

  RETURN v_ft;
END;
$$;

-- 4.6 reconcile_cap_surplus: lock, timezone local, IF NOT FOUND, bound target_income_month
CREATE OR REPLACE FUNCTION public.reconcile_cap_surplus(
  p_month_date DATE,
  p_bucket VARCHAR,              -- 'fixed_limit' | 'gustitos'
  p_action VARCHAR,              -- 'to_savings' | 'to_available' | 'mark_reviewed'
  p_amount NUMERIC(12, 2) DEFAULT 0.00,
  p_target_income_month DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  IF p_action = 'mark_reviewed' THEN
    UPDATE public.monthly_budgets
    SET surplus_review_completed_at = NOW()
    WHERE user_id = v_user_id AND month_date = v_month;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'El período % no está inicializado.', v_month;
    END IF;

    RETURN jsonb_build_object('ok', true, 'action', 'mark_reviewed');
  END IF;

  IF p_bucket IS NULL
     OR p_bucket NOT IN ('fixed_limit', 'gustitos')
     OR p_action IS NULL
     OR p_action NOT IN ('to_savings', 'to_available') THEN
    RAISE EXCEPTION 'Parámetros inválidos para conciliación de sobrante.';
  END IF;

  IF v_amount <= 0 OR v_amount > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings
  WHERE user_id = v_user_id;

  v_local_today := (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE;
  v_current_local_month := date_trunc('month', v_local_today)::DATE;

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
      CASE WHEN p_bucket = 'fixed_limit' THEN 'Sobrante de Límite Fijos a Ahorros' ELSE 'Sobrante de Gustitos a Ahorros' END,
      'Traslado manual de sobrante de tope mensual sin doble descuento.',
      CASE WHEN p_bucket = 'fixed_limit' THEN 'cap_surplus_fixed' ELSE 'cap_surplus_gustitos' END,
      v_month
    );
    PERFORM set_config('sb_finance.allow_savings_system_dml', 'off', true);
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

-- ----------------------------------------------------------------------------
-- 5. NUEVAS RPCs ATÓMICAS DE FASE 3
-- ----------------------------------------------------------------------------

-- 5.1 cancel_fixed_term_deposit: anula de forma atómica un plazo fijo activo (Web y Telegram)
CREATE OR REPLACE FUNCTION public.cancel_fixed_term_deposit(
  p_fixed_term_id UUID,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_user_id UUID;
  v_ft public.fixed_term_deposits;
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

  PERFORM set_config('sb_finance.allow_savings_system_dml', 'on', true);

  DELETE FROM public.savings_entries
  WHERE fixed_term_id = p_fixed_term_id
    AND user_id = v_user_id;

  DELETE FROM public.fixed_term_deposits
  WHERE id = p_fixed_term_id
    AND user_id = v_user_id
    AND status = 'active';

  PERFORM set_config('sb_finance.allow_savings_system_dml', 'off', true);

  RETURN jsonb_build_object(
    'cancelled', true,
    'fixed_term_id', p_fixed_term_id,
    'origin', v_ft.origin,
    'principal_amount', v_ft.principal_amount
  );
END;
$$;

-- 5.2 apply_budget_assistant_limits: aplica propuesta de límites en una sola transacción
CREATE OR REPLACE FUNCTION public.apply_budget_assistant_limits(
  p_fixed_expenses_limit NUMERIC(12, 2),
  p_gustitos_budget NUMERIC(12, 2),
  p_monthly_savings_target NUMERIC(12, 2),
  p_category_limits JSONB DEFAULT '[]'::jsonb,
  p_apply_to_current_month BOOLEAN DEFAULT false,
  p_target_month_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_fixed_limit NUMERIC(12, 2);
  v_gustitos_budget NUMERIC(12, 2);
  v_savings_target NUMERIC(12, 2);
  v_tz TEXT;
  v_local_month DATE;
  v_target_month DATE := NULL;
  v_item JSONB;
  v_cat_id UUID;
  v_raw_limit TEXT;
  v_limit_num NUMERIC;
  v_norm_limit NUMERIC(12, 2);
  v_updated_cats INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_fixed_limit := ROUND(COALESCE(p_fixed_expenses_limit, -1), 2);
  v_gustitos_budget := ROUND(COALESCE(p_gustitos_budget, -1), 2);
  v_savings_target := ROUND(COALESCE(p_monthly_savings_target, -1), 2);

  IF v_fixed_limit < 0 OR v_fixed_limit > 9999999999.99 THEN
    RAISE EXCEPTION 'El límite de gastos fijos debe estar entre $0,00 y $9.999.999.999,99.';
  END IF;
  IF v_gustitos_budget < 0 OR v_gustitos_budget > 9999999999.99 THEN
    RAISE EXCEPTION 'El presupuesto de Gustitos debe estar entre $0,00 y $9.999.999.999,99.';
  END IF;
  IF v_savings_target < 0 OR v_savings_target > 9999999999.99 THEN
    RAISE EXCEPTION 'La meta de ahorro mensual debe estar entre $0,00 y $9.999.999.999,99.';
  END IF;

  IF p_category_limits IS NOT NULL AND jsonb_typeof(p_category_limits) <> 'array' THEN
    RAISE EXCEPTION 'El formato de límites por categoría debe ser un arreglo JSON.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  UPDATE public.user_settings
  SET
    fixed_expenses_limit = v_fixed_limit,
    gustitos_budget = v_gustitos_budget,
    monthly_savings_target = v_savings_target
  WHERE user_id = v_user_id
  RETURNING COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la configuración del usuario.';
  END IF;

  IF p_category_limits IS NOT NULL THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_category_limits) LOOP
      IF jsonb_typeof(v_item) <> 'object' OR NULLIF(trim(COALESCE(v_item->>'category_id', '')), '') IS NULL THEN
        RAISE EXCEPTION 'Cada elemento de category_limits debe incluir un category_id válido.';
      END IF;

      BEGIN
        v_cat_id := (v_item->>'category_id')::UUID;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Identificador de categoría inválido: %.', v_item->>'category_id';
      END;

      v_raw_limit := v_item->>'suggested_limit';
      IF v_raw_limit IS NULL OR jsonb_typeof(v_item->'suggested_limit') = 'null' THEN
        v_norm_limit := NULL;
      ELSE
        BEGIN
          v_limit_num := v_raw_limit::NUMERIC;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          RAISE EXCEPTION 'El límite sugerido para la categoría % es inválido.', v_cat_id;
        END;

        IF v_limit_num < 0 OR v_limit_num > 9999999999.99 THEN
          RAISE EXCEPTION 'El límite sugerido para la categoría % debe estar entre $0,00 y $9.999.999.999,99.', v_cat_id;
        END IF;

        v_norm_limit := CASE WHEN ROUND(v_limit_num, 2) > 0 THEN ROUND(v_limit_num, 2) ELSE NULL END;
      END IF;

      UPDATE public.categories
      SET monthly_limit = v_norm_limit
      WHERE id = v_cat_id
        AND user_id = v_user_id
        AND type = 'expense';

      IF NOT FOUND THEN
        RAISE EXCEPTION 'La categoría % no existe, no pertenece al usuario o no es de tipo gasto.', v_cat_id;
      END IF;

      v_updated_cats := v_updated_cats + 1;
    END LOOP;
  END IF;

  IF COALESCE(p_apply_to_current_month, false) THEN
    v_local_month := date_trunc('month', (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE)::DATE;
    v_target_month := COALESCE(date_trunc('month', p_target_month_date)::DATE, v_local_month);

    IF v_target_month < v_local_month THEN
      RAISE EXCEPTION 'No está permitido sobrescribir el presupuesto de un mes anterior (%).', v_target_month;
    END IF;

    PERFORM public.ensure_monthly_period(v_target_month);

    UPDATE public.monthly_budgets
    SET
      fixed_expenses_limit = v_fixed_limit,
      gustitos_budget = v_gustitos_budget,
      monthly_savings_target = v_savings_target
    WHERE user_id = v_user_id
      AND month_date = v_target_month;

    IF p_category_limits IS NOT NULL THEN
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_category_limits) LOOP
        v_cat_id := (v_item->>'category_id')::UUID;
        v_raw_limit := v_item->>'suggested_limit';
        IF v_raw_limit IS NULL OR jsonb_typeof(v_item->'suggested_limit') = 'null' THEN
          v_norm_limit := NULL;
        ELSE
          v_limit_num := v_raw_limit::NUMERIC;
          v_norm_limit := CASE WHEN ROUND(v_limit_num, 2) > 0 THEN ROUND(v_limit_num, 2) ELSE NULL END;
        END IF;

        UPDATE public.monthly_category_snapshots
        SET monthly_limit = v_norm_limit
        WHERE user_id = v_user_id
          AND month_date = v_target_month
          AND category_id = v_cat_id;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied_to_current_month', COALESCE(p_apply_to_current_month, false),
    'target_month_date', v_target_month,
    'updated_categories_count', v_updated_cats
  );
END;
$$;

-- 5.3 convert_priority_item_to_purchase: conversión atómica de deseo a gasto o compra en cuotas
CREATE OR REPLACE FUNCTION public.convert_priority_item_to_purchase(
  p_priority_item_id UUID,
  p_purchase_mode VARCHAR,               -- 'cash' | 'installments'
  p_category_id UUID,
  p_description VARCHAR,
  p_amount NUMERIC(12, 2),
  p_purchase_date DATE,
  p_installments_count SMALLINT DEFAULT 1,
  p_first_installment_date DATE DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_is_gustito BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_item public.priority_items;
  v_cat public.categories;
  v_clean_desc VARCHAR(150);
  v_clean_notes TEXT;
  v_norm_amount NUMERIC(12, 2);
  v_effective_gustito BOOLEAN;
  v_tz TEXT;
  v_local_month DATE;
  v_target_month DATE;
  v_created_id UUID;
  v_purchase public.installment_purchases;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_priority_item_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del ítem de la matriz es obligatorio.';
  END IF;

  IF p_purchase_mode IS NULL OR p_purchase_mode NOT IN ('cash', 'installments') THEN
    RAISE EXCEPTION 'Modo de conversión inválido. Debe ser cash o installments.';
  END IF;

  v_clean_desc := trim(COALESCE(p_description, ''));
  IF char_length(v_clean_desc) < 2 OR char_length(v_clean_desc) > 150 THEN
    RAISE EXCEPTION 'La descripción debe tener entre 2 y 150 caracteres.';
  END IF;

  v_clean_notes := NULLIF(trim(COALESCE(p_notes, '')), '');
  IF v_clean_notes IS NOT NULL AND char_length(v_clean_notes) > 500 THEN
    RAISE EXCEPTION 'Las notas no pueden superar los 500 caracteres.';
  END IF;

  v_norm_amount := ROUND(COALESCE(p_amount, 0.00), 2);
  IF v_norm_amount < 0.01 OR v_norm_amount > 9999999999.99 THEN
    RAISE EXCEPTION 'El monto debe estar entre $0,01 y $9.999.999.999,99.';
  END IF;

  IF p_purchase_date IS NULL THEN
    RAISE EXCEPTION 'La fecha de compra es obligatoria.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::TEXT));

  SELECT * INTO v_item
  FROM public.priority_items
  WHERE id = p_priority_item_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El ítem de la Matriz de Prioridad no existe o ya fue convertido.';
  END IF;

  SELECT * INTO v_cat
  FROM public.categories
  WHERE id = p_category_id
    AND user_id = v_user_id
    AND type = 'expense';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La categoría seleccionada no existe, no pertenece al usuario o no es de tipo gasto.';
  END IF;

  v_effective_gustito := COALESCE(p_is_gustito, false) OR COALESCE(v_cat.is_gustito, false);

  SELECT COALESCE(timezone, 'America/Argentina/Buenos_Aires') INTO v_tz
  FROM public.user_settings
  WHERE user_id = v_user_id;

  v_local_month := date_trunc('month', (NOW() AT TIME ZONE COALESCE(v_tz, 'America/Argentina/Buenos_Aires'))::DATE)::DATE;

  IF p_purchase_mode = 'cash' THEN
    v_target_month := date_trunc('month', p_purchase_date)::DATE;
    IF v_target_month >= v_local_month THEN
      PERFORM public.ensure_monthly_period(v_target_month);
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
      'expense',
      v_norm_amount,
      p_purchase_date,
      v_clean_desc,
      v_clean_notes,
      'web',
      v_effective_gustito,
      false
    )
    RETURNING id INTO v_created_id;
  ELSE
    IF p_installments_count IS NULL OR p_installments_count < 1 OR p_installments_count > 120 THEN
      RAISE EXCEPTION 'La cantidad de cuotas debe estar entre 1 y 120.';
    END IF;

    IF p_first_installment_date IS NULL THEN
      RAISE EXCEPTION 'La fecha de la primera cuota es obligatoria.';
    END IF;

    IF (v_norm_amount * p_installments_count) > 9999999999.99 THEN
      RAISE EXCEPTION 'El monto total financiado supera el máximo permitido.';
    END IF;

    v_target_month := date_trunc('month', p_first_installment_date)::DATE;
    IF v_target_month >= v_local_month THEN
      PERFORM public.ensure_monthly_period(v_target_month);
    END IF;

    v_purchase := public.create_installment_purchase(
      p_category_id,
      v_clean_desc,
      v_norm_amount,
      p_installments_count,
      p_purchase_date,
      p_first_installment_date,
      v_clean_notes,
      v_effective_gustito,
      'web'
    );
    v_created_id := v_purchase.id;
  END IF;

  DELETE FROM public.priority_items
  WHERE id = p_priority_item_id AND user_id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', p_purchase_mode,
    'priority_item_id', p_priority_item_id,
    'created_id', v_created_id,
    'month_date', v_target_month
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. PRIVILEGIOS EXPLÍCITOS DE EJECUCIÓN EN TODAS LAS RPCs DE FASE 3
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.guard_savings_entries_system_dml() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.advance_installments(UUID, SMALLINT, DATE, NUMERIC, VARCHAR, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_installments(UUID, SMALLINT, DATE, NUMERIC, VARCHAR, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.revert_installment_payment_batch(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_installment_payment_batch(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_liquid_savings_balance(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_liquid_savings_balance(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_fixed_term_deposit(VARCHAR, NUMERIC, NUMERIC, DATE, DATE, VARCHAR, VARCHAR, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_fixed_term_deposit(VARCHAR, NUMERIC, NUMERIC, DATE, DATE, VARCHAR, VARCHAR, TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.accredit_fixed_term_deposit(UUID, VARCHAR, NUMERIC, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accredit_fixed_term_deposit(UUID, VARCHAR, NUMERIC, DATE) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reconcile_cap_surplus(DATE, VARCHAR, VARCHAR, NUMERIC, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_cap_surplus(DATE, VARCHAR, VARCHAR, NUMERIC, DATE) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.cancel_fixed_term_deposit(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_fixed_term_deposit(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.apply_budget_assistant_limits(NUMERIC, NUMERIC, NUMERIC, JSONB, BOOLEAN, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_budget_assistant_limits(NUMERIC, NUMERIC, NUMERIC, JSONB, BOOLEAN, DATE) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.convert_priority_item_to_purchase(UUID, VARCHAR, UUID, VARCHAR, NUMERIC, DATE, SMALLINT, DATE, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_priority_item_to_purchase(UUID, VARCHAR, UUID, VARCHAR, NUMERIC, DATE, SMALLINT, DATE, TEXT, BOOLEAN) TO authenticated, service_role;
