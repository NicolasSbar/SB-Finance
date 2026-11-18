# Especificación Técnica — Fase 1 (Core MVP) — SB-Finance

> **Versión:** 1.0.0  
> **Estado:** Aprobado para implementación  
> **Documentos base:** `specs/constitution.md`, `specs/product_roadmap.md`, `specs/fase-1-core/01-functional-spec.md`

---

## 1. Esquema Completo de PostgreSQL (SQL Listo para Migración)

El siguiente script SQL (`supabase/migrations/20261115000001_phase1_core_mvp.sql`) define todas las tablas, restricciones de integridad, índices, funciones RPC transaccionales, triggers de aprovisionamiento y políticas **Row Level Security (RLS)** de la Fase 1.

```sql
-- ============================================================================
-- MIGRACIÓN FASE 1 (CORE MVP) — SB-FINANCE
-- Motor: PostgreSQL 15+ (Supabase)
-- Reglas: NUMERIC(12,2) para dinero, DATE para fechas, RLS estricto por auth.uid()
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 0. FUNCIÓN AUXILIAR PARA TIMESTAMPS (updated_at)
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
  CONSTRAINT uq_categories_user_name_type UNIQUE (user_id, name, type),
  CONSTRAINT uq_categories_id_user UNIQUE (id, user_id)
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
  category_id UUID NOT NULL,
  name VARCHAR(100) NOT NULL CHECK (char_length(trim(name)) >= 2),
  default_amount NUMERIC(12, 2) NOT NULL
    CHECK (default_amount > 0 AND default_amount <= 9999999999.99),
  due_day SMALLINT
    CHECK (due_day IS NULL OR (due_day >= 1 AND due_day <= 31)),
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_fixed_templates_category_user
    FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE RESTRICT
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
  category_id UUID NOT NULL,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_installment_purchases_category_user
    FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE RESTRICT
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
  category_id UUID NOT NULL,
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
  ),
  CONSTRAINT fk_monthly_commitments_category_user
    FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE RESTRICT
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
  category_id UUID NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('expense', 'income')),
  amount NUMERIC(12, 2) NOT NULL
    CHECK (amount > 0 AND amount <= 9999999999.99),
  transaction_date DATE NOT NULL,
  description VARCHAR(150) NOT NULL CHECK (char_length(trim(description)) >= 2),
  notes TEXT,
  source VARCHAR(15) NOT NULL DEFAULT 'web'
    CHECK (source IN ('web', 'telegram')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_transactions_category_user
    FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id) ON DELETE RESTRICT
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
    SELECT 1 FROM public.categories
    WHERE id = p_category_id AND user_id = v_user_id AND type = 'expense'
  ) THEN
    RAISE EXCEPTION 'Categoría de gasto inválida o sin permisos';
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
    SELECT 1 FROM public.installment_purchases
    WHERE id = p_purchase_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Compra en cuotas no encontrada o sin permisos';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.categories
    WHERE id = p_category_id AND user_id = v_user_id AND type = 'expense'
  ) THEN
    RAISE EXCEPTION 'Categoría de gasto inválida o sin permisos';
  END IF;

  SELECT COUNT(*) INTO v_paid_count
  FROM public.monthly_commitments
  WHERE installment_purchase_id = p_purchase_id
    AND user_id = v_user_id
    AND is_paid = true;

  IF v_paid_count = 0 THEN
    -- Si ninguna cuota fue pagada, se puede regenerar la estructura completa
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
```

---

## 2. Interfaces y Tipos TypeScript (`strict: true`) y Esquemas `zod`

### 2.1 Tipos de Dominio (`src/types/database.types.ts`)

