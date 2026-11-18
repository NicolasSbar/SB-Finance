-- ============================================================================
-- MIGRACIÓN INCREMENTAL: Cierre de mes por Telegram + Día de cobro hábil
-- Motor: PostgreSQL 15+ (Supabase)
-- Decisiones de Arquitectura:
-- - Se amplía `user_settings.salary_payday` a `0..31` (donde `0` representa
--   "Último día hábil del mes") de forma retrocompatible sin tocar datos previos.
-- - Se habilita `'fixed_cap_surplus_closing'` en `notification_logs.alert_type`
--   para que `daily-alerts` envíe como máximo 1 recordatorio por mes en los
--   últimos 3 días antes del cierre cuando quede sobrante de gastos fijos.
-- ============================================================================

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  -- 1. Ampliar CHECK de user_settings.salary_payday (0 = último día hábil, 1..31 = día fijo)
  FOR v_conname IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.user_settings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%salary_payday%'
  LOOP
    EXECUTE format('ALTER TABLE public.user_settings DROP CONSTRAINT %I', v_conname);
  END LOOP;

  ALTER TABLE public.user_settings
    ADD CONSTRAINT chk_user_settings_salary_payday
    CHECK (salary_payday >= 0 AND salary_payday <= 31);

  -- 2. Ampliar CHECK de notification_logs.alert_type para alerta de cierre de gastos fijos
  FOR v_conname IN
    SELECT conname
    FROM pg_constraint
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
        'fixed_term_due_today',
        'fixed_cap_surplus_closing'
      )
    );
END $$;
