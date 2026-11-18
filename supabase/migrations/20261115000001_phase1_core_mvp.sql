-- ============================================================================
-- MIGRACIÓN FASE 1 (CORE MVP) — SB-FINANCE
-- Motor: PostgreSQL 15+ (Supabase)
-- Reglas: NUMERIC(12,2) para dinero, DATE para fechas, RLS estricto por auth.uid()
-- ============================================================================
-- Decisiones de Arquitectura:
-- 1. Dinero en NUMERIC(12,2): evita imprecisiones binarias IEEE 754 (0.1 + 0.2 != 0.3).
-- 2. Períodos mensuales como DATE anclado al día 1 ('YYYY-MM-01'): permite
--    indexación eficiente de 4 bytes y aritmética de calendario nativa en PostgreSQL.
-- 3. Tabla unificada monthly_commitments: converge gastos fijos (Lazy Init) y cuotas
--    (Eager Pre-generation con ON DELETE CASCADE) para consultar el total comprometido
--    del mes sin joins complejos.
-- 4. Categorías con ON DELETE RESTRICT + is_active: protege la integridad histórica
--    evitando borrar o quedar sin categoría en movimientos de meses cerrados.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 0. FUNCIÓN AUXILIAR PARA TIMESTAMPS (updated_at)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. TABLA: user_settings (Configuración global del usuario y rol admin)
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  fixed_salary NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (fixed_salary >= 0 AND fixed_salary <= 9999999999.99),
  monthly_savings_target NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (monthly_savings_target >= 0 AND monthly_savings_target <= 9999999999.99),
  fixed_expenses_limit NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (fixed_expenses_limit >= 0 AND fixed_expenses_limit <= 9999999999.99),
  currency VARCHAR(3) NOT NULL DEFAULT 'ARS'
    CHECK (char_length(currency) = 3),
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. TABLA: categories (Categorías de Gastos e Ingresos con Borrado Lógico)
-- ----------------------------------------------------------------------------
CREATE TABLE public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(60) NOT NULL CHECK (char_length(trim(name)) >= 2),
  type VARCHAR(10) NOT NULL CHECK (type IN ('expense', 'income')),
  icon VARCHAR(40) NOT NULL DEFAULT 'tag',
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_categories_user_name_type UNIQUE (user_id, name, type)
);

CREATE INDEX idx_categories_user_type_active
  ON public.categories (user_id, type, is_active);

CREATE TRIGGER trg_categories_updated_at
  BEFORE UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. TABLA: monthly_budgets (Snapshots mensuales para inmutabilidad histórica)
-- Nota: month_date siempre es el día 1 del mes (ej. '2026-11-01')
-- ----------------------------------------------------------------------------
CREATE TABLE public.monthly_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_date DATE NOT NULL
    CHECK (EXTRACT(DAY FROM month_date) = 1),
  fixed_salary NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (fixed_salary >= 0 AND fixed_salary <= 9999999999.99),
  monthly_savings_target NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (monthly_savings_target >= 0 AND monthly_savings_target <= 9999999999.99),
  fixed_expenses_limit NUMERIC(12, 2) NOT NULL DEFAULT 0.00
    CHECK (fixed_expenses_limit >= 0 AND fixed_expenses_limit <= 9999999999.99),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_monthly_budgets_user_month UNIQUE (user_id, month_date)
);

CREATE INDEX idx_monthly_budgets_user_month
  ON public.monthly_budgets (user_id, month_date DESC);

CREATE TRIGGER trg_monthly_budgets_updated_at
  BEFORE UPDATE ON public.monthly_budgets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. TABLA: fixed_expense_templates (Plantillas de Gastos Fijos Recurrentes)
-- ----------------------------------------------------------------------------
CREATE TABLE public.fixed_expense_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL CHECK (char_length(trim(name)) >= 2),
  default_amount NUMERIC(12, 2) NOT NULL
    CHECK (default_amount > 0 AND default_amount <= 9999999999.99),
  due_day SMALLINT
    CHECK (due_day IS NULL OR (due_day >= 1 AND due_day <= 31)),
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fixed_templates_user_active
  ON public.fixed_expense_templates (user_id, is_active);