```typescript
export type TransactionType = 'expense' | 'income';
export type CommitmentType = 'fixed_expense' | 'installment';
export type TransactionSource = 'web' | 'telegram';
export type SavingsEntryType = 'deposit' | 'withdrawal';

export interface UserSettings {
  user_id: string;
  fixed_salary: number;
  monthly_savings_target: number;
  fixed_expenses_limit: number;
  currency: string;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  user_id: string;
  name: string;
  type: TransactionType;
  icon: string;
  is_system: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MonthlyBudget {
  id: string;
  user_id: string;
  month_date: string; // 'YYYY-MM-01'
  fixed_salary: number;
  monthly_savings_target: number;
  fixed_expenses_limit: number;
  created_at: string;
  updated_at: string;
}

export interface FixedExpenseTemplate {
  id: string;
  user_id: string;
  category_id: string;
  name: string;
  default_amount: number;
  due_day: number | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  category?: Category;
}

export interface InstallmentPurchase {
  id: string;
  user_id: string;
  category_id: string;
  description: string;
  installment_amount: number;
  installments_count: number;
  total_amount: number;
  purchase_date: string; // 'YYYY-MM-DD'
  first_installment_date: string; // 'YYYY-MM-DD'
  notes: string | null;
  created_at: string;
  updated_at: string;
  category?: Category;
}

export interface MonthlyCommitment {
  id: string;
  user_id: string;
  month_date: string; // 'YYYY-MM-01'
  category_id: string;
  commitment_type: CommitmentType;
  fixed_expense_template_id: string | null;
  installment_purchase_id: string | null;
  name: string;
  amount: number;
  due_date: string | null;
  installment_number: number | null;
  total_installments: number | null;
  is_paid: boolean;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  category?: Category;
}

export interface Transaction {
  id: string;
  user_id: string;
  category_id: string;
  type: TransactionType;
  amount: number;
  transaction_date: string; // 'YYYY-MM-DD'
  description: string;
  notes: string | null;
  source: TransactionSource;
  created_at: string;
  updated_at: string;
  category?: Category;
}

export interface SavingsEntry {
  id: string;
  user_id: string;
  month_date: string; // 'YYYY-MM-01'
  entry_type: SavingsEntryType;
  amount: number;
  entry_date: string; // 'YYYY-MM-DD'
  description: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonthlyFinancialSummary {
  monthDate: string; // 'YYYY-MM-01'
  isInitialized: boolean;
  fixedSalary: number;
  extraIncomeTotal: number;
  totalIncome: number; // fixedSalary + extraIncomeTotal
  fixedExpensesLimit: number;
  fixedExpensesTotal: number;
  installmentsTotal: number;
  totalCommitted: number; // fixedExpensesTotal + installmentsTotal
  committedLimitUsagePercent: number | null; // null si fixedExpensesLimit === 0
  isOverFixedLimit: boolean;
  paidCommitmentsTotal: number;
  pendingCommitmentsTotal: number; // Lo que falta abonar en el mes
  pendingCommitmentsCount: number;
  totalCommitmentsCount: number;
  monthlySavingsTarget: number; // Ahorro fijo apartado del mes
  extraSavingsDeposits: number; // Aportes extra a ahorros en el mes
  totalMonthlySavings: number; // monthlySavingsTarget + extraSavingsDeposits (oculto del Disponible Real)
  variableExpensesTotal: number;
  realAvailable: number; // (fixedSalary + extraIncomeTotal) - totalCommitted - totalMonthlySavings - variableExpensesTotal
}
```

### 2.2 Esquemas de Validación con `zod` (`src/lib/validations.ts`)

