/**
 * Simulador de Gastos "¿Qué pasa si...?" (`/simulator`).
 *
 * Arquitectura y decisiones técnicas:
 * - Herramienta 100% efímera: no realiza escrituras en Supabase ni en
 *   `localStorage`. Permite agregar múltiples compras hipotéticas combinadas
 *   (al contado o en cuotas, Gustito o Fijo/Variable, inicio este mes o próximo)
 *   para observar su impacto conjunto antes de tomar decisiones.
 * - Workbench sticky en 2 columnas: mantiene el constructor y la lista a la
 *   izquierda (`lg:col-span-5`) y la comparativa fija a la derecha (`lg:col-span-7
 *   lg:sticky lg:top-[84px]`) con selector accesible `Mes actual | Mes próximo` vía
 *   `useRovingTabs` y barra compacta fija en mobile (`390px`) para ver el impacto sin
 *   scrollear.
 * - Validación estricta por campo (`simulatorItemSchema`): rechaza montos `< $0,01`
 *   (ej. `0` o `0.001`), topes mayores a `MAX_MONEY` y productos `cuota × meses` que
 *   excedan `MAX_MONEY`, además de bloquear cualquier simulación silenciosa sobre `$0`
 *   cuando falla la carga inicial (`currentData.error` / `nextData.error`).
 */
import { useMemo, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { PageSubnav } from '../../components/layout/PageSubnav';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { InputField } from '../../components/ui/InputField';
import { SelectField } from '../../components/ui/SelectField';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardData } from '../../hooks/useDashboardData';
import {
  useExpenseSimulator,
  type SimulatedPeriodProjection,
} from '../../hooks/useExpenseSimulator';
import { useRovingTabs } from '../../hooks/useRovingTabs';
import {
  addMonthsToMonthDate,
  formatCurrency,
  formatMonthLabel,
  formatPercent,
  roundCurrency,
  toLocalISODate,
  toMonthStartISODate,
} from '../../lib/formatters';
import { MAX_MONEY, simulatorItemSchema } from '../../lib/validations';
import { createInstallmentPurchase } from '../../services/commitmentsService';
import { createTransaction } from '../../services/transactionsService';
import type { SimulatedExpenseItem } from '../../types/database.types';

type ComparisonTab = 'current' | 'next';
type SimulatorFieldName = 'description' | 'unitAmount' | 'installmentsCount' | 'categoryId';
type SimulatorFieldErrors = Partial<Record<SimulatorFieldName, string>>;

const COMPARISON_TABS: readonly ComparisonTab[] = ['current', 'next'];

