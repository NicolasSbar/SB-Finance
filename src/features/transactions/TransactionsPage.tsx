/**
 * Página dedicada de Movimientos Manuales y Compromisos Abonados (`TransactionsPage`).
 *
 * Arquitectura y decisiones técnicas:
 * - Permite navegar por mes, filtrar dinámicamente los movimientos del período,
 *   inspeccionar los totales filtrados al instante y crear/editar/eliminar movimientos
 *   con sincronización automática del Disponible Real.
 * - Muestra los compromisos mensuales pagados (`is_paid = true`) en modo solo lectura
 *   junto a los movimientos manuales, manteniendo intactos los totales de
 *   `Ingresos Extra` y `Gastos Variables` para evitar doble descuento.
 * - Accesibilidad y resiliencia: expone banner `role="alert"` con reintento
 *   explícito ante fallos de carga en lugar de ocultar el estado de error.
 */
import { useMemo, useState } from 'react';
import { MonthSelectorBar } from '../../components/layout/MonthSelectorBar';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardData } from '../../hooks/useDashboardData';
import { useMonthlyPeriod } from '../../hooks/useMonthlyPeriod';
import {
  formatCurrency,
  getMonthEndISODate,
  roundCurrency,
} from '../../lib/formatters';
import type { Transaction, TransactionFilters } from '../../types/database.types';
import {
  EMPTY_TRANSACTION_FILTERS,
  TransactionFiltersBar,
  filterTransactions,
} from './TransactionFiltersBar';
import { TransactionFormModal } from './TransactionFormModal';
import {
  TransactionsTable,
  filterPaidCommitments,
} from './TransactionsTable';

export function TransactionsPage() {
  const { user, userSettings } = useAuth();
  const { monthDate, monthLabel } = useMonthlyPeriod();
  const {
    commitments,
    transactions,
    categories,
    summary,
    isLoading,
    error,
    refresh,
  } = useDashboardData(undefined, {
    includeEvolution: false,
  });

  const [filters, setFilters] = useState<TransactionFilters>(
    EMPTY_TRANSACTION_FILTERS,
  );
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const currency = userSettings?.currency ?? 'ARS';
  const monthEnd = getMonthEndISODate(monthDate);

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

  const filteredTotals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const tx of filteredTransactions) {
      if (tx.type === 'income') {
        income = roundCurrency(income + tx.amount);
      } else {
        expense = roundCurrency(expense + tx.amount);
      }
    }
    return {
      income,
      expense,
      manualCount: filteredTransactions.length,
      paidCommitmentsCount: filteredPaidCommitments.length,
      visibleCount: filteredTransactions.length + filteredPaidCommitments.length,
    };
  }, [filteredTransactions, filteredPaidCommitments]);

  function openCreate(): void {
    setEditingTx(null);
    setIsModalOpen(true);
  }

  function openEdit(tx: Transaction): void {
    setEditingTx(tx);
    setIsModalOpen(true);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Movimientos de {monthLabel}
          </h1>
          <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
            Registrá tus gastos variables del día a día e ingresos adicionales fuera del sueldo fijo. Los fijos y cuotas pagados aparecen en modo solo lectura.
          </p>
        </div>

        <Button variant="primary" className="w-full sm:w-auto" onClick={openCreate}>
          + Nuevo movimiento
        </Button>
      </div>

      <MonthSelectorBar />

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

      {/* Resumen de los movimientos filtrados (totales variables sin mezclar compromisos abonados) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card padding="sm">
          <span className="text-[13px] text-[#A3A3A3]">Movimientos visibles</span>
          <p className="mt-1 font-mono-num text-xl font-bold text-[#FAFAFA]">
            {filteredTotals.visibleCount}
          </p>
          {filteredTotals.paidCommitmentsCount > 0 ? (
            <p className="mt-1 text-xs text-[#A3A3A3]">
              {filteredTotals.manualCount}{' '}
              {filteredTotals.manualCount === 1 ? 'manual' : 'manuales'} ·{' '}
              {filteredTotals.paidCommitmentsCount}{' '}
              {filteredTotals.paidCommitmentsCount === 1
                ? 'compromiso pagado'
                : 'compromisos pagados'}{' '}
              (solo lectura)
            </p>
          ) : null}
        </Card>
        <Card padding="sm">
          <span className="text-[13px] text-[#A3A3A3]">Ingresos Extra (filtrados)</span>
          <p className="mt-1 font-mono-num text-xl font-bold text-[#22C55E]">
            + {formatCurrency(filteredTotals.income, currency)}
          </p>
        </Card>
        <Card padding="sm">
          <span className="text-[13px] text-[#A3A3A3]">Gastos Variables (filtrados)</span>
          <p className="mt-1 font-mono-num text-xl font-bold text-[#EF4444]">
            - {formatCurrency(filteredTotals.expense, currency)}
          </p>
        </Card>
      </div>

      <section aria-labelledby="transactions-list-heading" className="flex flex-col gap-4">
        <h2 id="transactions-list-heading" className="sr-only">
          Listado de movimientos de {monthLabel}
        </h2>
        <TransactionFiltersBar
          filters={filters}
          categories={categories}
          monthMinDate={monthDate}
          monthMaxDate={monthEnd}
          onChange={setFilters}
        />

        {isLoading ? (
          <div className="h-48 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
        ) : error &&
          filteredTransactions.length === 0 &&
          filteredPaidCommitments.length === 0 ? null : (
          <TransactionsTable
            transactions={filteredTransactions}
            paidCommitments={filteredPaidCommitments}
            gustitoCategoryIds={gustitoCategoryIds}
            currency={currency}
            onEdit={openEdit}
            onCreateNew={openCreate}
            onDeleted={refresh}
          />
        )}
      </section>

      {user ? (
        <TransactionFormModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          userId={user.id}
          categories={categories}
          defaultMonthDate={monthDate}
          initialTransaction={editingTx}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}