```typescript
import { z } from 'zod';

const MAX_MONEY = 9999999999.99;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const loginSchema = z.object({
  email: z.string().trim().email('Ingresá un correo electrónico válido.'),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.'),
});

export const adminCreateUserSchema = z.object({
  email: z.string().trim().email('Ingresá un correo electrónico válido.'),
  password: z
    .string()
    .min(8, 'La contraseña inicial debe tener al menos 8 caracteres.'),
});

export const userSettingsSchema = z.object({
  fixed_salary: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El sueldo fijo no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  monthly_savings_target: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El ahorro mensual no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  fixed_expenses_limit: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El límite no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  update_current_month: z.boolean().default(true),
});

export const monthlyBudgetSnapshotSchema = z.object({
  fixed_salary: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El sueldo fijo no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  monthly_savings_target: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El ahorro mensual no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  fixed_expenses_limit: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El límite no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
});

export const savingsEntrySchema = z.object({
  entry_type: z.enum(['deposit', 'withdrawal']),
  amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  entry_date: z
    .string()
    .regex(ISO_DATE_REGEX, 'Ingresá una fecha válida (AAAA-MM-DD).'),
  description: z
    .string()
    .trim()
    .min(2, 'Ingresá una descripción breve (mínimo 2 caracteres).')
    .max(150, 'La descripción no puede superar los 150 caracteres.'),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar los 500 caracteres.')
    .nullable()
    .optional(),
});

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'El nombre debe tener al menos 2 caracteres.')
    .max(60, 'El nombre no puede superar los 60 caracteres.'),
  type: z.enum(['expense', 'income'], {
    required_error: 'Seleccioná el tipo de categoría.',
  }),
  icon: z.string().trim().min(1).max(40).default('tag'),
});

export const fixedExpenseTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'El nombre debe tener al menos 2 caracteres.')
    .max(100, 'El nombre no puede superar los 100 caracteres.'),
  category_id: z.string().uuid('Seleccioná una categoría válida.'),
  default_amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  due_day: z
    .union([
      z.coerce.number().int().min(1, 'Día entre 1 y 31').max(31, 'Día entre 1 y 31'),
      z.literal(''),
      z.null(),
    ])
    .optional()
    .transform((val) => (val === '' || val === null || val === undefined ? null : Number(val))),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar los 500 caracteres.')
    .nullable()
    .optional(),
});

export const installmentPurchaseSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(2, 'La descripción debe tener al menos 2 caracteres.')
      .max(150, 'La descripción no puede superar los 150 caracteres.'),
    category_id: z.string().uuid('Seleccioná una categoría de gasto.'),
    installment_amount: z.coerce
      .number({ invalid_type_error: 'Ingresá un monto de cuota válido.' })
      .min(0.01, 'El monto por cuota debe ser de al menos $0,01.')
      .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
    installments_count: z.coerce
      .number({ invalid_type_error: 'Ingresá una cantidad entera de cuotas.' })
      .int('La cantidad de cuotas debe ser un número entero.')
      .min(1, 'Debe tener al menos 1 cuota.')
      .max(120, 'No puede superar las 120 cuotas.'),
    purchase_date: z
      .string()
      .regex(ISO_DATE_REGEX, 'Ingresá una fecha de compra válida (AAAA-MM-DD).'),
    first_installment_date: z
      .string()
      .regex(ISO_DATE_REGEX, 'Ingresá la fecha de la primera cuota (AAAA-MM-DD).'),
    notes: z
      .string()
      .trim()
      .max(500, 'Las notas no pueden superar los 500 caracteres.')
      .nullable()
      .optional(),
  })
  .refine(
    (data) =>
      Math.round((data.installment_amount * data.installments_count + Number.EPSILON) * 100) /
        100 <=
      MAX_MONEY,
    {
      message: 'El monto total financiado supera el máximo permitido.',
      path: ['installment_amount'],
    },
  );

export const transactionSchema = z.object({
  type: z.enum(['expense', 'income']),
  category_id: z.string().uuid('Seleccioná una categoría obligatoria.'),
  amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  transaction_date: z
    .string()
    .regex(ISO_DATE_REGEX, 'Ingresá una fecha válida (AAAA-MM-DD).'),
  description: z
    .string()
    .trim()
    .min(2, 'Ingresá una descripción breve (mínimo 2 caracteres).')
    .max(150, 'La descripción no puede superar los 150 caracteres.'),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar los 500 caracteres.')
    .nullable()
    .optional(),
});

export const monthlyAmountEditSchema = z.object({
  amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
});
```

---

## 3. Arquitectura, Estructura de Archivos y Lineamientos UI

### 3.1 Árbol de Archivos del Proyecto

Respetando estrictamente la estructura de `specs/constitution.md`:

