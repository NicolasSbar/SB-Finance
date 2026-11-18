/**
 * Tabla responsiva de Movimientos Manuales y Compromisos Abonados (`TransactionsTable`).
 *
 * Arquitectura y decisiones técnicas:
 * - En pantallas medianas/grandes renderiza tabla contable con cifras en `tabular-nums`,
 *   encabezados semánticos `scope="col"` y atributos `title` en textos truncados;
 *   en pantallas móviles (`< 768px`) cambia a tarjetas apiladas para garantizar cero
 *   scroll horizontal en 390px y 320px.
 * - Intercala cronológicamente los compromisos mensuales pagados (`monthly_commitments`
 *   con `is_paid = true`) en modo solo lectura con badge `Cuota pagada` / `Fijo pagado`
 *   y enlace directo a `/commitments`, evitando insertarlos en `transactions` y
 *   preservando intactos los totales de Gastos Variables.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button, linkButtonClasses } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { formatCurrency, formatShortDate, toLocalISODate } from '../../lib/formatters';
import { deleteTransaction } from '../../services/transactionsService';
import type {
  MonthlyCommitment,
  Transaction,
  TransactionFilters,
} from '../../types/database.types';

export function getPaidCommitmentDisplayDate(commitment: MonthlyCommitment): string {
  if (commitment.paid_at) {
    const parsed = new Date(commitment.paid_at);
    if (Number.isFinite(parsed.getTime())) {
      return toLocalISODate(parsed);
    }
  }
  return commitment.due_date ?? commitment.month_date;
}

export function filterPaidCommitments(
  commitments: MonthlyCommitment[],
  filters: TransactionFilters,
): MonthlyCommitment[] {
  if (filters.type === 'income') {
    return [];
  }

  const normalizedSearch = filters.search.trim().toLowerCase();

  return commitments.filter((commitment) => {
    if (!commitment.is_paid) {
      return false;
    }

    if (filters.categoryId !== 'all' && commitment.category_id !== filters.categoryId) {
      return false;
    }

    const displayDate = getPaidCommitmentDisplayDate(commitment);
    if (filters.dateFrom && displayDate < filters.dateFrom) {
      return false;
    }
    if (filters.dateTo && displayDate > filters.dateTo) {
      return false;
    }

    if (normalizedSearch.length > 0) {
      const nameMatch = commitment.name.toLowerCase().includes(normalizedSearch);
      const notesMatch = (commitment.notes ?? '').toLowerCase().includes(normalizedSearch);
      const categoryMatch = (commitment.category?.name ?? '')
        .toLowerCase()
        .includes(normalizedSearch);
      const typeLabel =
        commitment.commitment_type === 'installment' ? 'cuota pagada' : 'fijo pagado';
      const typeMatch = typeLabel.includes(normalizedSearch);
      if (!nameMatch && !notesMatch && !categoryMatch && !typeMatch) {
        return false;
      }
    }

    return true;
  });
}

type MovementRow =
  | {
      kind: 'transaction';
      sortDate: string;
      sortTimeMs: number;
      transaction: Transaction;
    }
  | {
      kind: 'commitment';
      sortDate: string;
      sortTimeMs: number;
      commitment: MonthlyCommitment;
    };

export interface TransactionsTableProps {
  transactions: Transaction[];
  paidCommitments?: MonthlyCommitment[];
  gustitoCategoryIds?: Set<string>;
  currency: string;
  onEdit: (tx: Transaction) => void;
  onCreateNew?: () => void;
  onDeleted: () => Promise<void>;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function TransactionsTable({
  transactions,
  paidCommitments = [],
  gustitoCategoryIds,
  currency,
  onEdit,
  onCreateNew,
  onDeleted,
  emptyTitle = 'No hay movimientos para mostrar',
  emptyDescription = 'Registrá un gasto variable o ingreso extra, o ajustá los filtros activos.',
}: TransactionsTableProps) {
  const [deletingTarget, setDeletingTarget] = useState<Transaction | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const rows = useMemo<MovementRow[]>(() => {
    const merged: MovementRow[] = [
      ...transactions.map((tx): MovementRow => ({
        kind: 'transaction',
        sortDate: tx.transaction_date,
        sortTimeMs: Date.parse(tx.created_at) || 0,
        transaction: tx,
      })),
      ...paidCommitments
        .filter((commitment) => commitment.is_paid)
        .map((commitment): MovementRow => ({
          kind: 'commitment',
          sortDate: getPaidCommitmentDisplayDate(commitment),
          sortTimeMs:
            Date.parse(commitment.paid_at ?? commitment.updated_at ?? commitment.created_at) ||
            0,
          commitment,
        })),
    ];

    merged.sort((a, b) => {
      const dateCmp = b.sortDate.localeCompare(a.sortDate);
      if (dateCmp !== 0) return dateCmp;
      return b.sortTimeMs - a.sortTimeMs;
    });

    return merged;
  }, [transactions, paidCommitments]);

  async function handleConfirmDelete(): Promise<void> {
    if (!deletingTarget) return;
    setIsDeleting(true);
    try {
      await deleteTransaction(deletingTarget.id);
      toast.success('Movimiento eliminado.');
      setDeletingTarget(null);
      await onDeleted();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo eliminar el movimiento.';
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        actionLabel={onCreateNew ? 'Registrar movimiento' : undefined}
        onAction={onCreateNew}
      />
    );
  }

  return (
    <>
      {/* Vista Desktop / Tablet */}
      <Card padding="none" className="hidden md:block overflow-hidden">
        <div className="overflow-x-auto">
          <table
            aria-label="Tabla de movimientos variables, ingresos extra y compromisos abonados"
            className="w-full text-left border-collapse"
          >
            <thead>
              <tr className="border-b border-[#262626] bg-[#0F0F0F] text-[13px] font-semibold text-[#A3A3A3]">
                <th scope="col" className="py-3.5 px-4">
                  Fecha
                </th>
                <th scope="col" className="py-3.5 px-4">
                  Descripción
                </th>
                <th scope="col" className="py-3.5 px-4">
                  Categoría
                </th>
                <th scope="col" className="py-3.5 px-4">
                  Tipo
                </th>
                <th scope="col" className="py-3.5 px-4 text-right">
                  Monto
                </th>
                <th scope="col" className="py-3.5 px-4 text-right">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E1E1E] text-[15px]">
              {rows.map((row) => {
                if (row.kind === 'commitment') {
                  const { commitment } = row;
                  const catName = commitment.category?.name ?? 'Sin categoría';
                  const isCatArchived = commitment.category
                    ? !commitment.category.is_active
                    : false;
                  const isInstallment = commitment.commitment_type === 'installment';
                  const isGustitoCommitment =
                    isInstallment &&
                    (Boolean(commitment.installment_purchase?.is_gustito) ||
                      (gustitoCategoryIds
                        ? gustitoCategoryIds.has(commitment.category_id)
                        : Boolean(commitment.category?.is_gustito)));
                  const isFromTelegram =
                    commitment.installment_purchase?.source === 'telegram';

                  return (
                    <tr
                      key={`commitment-${commitment.id}`}
                      className="bg-[#0C0C0C] hover:bg-[#171717] transition-colors"
                    >
                      <td className="py-3.5 px-4 font-mono-num text-sm text-[#D4D4D4] whitespace-nowrap">
                        {formatShortDate(row.sortDate)}
                      </td>
                      <td className="py-3.5 px-4">
                        <p className="font-semibold text-[#FAFAFA]">{commitment.name}</p>
                        {commitment.notes ? (
                          <p
                            title={commitment.notes}
                            className="text-[13px] text-[#A3A3A3] mt-0.5 line-clamp-1"
                          >
                            {commitment.notes}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <Badge variant="neutral">
                          {isCatArchived ? `${catName} (Archivada)` : catName}
                        </Badge>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="neutral">
                            {isInstallment ? 'Cuota pagada' : 'Fijo pagado'}
                          </Badge>
                          {isGustitoCommitment ? (
                            <Badge variant="yellow">Gustito</Badge>
                          ) : null}
                          {isFromTelegram ? (
                            <Badge variant="neutral">Telegram</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono-num font-bold text-[#FAFAFA] whitespace-nowrap">
                        - {formatCurrency(commitment.amount, currency)}
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <Link
                          to="/commitments"
                          className={linkButtonClasses(
                            'ghost',
                            'sm',
                            'text-[#FACC15] hover:text-[#FDE047]',
                          )}
                          aria-label={`Gestionar ${commitment.name} en Fijos y Cuotas`}
                          title="Gestionar o revertir pago en Fijos y Cuotas"
                        >
                          Fijos y Cuotas <span aria-hidden="true">&rarr;</span>
                        </Link>
                      </td>
                    </tr>
                  );
                }

                const { transaction: tx } = row;
                const isIncome = tx.type === 'income';
                const catName = tx.category?.name ?? 'Sin categoría';
                const isCatArchived = tx.category ? !tx.category.is_active : false;
                const isGustitoTx =
                  !isIncome &&
                  (Boolean(tx.is_gustito) || Boolean(tx.category?.is_gustito));
                const isSavedToVault = isIncome && Boolean(tx.save_to_savings);
                const isFromTelegram = tx.source === 'telegram';

                return (
                  <tr
                    key={tx.id}
                    className="hover:bg-[#171717] transition-colors"
                  >
                    <td className="py-3.5 px-4 font-mono-num text-sm text-[#D4D4D4] whitespace-nowrap">
                      {formatShortDate(tx.transaction_date)}
                    </td>
                    <td className="py-3.5 px-4">
                      <p className="font-semibold text-[#FAFAFA]">{tx.description}</p>
                      {tx.notes ? (
                        <p
                          title={tx.notes}
                          className="text-[13px] text-[#A3A3A3] mt-0.5 line-clamp-1"
                        >
                          {tx.notes}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <Badge variant="neutral">
                        {isCatArchived ? `${catName} (Archivada)` : catName}
                      </Badge>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={isIncome ? 'green' : 'red'}>
                          {isIncome ? 'Ingreso Extra' : 'Gasto Variable'}
                        </Badge>
                        {isSavedToVault ? (
                          <Badge variant="yellow">Ahorro</Badge>
                        ) : null}
                        {isGustitoTx ? <Badge variant="yellow">Gustito</Badge> : null}
                        {isFromTelegram ? (
                          <Badge variant="neutral">Telegram</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className={[
                        'py-3.5 px-4 text-right font-mono-num font-bold whitespace-nowrap',
                        isIncome ? 'text-[#22C55E]' : 'text-[#FAFAFA]',
                      ].join(' ')}
                    >
                      {isIncome ? '+' : '-'}{' '}
                      {formatCurrency(tx.amount, currency)}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Editar ${tx.description}`}
                          onClick={() => onEdit(tx)}
                        >
                          Editar
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          aria-label={`Eliminar ${tx.description}`}
                          onClick={() => setDeletingTarget(tx)}
                        >
                          Eliminar
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Vista Mobile (< 768px) */}
      <div className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => {
          if (row.kind === 'commitment') {
            const { commitment } = row;
            const catName = commitment.category?.name ?? 'Sin categoría';
            const isCatArchived = commitment.category
              ? !commitment.category.is_active
              : false;
            const isInstallment = commitment.commitment_type === 'installment';
            const isGustitoCommitment =
              isInstallment &&
              (Boolean(commitment.installment_purchase?.is_gustito) ||
                (gustitoCategoryIds
                  ? gustitoCategoryIds.has(commitment.category_id)
                  : Boolean(commitment.category?.is_gustito)));
            const isFromTelegram =
              commitment.installment_purchase?.source === 'telegram';

            return (
              <Card key={`commitment-${commitment.id}`} padding="sm">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p
                        title={commitment.name}
                        className="text-[15px] font-bold text-[#FAFAFA] truncate"
                      >
                        {commitment.name}
                      </p>
                      <p className="text-[13px] font-mono-num text-[#A3A3A3]">
                        {formatShortDate(row.sortDate)}
                      </p>
                    </div>
                    <span className="font-mono-num text-base font-bold text-[#FAFAFA] shrink-0">
                      - {formatCurrency(commitment.amount, currency)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="neutral">
                      {isInstallment ? 'Cuota pagada' : 'Fijo pagado'}
                    </Badge>
                    <Badge variant="neutral">
                      {isCatArchived ? `${catName} (Archivada)` : catName}
                    </Badge>
                    {isGustitoCommitment ? (
                      <Badge variant="yellow">Gustito</Badge>
                    ) : null}
                    {isFromTelegram ? (
                      <Badge variant="neutral">Telegram</Badge>
                    ) : null}
                  </div>

                  {commitment.notes ? (
                    <p className="text-[13px] text-[#A3A3A3]">{commitment.notes}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#1F1F1F]">
                    <span className="text-xs text-[#A3A3A3]">Solo lectura</span>
                    <Link
                      to="/commitments"
                      className={linkButtonClasses(
                        'secondary',
                        'sm',
                        'text-[#FACC15] hover:border-[#FACC15]/50',
                      )}
                      aria-label={`Gestionar ${commitment.name} en Fijos y Cuotas`}
                    >
                      Ir a Fijos y Cuotas <span aria-hidden="true">&rarr;</span>
                    </Link>
                  </div>
                </div>
              </Card>
            );
          }

          const { transaction: tx } = row;
          const isIncome = tx.type === 'income';
          const catName = tx.category?.name ?? 'Sin categoría';
          const isCatArchived = tx.category ? !tx.category.is_active : false;
          const isGustitoTx =
            !isIncome &&
            (Boolean(tx.is_gustito) || Boolean(tx.category?.is_gustito));
          const isSavedToVault = isIncome && Boolean(tx.save_to_savings);
          const isFromTelegram = tx.source === 'telegram';

          return (
            <Card key={tx.id} padding="sm">
              <div className="flex flex-col gap-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p
                      title={tx.description}
                      className="text-[15px] font-bold text-[#FAFAFA] truncate"
                    >
                      {tx.description}
                    </p>
                    <p className="text-[13px] font-mono-num text-[#A3A3A3]">
                      {formatShortDate(tx.transaction_date)}
                    </p>
                  </div>
                  <span
                    className={[
                      'font-mono-num text-base font-bold shrink-0',
                      isIncome ? 'text-[#22C55E]' : 'text-[#FAFAFA]',
                    ].join(' ')}
                  >
                    {isIncome ? '+' : '-'} {formatCurrency(tx.amount, currency)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={isIncome ? 'green' : 'red'}>
                    {isIncome ? 'Ingreso Extra' : 'Gasto Variable'}
                  </Badge>
                  <Badge variant="neutral">
                    {isCatArchived ? `${catName} (Archivada)` : catName}
                  </Badge>
                  {isSavedToVault ? <Badge variant="yellow">Ahorro</Badge> : null}
                  {isGustitoTx ? <Badge variant="yellow">Gustito</Badge> : null}
                  {isFromTelegram ? (
                    <Badge variant="neutral">Telegram</Badge>
                  ) : null}
                </div>

                {tx.notes ? (
                  <p className="text-[13px] text-[#A3A3A3]">{tx.notes}</p>
                ) : null}

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#1F1F1F]">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Editar ${tx.description}`}
                    onClick={() => onEdit(tx)}
                  >
                    Editar
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    aria-label={`Eliminar ${tx.description}`}
                    onClick={() => setDeletingTarget(tx)}
                  >
                    Eliminar
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Modal
        isOpen={Boolean(deletingTarget)}
        onClose={() => setDeletingTarget(null)}
        title="Eliminar movimiento"
        description={
          deletingTarget
            ? `¿Confirmás eliminar "${deletingTarget.description}" por ${formatCurrency(deletingTarget.amount, currency)}?`
            : undefined
        }
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#D4D4D4]">
            El Disponible Real del mes se recalculará automáticamente al eliminar este registro.
          </p>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
            <Button
              variant="secondary"
              onClick={() => setDeletingTarget(null)}
              disabled={isDeleting}
            >
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleConfirmDelete()}
              isLoading={isDeleting}
              loadingText="Eliminando..."
            >
              Eliminar movimiento
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