CREATE TRIGGER trg_fixed_expense_templates_updated_at
  BEFORE UPDATE ON public.fixed_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. TABLA: installment_purchases (Compras Padre en Cuotas)
-- ----------------------------------------------------------------------------
CREATE TABLE public.installment_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  description VARCHAR(150) NOT NULL CHECK (char_length(trim(description)) >= 2),
  installment_amount NUMERIC(12, 2) NOT NULL
    CHECK (installment_amount > 0 AND installment_amount <= 9999999999.99),
  installments_count SMALLINT NOT NULL
    CHECK (installments_count >= 1 AND installments_count <= 120),
  total_amount NUMERIC(12, 2) NOT NULL
    CHECK (total_amount > 0 AND total_amount <= 9999999999.99),
  purchase_date DATE NOT NULL,
  first_installment_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_installment_purchases_user_date
  ON public.installment_purchases (user_id, first_installment_date DESC);

CREATE TRIGGER trg_installment_purchases_updated_at
  BEFORE UPDATE ON public.installment_purchases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 6. TABLA: monthly_commitments (Instancias Mensuales de Fijos y Cuotas)
-- Nota crítica:
--   - installment_purchase_id usa ON DELETE CASCADE (anular compra borra sus cuotas).
--   - fixed_expense_template_id usa ON DELETE SET NULL (borrar plantilla no borra historial pasado).
-- ----------------------------------------------------------------------------
CREATE TABLE public.monthly_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_date DATE NOT NULL
    CHECK (EXTRACT(DAY FROM month_date) = 1),
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  commitment_type VARCHAR(20) NOT NULL
    CHECK (commitment_type IN ('fixed_expense', 'installment')),
  fixed_expense_template_id UUID
    REFERENCES public.fixed_expense_templates(id) ON DELETE SET NULL,
  installment_purchase_id UUID
    REFERENCES public.installment_purchases(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL CHECK (char_length(trim(name)) >= 2),
  amount NUMERIC(12, 2) NOT NULL
    CHECK (amount > 0 AND amount <= 9999999999.99),
  due_date DATE,
  installment_number SMALLINT
    CHECK (installment_number IS NULL OR installment_number >= 1),
  total_installments SMALLINT
    CHECK (total_installments IS NULL OR total_installments >= 1),
  is_paid BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_commitment_source_coherence CHECK (
    (commitment_type = 'fixed_expense' AND installment_purchase_id IS NULL AND installment_number IS NULL AND total_installments IS NULL)
    OR
    (commitment_type = 'installment' AND installment_purchase_id IS NOT NULL AND installment_number IS NOT NULL AND total_installments IS NOT NULL AND installment_number <= total_installments)
  )
);

-- Evita duplicar la instancia de una misma plantilla de gasto fijo en el mismo mes
CREATE UNIQUE INDEX uq_monthly_commitment_fixed_template_month
  ON public.monthly_commitments (user_id, fixed_expense_template_id, month_date)
  WHERE fixed_expense_template_id IS NOT NULL;

-- Evita duplicar el mismo número de cuota para una misma compra
CREATE UNIQUE INDEX uq_monthly_commitment_installment_number
  ON public.monthly_commitments (installment_purchase_id, installment_number)
  WHERE installment_purchase_id IS NOT NULL;

CREATE INDEX idx_monthly_commitments_user_month
  ON public.monthly_commitments (user_id, month_date, is_paid);

CREATE TRIGGER trg_monthly_commitments_updated_at
  BEFORE UPDATE ON public.monthly_commitments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. TABLA: transactions (Movimientos Manuales: Gastos Variables e Ingresos Extra)