```text
SB-Finance/
├── .env.example
├── .gitignore
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── supabase/
│   ├── migrations/
│   │   ├── 20261115000001_phase1_core_mvp.sql
│   │   └── 20261115000002_phase1_audit_security_fixes.sql
│   └── functions/
│       └── admin-create-user/
│           ├── deno.json
│           └── index.ts
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── index.css
    ├── types/
    │   └── database.types.ts
    ├── lib/
    │   ├── supabaseClient.ts
    │   ├── formatters.ts
    │   └── validations.ts
    ├── services/
    │   ├── authService.ts
    │   ├── settingsService.ts
    │   ├── categoriesService.ts
    │   ├── commitmentsService.ts
    │   ├── transactionsService.ts
    │   └── savingsService.ts
    ├── hooks/
    │   ├── useAuth.ts
    │   ├── useMonthlyPeriod.ts
    │   └── useDashboardData.ts
    ├── components/
    │   ├── layout/
    │   │   ├── AppShell.tsx
    │   │   ├── TopNavbar.tsx
    │   │   └── MonthSelectorBar.tsx
    │   └── ui/
    │       ├── Button.tsx
    │       ├── Card.tsx
    │       ├── Modal.tsx
    │       ├── InputField.tsx
    │       ├── SelectField.tsx
    │       ├── Badge.tsx
    │       └── EmptyState.tsx
    └── features/
        ├── auth/
        │   ├── LoginPage.tsx
        │   └── ProtectedRoute.tsx
        ├── dashboard/
        │   ├── DashboardPage.tsx
        │   ├── SetupAlertBanner.tsx
        │   ├── KpiSummaryGrid.tsx
        │   ├── FinancialChartsSection.tsx
        │   └── PendingCommitmentsWidget.tsx
        ├── transactions/
        │   ├── TransactionsPage.tsx
        │   ├── TransactionFiltersBar.tsx
        │   ├── TransactionsTable.tsx
        │   └── TransactionFormModal.tsx
        ├── commitments/
        │   ├── CommitmentsPage.tsx
        │   ├── FixedExpensesList.tsx
        │   ├── FixedExpenseFormModal.tsx
        │   ├── InstallmentsList.tsx
        │   └── InstallmentFormModal.tsx
        ├── categories/
        │   ├── CategoriesPage.tsx
        │   └── CategoryFormModal.tsx
        ├── savings/
        │   ├── SavingsPage.tsx
        │   └── SavingsEntryFormModal.tsx
        └── settings/
            ├── SettingsPage.tsx
            ├── BudgetSettingsForm.tsx
            └── AdminUserCreationCard.tsx
```

### 3.2 Sistema de Diseño Visual (Identidad Amarillo y Negro)

Directrices del sistema visual adaptadas a una aplicación financiera de alto contraste:

1. **Paleta de Colores Estricto (Tokens CSS en `src/index.css`):**
   - **Fondo Principal (`--bg-primary`):** `#0A0A0A` (Negro carbón profundo, evita el cansancio visual del `#000000` puro en pantallas OLED/IPS).
   - **Superficie / Tarjetas (`--bg-surface`):** `#121212` y `#1A1A1A` para paneles elevados, con borde sutil `1px solid #262626`.
   - **Color Primario de Marca (`--brand-yellow`):** `#FACC15` (Amarillo solar de alto contraste; hover `#EAB308`; texto sobre amarillo siempre en `#0A0A0A` para ratio de contraste WCAG AAA `> 12:1`).
   - **Texto Principal (`--ink-primary`):** `#FAFAFA`; Texto Secundario (`--ink-muted`): `#A3A3A3`.
   - **Colores Semánticos Financieros (Exclusivos para indicadores financieros):**
     - **Positivo / Ingresos / Disponible saludable (`--semantic-green`):** `#22C55E` (fondo sutil `rgba(34, 197, 94, 0.12)`). Prohibido usarlo en categorías del gráfico de gastos o badges de calendario.
     - **Negativo / Gastos / Alerta de Límite Superado (`--semantic-red`):** `#EF4444` (y `#F87171` para texto pequeño sobre fondos oscuros tintados garantizando contraste WCAG AA >= 4.5:1; fondo sutil `rgba(239, 68, 68, 0.12)`).
   - **Prohibición estricta (`SKILL.md` Regla 6):** Cero uso de violeta, lavanda o gradientes decorativos genéricos de IA en ningún componente ni gráfico.
