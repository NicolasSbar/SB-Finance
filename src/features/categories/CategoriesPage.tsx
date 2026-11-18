/**
 * Página de gestión de Categorías (Gastos e Ingresos) con Borrado Lógico,
 * pertenencia a bolsa de Gustitos y progreso de límites mensuales.
 *
 * Arquitectura y decisiones técnicas:
 * - Divide la vista en dos pestañas claras ("Categorías de Gastos" y "Categorías de
 *   Ingresos") e incluye un interruptor para inspeccionar y restaurar categorías
 *   archivadas (`is_active = false`), manteniendo intacto todo historial.
 * - Muestra el consumo del mes calendario actual contra `monthly_limit` usando los
 *   mismos cálculos consolidados de `useDashboardData`.
 * - Integra `PageSubnav` (`group="tools"`) para alternar en 1 clic entre los módulos
 *   de Herramientas (`Asistente IA ↔ Categorías ↔ Configuración`).
 * - Accesibilidad y resiliencia: usa `useRovingTabs` (WAI-ARIA Tabs con flechas,
 *   `Home` y `End`) y expone banner `role="alert"` con reintento explícito si falla la carga.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { PageSubnav } from '../../components/layout/PageSubnav';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardData } from '../../hooks/useDashboardData';
import { useRovingTabs } from '../../hooks/useRovingTabs';
import { formatCurrency, formatPercent, toMonthStartISODate } from '../../lib/formatters';
import {
  archiveCategory,
  getCategories,
  restoreCategory,
} from '../../services/categoriesService';
import type { Category, TransactionType } from '../../types/database.types';
import { CategoryFormModal, CategoryIcon } from './CategoryFormModal';

const CATEGORY_TABS: readonly TransactionType[] = ['expense', 'income'];

export function CategoriesPage() {
  const { user, userSettings } = useAuth();
  const currentCalendarMonth = toMonthStartISODate(new Date());
  const { summary, refresh: refreshDashboard } = useDashboardData(currentCalendarMonth, {
    includeEvolution: false,
  });

  const [categories, setCategories] = useState<Category[]>([]);
  const [activeTab, setActiveTab] = useState<TransactionType>('expense');
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);

  const { getTabListProps, getTabProps, getPanelProps } =
    useRovingTabs<TransactionType>({
      tabs: CATEGORY_TABS,
      activeTab,
      onChange: setActiveTab,
      orientation: 'horizontal',
      idPrefix: 'categories',
    });

  const currency = userSettings?.currency ?? 'ARS';

  const loadCategories = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getCategories({ includeInactive: true });
      setCategories(data);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudieron cargar las categorías.';
      setError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const handleSavedCategory = useCallback(async () => {
    await Promise.all([loadCategories(), refreshDashboard()]);
  }, [loadCategories, refreshDashboard]);

  const limitProgressByCatId = useMemo(() => {
    const map = new Map<string, (typeof summary.categoryLimits)[number]>();
    for (const item of summary.categoryLimits) {
      map.set(item.categoryId, item);
    }
    return map;
  }, [summary.categoryLimits]);

  const filteredCategories = useMemo(() => {
    return categories.filter((cat) => {
      if (cat.type !== activeTab) return false;
      if (!showArchived && !cat.is_active) return false;
      return true;
    });
  }, [categories, activeTab, showArchived]);

  const counts = useMemo(() => {
    const expenseActive = categories.filter(
      (c) => c.type === 'expense' && c.is_active,
    ).length;
    const incomeActive = categories.filter(
      (c) => c.type === 'income' && c.is_active,
    ).length;
    const archivedInTab = categories.filter(
      (c) => c.type === activeTab && !c.is_active,
    ).length;
    return { expenseActive, incomeActive, archivedInTab };
  }, [categories, activeTab]);

  async function handleArchive(cat: Category): Promise<void> {
    setProcessingId(cat.id);
    try {
      await archiveCategory(cat.id);
      toast.success(
        `Categoría "${cat.name}" archivada. Tus movimientos históricos se mantienen intactos.`,
      );
      await loadCategories();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo archivar la categoría.';
      toast.error(msg);
    } finally {
      setProcessingId(null);
    }
  }

  async function handleRestore(cat: Category): Promise<void> {
    setProcessingId(cat.id);
    try {
      await restoreCategory(cat.id);
      toast.success(`Categoría "${cat.name}" restaurada.`);
      await loadCategories();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo restaurar la categoría.';
      toast.error(msg);
    } finally {
      setProcessingId(null);
    }
  }

  function openCreateModal(): void {
    setEditingCategory(null);
    setIsModalOpen(true);
  }

  function openEditModal(cat: Category): void {
    setEditingCategory(cat);
    setIsModalOpen(true);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageSubnav group="tools" />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Categorías
          </h1>
          <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
            Organizá tus categorías de gastos e ingresos. Archivar una categoría la oculta de nuevos formularios sin borrar tu historial.
          </p>
        </div>

        <Button variant="primary" className="w-full sm:w-auto" onClick={openCreateModal}>
          + Nueva categoría
        </Button>
      </div>

      {/* Selector de pestañas y filtro de archivadas */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-[#262626] pb-4">
        <div
          {...getTabListProps('Tipo de categoría')}
          className="grid grid-cols-2 w-full sm:w-auto sm:inline-flex rounded-[6px] bg-[#121212] border border-[#262626] p-1"
        >
          <button
            {...getTabProps('expense')}
            className={[
              'min-h-[44px] px-2.5 sm:px-4 rounded-[4px] text-xs sm:text-sm font-semibold transition-colors cursor-pointer text-center',
              activeTab === 'expense'
                ? 'bg-[#FACC15] text-[#0A0A0A]'
                : 'text-[#D4D4D4] hover:text-[#FAFAFA]',
            ].join(' ')}
          >
            Gastos ({counts.expenseActive})
          </button>
          <button
            {...getTabProps('income')}
            className={[
              'min-h-[44px] px-2.5 sm:px-4 rounded-[4px] text-xs sm:text-sm font-semibold transition-colors cursor-pointer text-center',
              activeTab === 'income'
                ? 'bg-[#FACC15] text-[#0A0A0A]'
                : 'text-[#D4D4D4] hover:text-[#FAFAFA]',
            ].join(' ')}
          >
            Ingresos ({counts.incomeActive})
          </button>
        </div>

        <label className="inline-flex items-center gap-2.5 text-sm text-[#D4D4D4] cursor-pointer select-none min-h-[44px]">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-4 w-4 accent-[#FACC15] cursor-pointer"
          />
          <span>
            Mostrar categorías archivadas ({counts.archivedInTab})
          </span>
        </label>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-sm text-[#FAFAFA]">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadCategories()}
            isLoading={isLoading}
            loadingText="Reintentando..."
          >
            Reintentar carga
          </Button>
        </div>
      ) : null}

      <div {...getPanelProps(activeTab)}>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((item) => (
              <div
                key={item}
                className="h-[112px] rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse"
              />
            ))}
          </div>
        ) : error && filteredCategories.length === 0 ? null : filteredCategories.length === 0 ? (
          <EmptyState
            headingLevel="h2"
            title="No hay categorías en esta vista"
            description={
              showArchived
                ? 'No tenés categorías archivadas ni activas en este tipo.'
                : 'Creá tu primera categoría para empezar a clasificar movimientos.'
            }
            actionLabel="Crear categoría"
            onAction={openCreateModal}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCategories.map((cat) => {
            const isBusy = processingId === cat.id;
            return (
              <Card
                key={cat.id}
                padding="md"
                interactive={cat.is_active}
                className={!cat.is_active ? 'opacity-75 border-dashed' : ''}
              >
                <div className="flex flex-col justify-between gap-4 h-full">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="h-9 w-9 shrink-0 rounded-[6px] bg-[#0A0A0A] border border-[#262626] flex items-center justify-center text-[#FACC15]"
                    >
                      <CategoryIcon icon={cat.icon} className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-base font-bold text-[#FAFAFA] truncate">
                        {cat.name}
                      </h2>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge variant={cat.type === 'income' ? 'green' : 'red'}>
                          {cat.type === 'income' ? 'Ingreso' : 'Gasto'}
                        </Badge>
                        {cat.type === 'expense' && cat.is_gustito ? (
                          <Badge variant="yellow">Gustito</Badge>
                        ) : null}
                        {cat.is_system ? (
                          <Badge variant="neutral">Base</Badge>
                        ) : null}
                        {!cat.is_active ? (
                          <Badge variant="neutral">Archivada</Badge>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {cat.type === 'expense' &&
                  cat.monthly_limit !== null &&
                  cat.monthly_limit > 0
                    ? (() => {
                        const progress = limitProgressByCatId.get(cat.id);
                        const spent = progress?.spent ?? 0;
                        const limit = progress?.monthlyLimit ?? cat.monthly_limit;
                        const usagePercent =
                          progress?.usagePercent ??
                          (limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0);
                        const isExceeded = usagePercent >= 100;
                        const isWarning = usagePercent > 80 && usagePercent < 100;
                        const barWidth = Math.min(100, Math.max(0, usagePercent));
                        const barColor = isExceeded
                          ? '#EF4444'
                          : isWarning
                            ? '#EAB308'
                            : '#FACC15';

                        return (
                          <div className="flex flex-col gap-1.5 pt-2 border-t border-[#1F1F1F]">
                            <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                              <span className="text-[#A3A3A3]">Tope mensual</span>
                              <div className="flex items-center gap-1.5">
                                {isExceeded ? (
                                  <Badge variant="red">Límite superado</Badge>
                                ) : isWarning ? (
                                  <Badge variant="yellow">Cerca del tope</Badge>
                                ) : null}
                                <span
                                  className={[
                                    'font-mono-num font-bold',
                                    isExceeded
                                      ? 'text-[#F87171]'
                                      : isWarning
                                        ? 'text-[#FACC15]'
                                        : 'text-[#FAFAFA]',
                                  ].join(' ')}
                                >
                                  {formatPercent(usagePercent)}
                                </span>
                              </div>
                            </div>
                            <div
                              role="progressbar"
                              aria-label={`Uso de tope mensual en ${cat.name}`}
                              aria-valuenow={Math.min(100, Math.round(usagePercent))}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              className="h-2 w-full overflow-hidden rounded-full bg-[#262626]"
                            >
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{
                                  width: `${barWidth}%`,
                                  backgroundColor: barColor,
                                }}
                              />
                            </div>
                            <div className="flex items-center justify-between gap-2 text-xs font-mono-num text-[#A3A3A3]">
                              <span>{formatCurrency(spent, currency)}</span>
                              <span>de {formatCurrency(limit, currency)}</span>
                            </div>
                          </div>
                        );
                      })()
                    : null}

                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#1F1F1F]">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openEditModal(cat)}
                      disabled={isBusy}
                    >
                      Editar categoría
                    </Button>

                    {cat.is_active ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleArchive(cat)}
                        isLoading={isBusy}
                        loadingText="Archivando..."
                      >
                        Archivar categoría
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void handleRestore(cat)}
                        isLoading={isBusy}
                        loadingText="Restaurando..."
                      >
                        Restaurar categoría
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
          </div>
        )}
      </div>

      {user ? (
        <CategoryFormModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          userId={user.id}
          initialCategory={editingCategory}
          defaultType={activeTab}
          onSaved={handleSavedCategory}
        />
      ) : null}
    </div>
  );
}
