/**
 * Listado de Compras en Cuotas con barra de avance, adelanto de N cuotas,
 * reversión por lote y anulación en cascada (`InstallmentsList`).
 *
 * Arquitectura y decisiones técnicas:
 * - Adelanto y reversión atómica desde Web: permite adelantar `N` cuotas
 *   pendientes mediante `AdvanceInstallmentsModal` y deshacer inmediatamente el último
 *   lote adelantado (`revert_installment_payment_batch`) sin recargar la página.
 * - Antes de anular una compra completa, consultamos cuántas cuotas ya figuran como
 *   `Pagado` y mostramos una confirmación explícita advirtiendo la eliminación en cascada.
 */
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import {
  calculateLastInstallmentMonthLabel,
  formatCurrency,
  formatMonthLabel,
  formatShortDate,
  toMonthStartISODate,
} from '../../lib/formatters';
import {
  deleteInstallmentPurchase,
  getPaidInstallmentsCount,
  revertInstallmentPaymentBatch,
} from '../../services/commitmentsService';
import type {
  InstallmentPaymentBatch,
  InstallmentProgressSummary,
  InstallmentPurchase,
} from '../../types/database.types';
import { AdvanceInstallmentsModal } from './AdvanceInstallmentsModal';

export interface InstallmentsListProps {
  purchases: InstallmentPurchase[];
  progressMap: Record<string, InstallmentProgressSummary>;
  recentBatches?: InstallmentPaymentBatch[];
  currency: string;
  onNewPurchase: () => void;
  onEditPurchase: (purchase: InstallmentPurchase) => void;
  onRefresh: () => Promise<void>;
}

interface CancelConfirmationState {
  purchase: InstallmentPurchase;
  paidCount: number;
}