2. **Tipografía y Números Tabulares:**
   - Fuente UI: `'Inter'` o `'Plus Jakarta Sans'` para lectura limpia; fuente monoespaciada/tabular (`'JetBrains Mono'` o `font-variant-numeric: tabular-nums`) obligatoria en todos los montos (`$ 1.250.000,00`), porcentajes y tablas para que las unidades y centavos queden perfectamente alineados en columna.
3. **Geometría, Bordes Iguales y Micro-interacciones (`SKILL.md` Reglas 4 y 5):**
   - **Radio (`data-radius="sharp"` para fintech):** Bordes precisos de `6px` (`rounded-md`) en botones e inputs y `8px` (`rounded-lg`) en contenedores.
   - **Márgenes simétricos (`.wrap`):** Contenedor central máximo de `1360px` con `padding-inline` simétrico en `1440px`, `1024px`, `768px` y `390px`.
   - **Micro-interacciones silenciosas:**
     - Tarjetas interactivas se elevan `-2px` (`translateY(-2px)`) en `:hover` con transición suave de `160ms` y cambio de borde a `rgba(250, 204, 21, 0.45)`.
     - Botones con respuesta física en `:hover` y `:active` (`translateY(1px)` al presionar).
     - Controles interactivos con altura mínima de `44px` en mobile (`390px` / `320px`) para evitar errores táctiles.
4. **Copywriting directo (`copy.md`):**
   - Botones siempre con formato **Verbo + Objeto** (*"Guardar gasto"*, *"Registrar compra en cuotas"*, *"Archivar categoría"*, *"Marcar como pagado"*), evitando etiquetas ambiguas como *"Enviar"* o *"OK"*.

---

## 4. Decisiones de Arquitectura

Los siguientes cinco criterios resumen las decisiones de ingeniería detrás del diseño de la Fase 1:

### 4.1 ¿Por qué `NUMERIC(12, 2)` en PostgreSQL y no `FLOAT` o `DOUBLE PRECISION`?
En arquitectura de computadores, los tipos de punto flotante (`float4`, `float8`, y `number` en JavaScript bajo el estándar **IEEE 754**) representan los números en base 2 (binario). Fracciones decimales simples como `0.1` o `0.2` son periódicas infinitas en binario (por eso en consola `0.1 + 0.2 === 0.30000000000000004`). En un sistema financiero, acumular cientos de transacciones con punto flotante produce descuadres de centavos.
- **Solución:** En PostgreSQL usamos `NUMERIC(12, 2)` (aritmética decimal exacta en base 10), y todas las sumatorias críticas (`SUM`, multiplicación de cuotas) se resuelven en la base de datos o redondeando a 2 decimales (`Math.round((val + Number.EPSILON) * 100) / 100`).

### 4.2 ¿Por qué una tabla unificada `monthly_commitments` con dos orígenes (Plantillas vs. Cuotas)?
Existen dos compromisos financieros con distinto ciclo de vida que impactan de forma equivalente en el presupuesto mensual del usuario: **Gastos Fijos** (alquiler, servicios) y **Compras en Cuotas** (cuota 3/6 de una compra).
- Mantenerlos en tablas aisladas o calcular cuotas al vuelo en React exigiría cruzar múltiples tablas y aritmética de fechas en el frontend para responder *"¿Cuánto dinero está comprometido en un mes dado y cuánto ya se abonó?"*.
- Al converger ambos en `monthly_commitments`:
  - **Las compras en cuotas son finitas y conocidas de antemano:** se aplica *Eager Pre-generation* (`generate_series(1, N)`) al momento de registrar la compra. Si el usuario anula la compra padre, la clave foránea `ON DELETE CASCADE` limpia las $N$ cuotas en una sola operación atómica del motor relacional.
  - **Los gastos fijos son potencialmente infinitos:** no es viable pre-generar infinitos meses de alquiler. Por eso se aplica *Lazy Initialization* (`ensure_monthly_period`): cada mes nuevo copia las plantillas activas en `monthly_commitments`. Su clave foránea usa `ON DELETE SET NULL` (no `CASCADE`) para preservar intacto el historial de pagos anteriores cuando se da de baja una plantilla.

