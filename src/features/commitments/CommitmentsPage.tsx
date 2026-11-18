/**
 * Página unificada de Gastos Fijos Recurrentes, Compras en Cuotas y Checklist Mensual.
 *
 * Arquitectura y decisiones técnicas:
 * - Integra en una sola vista la ejecución del mes seleccionado (`monthly_commitments`
 *   con su límite y estado `Pagado`/`Pendiente`) junto con las fuentes que lo originan
 *   (plantillas recurrentes y compras en cuotas).
 * - Permite ajustar el monto puntual de un gasto fijo solo para el mes seleccionado
 *   sin modificar el valor base de su plantilla para meses posteriores.
 * - Expone explícitamente cualquier fallo de `useDashboardData` o `loadSources` en un
 *   banner `role="alert"` con acción `Reintentar`, evitando listas vacías engañosas.
 * - Consistencia histórica de Gustitos: resuelve si la categoría de una cuota
 *   pertenece a Gustitos según el snapshot mensual (`monthly_category_snapshots`) del
 *   período visualizado, evitando que cambios posteriores en la categoría alteren meses pasados.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { MonthSelectorBar } from '../../components/layout/MonthSelectorBar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardData } from '../../hooks/useDashboardData';
import { useMonthlyPeriod } from '../../hooks/useMonthlyPeriod';
import {
  formatCurrency,
  formatPercent,
  formatShortDate,
  roundCurrency,
} from '../../lib/formatters';
import { monthlyAmountEditSchema } from '../../lib/validations';
import { getMonthlyCategorySnapshots } from '../../services/categoriesService';
import {
  getFixedExpenseTemplates,
  getInstallmentProgressMap,
  getInstallmentPurchases,
  getRecentInstallmentBatches,
  toggleCommitmentPaidStatus,
  updateMonthlyCommitmentAmount,
} from '../../services/commitmentsService';
import type {
  FixedExpenseTemplate,
  InstallmentPaymentBatch,
  InstallmentProgressSummary,
  InstallmentPurchase,
  MonthlyCategorySnapshot,
  MonthlyCommitment,
} from '../../types/database.types';
import { FixedExpenseFormModal } from './FixedExpenseFormModal';
import { FixedExpensesList } from './FixedExpensesList';
import { InstallmentFormModal } from './InstallmentFormModal';
import { InstallmentsList } from './InstallmentsList';

export function CommitmentsPage() {
  const { user, userSettings } = useAuth();
  const { monthDate, monthLabel, currentCalendarMonth } = useMonthlyPeriod();
  const {
    commitments,
    categories,
    summary,
    isLoading: isDashboardLoading,
    error: dashboardError,
    refresh: refreshDashboard,
  } = useDashboardData(undefined, {
    includeEvolution: false,
    includeTransactions: false,
  });

  const [templates, setTemplates] = useState<FixedExpenseTemplate[]>([]);
  const [purchases, setPurchases] = useState<InstallmentPurchase[]>([]);
  const [recentBatches, setRecentBatches] = useState<InstallmentPaymentBatch[]>([]);
  const [progressMap, setProgressMap] = useState<
    Record<string, InstallmentProgressSummary>
  >({});
  const [snapshotState, setSnapshotState] = useState<{
    monthDate: string;
    rows: MonthlyCategorySnapshot[];
  }>({ monthDate, rows: [] });
  const [isLoadingLists, setIsLoadingLists] = useState<boolean>(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [isRetryingLoad, setIsRetryingLoad] = useState<boolean>(false);
  const hasLoadedSourcesRef = useRef<boolean>(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Modales
  const [isFixedModalOpen, setIsFixedModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<FixedExpenseTemplate | null>(
    null,
  );
  const [isInstallmentModalOpen, setIsInstallmentModalOpen] = useState(false);
  const [editingPurchase, setEditingPurchase] = useState<InstallmentPurchase | null>(
    null,
  );

  // Modal de ajuste puntual de un gasto fijo en el mes actual
  const [adjustingCommitment, setAdjustingCommitment] =
    useState<MonthlyCommitment | null>(null);
  const [adjustAmountValue, setAdjustAmountValue] = useState('');
  const [adjustError, setAdjustError] = useState<string | undefined>(undefined);
  const [isAdjusting, setIsAdjusting] = useState(false);

  const currency = userSettings?.currency ?? 'ARS';

  const loadSources = useCallback(async () => {
    if (!hasLoadedSourcesRef.current) {
      setIsLoadingLists(true);
    }
    setSourcesError(null);
    try {
      const [tplData, purData, progData, batchesData, snapshotsData] =
        await Promise.all([
          getFixedExpenseTemplates(),
          getInstallmentPurchases(),
          getInstallmentProgressMap(),
          getRecentInstallmentBatches(),
          getMonthlyCategorySnapshots(monthDate),
        ]);
      setTemplates(tplData);
      setPurchases(purData);
      setProgressMap(progData);
      setRecentBatches(batchesData);
      setSnapshotState({ monthDate, rows: snapshotsData });
      hasLoadedSourcesRef.current = true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudieron cargar las plantillas y cuotas.';
      setSourcesError(msg);
      if (hasLoadedSourcesRef.current) {
        toast.error(msg);
      }
    } finally {
      setIsLoadingLists(false);
    }
  }, [monthDate]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshDashboard(), loadSources()]);
  }, [refreshDashboard, loadSources]);

  async function handleRetryLoad(): Promise<void> {
    setIsRetryingLoad(true);
    try {
      await refreshAll();
    } finally {
      setIsRetryingLoad(false);
    }
  }

  async function handleTogglePaid(item: MonthlyCommitment): Promise<void> {
    setTogglingId(item.id);
    try {
      await toggleCommitmentPaidStatus(item.id, !item.is_paid);
      toast.success(
        !item.is_paid
          ? `"${item.name}" marcado como pagado.`
          : `"${item.name}" marcado como pendiente.`,
      );
      await refreshAll();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo cambiar el estado de pago.';
      toast.error(msg);
    } finally {
      setTogglingId(null);
    }
  }

  function openAdjustAmountModal(item: MonthlyCommitment): void {
    setAdjustingCommitment(item);
    setAdjustAmountValue(String(item.amount));
    setAdjustError(undefined);
  }

  async function handleSaveAdjustedAmount(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!adjustingCommitment) return;
    setAdjustError(undefined);

    const parsed = monthlyAmountEditSchema.safeParse({ amount: adjustAmountValue });
    if (!parsed.success) {
      setAdjustError(parsed.error.flatten().fieldErrors.amount?.[0]);
      return;
    }

    setIsAdjusting(true);
    try {
      await updateMonthlyCommitmentAmount(adjustingCommitment.id, parsed.data.amount);
      toast.success(
        `Monto ajustado solo para ${monthLabel} sin modificar la plantilla base.`,
      );
      setAdjustingCommitment(null);
      await refreshAll();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo ajustar el monto del mes.';
      toast.error(msg);
    } finally {
      setIsAdjusting(false);
    }
  }

  const { snapshotByCatId, hasMonthSnapshots } = useMemo(() => {
    const map = new Map<string, MonthlyCategorySnapshot>();
    if (snapshotState.monthDate === monthDate) {
      for (const snap of snapshotState.rows) {
        map.set(snap.category_id, snap);
      }
    }
    return {
      snapshotByCatId: map,
      hasMonthSnapshots: map.size > 0,
    };
  }, [snapshotState, monthDate]);

  const loadError = dashboardError ?? sourcesError;
  const limitUsagePercent = summary.committedLimitUsagePercent;
  const barWidth =
    limitUsagePercent !== null ? Math.min(100, Math.max(0, limitUsagePercent)) : 0;
  const isCaution =
    limitUsagePercent !== null && limitUsagePercent >= 85 && !summary.isOverFixedLimit;
  const excessAmount =
    summary.isOverFixedLimit
      ? roundCurrency(summary.totalCommitted - summary.fixedExpensesLimit)
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
          Fijos y Cuotas
        </h1>
        <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
          Administrá tus compromisos mensuales apartados desde el día 1, marcá pagos realizados y planificá compras en cuotas.
        </p>
      </div>

      <MonthSelectorBar
        rightSlot={
          <>
            <Button
              variant="secondary"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                setEditingTemplate(null);
                setIsFixedModalOpen(true);
              }}
            >
              + Nuevo gasto fijo
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                setEditingPurchase(null);
                setIsInstallmentModalOpen(true);
              }}
            >
              + Nueva compra en cuotas
            </Button>
          </>
        }
      />

      {loadError ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-[#FAFAFA]">
              No se pudieron cargar todos los compromisos y fuentes del mes.
            </p>
            <p className="text-xs text-[#D4D4D4]">{loadError}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRetryLoad()}
            isLoading={isRetryingLoad}
            loadingText="Reintentando..."
            className="w-full sm:w-auto shrink-0"
          >
            Reintentar
          </Button>
        </div>
      ) : null}

      {/* Tarjeta de estado del límite mensual */}
      <Card
        padding="md"
        highlight={summary.isOverFixedLimit ? 'red' : 'none'}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <span className="text-[13px] font-medium text-[#A3A3A3]">
                Comprometido en {monthLabel} (Fijos + Cuotas No-Gustito) vs. Límite
              </span>
              <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
                <span className="font-mono-num text-2xl font-bold text-[#FAFAFA]">
                  {formatCurrency(summary.totalCommitted, currency)}
                </span>
                <span className="text-sm text-[#A3A3A3]">
                  {summary.fixedExpensesLimit > 0 ? (
                    <>
                      de{' '}
                      <span className="font-mono-num text-[#D4D4D4]">
                        {formatCurrency(summary.fixedExpensesLimit, currency)}
                      </span>
                    </>
                  ) : (
                    'Límite sin configurar'
                  )}
                </span>
              </div>
              {summary.gustitosInstallmentsTotal > 0 ? (
                <p className="mt-1 text-xs text-[#FACC15]">
                  Incluye además {formatCurrency(summary.gustitosInstallmentsTotal, currency)} en cuotas de Gustitos (descuentan de la Bolsa de Gustitos).
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {limitUsagePercent !== null ? (
                <Badge
                  variant={
                    summary.isOverFixedLimit
                      ? 'red'
                      : isCaution
                        ? 'yellow'
                        : 'neutral'
                  }
                >
                  {formatPercent(limitUsagePercent)} del límite
                </Badge>
              ) : (
                <Badge variant="neutral">Límite sin configurar</Badge>
              )}
              <Badge variant="neutral">
                Pendiente de abonar:{' '}
                <span className="font-mono-num ml-1">
                  {formatCurrency(summary.pendingCommitmentsTotal, currency)}
                </span>
              </Badge>
            </div>
          </div>

          {summary.fixedExpensesLimit > 0 ? (
            <div
              role="progressbar"
              aria-label="Uso del límite mensual de gastos fijos y cuotas"
              aria-valuenow={Math.round(barWidth)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={
                limitUsagePercent !== null
                  ? `${formatPercent(limitUsagePercent)} del límite mensual`
                  : undefined
              }
              className="h-2.5 w-full rounded-full bg-[#1F1F1F] overflow-hidden"
            >
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${barWidth}%`,
                  backgroundColor: summary.isOverFixedLimit ? '#EF4444' : '#FACC15',
                }}
              />
            </div>
          ) : null}

          {summary.isOverFixedLimit ? (
            <p className="text-sm font-medium text-[#F87171]">
              Alerta preventiva: superaste tu límite mensual de gastos fijos + cuotas en{' '}
              <span className="font-mono-num font-bold">
                {formatCurrency(excessAmount, currency)}
              </span>
              .
            </p>
          ) : null}
        </div>
      </Card>

      {/* Checklist mensual de pagos */}
      <section aria-labelledby="monthly-checklist-heading" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 id="monthly-checklist-heading" className="text-lg font-bold text-[#FAFAFA]">
              Checklist de Compromisos en {monthLabel}
            </h2>
            <p className="text-sm text-[#A3A3A3]">
              Tildar como pagado actualiza tu indicador &ldquo;Pendiente de Abonar&rdquo; sin cambiar tu Disponible Real.
            </p>
          </div>
          <span className="text-sm font-medium text-[#A3A3A3] shrink-0">
            {summary.pendingCommitmentsCount} de {summary.totalCommitmentsCount} pendientes
          </span>
        </div>

        {isDashboardLoading ? (
          <div className="h-32 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
        ) : commitments.length === 0 ? (
          <EmptyState
            title={`Sin compromisos registrados en ${monthLabel}`}
            description="Creá una plantilla de gasto fijo o registrá una compra en cuotas para ver tus vencimientos de este mes."
            actionLabel="Crear gasto fijo"
            onAction={() => {
              setEditingTemplate(null);
              setIsFixedModalOpen(true);
            }}
          />
        ) : (
          <Card padding="none">
            <div className="divide-y divide-[#1F1F1F]">
              {commitments.map((item) => {
                const isBusy = togglingId === item.id;
                const snap = snapshotByCatId.get(item.category_id);
                const isCategoryGustitoInMonth = snap
                  ? snap.is_gustito
                  : !hasMonthSnapshots
                    ? Boolean(item.category?.is_gustito)
                    : false;
                const isGustitoInstallment =
                  item.commitment_type === 'installment' &&
                  (Boolean(item.installment_purchase?.is_gustito) ||
                    isCategoryGustitoInMonth);
                return (
                  <div
                    key={item.id}
                    className="px-4 py-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                  >
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={[
                            'text-[15px] font-semibold',
                            item.is_paid
                              ? 'text-[#A3A3A3] line-through'
                              : 'text-[#FAFAFA]',
                          ].join(' ')}
                        >
                          {item.name}
                        </span>
                        <Badge
                          variant={
                            item.commitment_type === 'installment'
                              ? 'yellow'
                              : 'neutral'
                          }
                        >
                          {item.commitment_type === 'installment'
                            ? 'Cuota'
                            : 'Gasto Fijo'}
                        </Badge>
                        {isGustitoInstallment ? (
                          <Badge variant="yellow">Gustito</Badge>
                        ) : null}
                        <Badge variant={item.is_paid ? 'green' : 'neutral'}>
                          {item.is_paid ? 'Pagado' : 'Pendiente'}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-[13px] text-[#A3A3A3]">
                        <span>{item.category?.name ?? 'Sin categoría'}</span>
                        {item.due_date ? (
                          <span>Vence: {formatShortDate(item.due_date)}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 sm:justify-end">
                      <span className="font-mono-num text-base font-bold text-[#FAFAFA] mr-1">
                        {formatCurrency(item.amount, currency)}
                      </span>

                      {item.commitment_type === 'fixed_expense' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openAdjustAmountModal(item)}
                        >
                          Ajustar mes
                        </Button>
                      ) : null}

                      <Button
                        variant={item.is_paid ? 'secondary' : 'primary'}
                        size="sm"
                        onClick={() => void handleTogglePaid(item)}
                        isLoading={isBusy}
                      >
                        {item.is_paid ? 'Marcar pendiente' : 'Marcar como pagado'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </section>

      {/* Plantillas de gastos fijos */}
      {user ? (
        isLoadingLists ? (
          <div className="h-40 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
        ) : (
          <FixedExpensesList
            userId={user.id}
            currentCalendarMonth={currentCalendarMonth}
            templates={templates}
            monthCommitments={commitments}
            currency={currency}
            onNewTemplate={() => {
              setEditingTemplate(null);
              setIsFixedModalOpen(true);
            }}
            onEditTemplate={(tpl) => {
              setEditingTemplate(tpl);
              setIsFixedModalOpen(true);
            }}
            onRefresh={refreshAll}
          />
        )
      ) : null}

      {/* Compras en cuotas */}
      {!isLoadingLists ? (
        <InstallmentsList
          purchases={purchases}
          progressMap={progressMap}
          recentBatches={recentBatches}
          currency={currency}
          onNewPurchase={() => {
            setEditingPurchase(null);
            setIsInstallmentModalOpen(true);
          }}
          onEditPurchase={(purchase) => {
            setEditingPurchase(purchase);
            setIsInstallmentModalOpen(true);
          }}
          onRefresh={refreshAll}
        />
      ) : null}

      {/* Modales */}
      {user ? (
        <>
          <FixedExpenseFormModal
            isOpen={isFixedModalOpen}
            onClose={() => setIsFixedModalOpen(false)}
            userId={user.id}
            currentCalendarMonth={currentCalendarMonth}
            categories={categories}
            initialTemplate={editingTemplate}
            currentCommittedTotal={summary.totalCommitted}
            fixedExpensesLimit={summary.fixedExpensesLimit}
            currency={currency}
            onSaved={refreshAll}
          />

          <InstallmentFormModal
            isOpen={isInstallmentModalOpen}
            onClose={() => setIsInstallmentModalOpen(false)}
            userId={user.id}
            categories={categories}
            initialPurchase={editingPurchase}
            defaultLimit={userSettings?.fixed_expenses_limit ?? 0}
            currency={currency}
            onSaved={refreshAll}
          />
        </>
      ) : null}

      <Modal
        isOpen={Boolean(adjustingCommitment)}
        onClose={() => setAdjustingCommitment(null)}
        title="Ajustar monto solo para este mes"
        description={
          adjustingCommitment
            ? `Modificá el importe de "${adjustingCommitment.name}" únicamente en ${monthLabel}.`
            : undefined
        }
        size="sm"
      >
        <form onSubmit={handleSaveAdjustedAmount} noValidate className="flex flex-col gap-4">
          <InputField
            label={`Monto en ${monthLabel}`}
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            prefixText="$"
            value={adjustAmountValue}
            onChange={(e) => setAdjustAmountValue(e.target.value)}
            error={adjustError}
            hint="No altera el monto por defecto de la plantilla para los meses futuros."
            required
          />

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
            <Button
              variant="secondary"
              onClick={() => setAdjustingCommitment(null)}
              disabled={isAdjusting}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              isLoading={isAdjusting}
              loadingText="Guardando..."
            >
              Guardar monto del mes
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