-- ----------------------------------------------------------------------------
CREATE TABLE public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  type VARCHAR(10) NOT NULL CHECK (type IN ('expense', 'income')),
  amount NUMERIC(12, 2) NOT NULL
    CHECK (amount > 0 AND amount <= 9999999999.99),
  transaction_date DATE NOT NULL,
  description VARCHAR(150) NOT NULL CHECK (char_length(trim(description)) >= 2),
  notes TEXT,
  source VARCHAR(15) NOT NULL DEFAULT 'web'
    CHECK (source IN ('web', 'telegram')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_date
  ON public.transactions (user_id, transaction_date DESC);

CREATE INDEX idx_transactions_user_category
  ON public.transactions (user_id, category_id);

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7B. TABLA: savings_entries (Bóveda de Ahorros Aislada del Disponible Real)
-- ----------------------------------------------------------------------------
CREATE TABLE public.savings_entries (
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

CREATE INDEX idx_savings_entries_user_month
  ON public.savings_entries (user_id, month_date DESC, entry_date DESC);

CREATE TRIGGER trg_savings_entries_updated_at
  BEFORE UPDATE ON public.savings_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 8. POLÍTICAS ROW LEVEL SECURITY (RLS) ESTRICTAS POR auth.uid()
-- ============================================================================

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixed_expense_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.installment_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.savings_entries ENABLE ROW LEVEL SECURITY;

-- Políticas para user_settings
-- Nota de seguridad: el usuario no puede auto-asignarse is_admin = true desde el cliente
CREATE POLICY "user_settings_select_own" ON public.user_settings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_settings_insert_own" ON public.user_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id AND is_admin = false);

CREATE POLICY "user_settings_update_own" ON public.user_settings
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND is_admin = (SELECT us.is_admin FROM public.user_settings us WHERE us.user_id = auth.uid())
  );

-- Políticas para categories
CREATE POLICY "categories_select_own" ON public.categories
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "categories_insert_own" ON public.categories
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "categories_update_own" ON public.categories
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "categories_delete_own" ON public.categories
  FOR DELETE USING (auth.uid() = user_id);

-- Políticas para monthly_budgets
CREATE POLICY "monthly_budgets_select_own" ON public.monthly_budgets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "monthly_budgets_insert_own" ON public.monthly_budgets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "monthly_budgets_update_own" ON public.monthly_budgets
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "monthly_budgets_delete_own" ON public.monthly_budgets
  FOR DELETE USING (auth.uid() = user_id);

-- Políticas para fixed_expense_templates
CREATE POLICY "fixed_templates_select_own" ON public.fixed_expense_templates
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "fixed_templates_insert_own" ON public.fixed_expense_templates
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "fixed_templates_update_own" ON public.fixed_expense_templates
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "fixed_templates_delete_own" ON public.fixed_expense_templates
  FOR DELETE USING (auth.uid() = user_id);

-- Políticas para installment_purchases
CREATE POLICY "installments_select_own" ON public.installment_purchases
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "installments_insert_own" ON public.installment_purchases
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "installments_update_own" ON public.installment_purchases
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "installments_delete_own" ON public.installment_purchases
  FOR DELETE USING (auth.uid() = user_id);

-- Políticas para monthly_commitments
CREATE POLICY "commitments_select_own" ON public.monthly_commitments
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "commitments_insert_own" ON public.monthly_commitments
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "commitments_update_own" ON public.monthly_commitments
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "commitments_delete_own" ON public.monthly_commitments
  FOR DELETE USING (auth.uid() = user_id);

-- Políticas para transactions
CREATE POLICY "transactions_select_own" ON public.transactions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "transactions_insert_own" ON public.transactions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "transactions_update_own" ON public.transactions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "transactions_delete_own" ON public.transactions
  FOR DELETE USING (auth.uid() = user_id);

-- Políticas para savings_entries
CREATE POLICY "savings_entries_select_own" ON public.savings_entries
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "savings_entries_insert_own" ON public.savings_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "savings_entries_update_own" ON public.savings_entries
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "savings_entries_delete_own" ON public.savings_entries
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- 9. TRIGGERS Y FUNCIONES RPC DE NEGOCIO
-- ============================================================================

-- 9.1 Trigger de aprovisionamiento automático al crear un usuario en auth.users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1. Crear configuración inicial en $0
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

  -- 2. Crear set básico de categorías de Gastos (expense) e Ingresos (income)
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 9.2 RPC: Inicializar de forma idempotente el presupuesto mensual y los gastos fijos del mes
CREATE OR REPLACE FUNCTION public.ensure_monthly_period(p_month_date DATE)
RETURNS public.monthly_budgets
LANGUAGE plpgsql
SECURITY INVOKER
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

-- 9.3 RPC: Crear compra en cuotas y pre-generar sus N compromisos mensuales
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
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_total_amount NUMERIC(12, 2);
  v_purchase public.installment_purchases;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
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

-- 9.4 RPC: Editar compra en cuotas preservando cuotas pagadas
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
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_paid_count INT;
  v_purchase public.installment_purchases;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
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

-- ============================================================================
-- 10. KEEP-ALIVE DIARIO — ETAPA DE DESARROLLO (pg_cron + pg_net)
-- ============================================================================
-- Decisiones de Arquitectura:
-- - Por qué usamos `pg_net` hacia `/rest/v1/` en vez de un `SELECT 1` interno:
--   El plan gratuito de Supabase pausa proyectos tras 7 días sin tráfico en su
--   API Gateway / PostgREST. Una petición HTTP diaria mediante `pg_net` hacia
--   `/rest/v1/user_settings?select=user_id&limit=1` con la `anon` key atraviesa
--   todo el stack (Kong -> PostgREST -> PostgreSQL) y devuelve `200 OK` con 0
--   filas gracias a RLS (`auth.uid()` es NULL), manteniendo viva la instancia
--   sin exponer datos ni secretos.
-- - Reemplazo en producción: al desplegar en Vercel, el endpoint `/api/keep-alive`
--   (configurado en `vercel.json`) reemplaza este cron interno para evitar doble ping.
--
-- INSTRUCCIONES PARA COPIAR Y PEGAR EN EL SQL EDITOR DE SUPABASE:
-- 1. Reemplazá `<TU_PROYECTO>` y `<TU_SUPABASE_ANON_KEY>` por tus valores reales
--    (ubicados en Supabase Dashboard -> Project Settings -> API).
-- 2. Nunca subas a GitHub la `anon` key o `service_role` key pegada en este archivo.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'sb-finance-keep-alive-daily',
  '0 9 * * *', -- Todos los días a las 09:00 UTC (06:00 ART)
  $$
  SELECT net.http_get(
    url := 'https://<TU_PROYECTO>.supabase.co/rest/v1/user_settings?select=user_id&limit=1',
    headers := jsonb_build_object(
      'apikey', '<TU_SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <TU_SUPABASE_ANON_KEY>'
    )
  );
  $$
);

-- ----------------------------------------------------------------------------
-- Comandos útiles de verificación y transición a Producción (ejecutar aparte):
-- ----------------------------------------------------------------------------
-- 1) Verificar que el cron quedó programado:
--    SELECT jobid, jobname, schedule, active FROM cron.job;
--
-- 2) Revisar las últimas ejecuciones del cron:
--    SELECT jobid, status, return_message, start_time, end_time
--    FROM cron.job_run_details
--    ORDER BY start_time DESC
--    LIMIT 10;
--
-- 3) Probar el ping manualmente ahora mismo (opcional):
--    SELECT net.http_get(
--      url := 'https://<TU_PROYECTO>.supabase.co/rest/v1/user_settings?select=user_id&limit=1',
--      headers := jsonb_build_object(
--        'apikey', '<TU_SUPABASE_ANON_KEY>',
--        'Authorization', 'Bearer <TU_SUPABASE_ANON_KEY>'
--      )
--    );
--
-- 4) Desactivar el keep-alive interno cuando pases a Producción en Vercel:
--    SELECT cron.unschedule('sb-finance-keep-alive-daily');