export function SimulatorPage() {
  const { user, userSettings } = useAuth();
  const currentCalendarMonth = toMonthStartISODate(new Date());
  const nextCalendarMonth = addMonthsToMonthDate(currentCalendarMonth, 1);

  const currentData = useDashboardData(currentCalendarMonth, {
    includeEvolution: false,
  });
  const nextData = useDashboardData(nextCalendarMonth, {
    includeEvolution: false,
    includeTransactions: false,
  });

  const {
    items,
    addItem,
    removeItem,
    clearItems,
    currentMonthProjection,
    nextMonthProjection,
    totalSimulatedOutflow,
  } = useExpenseSimulator(
    currentData.summary,
    nextData.summary,
    currentData.categories,
  );

  const expenseCategories = useMemo(
    () =>
      currentData.categories.filter((c) => c.type === 'expense' && c.is_active),
    [currentData.categories],
  );

  // Formulario de ítem hipotético
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'cash' | 'installments'>('cash');
  const [unitAmount, setUnitAmount] = useState('');
  const [installmentsCount, setInstallmentsCount] = useState('3');
  const [categoryId, setCategoryId] = useState('');
  const [isGustito, setIsGustito] = useState(false);
  const [startMonth, setStartMonth] = useState<'current' | 'next'>('current');
  const [fieldErrors, setFieldErrors] = useState<SimulatorFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [isRetryingLoad, setIsRetryingLoad] = useState(false);
  const [activeComparisonTab, setActiveComparisonTab] =
    useState<ComparisonTab>('current');

  const { getTabListProps, getTabProps, getPanelProps } =
    useRovingTabs<ComparisonTab>({
      tabs: COMPARISON_TABS,
      activeTab: activeComparisonTab,
      onChange: setActiveComparisonTab,
      orientation: 'horizontal',
      idPrefix: 'simulator-comparison',
    });

  const currency = userSettings?.currency ?? 'ARS';
  const currentMonthLabel = formatMonthLabel(currentCalendarMonth);
  const nextMonthLabel = formatMonthLabel(nextCalendarMonth);

  const selectedCategory = useMemo(
    () => expenseCategories.find((c) => c.id === categoryId),
    [expenseCategories, categoryId],
  );
  const isCategoryGustito = Boolean(selectedCategory?.is_gustito);

  const isInitialLoading = currentData.isLoading || nextData.isLoading;
  const loadError = currentData.error ?? nextData.error;

  async function handleRetryLoad(): Promise<void> {
    setIsRetryingLoad(true);
    try {
      await Promise.all([currentData.refresh(), nextData.refresh()]);
    } finally {
      setIsRetryingLoad(false);
    }
  }

  function clearFieldError(field: SimulatorFieldName): void {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function handleAddSimulatedItem(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);

    const parsed = simulatorItemSchema.safeParse({
      description,
      mode,
      unitAmount: unitAmount.trim() === '' ? Number.NaN : unitAmount,
      installmentsCount:
        mode === 'installments'
          ? installmentsCount.trim() === ''
            ? Number.NaN
            : installmentsCount
          : 1,
      categoryId: categoryId || null,
      isGustito: isCategoryGustito || isGustito,
      startMonth,
    });

    if (!parsed.success) {
      const nextErrors: SimulatorFieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (
          (key === 'description' ||
            key === 'unitAmount' ||
            key === 'installmentsCount' ||
            key === 'categoryId') &&
          !nextErrors[key]
        ) {
          nextErrors[key] = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      if (Object.keys(nextErrors).length === 0) {
        setFormError(
          parsed.error.issues[0]?.message ??
            'Revisá los datos del gasto hipotético.',
        );
      }
      return;
    }

    const added = addItem({
      description: parsed.data.description,
      mode: parsed.data.mode,
      unitAmount: roundCurrency(parsed.data.unitAmount),
      installmentsCount:
        parsed.data.mode === 'installments'
          ? parsed.data.installmentsCount
          : 1,
      categoryId: parsed.data.categoryId,
      isGustito: parsed.data.isGustito,
      startMonth: parsed.data.startMonth,
    });

    if (!added) {
      setFormError('No se pudo agregar el ítem a la simulación.');
      return;
    }

    setActiveComparisonTab(parsed.data.startMonth);
    setDescription('');
    setUnitAmount('');
  }

  async function handleConvertToReal(item: SimulatedExpenseItem): Promise<void> {
    if (!user) return;
    const resolvedCategoryId = item.categoryId || expenseCategories[0]?.id;
    if (!resolvedCategoryId) {
      toast.error('Creá al menos una categoría de gasto para registrar este ítem.');
      return;
    }

    const targetDate =
      item.startMonth === 'current' ? toLocalISODate() : nextCalendarMonth;

    setConvertingId(item.id);
    try {
      if (item.mode === 'cash') {
        await createTransaction(user.id, {
          type: 'expense',
          category_id: resolvedCategoryId,
          amount: item.unitAmount,
          transaction_date: targetDate,
          description: item.description,
          is_gustito: item.isGustito,
          save_to_savings: false,
        });
        toast.success(`"${item.description}" registrado como gasto real.`);
      } else {
        await createInstallmentPurchase({
          description: item.description,
          category_id: resolvedCategoryId,
          installment_amount: item.unitAmount,
          installments_count: item.installmentsCount,
          purchase_date: toLocalISODate(),
          first_installment_date: targetDate,
          is_gustito: item.isGustito,
        });
        toast.success(
          `"${item.description}" registrado en ${item.installmentsCount} cuota(s) reales.`,
        );
      }

      removeItem(item.id);
      await Promise.all([currentData.refresh(), nextData.refresh()]);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo convertir el ítem en registro real.';
      toast.error(msg);
    } finally {
      setConvertingId(null);
    }
  }

  function renderComparisonPanel(
    title: string,
    projection: SimulatedPeriodProjection,
    otherTab: ComparisonTab,
    otherLabel: string,
    otherAddedTotal: number,
  ) {
    const fixedBarWidth =
      projection.simulatedFixedUsagePercent !== null
        ? Math.min(100, Math.max(0, projection.simulatedFixedUsagePercent))
        : 0;
    const gustitosBarWidth =
      projection.simulatedGustitosUsagePercent !== null
        ? Math.min(100, Math.max(0, projection.simulatedGustitosUsagePercent))
        : 0;

    return (
      <Card padding="md" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1F1F1F]">
          <h2 className="text-base font-bold text-[#FAFAFA]">{title}</h2>
          <Badge variant={projection.addedTotalInPeriod > 0 ? 'yellow' : 'neutral'}>
            Impacto en el mes: {formatCurrency(projection.addedTotalInPeriod, currency)}
          </Badge>
        </div>

        {/* Disponible Real: Actual vs Simulado */}
        <div className="rounded-[6px] border border-[#262626] bg-[#0A0A0A] p-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#A3A3A3]">
            <span>Disponible Real</span>
            {projection.realAvailableDelta !== 0 ? (
              <span className="font-mono-num font-semibold text-[#F87171]">
                {formatCurrency(projection.realAvailableDelta, currency)}
              </span>
            ) : (
              <span className="font-mono-num text-[#22C55E]">
                Absorbido por margen del tope
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 items-baseline">
            <div className="min-w-0">
              <span className="block text-[11px] text-[#A3A3A3]">Actual</span>
              <span className="font-mono-num text-base font-semibold text-[#D4D4D4]">
                {formatCurrency(projection.baseRealAvailable, currency)}
              </span>
            </div>
            <div className="text-right min-w-0">
              <span className="block text-[11px] text-[#A3A3A3]">Simulado</span>
              <span
                className={[
                  'font-mono-num text-lg sm:text-xl font-extrabold',
                  projection.simulatedRealAvailable > 0
                    ? 'text-[#22C55E]'
                    : projection.simulatedRealAvailable < 0
                      ? 'text-[#EF4444]'
                      : 'text-[#FAFAFA]',
                ].join(' ')}
              >
                {formatCurrency(projection.simulatedRealAvailable, currency)}
              </span>
            </div>
          </div>
        </div>

        {/* Barra Comprometido Fijos + Cuotas No-Gustito */}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="font-semibold text-[#D4D4D4]">
              Comprometido (Fijos + Cuotas)
            </span>
            <span
              className={[
                'font-mono-num font-bold',
                projection.exceedsFixedLimit ? 'text-[#F87171]' : 'text-[#FAFAFA]',
              ].join(' ')}
            >
              {formatCurrency(projection.simulatedFixedCommitted, currency)}
              {projection.fixedLimit > 0
                ? ` / ${formatCurrency(projection.fixedLimit, currency)}`
                : ''}
            </span>
          </div>
          {projection.fixedLimit > 0 ? (
            <div
              role="progressbar"
              aria-label="Uso proyectado de Comprometido (Fijos y Cuotas)"
              aria-valuenow={Math.round(fixedBarWidth)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={
                projection.simulatedFixedUsagePercent !== null
                  ? `${formatPercent(projection.simulatedFixedUsagePercent)} del límite de gastos fijos`
                  : undefined
              }
              className="h-2.5 w-full rounded-full bg-[#262626] overflow-hidden"
            >
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${fixedBarWidth}%`,
                  backgroundColor: projection.exceedsFixedLimit
                    ? '#EF4444'
                    : '#FACC15',
                }}
              />
            </div>
          ) : null}
          <div className="flex justify-between text-[11px] text-[#A3A3A3]">
            <span>Actual: {formatCurrency(projection.baseFixedCommitted, currency)}</span>
            {projection.simulatedFixedUsagePercent !== null ? (
              <span>{formatPercent(projection.simulatedFixedUsagePercent)}</span>
            ) : null}
          </div>
        </div>

        {/* Barra Bolsa de Gustitos */}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="font-semibold text-[#D4D4D4]">Bolsa de Gustitos</span>
            <span
              className={[
                'font-mono-num font-bold',
                projection.exceedsGustitosBudget
                  ? 'text-[#F87171]'
                  : 'text-[#FAFAFA]',
              ].join(' ')}
            >
              {formatCurrency(projection.simulatedGustitosSpent, currency)}
              {projection.gustitosBudget > 0
                ? ` / ${formatCurrency(projection.gustitosBudget, currency)}`
                : ''}
            </span>
          </div>
          {projection.gustitosBudget > 0 ? (
            <div
              role="progressbar"
              aria-label="Uso proyectado de Bolsa de Gustitos"
              aria-valuenow={Math.round(gustitosBarWidth)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={
                projection.simulatedGustitosUsagePercent !== null
                  ? `${formatPercent(projection.simulatedGustitosUsagePercent)} del presupuesto de Gustitos`
                  : undefined
              }
              className="h-2.5 w-full rounded-full bg-[#262626] overflow-hidden"
            >
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${gustitosBarWidth}%`,
                  backgroundColor: projection.exceedsGustitosBudget
                    ? '#EF4444'
                    : '#FACC15',
                }}
              />
            </div>
          ) : null}
          <div className="flex justify-between text-[11px] text-[#A3A3A3]">
            <span>Actual: {formatCurrency(projection.baseGustitosSpent, currency)}</span>
            {projection.simulatedGustitosUsagePercent !== null ? (
              <span>{formatPercent(projection.simulatedGustitosUsagePercent)}</span>
            ) : null}
          </div>
        </div>

        {/* Categorías afectadas */}
        {projection.categoryImpacts.length > 0 ? (
          <div className="pt-3 border-t border-[#1F1F1F] flex flex-col gap-2">
            <span className="text-xs font-semibold text-[#A3A3A3]">
              Categorías afectadas
            </span>
            {projection.categoryImpacts.map((cat) => (
              <div
                key={cat.categoryId}
                className="flex items-center justify-between gap-2 text-xs rounded-[6px] bg-[#0A0A0A] border border-[#262626] px-3 py-2"
              >
                <span className="text-[#FAFAFA] font-medium truncate">
                  {cat.categoryName}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono-num text-[#D4D4D4]">
                    {formatCurrency(cat.simulatedSpent, currency)}
                    {cat.monthlyLimit !== null
                      ? ` / ${formatCurrency(cat.monthlyLimit, currency)}`
                      : ''}
                  </span>
                  {cat.exceedsLimit ? (
                    <Badge variant="red">Supera tope</Badge>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {otherAddedTotal > 0 ? (
          <div className="pt-2 border-t border-[#1F1F1F] flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-[#A3A3A3]">
              También hay{' '}
              <strong className="font-mono-num text-[#FACC15]">
                {formatCurrency(otherAddedTotal, currency)}
              </strong>{' '}
              simulados en {otherLabel}.
            </span>
            <button
              type="button"
              onClick={() => setActiveComparisonTab(otherTab)}
              className="min-h-[44px] px-2.5 rounded-[6px] font-semibold text-[#FACC15] hover:bg-[#1A1A1A] cursor-pointer transition-colors"
            >
              Ver {otherTab === 'current' ? 'mes actual' : 'mes próximo'} &rarr;
            </button>
          </div>
        ) : null}
      </Card>
    );
  }

  const activeProjection =
    activeComparisonTab === 'current'
      ? currentMonthProjection
      : nextMonthProjection;
  const activePanelTitle =
    activeComparisonTab === 'current'
      ? `Mes actual — ${currentMonthLabel}`
      : `Mes próximo — ${nextMonthLabel}`;
  const otherTab: ComparisonTab =
    activeComparisonTab === 'current' ? 'next' : 'current';
  const otherLabel =
    otherTab === 'current' ? currentMonthLabel : nextMonthLabel;
  const otherAddedTotal =
    otherTab === 'current'
      ? currentMonthProjection.addedTotalInPeriod
      : nextMonthProjection.addedTotalInPeriod;

  return (
    <div className="flex flex-col gap-6 pb-24 lg:pb-0">
      <PageSubnav group="decision" />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Simulador de Gastos (&ldquo;¿Qué pasa si...?&rdquo;)
          </h1>
          <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
            Probá compras combinadas al contado o en cuotas sobre tus números reales antes de gastar.
          </p>
        </div>

        <Badge variant="yellow">
          Simulación efímera &mdash; no guarda cambios en tus cuentas
        </Badge>
      </div>

      {isInitialLoading ? (
        <div
          role="status"
          aria-label="Cargando datos reales para el simulador"
          className="grid grid-cols-1 lg:grid-cols-12 gap-5"
        >
          <div className="lg:col-span-5 h-96 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
          <div className="lg:col-span-7 h-96 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
          <span className="sr-only">Cargando datos del simulador...</span>
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-bold text-[#FAFAFA]">
              No pudimos cargar tus saldos reales para simular
            </h2>
            <p className="text-sm text-[#D4D4D4]">{loadError}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRetryLoad()}
            isLoading={isRetryingLoad}
            loadingText="Reintentando..."
            className="w-full sm:w-auto shrink-0"
          >
            Reintentar carga
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Columna izquierda: constructor + escenario combinado */}
            <div className="lg:col-span-5 flex flex-col gap-5">
              <Card padding="md" className="flex flex-col gap-4">
                <h2 className="text-base font-bold text-[#FAFAFA]">
                  Agregar compra hipotética
                </h2>

                <form
                  onSubmit={handleAddSimulatedItem}
                  noValidate
                  className="flex flex-col gap-3.5"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      aria-pressed={mode === 'cash'}
                      onClick={() => {
                        setMode('cash');
                        clearFieldError('installmentsCount');
                      }}
                      className={[
                        'min-h-[44px] rounded-[6px] border text-sm font-bold cursor-pointer transition-colors',
                        mode === 'cash'
                          ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                          : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3]',
                      ].join(' ')}
                    >
                      Al contado
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === 'installments'}
                      onClick={() => setMode('installments')}
                      className={[
                        'min-h-[44px] rounded-[6px] border text-sm font-bold cursor-pointer transition-colors',
                        mode === 'installments'
                          ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                          : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3]',
                      ].join(' ')}
                    >
                      En cuotas
                    </button>
                  </div>

                  <InputField
                    label="Descripción"
                    placeholder="Ej. Notebook / Escapada fin de semana"
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      clearFieldError('description');
                    }}
                    error={fieldErrors.description}
                    required
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <InputField
                      label={mode === 'installments' ? 'Monto por cuota' : 'Monto total'}
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={MAX_MONEY}
                      inputMode="decimal"
                      prefixText="$"
                      placeholder="0.00"
                      value={unitAmount}
                      onChange={(e) => {
                        setUnitAmount(e.target.value);
                        clearFieldError('unitAmount');
                      }}
                      error={fieldErrors.unitAmount}
                      required
                    />

                    {mode === 'installments' ? (
                      <InputField
                        label="Cuotas"
                        type="number"
                        min="1"
                        max="120"
                        inputMode="numeric"
                        value={installmentsCount}
                        onChange={(e) => {
                          setInstallmentsCount(e.target.value);
                          clearFieldError('installmentsCount');
                        }}
                        error={fieldErrors.installmentsCount}
                        required
                      />
                    ) : (
                      <SelectField
                        label="Mes de impacto"
                        value={startMonth}
                        onChange={(e) =>
                          setStartMonth(e.target.value as 'current' | 'next')
                        }
                        options={[
                          { value: 'current', label: `Este mes (${currentMonthLabel})` },
                          { value: 'next', label: `Mes próximo (${nextMonthLabel})` },
                        ]}
                      />
                    )}
                  </div>

                  {mode === 'installments' ? (
                    <SelectField
                      label="Mes de la 1.ª cuota"
                      value={startMonth}
                      onChange={(e) =>
                        setStartMonth(e.target.value as 'current' | 'next')
                      }
                      options={[
                        { value: 'current', label: `Este mes (${currentMonthLabel})` },
                        { value: 'next', label: `Mes próximo (${nextMonthLabel})` },
                      ]}
                    />
                  ) : null}

                  <SelectField
                    label="Categoría afectada (opcional)"
                    value={categoryId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setCategoryId(nextId);
                      clearFieldError('categoryId');
                      const found = expenseCategories.find((c) => c.id === nextId);
                      setIsGustito(Boolean(found?.is_gustito));
                    }}
                    error={fieldErrors.categoryId}
                    placeholder="Sin categoría específica"
                    options={expenseCategories.map((c) => ({
                      value: c.id,
                      label: c.name,
                    }))}
                  />

                  <label
                    htmlFor="sim-is-gustito"
                    className="flex min-h-[44px] items-center justify-between gap-3 rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3 py-2 cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <input
                        id="sim-is-gustito"
                        type="checkbox"
                        checked={isCategoryGustito || isGustito}
                        disabled={isCategoryGustito}
                        onChange={(e) => setIsGustito(e.target.checked)}
                        className="h-4 w-4 accent-[#FACC15]"
                      />
                      <span className="text-sm font-medium text-[#FAFAFA]">
                        Imputar en Bolsa de Gustitos
                      </span>
                    </div>
                    <span className="text-xs text-[#A3A3A3]">
                      {isCategoryGustito ? 'Por categoría' : isGustito ? 'Sí' : 'No'}
                    </span>
                  </label>

                  {formError ? (
                    <p role="alert" className="text-xs font-medium text-[#EF4444]">
                      {formError}
                    </p>
                  ) : null}

                  <Button type="submit" variant="primary">
                    + Agregar a simulación
                  </Button>
                </form>
              </Card>

              {/* Lista de ítems simulados */}
              <Card padding="md" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-bold text-[#FAFAFA]">
                      Escenario combinado ({items.length})
                    </h2>
                    <p className="text-xs text-[#A3A3A3]">
                      Compromiso total simulado:{' '}
                      <strong className="font-mono-num text-[#FACC15]">
                        {formatCurrency(totalSimulatedOutflow, currency)}
                      </strong>
                    </p>
                  </div>

                  {items.length > 0 ? (
                    <Button variant="secondary" size="sm" onClick={clearItems}>
                      Limpiar simulación
                    </Button>
                  ) : null}
                </div>

                {items.length === 0 ? (
                  <EmptyState
                    title="Todavía no agregaste gastos hipotéticos"
                    description="Agregá una o varias compras arriba para ver al instante cómo impactan en tu Disponible Real, Comprometido y Gustitos."
                  />
                ) : (
                  <div className="divide-y divide-[#1E1E1E] border border-[#222222] rounded-[6px] bg-[#0A0A0A]">
                    {items.map((item) => {
                      const catName = item.categoryId
                        ? (expenseCategories.find((c) => c.id === item.categoryId)
                            ?.name ?? 'Categoría')
                        : 'Sin categoría';

                      return (
                        <div
                          key={item.id}
                          className="p-3.5 flex flex-col gap-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-sm font-bold text-[#FAFAFA]">
                                  {item.description}
                                </span>
                                <Badge variant="neutral">
                                  {item.mode === 'installments'
                                    ? `${item.installmentsCount} cuotas`
                                    : 'Contado'}
                                </Badge>
                                {item.isGustito ? (
                                  <Badge variant="yellow">Gustito</Badge>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs text-[#A3A3A3]">
                                {catName} &middot; Inicia en{' '}
                                {item.startMonth === 'current'
                                  ? currentMonthLabel
                                  : nextMonthLabel}
                              </p>
                            </div>

                            <span className="font-mono-num text-sm font-bold text-[#FACC15] shrink-0">
                              {formatCurrency(item.unitAmount, currency)}
                              {item.mode === 'installments' ? '/mes' : ''}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void handleConvertToReal(item)}
                              isLoading={convertingId === item.id}
                              loadingText="Guardando..."
                            >
                              Registrar real
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => removeItem(item.id)}
                              disabled={convertingId === item.id}
                            >
                              Quitar
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            </div>

            {/* Columna derecha sticky: comparativa con toggle Mes actual | Mes próximo */}
            <div
              id="simulator-comparison-panel"
              className="lg:col-span-7 lg:sticky lg:top-[84px] flex flex-col gap-3 scroll-mt-24"
            >
              <div
                {...getTabListProps('Seleccionar período de comparación')}
                className="grid grid-cols-2 gap-2 rounded-[8px] border border-[#262626] bg-[#121212] p-1.5"
              >
                <button
                  {...getTabProps('current')}
                  className={[
                    'min-h-[44px] px-3 py-1.5 rounded-[6px] text-sm transition-colors cursor-pointer text-left',
                    activeComparisonTab === 'current'
                      ? 'bg-[#FACC15] text-[#0A0A0A] font-bold'
                      : 'text-[#D4D4D4] hover:bg-[#1A1A1A] hover:text-[#FAFAFA] font-medium',
                  ].join(' ')}
                >
                  <span className="block truncate">Mes actual</span>
                  <span
                    className={[
                      'block text-[11px] truncate',
                      activeComparisonTab === 'current'
                        ? 'text-[#0A0A0A]/80'
                        : 'text-[#A3A3A3]',
                    ].join(' ')}
                  >
                    {currentMonthLabel}
                  </span>
                </button>

                <button
                  {...getTabProps('next')}
                  className={[
                    'min-h-[44px] px-3 py-1.5 rounded-[6px] text-sm transition-colors cursor-pointer text-left',
                    activeComparisonTab === 'next'
                      ? 'bg-[#FACC15] text-[#0A0A0A] font-bold'
                      : 'text-[#D4D4D4] hover:bg-[#1A1A1A] hover:text-[#FAFAFA] font-medium',
                  ].join(' ')}
                >
                  <span className="block truncate">Mes próximo</span>
                  <span
                    className={[
                      'block text-[11px] truncate',
                      activeComparisonTab === 'next'
                        ? 'text-[#0A0A0A]/80'
                        : 'text-[#A3A3A3]',
                    ].join(' ')}
                  >
                    {nextMonthLabel}
                  </span>
                </button>
              </div>

              <div {...getPanelProps(activeComparisonTab)} className="outline-none">
                {renderComparisonPanel(
                  activePanelTitle,
                  activeProjection,
                  otherTab,
                  otherLabel,
                  otherAddedTotal,
                )}
              </div>
            </div>
          </div>

          {/* Barra resumen compacta fija en mobile (390px/320px) */}
          <div
            aria-label="Resumen rápido del simulador"
            className="lg:hidden fixed inset-x-0 bottom-0 z-30 border-t border-[#262626] bg-[#121212] px-4 py-2.5"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-[11px] text-[#A3A3A3] truncate">
                  Disp. simulado ({activeComparisonTab === 'current' ? 'Mes actual' : 'Mes próx.'})
                </span>
                <div className="flex items-baseline gap-2">
                  <span
                    className={[
                      'font-mono-num text-base font-extrabold truncate',
                      activeProjection.simulatedRealAvailable > 0
                        ? 'text-[#22C55E]'
                        : activeProjection.simulatedRealAvailable < 0
                          ? 'text-[#EF4444]'
                          : 'text-[#FAFAFA]',
                    ].join(' ')}
                  >
                    {formatCurrency(activeProjection.simulatedRealAvailable, currency)}
                  </span>
                  {activeProjection.realAvailableDelta !== 0 ? (
                    <span className="font-mono-num text-xs font-semibold text-[#F87171] shrink-0">
                      {formatCurrency(activeProjection.realAvailableDelta, currency)}
                    </span>
                  ) : null}
                </div>
              </div>

              <a
                href="#simulator-comparison-panel"
                className="min-h-[44px] px-3.5 inline-flex items-center justify-center rounded-[6px] border border-[#262626] bg-[#0A0A0A] text-xs font-bold text-[#FACC15] hover:border-[#FACC15] whitespace-nowrap shrink-0 no-underline"
              >
                Ver impacto
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
