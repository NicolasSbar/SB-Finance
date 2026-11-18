/**
 * Página Principal de Control Financiero Ejecutivo (`DashboardPage`).
 *
 * Arquitectura y decisiones técnicas:
 * - Vista ejecutiva sin sobrecarga cognitiva: la primera pantalla prioriza el selector
 *   mensual, acciones rápidas compactas (`grid-cols-2` para `+ Plazo Fijo` / `+ Cuotas`
 *   y `+ Nuevo Movimiento`), el aviso de cierre sin duplicar CTAs, el KPI protagonista
 *   `Disponible Real` y las dos barras `0% → 100%` (*Comprometido* y *Bolsa de Gustitos*).
 * - Todo el detalle operativo se organiza debajo en 3 sub-pestañas accesibles con
 *   `useRovingTabs` (`Resumen y Gráficos`, `Pendientes de Pago`, `Movimientos del Mes`),
 *   emparejando `CategoryLimitsWidget` con el gráfico de dona en `lg:grid-cols-2`.
 * - Modales montados bajo demanda (`isOpen`) y estado de carga explícito al consultar
 *   la Bóveda antes de abrir `+ Plazo Fijo`.
 * - En `Movimientos del Mes` muestra los compromisos pagados (`is_paid = true`)
 *   en modo solo lectura sin duplicar ni alterar totales contables.
 */
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { MonthSelectorBar } from '../../components/layout/MonthSelectorBar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardData } from '../../hooks/useDashboardData';
import { useMonthlyPeriod } from '../../hooks/useMonthlyPeriod';
import { useRovingTabs } from '../../hooks/useRovingTabs';
import {
  formatCurrency,
  roundCurrency,
} from '../../lib/formatters';
import { monthlyBudgetSnapshotSchema } from '../../lib/validations';
import { getAccumulatedSavingsBalance } from '../../services/savingsService';
import { updateMonthlyBudgetSnapshot } from '../../services/settingsService';
import type { Transaction, TransactionFilters } from '../../types/database.types';
import { InstallmentFormModal } from '../commitments/InstallmentFormModal';
import { FixedTermFormModal } from '../fixed-terms/FixedTermFormModal';
import {
  EMPTY_TRANSACTION_FILTERS,
  filterTransactions,
} from '../transactions/TransactionFiltersBar';
import { TransactionFormModal } from '../transactions/TransactionFormModal';
import {
  TransactionsTable,
  filterPaidCommitments,
} from '../transactions/TransactionsTable';
import { CategoryLimitsWidget } from './CategoryLimitsWidget';
import {
  CategoryBreakdownChartCard,
  FinancialChartsSection,
} from './FinancialChartsSection';
import { GustitosProgressWidget } from './GustitosProgressWidget';
import { KpiSummaryGrid } from './KpiSummaryGrid';
import { PendingCommitmentsWidget } from './PendingCommitmentsWidget';
import { SetupAlertBanner } from './SetupAlertBanner';
import { SurplusCloseModal } from './SurplusCloseModal';

type DashboardTab = 'overview' | 'commitments' | 'transactions';

const DASHBOARD_TABS: readonly DashboardTab[] = [
  'overview',
  'commitments',
  'transactions',
];

