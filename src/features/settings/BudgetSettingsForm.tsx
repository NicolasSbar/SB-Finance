/**
 * Formulario de configuración de Sueldo Fijo, Ahorro Mensual Objetivo, Límite de Fijos + Cuotas,
 * Presupuesto de Gustitos, Zona Horaria y selección rápida de categorías Gustito.
 *
 * Arquitectura y decisiones técnicas:
 * - Permite elegir explícitamente si el cambio impacta en el snapshot del mes actual
 *   además de quedar como base para meses futuros, garantizando que los cierres de
 *   meses pasados jamás se alteren.
 * - Mantiene sincronizadas las categorías marcadas como Gustito con `/categories`.
 * - Protección ante fallos parciales: si `getCategories` falla o sigue cargando,
 *   expone un banner `role="alert"` con reintento y bloquea `syncGustitoCategoriesSelection`
 *   para impedir que un estado vacío `[]` borre `is_gustito` en las categorías del usuario.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { InputField } from '../../components/ui/InputField';
import { SelectField } from '../../components/ui/SelectField';
import { useAuth } from '../../hooks/useAuth';
import {
  IANA_TIMEZONE_OPTIONS,
  formatCurrency,
  formatMonthLabel,
  getLastBusinessDayOfMonth,
  toMonthStartISODate,
} from '../../lib/formatters';
import { userSettingsSchema } from '../../lib/validations';
import {
  getCategories,
  syncGustitoCategoriesSelection,
} from '../../services/categoriesService';
import { updateUserSettings } from '../../services/settingsService';
import type { Category } from '../../types/database.types';

export function BudgetSettingsForm() {
  const { user, userSettings, refreshSettings } = useAuth();

  const [fixedSalary, setFixedSalary] = useState<string>('0');
  const [monthlySavingsTarget, setMonthlySavingsTarget] = useState<string>('0');
  const [fixedLimit, setFixedLimit] = useState<string>('0');
  const [gustitosBudget, setGustitosBudget] = useState<string>('0');
  const [paydayMode, setPaydayMode] = useState<'fixed_day' | 'last_business_day'>('fixed_day');
  const [salaryPayday, setSalaryPayday] = useState<string>('1');
  const [timezone, setTimezone] = useState<string>('America/Argentina/Buenos_Aires');
  const [updateCurrentMonth, setUpdateCurrentMonth] = useState<boolean>(true);

  const [expenseCategories, setExpenseCategories] = useState<Category[]>([]);
  const [selectedGustitoIds, setSelectedGustitoIds] = useState<string[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState<boolean>(true);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const categoriesRequestIdRef = useRef<number>(0);

  const [fieldErrors, setFieldErrors] = useState<{
    fixed_salary?: string;
    monthly_savings_target?: string;
    fixed_expenses_limit?: string;
    gustitos_budget?: string;
    salary_payday?: string;
    timezone?: string;
  }>({});
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    if (userSettings) {
      setFixedSalary(String(userSettings.fixed_salary));
      setMonthlySavingsTarget(String(userSettings.monthly_savings_target ?? 0));
      setFixedLimit(String(userSettings.fixed_expenses_limit));
      setGustitosBudget(String(userSettings.gustitos_budget ?? 0));
      const loadedPayday = userSettings.salary_payday ?? 1;
      if (loadedPayday === 0) {
        setPaydayMode('last_business_day');
        setSalaryPayday('0');
      } else {
        setPaydayMode('fixed_day');
        setSalaryPayday(String(loadedPayday));
      }
      setTimezone(userSettings.timezone || 'America/Argentina/Buenos_Aires');
    }
  }, [userSettings]);

  const loadExpenseCategories = useCallback(async (): Promise<void> => {
    const requestId = categoriesRequestIdRef.current + 1;
    categoriesRequestIdRef.current = requestId;
    setIsLoadingCategories(true);
    setCategoriesError(null);
    try {
      const cats = await getCategories({ includeInactive: false, type: 'expense' });
      if (requestId !== categoriesRequestIdRef.current) return;
      setExpenseCategories(cats);
      setSelectedGustitoIds(cats.filter((c) => c.is_gustito).map((c) => c.id));
    } catch (err) {
      if (requestId !== categoriesRequestIdRef.current) return;
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudieron cargar las categorías de gasto.';
      setCategoriesError(msg);
    } finally {
      if (requestId === categoriesRequestIdRef.current) {
        setIsLoadingCategories(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadExpenseCategories();
    return () => {
      categoriesRequestIdRef.current += 1;
    };
  }, [loadExpenseCategories]);

  const timezoneOptions = useMemo(() => {
    const exists = IANA_TIMEZONE_OPTIONS.some((opt) => opt.value === timezone);
    if (exists || !timezone) return [...IANA_TIMEZONE_OPTIONS];
    return [{ value: timezone, label: timezone }, ...IANA_TIMEZONE_OPTIONS];
  }, [timezone]);

  const currentMonthLabel = formatMonthLabel(toMonthStartISODate(new Date()));

  function toggleGustitoCategory(catId: string): void {
    setSelectedGustitoIds((prev) =>
      prev.includes(catId) ? prev.filter((id) => id !== catId) : [...prev, catId],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!user) return;
    setFieldErrors({});

    const effectivePaydayInput =
      paydayMode === 'last_business_day' ? 0 : salaryPayday;

    const parsed = userSettingsSchema.safeParse({
      fixed_salary: fixedSalary,
      monthly_savings_target: monthlySavingsTarget,
      fixed_expenses_limit: fixedLimit,
      gustitos_budget: gustitosBudget,
      salary_payday: effectivePaydayInput,
      timezone,
      update_current_month: updateCurrentMonth,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setFieldErrors({
        fixed_salary: flat.fixed_salary?.[0],
        monthly_savings_target: flat.monthly_savings_target?.[0],
        fixed_expenses_limit: flat.fixed_expenses_limit?.[0],
        gustitos_budget: flat.gustitos_budget?.[0],
        salary_payday: flat.salary_payday?.[0],
        timezone: flat.timezone?.[0],
      });
      return;
    }

    const canSyncGustitos = !isLoadingCategories && !categoriesError;

    setIsSaving(true);
    try {
      await updateUserSettings(user.id, parsed.data);
      if (canSyncGustitos) {
        await syncGustitoCategoriesSelection(
          user.id,
          selectedGustitoIds,
          parsed.data.update_current_month,
        );
      }
      await refreshSettings();
      if (!canSyncGustitos) {
        toast.error(
          'Configuración base guardada, pero no se modificaron las categorías Gustito porque no terminaron de cargar.',
        );
      } else {
        toast.success(
          parsed.data.update_current_month
            ? `Configuración guardada y aplicada a ${currentMonthLabel}.`
            : 'Configuración base guardada para los próximos meses.',
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo guardar la configuración.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  const parsedSalaryPreview = Number(fixedSalary);
  const parsedSavingsPreview = Number(monthlySavingsTarget);
  const parsedLimitPreview = Number(fixedLimit);
  const parsedGustitosPreview = Number(gustitosBudget);
  const currency = userSettings?.currency ?? 'ARS';

  return (
    <Card padding="lg">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-[#FAFAFA]">
          Presupuesto Mensual, Gustitos y Zona Horaria
        </h2>
        <p className="mt-1 text-sm text-[#A3A3A3]">
          Definí tu sueldo fijo, tu ahorro objetivo, el tope de fijos y cuotas, tu bolsa mensual de Gustitos y tu reloj local para alertas.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <InputField
            label="Sueldo Fijo Mensual"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            prefixText="$"
            value={fixedSalary}
            onChange={(e) => setFixedSalary(e.target.value)}
            error={fieldErrors.fixed_salary}
            hint={
              Number.isFinite(parsedSalaryPreview) && parsedSalaryPreview >= 0
                ? `Vista previa: ${formatCurrency(parsedSalaryPreview, currency)}`
                : undefined
            }
            required
          />

          <InputField
            label="Ahorro Mensual Objetivo"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            prefixText="$"
            value={monthlySavingsTarget}
            onChange={(e) => setMonthlySavingsTarget(e.target.value)}
            error={fieldErrors.monthly_savings_target}
            hint={
              Number.isFinite(parsedSavingsPreview) && parsedSavingsPreview >= 0
                ? `Apartado: ${formatCurrency(parsedSavingsPreview, currency)}`
                : undefined
            }
            required
          />

          <InputField
            label="Límite Fijos + Cuotas"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            prefixText="$"
            value={fixedLimit}
            onChange={(e) => setFixedLimit(e.target.value)}
            error={fieldErrors.fixed_expenses_limit}
            hint={
              Number.isFinite(parsedLimitPreview) && parsedLimitPreview >= 0
                ? `Tope alerta: ${formatCurrency(parsedLimitPreview, currency)}`
                : undefined
            }
            required
          />

          <InputField
            label="Presupuesto Mensual de Gustitos"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            prefixText="$"
            value={gustitosBudget}
            onChange={(e) => setGustitosBudget(e.target.value)}
            error={fieldErrors.gustitos_budget}
            hint={
              Number.isFinite(parsedGustitosPreview) && parsedGustitosPreview >= 0
                ? `Bolsa discrecional: ${formatCurrency(parsedGustitosPreview, currency)}`
                : undefined
            }
            required
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <div className="flex flex-col gap-4">
            <SelectField
              label="Día de cobro del sueldo fijo"
              value={paydayMode}
              onChange={(e) => {
                const nextMode = e.target.value as 'fixed_day' | 'last_business_day';
                setPaydayMode(nextMode);
                if (nextMode === 'last_business_day') {
                  setSalaryPayday('0');
                } else if (salaryPayday === '0' || !salaryPayday) {
                  setSalaryPayday('1');
                }
              }}
              options={[
                {
                  value: 'last_business_day',
                  label: 'Último día hábil del mes (lunes a viernes)',
                },
                {
                  value: 'fixed_day',
                  label: 'Día fijo del mes (1–31)',
                },
              ]}
              hint={
                paydayMode === 'last_business_day'
                  ? `Este mes corresponde al día ${getLastBusinessDayOfMonth(
                      new Date().getFullYear(),
                      new Date().getMonth() + 1,
                    )} (lun–vie, sin contar feriados locales). La revisión de cierre avisa cuando faltan ≤ 3 días para fin de mes.`
                  : 'La revisión de cierre avisa automáticamente en el Dashboard y por Telegram cuando faltan ≤ 3 días para fin de mes.'
              }
            />

            {paydayMode === 'fixed_day' ? (
              <InputField
                label="Número de día de cobro (1–31)"
                type="number"
                min="1"
                max="31"
                step="1"
                inputMode="numeric"
                value={salaryPayday === '0' ? '1' : salaryPayday}
                onChange={(e) => setSalaryPayday(e.target.value)}
                error={fieldErrors.salary_payday}
                required
              />
            ) : null}

            <SelectField
              label="Zona Horaria Local (Alertas 08:00 AM)"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              options={timezoneOptions}
              error={fieldErrors.timezone}
              hint="Define las fechas registradas desde Telegram y la hora de las alertas diarias."
              required
            />
          </div>

          <div
            role="group"
            aria-labelledby="gustito-categories-label"
            className="flex flex-col gap-1.5"
          >
            <span
              id="gustito-categories-label"
              className="text-[14px] font-medium text-[#FAFAFA]"
            >
              Categorías incluidas en la bolsa de Gustitos (
              {isLoadingCategories || categoriesError ? '—' : selectedGustitoIds.length})
            </span>
            <div className="rounded-[6px] bg-[#0A0A0A] border border-[#262626] p-3 max-h-48 overflow-y-auto">
              {isLoadingCategories ? (
                <p className="text-xs text-[#A3A3A3]">Cargando categorías de gasto...</p>
              ) : categoriesError ? (
                <div role="alert" className="flex flex-col gap-2.5">
                  <p className="text-xs font-medium text-[#F87171]">
                    {categoriesError}
                  </p>
                  <p className="text-xs text-[#A3A3A3]">
                    El guardado de la selección de Gustitos está bloqueado para evitar borrar tus categorías actuales.
                  </p>
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void loadExpenseCategories()}
                    >
                      Reintentar carga de categorías
                    </Button>
                  </div>
                </div>
              ) : expenseCategories.length === 0 ? (
                <p className="text-xs text-[#A3A3A3]">
                  No hay categorías de gasto activas.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {expenseCategories.map((cat) => {
                    const checked = selectedGustitoIds.includes(cat.id);
                    return (
                      <label
                        key={cat.id}
                        className="flex items-center gap-2.5 text-sm text-[#D4D4D4] cursor-pointer select-none min-h-[44px] px-1.5 rounded hover:bg-[#171717]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleGustitoCategory(cat.id)}
                          className="h-4 w-4 accent-[#FACC15] cursor-pointer shrink-0"
                        />
                        <span className="truncate">{cat.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <span className="text-[13px] text-[#A3A3A3]">
              Sincronizado con la pantalla Categorías. Los gastos fijos nunca descuentan de Gustitos.
            </span>
          </div>
        </div>

        <label className="flex items-start gap-3 p-3.5 rounded-[6px] bg-[#0A0A0A] border border-[#262626] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={updateCurrentMonth}
            onChange={(e) => setUpdateCurrentMonth(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#FACC15] cursor-pointer"
          />
          <span className="text-sm text-[#D4D4D4] leading-snug">
            Aplicar estos valores también al snapshot del mes en curso (
            <strong className="text-[#FAFAFA]">{currentMonthLabel}</strong>). Los cierres de meses anteriores nunca se modifican.
          </span>
        </label>

        <div className="flex justify-end pt-1">
          <Button
            type="submit"
            variant="primary"
            isLoading={isSaving}
            loadingText="Guardando configuración..."
          >
            Guardar configuración
          </Button>
        </div>
      </form>
    </Card>
  );
}
