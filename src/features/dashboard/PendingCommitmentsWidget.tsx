/**
 * Widget interactivo de Compromisos del Mes en el Dashboard (`PendingCommitmentsWidget`).
 *
 * Arquitectura y decisiones técnicas:
 * - Permite marcar cualquier gasto fijo o cuota como `Pagado` o `Pendiente`
 *   directamente desde el Dashboard, manteniendo visibles las cuotas de Gustitos
 *   con su distintivo explícito (`Gustito`) para aclarar que descuentan de
 *   la Bolsa de Gustitos y no del límite de Fijos.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatCurrency, formatShortDate } from '../../lib/formatters';
import { toggleCommitmentPaidStatus } from '../../services/commitmentsService';
import type { MonthlyCommitment } from '../../types/database.types';

export interface PendingCommitmentsWidgetProps {
  commitments: MonthlyCommitment[];
  currency: string;
  monthLabel: string;
  gustitoCategoryIds?: Set<string>;
  onUpdated: () => Promise<void>;
}

export function PendingCommitmentsWidget({
  commitments,
  currency,
  monthLabel,
  gustitoCategoryIds,
  onUpdated,
}: PendingCommitmentsWidgetProps) {
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleToggle(item: MonthlyCommitment): Promise<void> {
    setBusyId(item.id);
    try {
      await toggleCommitmentPaidStatus(item.id, !item.is_paid);
      toast.success(
        !item.is_paid
          ? `"${item.name}" marcado como pagado.`
          : `"${item.name}" devuelto a pendiente.`,
      );
      await onUpdated();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo actualizar el pago.';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card padding="md" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-[#FAFAFA]">
            Compromisos de {monthLabel}
          </h2>
          <p className="text-sm text-[#A3A3A3]">
            Gastos fijos y cuotas del período (las cuotas de Gustitos descuentan de la Bolsa de Gustitos).
          </p>
        </div>

        <Link
          to="/commitments"
          className="inline-flex items-center min-h-[44px] px-2 -mx-2 text-sm font-semibold text-[#FACC15] hover:underline"
        >
          Gestionar o adelantar cuotas &rarr;
        </Link>
      </div>

      {commitments.length === 0 ? (
        <EmptyState
          title="Sin fijos ni cuotas este mes"
          description="Todavía no tenés obligaciones programadas para este período."
          actionLabel="Gestionar fijos y cuotas"
          onAction={() => navigate('/commitments')}
        />
      ) : (
        <div className="divide-y divide-[#1E1E1E] border border-[#222222] rounded-[6px] bg-[#0D0D0D]">
          {commitments.map((item) => {
            const isBusy = busyId === item.id;
            const isGustitoInstallment =
              item.commitment_type === 'installment' &&
              (Boolean(item.installment_purchase?.is_gustito) ||
                (gustitoCategoryIds
                  ? gustitoCategoryIds.has(item.category_id)
                  : Boolean(item.category?.is_gustito)));

            return (
              <div
                key={item.id}
                className="px-3.5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5"
              >
                <div className="min-w-0">
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
                      {item.commitment_type === 'installment' ? 'Cuota' : 'Fijo'}
                    </Badge>
                    {isGustitoInstallment ? (
                      <Badge variant="yellow">Gustito</Badge>
                    ) : null}
                    <Badge variant={item.is_paid ? 'green' : 'neutral'}>
                      {item.is_paid ? 'Pagado' : 'Pendiente'}
                    </Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2.5 text-[12px] text-[#A3A3A3]">
                    <span>{item.category?.name ?? 'Sin categoría'}</span>
                    {item.due_date ? (
                      <span>Vence {formatShortDate(item.due_date)}</span>
                    ) : null}
                    {isGustitoInstallment ? (
                      <span className="text-[#FACC15]">Descuenta de Gustitos</span>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                  <span className="font-mono-num text-[15px] font-bold text-[#FAFAFA]">
                    {formatCurrency(item.amount, currency)}
                  </span>
                  <Button
                    variant={item.is_paid ? 'secondary' : 'primary'}
                    size="sm"
                    onClick={() => void handleToggle(item)}
                    isLoading={isBusy}
                    loadingText="Actualizando..."
                  >
                    {item.is_paid ? 'Marcar pendiente' : 'Marcar como pagado'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
