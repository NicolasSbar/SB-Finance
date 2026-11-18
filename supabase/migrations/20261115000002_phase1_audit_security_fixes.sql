-- ============================================================================
-- MIGRACIÓN DE REMEDIACIÓN DE SEGURIDAD FASE 1 — SB-FINANCE
-- ============================================================================
-- Decisiones de Arquitectura:
-- 1. FKs compuestas (category_id, user_id) -> categories(id, user_id):
--    En arquitecturas multi-tenant con RLS, una FK simple sobre `category_id`
--    solo verifica que la categoría exista, pero no que pertenezca al mismo
--    `user_id`. Con la restricción UNIQUE (id, user_id) y FKs compuestas,
--    PostgreSQL garantiza en motor que ningún usuario pueda referenciar
--    categorías ajenas ni bloquear el borrado de cuentas de terceros.
-- 2. Trigger BEFORE UPDATE en user_settings: complementa la política RLS
--    impidiendo cualquier intento de auto-escalación de `is_admin` desde el rol
--    `authenticated` (defensa en profundidad).
-- 3. SET search_path = public en todas las funciones/triggers/RPCs: mitiga
--    ataques de secuestro de búsqueda de esquemas (search_path hijacking).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Restricción UNIQUE compuesta en categories para soportar FKs por tenant
-- ----------------------------------------------------------------------------
ALTER TABLE public.categories
  ADD CONSTRAINT uq_categories_id_user UNIQUE (id, user_id);

-- ----------------------------------------------------------------------------
-- 2. Reemplazar FKs simples de category_id por FKs compuestas (category_id, user_id)
-- ----------------------------------------------------------------------------
ALTER TABLE public.fixed_expense_templates
  DROP CONSTRAINT IF EXISTS fixed_expense_templates_category_id_fkey,
  ADD CONSTRAINT fk_fixed_expense_templates_category_user
    FOREIGN KEY (category_id, user_id)
    REFERENCES public.categories (id, user_id)
    ON DELETE RESTRICT;

ALTER TABLE public.installment_purchases
  DROP CONSTRAINT IF EXISTS installment_purchases_category_id_fkey,
  ADD CONSTRAINT fk_installment_purchases_category_user
    FOREIGN KEY (category_id, user_id)
    REFERENCES public.categories (id, user_id)
    ON DELETE RESTRICT;

ALTER TABLE public.monthly_commitments
  DROP CONSTRAINT IF EXISTS monthly_commitments_category_id_fkey,
  ADD CONSTRAINT fk_monthly_commitments_category_user
    FOREIGN KEY (category_id, user_id)
    REFERENCES public.categories (id, user_id)
    ON DELETE RESTRICT;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_category_id_fkey,
  ADD CONSTRAINT fk_transactions_category_user
    FOREIGN KEY (category_id, user_id)
    REFERENCES public.categories (id, user_id)
    ON DELETE RESTRICT;

-- ----------------------------------------------------------------------------
-- 3. Defensa en profundidad contra auto-escalación de is_admin en user_settings
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_is_admin_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin
     AND COALESCE(auth.role(), '') = 'authenticated' THEN
    RAISE EXCEPTION 'No está permitido modificar el privilegio de administrador desde el cliente.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_settings_prevent_admin_escalation ON public.user_settings;
CREATE TRIGGER trg_user_settings_prevent_admin_escalation
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.prevent_is_admin_escalation();

-- ----------------------------------------------------------------------------
-- 4. Fijar SET search_path = public en set_updated_at y ensure_monthly_period
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

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

  -- Obtener configuración base del usuario
  SELECT * INTO v_settings
  FROM public.user_settings
  WHERE user_id = v_user_id;

  -- 1. Crear snapshot en monthly_budgets si no existe
  INSERT INTO public.monthly_budgets (
    user_id,
    month_date,
    fixed_salary,
    monthly_savings_target,
    fixed_expenses_limit
  )
  VALUES (
    v_user_id,
    v_normalized_month,
    COALESCE(v_settings.fixed_salary, 0.00),
    COALESCE(v_settings.monthly_savings_target, 0.00),
    COALESCE(v_settings.fixed_expenses_limit, 0.00)
  )
  ON CONFLICT (user_id, month_date) DO NOTHING;

  -- 2. Instanciar gastos fijos activos que aún no estén en ese mes
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