### 4.3 ¿Por qué representar el mes como `DATE ('YYYY-MM-01')` en vez de un `VARCHAR ('2026-11')`?
Guardar un mes como texto (`'2026-11'` o `'Noviembre 2026'`) impide que el motor de base de datos use aritmética temporal nativa (`+ INTERVAL '1 month'`, `date_trunc`) y validación de calendario. Al normalizar todo período mensual a un tipo `DATE` anclado al día 1 (`CHECK (EXTRACT(DAY FROM month_date) = 1)`), PostgreSQL indexa el campo en apenas 4 bytes, valida fechas reales y permite comparar rangos de meses con operadores estándar (`<`, `>`, `BETWEEN`).

### 4.4 ¿Por qué Borrado Lógico (`is_active = false`) + `ON DELETE RESTRICT` en Categorías?
En bases de datos relacionales, cuando una tabla hija (`transactions`) apunta a un catálogo (`categories`), existen tres alternativas ante un borrado:
1. `ON DELETE CASCADE`: Destruiría los gastos históricos asociados a la categoría y alteraría el saldo histórico de meses cerrados.
2. `ON DELETE SET NULL`: Se perdería la trazabilidad histórica (los gráficos históricos quedarían *"Sin categoría"*).
3. **Patrón de Catálogo Contable (`is_active = false` + `ON DELETE RESTRICT`):** La base de datos prohíbe destruir físicamente una categoría que tiene movimientos asociados (`RESTRICT`), y la aplicación la desactiva (`is_active = false`). Así, los formularios nuevos solo muestran categorías con `is_active = true`, pero los joins históricos siguen resolviendo el nombre original sin pérdida de información.

### 4.5 ¿Por qué el Alta de Usuarios por el Admin requiere una Edge Function y no se hace directo desde React?
En una arquitectura BaaS como Supabase existen dos llaves:
- `ANON_KEY` (pública, viaja en el navegador): Sujeta a RLS y a las reglas públicas de Auth. Llamar a `supabase.auth.signUp()` desde el navegador estando autenticado como Admin requeriría abrir el registro público a todo internet o sobrescribiría la sesión actual.
- `SERVICE_ROLE_KEY` (secreta, salta todo el RLS): Tiene permiso de superusuario (`supabase.auth.admin.createUser()`). Exponer esta llave en una variable `VITE_...` del cliente permitiría extraerla desde DevTools del navegador y comprometer toda la base de datos.
- **Solución:** El botón *"Crear usuario"* del panel de administración en `/settings` envía la petición con el JWT de sesión a la Edge Function `supabase/functions/admin-create-user`. La Edge Function corre en el servidor (Deno), verifica en `public.user_settings` que el `auth.uid()` tenga `is_admin = true`, y recién ahí usa `SUPABASE_SERVICE_ROLE_KEY` para crear la cuenta nueva.

### 4.6 ¿Por qué `savings_entries` vive en su propia tabla separada de `transactions`?
Financieramente, mover fondos a **Ahorros** no constituye un gasto de consumo ni pérdida de patrimonio, pero operativamente **sí debe restarse del `Disponible Real`** para no permanecer visible como dinero libre para gastar.
- Guardar los ahorros dentro de `transactions` como un `expense` distorsionaría los gráficos de distribución de gastos por categoría mezclando consumo real con patrimonio ahorrado.
- Al aislarlo en `savings_entries` + `monthly_savings_target`:
  1. Se descuenta con precisión del `Disponible Real` mensual.
  2. No contamina los gráficos ni los totales de gastos variables.
  3. Mantiene el saldo acumulado de ahorros oculto del Dashboard principal (solo accesible en `/savings`) y sienta la base para conectar los **Plazos Fijos** de la Fase 3.