export function DashboardPage() {
  const { user, userSettings } = useAuth();
  const { monthDate, monthLabel, isPastMonth } = useMonthlyPeriod();
  const {
    commitments,
    transactions,
    categories,
    evolution,
    summary,
    categoryBreakdown,
    isLoading,
    isInitializingMonth,
    error,
    refresh,
    initializeHistoricalMonth,
  } = useDashboardData();

  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const tabsSectionRef = useRef<HTMLDivElement | null>(null);
  const { getTabListProps, getTabProps, getPanelProps } = useRovingTabs({
    tabs: DASHBOARD_TABS,
    activeTab,
    onChange: setActiveTab,
    orientation: 'horizontal',
    idPrefix: 'dashboard',
  });
  const [filters, setFilters] = useState<TransactionFilters>(
    EMPTY_TRANSACTION_FILTERS,
  );

  // Modales de acción rápida
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [isInstallmentModalOpen, setIsInstallmentModalOpen] = useState(false);
  const [isFixedTermModalOpen, setIsFixedTermModalOpen] = useState(false);
  const [isOpeningFixedTerm, setIsOpeningFixedTerm] = useState(false);
  const [liquidVaultBalance, setLiquidVaultBalance] = useState<number>(0);
  const [isSurplusModalOpen, setIsSurplusModalOpen] = useState(false);

  // Modal de ajuste puntual de presupuesto mensual
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false);
  const [budgetSalaryInput, setBudgetSalaryInput] = useState('');
  const [budgetSavingsInput, setBudgetSavingsInput] = useState('');
  const [budgetLimitInput, setBudgetLimitInput] = useState('');
  const [budgetGustitosInput, setBudgetGustitosInput] = useState('');
  const [budgetErrors, setBudgetErrors] = useState<{
    fixed_salary?: string;
    monthly_savings_target?: string;
    fixed_expenses_limit?: string;
    gustitos_budget?: string;
  }>({});
  const [isSavingBudget, setIsSavingBudget] = useState(false);

  const currency = userSettings?.currency ?? 'ARS';
  const totalCapSurplus = roundCurrency(summary.fixedCapSurplus);

  const gustitoCategoryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const cat of categories) {
      if (cat.is_gustito) {
        ids.add(cat.id);
      }
    }
    for (const limit of summary.categoryLimits) {
      if (limit.isGustito) {
        ids.add(limit.categoryId);
      } else {
        ids.delete(limit.categoryId);
      }
    }
    return ids;
  }, [categories, summary.categoryLimits]);

  const paidCommitments = useMemo(
    () => commitments.filter((commitment) => commitment.is_paid),
    [commitments],
  );

  const filteredTransactions = useMemo(
    () => filterTransactions(transactions, filters),
    [transactions, filters],
  );

  const filteredPaidCommitments = useMemo(
    () => filterPaidCommitments(paidCommitments, filters),
    [paidCommitments, filters],
  );

  const hasSimpleFilters = filters.search !== '' || filters.type !== 'all';

  async function handleInitializePastMonth(): Promise<void> {
    try {
      await initializeHistoricalMonth();
      toast.success(`Período ${monthLabel} inicializado para carga histórica.`);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo inicializar el mes histórico.';
      toast.error(msg);
    }
  }

  async function handleOpenFixedTermModal(): Promise<void> {
    if (isOpeningFixedTerm) return;
    setIsOpeningFixedTerm(true);
    try {
      const balance = await getAccumulatedSavingsBalance();
      setLiquidVaultBalance(balance.liquidBalance);
      setIsFixedTermModalOpen(true);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo consultar el saldo líquido de tu Bóveda de Ahorros. Intentá nuevamente.';
      toast.error(msg);
    } finally {
      setIsOpeningFixedTerm(false);
    }
  }

  function openBudgetModal(): void {
    setBudgetErrors({});
    setBudgetSalaryInput(String(summary.fixedSalary));
    setBudgetSavingsInput(String(summary.monthlySavingsTarget));
    setBudgetLimitInput(String(summary.fixedExpensesLimit));
    setBudgetGustitosInput(String(summary.gustitos.budget));
    setIsBudgetModalOpen(true);
  }

  async function handleSaveBudgetSnapshot(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!user) return;
    setBudgetErrors({});

    const parsed = monthlyBudgetSnapshotSchema.safeParse({
      fixed_salary: budgetSalaryInput,
      monthly_savings_target: budgetSavingsInput,
      fixed_expenses_limit: budgetLimitInput,
      gustitos_budget: budgetGustitosInput,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setBudgetErrors({
        fixed_salary: flat.fixed_salary?.[0],
        monthly_savings_target: flat.monthly_savings_target?.[0],
        fixed_expenses_limit: flat.fixed_expenses_limit?.[0],
        gustitos_budget: flat.gustitos_budget?.[0],
      });
      return;
    }

    setIsSavingBudget(true);
    try {
      await updateMonthlyBudgetSnapshot(
        user.id,
        monthDate,
        parsed.data.fixed_salary,
        parsed.data.monthly_savings_target,
        parsed.data.fixed_expenses_limit,
        parsed.data.gustitos_budget,
      );
      toast.success(
        `Presupuesto de ${monthLabel} actualizado sin modificar tu configuración base.`,
      );
      setIsBudgetModalOpen(false);
      await refresh();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo actualizar el presupuesto del mes.';
      toast.error(msg);
    } finally {
      setIsSavingBudget(false);
    }
  }

  const isEmptyUninitPastMonth =
    isPastMonth &&
    !summary.isInitialized &&
    commitments.length === 0 &&
    transactions.length === 0;

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Encabezado ejecutivo y acciones rápidas compactas para mobile 390px */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 sm:gap-4">
        <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
          Panel de {monthLabel}
        </h1>

        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-stretch sm:items-center gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => void handleOpenFixedTermModal()}
            isLoading={isOpeningFixedTerm}
            loadingText="Cargando..."
          >
            + Plazo Fijo
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => setIsInstallmentModalOpen(true)}
          >
            + Cuotas
          </Button>
          <Button
            variant="primary"
            className="col-span-2 sm:col-span-1 w-full sm:w-auto"
            onClick={() => {
              setEditingTx(null);
              setIsTxModalOpen(true);
            }}
          >
            + Nuevo Movimiento
          </Button>
        </div>
      </div>

      {/* Selector de mes limpio (el acceso manual al sobrante vive dentro de la tarjeta de Fijos) */}
      <MonthSelectorBar />

      {/* Aviso no bloqueante de revisión de cierre / día de cobro */}
      {summary.shouldPromptSurplusReview ? (
        <div
          role="region"
          aria-label="Revisión de cierre de período"
          className="rounded-[8px] border border-[#FACC15]/50 bg-[#FACC15]/10 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="yellow">Revisión de cierre</Badge>
              <span className="text-sm font-bold text-[#FAFAFA]">
                Tenés {formatCurrency(totalCapSurplus, currency)} sin usar en tu límite de Gastos Fijos de {monthLabel}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-[#D4D4D4]">
              Verificá si olvidaste registrar algún gasto y elegí si enviar ese sobrante a tu Bóveda de Ahorros o liberarlo al Disponible Real.
            </p>
          </div>

          <Button
            variant="primary"
            size="sm"
            className="shrink-0"
            onClick={() => setIsSurplusModalOpen(true)}
          >
            Revisar y distribuir
          </Button>
        </div>
      ) : null}

      {/* Banner de aviso si el sueldo fijo o límite siguen en $0 */}
      {userSettings ? (
        <SetupAlertBanner
          fixedSalary={userSettings.fixed_salary}
          fixedExpensesLimit={userSettings.fixed_expenses_limit}
        />
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-sm text-[#FAFAFA]">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            Reintentar carga
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 h-44 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
            <div className="h-44 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="h-36 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
            <div className="h-36 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
          </div>
        </div>
      ) : isEmptyUninitPastMonth ? (
        <EmptyState
          headingLevel="h2"
          title={`No hay cierre registrado para ${monthLabel}`}
          description="Este mes es anterior al actual y todavía no tiene presupuesto ni movimientos guardados. Podés inicializarlo manualmente si querés cargar historial retroactivo."
          actionLabel="Inicializar mes para carga histórica"
          onAction={() => void handleInitializePastMonth()}
          isActionLoading={isInitializingMonth}
        />
      ) : (
        <>
          {isPastMonth && !summary.isInitialized ? (
            <div className="rounded-[8px] border border-[#262626] bg-[#121212] px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-sm text-[#D4D4D4]">
                Este mes pasado tiene movimientos cargados pero no tiene snapshot de sueldo/límite registrado.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleInitializePastMonth()}
                isLoading={isInitializingMonth}
              >
                Inicializar mes para carga histórica
              </Button>
            </div>
          ) : null}

          {/* Cabecera Ejecutiva: Disponible Real + Resumen + Las 2 barras 0% -> 100% */}
          <KpiSummaryGrid
            summary={summary}
            currency={currency}
            gustitosSlot={
              <GustitosProgressWidget
                gustitos={summary.gustitos}
                currency={currency}
                monthLabel={monthLabel}
              />
            }
            onAdjustBudget={user ? openBudgetModal : undefined}
            isBudgetActionDisabled={isLoading}
            onReviewSurplus={
              user && totalCapSurplus > 0
                ? () => setIsSurplusModalOpen(true)
                : undefined
            }
            onViewPending={() => {
              setActiveTab('commitments');
              const prefersReduced =
                typeof window !== 'undefined' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
              tabsSectionRef.current?.scrollIntoView({
                behavior: prefersReduced ? 'auto' : 'smooth',
                block: 'start',
              });
            }}
          />

          {/* Navegación por Sub-pestañas Internas */}
          <div ref={tabsSectionRef} className="flex flex-col gap-4 pt-1 scroll-mt-20">
            <div
              {...getTabListProps('Detalle operativo del período')}
              className="flex flex-wrap gap-2 border-b border-[#262626] pb-3"
            >
              <button
                {...getTabProps('overview')}
                className={[
                  'min-h-[44px] px-4 rounded-[6px] border text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap',
                  activeTab === 'overview'
                    ? 'bg-[#FACC15] border-[#FACC15] text-[#0A0A0A]'
                    : 'bg-[#121212] border-[#262626] text-[#D4D4D4] hover:text-[#FAFAFA] hover:border-[#3A3A3A]',
                ].join(' ')}
              >
                Resumen y Gráficos
              </button>

              <button
                {...getTabProps('commitments')}
                className={[
                  'min-h-[44px] px-4 rounded-[6px] border text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap inline-flex items-center gap-2',
                  activeTab === 'commitments'
                    ? 'bg-[#FACC15] border-[#FACC15] text-[#0A0A0A]'
                    : 'bg-[#121212] border-[#262626] text-[#D4D4D4] hover:text-[#FAFAFA] hover:border-[#3A3A3A]',
                ].join(' ')}
              >
                <span>Pendientes de Pago</span>
                <span
                  className={[
                    'px-2 py-0.5 rounded-[4px] text-xs font-mono-num font-bold',
                    activeTab === 'commitments'
                      ? 'bg-[#0A0A0A]/15 text-[#0A0A0A]'
                      : 'bg-[#1F1F1F] text-[#FACC15]',
                  ].join(' ')}
                >
                  {summary.pendingCommitmentsCount}
                </span>
              </button>

              <button
                {...getTabProps('transactions')}
                className={[
                  'min-h-[44px] px-4 rounded-[6px] border text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap inline-flex items-center gap-2',
                  activeTab === 'transactions'
                    ? 'bg-[#FACC15] border-[#FACC15] text-[#0A0A0A]'
                    : 'bg-[#121212] border-[#262626] text-[#D4D4D4] hover:text-[#FAFAFA] hover:border-[#3A3A3A]',
                ].join(' ')}
              >
                <span>Movimientos del Mes</span>
                <span
                  className={[
                    'px-2 py-0.5 rounded-[4px] text-xs font-mono-num font-bold',
                    activeTab === 'transactions'
                      ? 'bg-[#0A0A0A]/15 text-[#0A0A0A]'
                      : 'bg-[#1F1F1F] text-[#D4D4D4]',
                  ].join(' ')}
                >
                  {transactions.length + paidCommitments.length}
                </span>
              </button>
            </div>

            {activeTab === 'overview' ? (
              <div
                {...getPanelProps('overview')}
                className="flex flex-col gap-4"
              >
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <CategoryLimitsWidget
                    categoryLimits={summary.categoryLimits}
                    currency={currency}
                    monthLabel={monthLabel}
                  />
                  <CategoryBreakdownChartCard
                    categoryBreakdown={categoryBreakdown}
                    currency={currency}
                  />
                </div>
                <FinancialChartsSection
                  summary={summary}
                  categoryBreakdown={categoryBreakdown}
                  evolution={evolution}
                  currency={currency}
                  showCategoryDonut={false}
                />
              </div>
            ) : null}

            {activeTab === 'commitments' ? (
              <div {...getPanelProps('commitments')}>
                <PendingCommitmentsWidget
                  commitments={commitments}
                  currency={currency}
                  monthLabel={monthLabel}
                  gustitoCategoryIds={gustitoCategoryIds}
                  onUpdated={refresh}
                />
              </div>
            ) : null}

            {activeTab === 'transactions' ? (
              <section
                {...getPanelProps('transactions')}
                className="flex flex-col gap-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-bold text-[#FAFAFA]">
                      Movimientos de {monthLabel}
                    </h2>
                    <p className="text-sm text-[#A3A3A3]">
                      Gastos variables, ingresos extra y compromisos abonados del período (solo lectura).
                    </p>
                  </div>

                  <Link
                    to="/transactions"
                    className="inline-flex items-center min-h-[44px] px-2 -mx-2 text-sm font-semibold text-[#FACC15] hover:underline"
                  >
                    Ver pantalla completa de movimientos{' '}
                    <span aria-hidden="true">&rarr;</span>
                  </Link>
                </div>

                {/* Filtros simplificados para el tab de movimientos del Dashboard */}
                <div className="bg-[#121212] border border-[#262626] rounded-[8px] p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-end gap-3">
                  <div className="flex-1 min-w-0">
                    <InputField
                      label="Buscar movimiento"
                      placeholder="Descripción, nota o categoría..."
                      value={filters.search}
                      onChange={(e) =>
                        setFilters({ ...filters, search: e.target.value })
                      }
                    />
                  </div>

                  <div className="w-full sm:w-48">
                    <SelectField
                      label="Tipo"
                      value={filters.type}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          type: e.target.value as TransactionFilters['type'],
                        })
                      }
                      options={[
                        { value: 'all', label: 'Todos' },
                        { value: 'expense', label: 'Gastos variables' },
                        { value: 'income', label: 'Ingresos extra' },
                      ]}
                    />
                  </div>

                  {hasSimpleFilters ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full sm:w-auto shrink-0"
                      onClick={() => setFilters(EMPTY_TRANSACTION_FILTERS)}
                    >
                      Limpiar
                    </Button>
                  ) : null}
                </div>

                <TransactionsTable
                  transactions={filteredTransactions}
                  paidCommitments={filteredPaidCommitments}
                  gustitoCategoryIds={gustitoCategoryIds}
                  currency={currency}
                  onEdit={(tx) => {
                    setEditingTx(tx);
                    setIsTxModalOpen(true);
                  }}
                  onCreateNew={() => {
                    setEditingTx(null);
                    setIsTxModalOpen(true);
                  }}
                  onDeleted={refresh}
                />
              </section>
            ) : null}
          </div>
        </>
      )}

      {/* Modales de acción rápida (montados bajo demanda solo cuando isOpen) */}
      {user ? (
        <>
          {isTxModalOpen ? (
            <TransactionFormModal
              isOpen={isTxModalOpen}
              onClose={() => setIsTxModalOpen(false)}
              userId={user.id}
              categories={categories}
              defaultMonthDate={monthDate}
              initialTransaction={editingTx}
              onSaved={refresh}
            />
          ) : null}

          {isInstallmentModalOpen ? (
            <InstallmentFormModal
              isOpen={isInstallmentModalOpen}
              onClose={() => setIsInstallmentModalOpen(false)}
              userId={user.id}
              categories={categories}
              defaultLimit={userSettings?.fixed_expenses_limit ?? 0}
              currency={currency}
              onSaved={refresh}
            />
          ) : null}

          {isFixedTermModalOpen ? (
            <FixedTermFormModal
              isOpen={isFixedTermModalOpen}
              onClose={() => setIsFixedTermModalOpen(false)}
              liquidSavingsBalance={liquidVaultBalance}
              currency={currency}
              onSaved={refresh}
            />
          ) : null}

          {isSurplusModalOpen ? (
            <SurplusCloseModal
              isOpen={isSurplusModalOpen}
              onClose={() => setIsSurplusModalOpen(false)}
              summary={summary}
              monthLabel={monthLabel}
              currency={currency}
              onRegisterForgottenExpense={() => {
                setEditingTx(null);
                setIsTxModalOpen(true);
              }}
              onReconciled={refresh}
            />
          ) : null}

          {isBudgetModalOpen ? (
            <Modal
              isOpen={isBudgetModalOpen}
              onClose={() => setIsBudgetModalOpen(false)}
              title={`Ajustar presupuesto de ${monthLabel}`}
              description="Edición puntual solo para este mes. No modifica tus valores base en Configuración ni otros períodos."
              size="sm"
            >
              <form onSubmit={handleSaveBudgetSnapshot} noValidate className="flex flex-col gap-4">
                <InputField
                  label={`Sueldo fijo de ${monthLabel}`}
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  prefixText="$"
                  value={budgetSalaryInput}
                  onChange={(e) => setBudgetSalaryInput(e.target.value)}
                  error={budgetErrors.fixed_salary}
                  required
                />

                <InputField
                  label={`Ahorro mensual objetivo de ${monthLabel}`}
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  prefixText="$"
                  value={budgetSavingsInput}
                  onChange={(e) => setBudgetSavingsInput(e.target.value)}
                  error={budgetErrors.monthly_savings_target}
                  hint="Monto apartado automáticamente de tu Disponible Real en este período."
                  required
                />

                <InputField
                  label={`Límite de gastos fijos de ${monthLabel}`}
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  prefixText="$"
                  value={budgetLimitInput}
                  onChange={(e) => setBudgetLimitInput(e.target.value)}
                  error={budgetErrors.fixed_expenses_limit}
                  hint="Usado para calcular las alertas preventivas de fijos y cuotas de este mes."
                  required
                />

                <InputField
                  label={`Presupuesto de Gustitos de ${monthLabel}`}
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  prefixText="$"
                  value={budgetGustitosInput}
                  onChange={(e) => setBudgetGustitosInput(e.target.value)}
                  error={budgetErrors.gustitos_budget}
                  hint="Tope compartido para compras discrecionales de este mes."
                  required
                />

                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
                  <Button
                    variant="secondary"
                    onClick={() => setIsBudgetModalOpen(false)}
                    disabled={isSavingBudget}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    isLoading={isSavingBudget}
                    loadingText="Guardando..."
                  >
                    Guardar presupuesto del mes
                  </Button>
                </div>
              </form>
            </Modal>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