export function InstallmentsList({
  purchases,
  progressMap,
  recentBatches = [],
  currency,
  onNewPurchase,
  onEditPurchase,
  onRefresh,
}: InstallmentsListProps) {
  const [confirmState, setConfirmState] = useState<CancelConfirmationState | null>(
    null,
  );
  const [advancingPurchase, setAdvancingPurchase] =
    useState<InstallmentPurchase | null>(null);
  const [revertingBatchId, setRevertingBatchId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const latestBatchByPurchase = useMemo(() => {
    const map = new Map<string, InstallmentPaymentBatch>();
    for (const batch of recentBatches) {
      if (batch.reverted_at !== null) continue;
      if (!map.has(batch.installment_purchase_id)) {
        map.set(batch.installment_purchase_id, batch);
      }
    }
    return map;
  }, [recentBatches]);

  async function handleOpenCancelModal(purchase: InstallmentPurchase): Promise<void> {
    setCheckingId(purchase.id);
    try {
      const paidCount = await getPaidInstallmentsCount(purchase.id);
      setConfirmState({ purchase, paidCount });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo consultar el estado de las cuotas.';
      toast.error(msg);
    } finally {
      setCheckingId(null);
    }
  }

  async function handleConfirmDelete(): Promise<void> {
    if (!confirmState) return;
    setIsDeleting(true);
    try {
      await deleteInstallmentPurchase(confirmState.purchase.id);
      toast.success(
        `Compra "${confirmState.purchase.description}" y sus ${confirmState.purchase.installments_count} cuota(s) anuladas.`,
      );
      setConfirmState(null);
      await onRefresh();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo anular la compra.';
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleRevertBatch(
    batch: InstallmentPaymentBatch,
    purchaseTitle: string,
  ): Promise<void> {
    setRevertingBatchId(batch.id);
    try {
      const res = await revertInstallmentPaymentBatch(batch.id);
      if (res.reverted) {
        toast.success(
          `Adelanto de "${purchaseTitle}" deshecho (${res.restored_count ?? batch.installments_count} cuota(s) devuelta(s) a pendiente).`,
        );
      } else {
        toast('El adelanto ya había sido revertido previamente.');
      }
      await onRefresh();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo deshacer el adelanto.';
      toast.error(msg);
    } finally {
      setRevertingBatchId(null);
    }
  }

  return (
    <section aria-labelledby="installments-heading" className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 id="installments-heading" className="text-lg font-bold text-[#FAFAFA]">
            Compras en Cuotas
          </h2>
          <p className="text-sm text-[#A3A3A3]">
            Plan de cuotas pre-generadas mes a mes. Podés adelantar cuotas pendientes o revertir un adelanto reciente.
          </p>
        </div>

        <Button variant="primary" size="sm" onClick={onNewPurchase}>
          + Nueva compra en cuotas
        </Button>
      </div>

      {purchases.length === 0 ? (
        <EmptyState
          title="No tenés compras en cuotas registradas"
          description="Cargá compras financiadas indicando la fecha de la 1.ª cuota y cantidad de cuotas para ver su impacto mes a mes."
          actionLabel="Registrar compra en cuotas"
          onAction={onNewPurchase}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {purchases.map((purchase) => {
            const progress = progressMap[purchase.id] ?? {
              purchaseId: purchase.id,
              paidCount: 0,
              totalCount: purchase.installments_count,
            };
            const pendingCount = Math.max(
              0,
              progress.totalCount - progress.paidCount,
            );
            const percent =
              progress.totalCount > 0
                ? Math.min(100, Math.round((progress.paidCount / progress.totalCount) * 100))
                : 0;
            const isFinished =
              progress.totalCount > 0 && progress.paidCount >= progress.totalCount;

            const startMonth = formatMonthLabel(
              toMonthStartISODate(purchase.first_installment_date),
            );
            const endMonth = calculateLastInstallmentMonthLabel(
              purchase.first_installment_date,
              purchase.installments_count,
            );
            const isGustitoPurchase =
              Boolean(purchase.is_gustito) || Boolean(purchase.category?.is_gustito);
            const isFromTelegram = purchase.source === 'telegram';
            const latestBatch = latestBatchByPurchase.get(purchase.id);

            return (
              <Card key={purchase.id} padding="md" interactive>
                <div className="flex flex-col gap-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-[#FAFAFA] truncate">
                        {purchase.description}
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="neutral">
                          {purchase.category?.name ?? 'Sin categoría'}
                        </Badge>
                        <Badge variant={isFinished ? 'green' : 'yellow'}>
                          {progress.paidCount}/{progress.totalCount} pagadas
                        </Badge>
                        {isGustitoPurchase ? (
                          <Badge variant="yellow">Gustito</Badge>
                        ) : null}
                        {isFromTelegram ? (
                          <Badge variant="neutral">Telegram</Badge>
                        ) : null}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="font-mono-num text-lg font-bold text-[#FAFAFA] block">
                        {formatCurrency(purchase.installment_amount, currency)}
                      </span>
                      <span className="text-[12px] text-[#A3A3A3]">por cuota</span>
                    </div>
                  </div>

                  {/* Barra de avance de cuotas */}
                  <div className="flex flex-col gap-1.5">
                    <div
                      role="progressbar"
                      aria-label={`Avance de cuotas de ${purchase.description}`}
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="h-2 w-full rounded-full bg-[#1F1F1F] overflow-hidden"
                    >
                      <div
                        className="h-full transition-all duration-300"
                        style={{
                          width: `${percent}%`,
                          backgroundColor: isFinished ? '#22C55E' : '#FACC15',
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#A3A3A3]">
                      <span>
                        Total:{' '}
                        <strong className="font-mono-num text-[#D4D4D4]">
                          {formatCurrency(purchase.total_amount, currency)}
                        </strong>
                      </span>
                      <span>
                        {purchase.installments_count === 1
                          ? startMonth
                          : `${startMonth} — ${endMonth}`}
                      </span>
                    </div>
                    <span className="text-[12px] text-[#A3A3A3]">
                      Compra: {formatShortDate(purchase.purchase_date)} · 1.ª cuota:{' '}
                      {formatShortDate(purchase.first_installment_date)}
                    </span>
                  </div>

                  {latestBatch ? (
                    <div className="rounded-[6px] border border-[#FACC15]/35 bg-[#FACC15]/8 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-[#D4D4D4]">
                        Adelanto reciente:{' '}
                        <strong className="text-[#FAFAFA]">
                          {latestBatch.installments_count} cuota(s)
                        </strong>{' '}
                        ({formatCurrency(latestBatch.total_paid_amount, currency)})
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void handleRevertBatch(latestBatch, purchase.description)
                        }
                        isLoading={revertingBatchId === latestBatch.id}
                        loadingText="Revirtiendo..."
                      >
                        Deshacer último adelanto
                      </Button>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#1F1F1F]">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onEditPurchase(purchase)}
                      >
                        Editar compra
                      </Button>

                      {pendingCount >= 1 ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => setAdvancingPurchase(purchase)}
                        >
                          Adelantar cuotas
                        </Button>
                      ) : null}
                    </div>

                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void handleOpenCancelModal(purchase)}
                      isLoading={checkingId === purchase.id}
                    >
                      Anular compra
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal de adelanto de N cuotas */}
      <AdvanceInstallmentsModal
        isOpen={Boolean(advancingPurchase)}
        onClose={() => setAdvancingPurchase(null)}
        purchase={advancingPurchase}
        currency={currency}
        onCompleted={onRefresh}
      />

      {/* Modal de confirmación de anulación en cascada */}
      <Modal
        isOpen={Boolean(confirmState)}
        onClose={() => setConfirmState(null)}
        title="Anular compra en cuotas"
        description={
          confirmState
            ? `Vas a anular "${confirmState.purchase.description}".`
            : undefined
        }
        size="sm"
      >
        {confirmState ? (
          <div className="flex flex-col gap-4">
            {confirmState.paidCount > 0 ? (
              <div className="rounded-[6px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-3.5 text-sm text-[#FAFAFA]">
                <strong className="text-[#F87171]">Atención:</strong> Esta compra tiene{' '}
                <strong>{confirmState.paidCount}</strong> cuota(s) ya marcada(s) como pagada(s). Si la anulás, se eliminarán todas las{' '}
                <strong>{confirmState.purchase.installments_count}</strong> cuotas del historial de sus meses correspondientes.
              </div>
            ) : (
              <p className="text-sm text-[#D4D4D4] leading-relaxed">
                Se eliminará la compra y todas sus{' '}
                <strong className="text-[#FAFAFA]">
                  {confirmState.purchase.installments_count}
                </strong>{' '}
                cuotas programadas en los meses futuros. Esta acción no se puede deshacer.
              </p>
            )}

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
              <Button
                variant="secondary"
                onClick={() => setConfirmState(null)}
                disabled={isDeleting}
              >
                Cancelar
              </Button>
              <Button
                variant="danger"
                onClick={() => void handleConfirmDelete()}
                isLoading={isDeleting}
                loadingText="Anulando..."
              >
                Confirmar anulación
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