-- ----------------------------------------------------------------------------
-- 5. Hardening de RPCs de cuotas (search_path, categoría propia de gasto y existencia)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_installment_purchase(
  p_category_id UUID,
  p_description VARCHAR,
  p_installment_amount NUMERIC(12, 2),
  p_installments_count SMALLINT,
  p_purchase_date DATE,
  p_first_installment_date DATE,
  p_notes TEXT DEFAULT NULL
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
    notes
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
    p_notes
  )
  RETURNING * INTO v_purchase;

  -- Pre-generar las N filas individuales en monthly_commitments
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

CREATE OR REPLACE FUNCTION public.update_installment_purchase(
  p_purchase_id UUID,
  p_category_id UUID,
  p_description VARCHAR,
  p_installment_amount NUMERIC(12, 2),
  p_installments_count SMALLINT,
  p_purchase_date DATE,
  p_first_installment_date DATE,
  p_notes TEXT DEFAULT NULL
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
      notes = p_notes
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
      notes = p_notes
    WHERE id = p_purchase_id AND user_id = v_user_id
    RETURNING * INTO v_purchase;
  END IF;

  RETURN v_purchase;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Idempotencia de Ahorros y Bóveda Aislada (para instancias ya inicializadas)
-- ----------------------------------------------------------------------------
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS monthly_savings_target NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (monthly_savings_target >= 0 AND monthly_savings_target <= 9999999999.99);

ALTER TABLE public.monthly_budgets
  ADD COLUMN IF NOT EXISTS monthly_savings_target NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (monthly_savings_target >= 0 AND monthly_savings_target <= 9999999999.99);

CREATE TABLE IF NOT EXISTS public.savings_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_date DATE NOT NULL
    CHECK (EXTRACT(DAY FROM month_date) = 1),
  entry_type VARCHAR(12) NOT NULL CHECK (entry_type IN ('deposit', 'withdrawal')),
  amount NUMERIC(12, 2) NOT NULL
    CHECK (amount > 0 AND amount <= 9999999999.99),
  entry_date DATE NOT NULL,
  description VARCHAR(150) NOT NULL CHECK (char_length(trim(description)) >= 2),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_savings_entry_month_coherence
    CHECK (month_date = date_trunc('month', entry_date)::DATE)
);

CREATE INDEX IF NOT EXISTS idx_savings_entries_user_month
  ON public.savings_entries (user_id, month_date DESC, entry_date DESC);

DROP TRIGGER IF EXISTS trg_savings_entries_updated_at ON public.savings_entries;
CREATE TRIGGER trg_savings_entries_updated_at
  BEFORE UPDATE ON public.savings_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.savings_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "savings_entries_select_own" ON public.savings_entries;
CREATE POLICY "savings_entries_select_own" ON public.savings_entries
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "savings_entries_insert_own" ON public.savings_entries;
CREATE POLICY "savings_entries_insert_own" ON public.savings_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "savings_entries_update_own" ON public.savings_entries;
CREATE POLICY "savings_entries_update_own" ON public.savings_entries
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "savings_entries_delete_own" ON public.savings_entries;
CREATE POLICY "savings_entries_delete_own" ON public.savings_entries
  FOR DELETE USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_settings (
    user_id,
    fixed_salary,
    monthly_savings_target,
    fixed_expenses_limit,
    currency,
    is_admin
  )
  VALUES (NEW.id, 0.00, 0.00, 0.00, 'ARS', false)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.categories (user_id, name, type, icon, is_system, is_active)
  VALUES
    (NEW.id, 'Comida y Supermercado', 'expense', 'utensils', true, true),
    (NEW.id, 'Transporte y Combustible', 'expense', 'car', true, true),
    (NEW.id, 'Servicios y Suscripciones', 'expense', 'zap', true, true),
    (NEW.id, 'Vivienda y Alquiler', 'expense', 'home', true, true),
    (NEW.id, 'Ocio y Salidas', 'expense', 'film', true, true),
    (NEW.id, 'Salud y Farmacia', 'expense', 'heart-pulse', true, true),
    (NEW.id, 'Educación', 'expense', 'graduation-cap', true, true),
    (NEW.id, 'Compras e Indumentaria', 'expense', 'shopping-bag', true, true),
    (NEW.id, 'Gastos Extra / Otros', 'expense', 'circle-ellipsis', true, true),
    (NEW.id, 'Ingresos Extra', 'income', 'wallet', true, true),
    (NEW.id, 'Freelance / Trabajos', 'income', 'briefcase', true, true),
    (NEW.id, 'Ventas / Reintegros', 'income', 'arrow-down-left', true, true)
  ON CONFLICT (user_id, name, type) DO NOTHING;

  RETURN NEW;
END;
$$;
