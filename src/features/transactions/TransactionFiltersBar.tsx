/**
 * Barra de filtros dinámicos para movimientos manuales (`TransactionFiltersBar`).
 *
 * Arquitectura y decisiones técnicas:
 * - Exportamos también la función pura `filterTransactions` desde este módulo para
 *   reutilizar exactamente la misma lógica de filtrado en `TransactionsPage` y en la
 *   tabla resumida de `DashboardPage` sin duplicar código.
 */
import type { Category, Transaction, TransactionFilters } from '../../types/database.types';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { SelectField } from '../../components/ui/SelectField';

export const EMPTY_TRANSACTION_FILTERS: TransactionFilters = {
  search: '',
  type: 'all',
  categoryId: 'all',
  dateFrom: '',
  dateTo: '',
};

export function filterTransactions(
  transactions: Transaction[],
  filters: TransactionFilters,
): Transaction[] {
  const normalizedSearch = filters.search.trim().toLowerCase();

  return transactions.filter((tx) => {
    if (filters.type !== 'all' && tx.type !== filters.type) {
      return false;
    }

    if (filters.categoryId !== 'all' && tx.category_id !== filters.categoryId) {
      return false;
    }

    if (filters.dateFrom && tx.transaction_date < filters.dateFrom) {
      return false;
    }

    if (filters.dateTo && tx.transaction_date > filters.dateTo) {
      return false;
    }

    if (normalizedSearch.length > 0) {
      const descriptionMatch = tx.description.toLowerCase().includes(normalizedSearch);
      const notesMatch = (tx.notes ?? '').toLowerCase().includes(normalizedSearch);
      const categoryMatch = (tx.category?.name ?? '').toLowerCase().includes(normalizedSearch);
      if (!descriptionMatch && !notesMatch && !categoryMatch) {
        return false;
      }
    }

    return true;
  });
}

export interface TransactionFiltersBarProps {
  filters: TransactionFilters;
  categories: Category[];
  monthMinDate?: string;
  monthMaxDate?: string;
  onChange: (next: TransactionFilters) => void;
}

export function TransactionFiltersBar({
  filters,
  categories,
  monthMinDate,
  monthMaxDate,
  onChange,
}: TransactionFiltersBarProps) {
  const hasActiveFilters =
    filters.search !== '' ||
    filters.type !== 'all' ||
    filters.categoryId !== 'all' ||
    filters.dateFrom !== '' ||
    filters.dateTo !== '';

  const filteredCategories =
    filters.type === 'all'
      ? categories
      : categories.filter((c) => c.type === filters.type);

  return (
    <div className="bg-[#121212] border border-[#262626] rounded-[8px] p-4 flex flex-col gap-3.5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <InputField
          label="Buscar movimiento"
          placeholder="Descripción, nota o categoría..."
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />

        <SelectField
          label="Tipo"
          value={filters.type}
          onChange={(e) =>
            onChange({
              ...filters,
              type: e.target.value as TransactionFilters['type'],
              categoryId: 'all',
            })
          }
          options={[
            { value: 'all', label: 'Todos' },
            { value: 'expense', label: 'Gastos variables' },
            { value: 'income', label: 'Ingresos extra' },
          ]}
        />

        <SelectField
          label="Categoría"
          value={filters.categoryId}
          onChange={(e) => onChange({ ...filters, categoryId: e.target.value })}
          options={[
            { value: 'all', label: 'Todas las categorías' },
            ...filteredCategories.map((c) => ({
              value: c.id,
              label: c.is_active ? c.name : `${c.name} (Archivada)`,
            })),
          ]}
        />

        <InputField
          label="Desde fecha"
          type="date"
          min={monthMinDate}
          max={monthMaxDate}
          value={filters.dateFrom}
          onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
        />

        <InputField
          label="Hasta fecha"
          type="date"
          min={monthMinDate}
          max={monthMaxDate}
          value={filters.dateTo}
          onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
        />
      </div>

      {hasActiveFilters ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(EMPTY_TRANSACTION_FILTERS)}
          >
            Limpiar filtros
          </Button>
        </div>
      ) : null}
    </div>
  );
}
