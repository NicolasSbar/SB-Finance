/**
 * Matriz de Prioridad Interactiva (`/priority-matrix`).
 *
 * Arquitectura y decisiones técnicas:
 * - Cero librerías externas de Drag & Drop: en escritorio usamos HTML5 Drag & Drop
 *   nativo (`draggable`, `onDragOver`, `onDrop`) con verificación de
 *   `contains(relatedTarget)` en `onDragLeave` para evitar parpadeos sobre hijos y un
 *   guard `wasDraggedRef` reseteado en `onDrop`, `onDragEnd`, `onPointerDown` y `onKeyDown`
 *   para no bloquear clicks posteriores cuando el botón origen se desmonta al cambiar
 *   de cuadrante.
 * - Diseño cartesiano 2x2: estructura visual de matriz con eje Y (`Impacto`:
 *   Bajo -> Alto) a la izquierda, eje X (`Costo`: Bajo -> Alto) abajo, marcas de agua
 *   translúcidas con el nombre de acción en cada cuadrante y tarjetas compactas
 *   (solo título + costo estimado) que al clickearse abren el modal de acciones
 *   (`Comprar`, `Editar`, `Eliminar` y cambio de cuadrante para móvil/teclado).
 * - Accesibilidad móvil: en `< 768px` usa `useRovingTabs` (`grid` 2x2) + `role="tabpanel"`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { PageSubnav } from '../../components/layout/PageSubnav';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { useAuth } from '../../hooks/useAuth';
import { useRovingTabs } from '../../hooks/useRovingTabs';
import {
  PRIORITY_QUADRANT_META,
  PRIORITY_QUADRANT_ORDER,
  formatCurrency,
  roundCurrency,
} from '../../lib/formatters';
import { getCategories } from '../../services/categoriesService';
import {
  deletePriorityItem,
  getPriorityItems,
  movePriorityItemQuadrant,
} from '../../services/priorityMatrixService';
import type {
  Category,
  PriorityItem,
  PriorityQuadrant,
} from '../../types/database.types';
import {
  PriorityItemFormModal,
  type PriorityModalMode,
} from './PriorityItemFormModal';

export function PriorityMatrixPage() {
  const { user, userSettings } = useAuth();
  const [items, setItems] = useState<PriorityItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  // Filtro móvil por cuadrante con navegación WAI-ARIA por teclado
  const [activeMobileQuadrant, setActiveMobileQuadrant] =
    useState<PriorityQuadrant>('high_impact_low_cost');

  const { getTabListProps, getTabProps, getPanelProps } =
    useRovingTabs<PriorityQuadrant>({
      tabs: PRIORITY_QUADRANT_ORDER,
      activeTab: activeMobileQuadrant,
      onChange: setActiveMobileQuadrant,
      orientation: 'grid',
      columns: 2,
      idPrefix: 'priority-matrix',
    });

  // HTML5 Drag & Drop nativo
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dragOverQuadrant, setDragOverQuadrant] =
    useState<PriorityQuadrant | null>(null);
  const wasDraggedRef = useRef(false);

  // Modales
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    mode: PriorityModalMode;
    item: PriorityItem | null;
    defaultQuadrant: PriorityQuadrant;
  }>({
    isOpen: false,
    mode: 'create',
    item: null,
    defaultQuadrant: 'high_impact_low_cost',
  });

  const [deletingTarget, setDeletingTarget] = useState<PriorityItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const currency = userSettings?.currency ?? 'ARS';

  const loadMatrixData = useCallback(async () => {
    if (!user) return;
    if (!hasLoadedRef.current) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const [itemsData, catsData] = await Promise.all([
        getPriorityItems(),
        getCategories({ includeInactive: false }),
      ]);
      setItems(itemsData);
      setCategories(catsData);
      hasLoadedRef.current = true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo cargar la Matriz de Prioridad.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadMatrixData();
  }, [loadMatrixData]);

  const itemsByQuadrant = useMemo(() => {
    const grouped: Record<PriorityQuadrant, PriorityItem[]> = {
      high_impact_low_cost: [],
      high_impact_high_cost: [],
      low_impact_low_cost: [],
      low_impact_high_cost: [],
    };
    for (const item of items) {
      grouped[item.quadrant].push(item);
    }
    return grouped;
  }, [items]);

  const totalEstimatedAll = useMemo(
    () =>
      items.reduce(
        (acc, item) => roundCurrency(acc + item.estimated_cost),
        0,
      ),
    [items],
  );

  async function handleMoveQuadrant(
    item: PriorityItem,
    nextQuadrant: PriorityQuadrant,
  ): Promise<void> {
    if (item.quadrant === nextQuadrant) return;

    const previousItems = items;
    // Actualización optimista inmediata (incluyendo el ítem activo si el modal está abierto)
    setItems((prev) =>
      prev.map((row) =>
        row.id === item.id ? { ...row, quadrant: nextQuadrant } : row,
      ),
    );
    setModalState((prev) =>
      prev.isOpen && prev.item?.id === item.id
        ? {
            ...prev,
            item: { ...prev.item, quadrant: nextQuadrant },
            defaultQuadrant: nextQuadrant,
          }
        : prev,
    );

    try {
      await movePriorityItemQuadrant(item.id, nextQuadrant);
      toast.success(
        `"${item.title}" movido a ${PRIORITY_QUADRANT_META[nextQuadrant].shortTitle}.`,
      );
    } catch (err) {
      setItems(previousItems);
      setModalState((prev) =>
        prev.isOpen && prev.item?.id === item.id
          ? {
              ...prev,
              item: { ...prev.item, quadrant: item.quadrant },
              defaultQuadrant: item.quadrant,
            }
          : prev,
      );
      const msg =
        err instanceof Error ? err.message : 'No se pudo mover el ítem.';
      toast.error(msg);
    }
  }

  async function handleConfirmDelete(): Promise<void> {
    if (!deletingTarget) return;
    setIsDeleting(true);
    try {
      await deletePriorityItem(deletingTarget.id);
      toast.success(`"${deletingTarget.title}" eliminado de la matriz.`);
      setDeletingTarget(null);
      await loadMatrixData();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo eliminar el ítem.';
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  }

  function renderQuadrantCell(quadrantId: PriorityQuadrant) {
    const meta = PRIORITY_QUADRANT_META[quadrantId];
    const list = itemsByQuadrant[quadrantId];
    const subtotal = list.reduce(
      (acc, i) => roundCurrency(acc + i.estimated_cost),
      0,
    );
    const isDropActive = dragOverQuadrant === quadrantId;
    const isPriorityQuadrant = quadrantId === 'high_impact_low_cost';

    return (
      <section
        key={quadrantId}
        aria-label={`${meta.shortTitle} (${meta.title})`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragOverQuadrant !== quadrantId) {
            setDragOverQuadrant(quadrantId);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            if (dragOverQuadrant === quadrantId) {
              setDragOverQuadrant(null);
            }
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverQuadrant(null);
          wasDraggedRef.current = false;
          const droppedId =
            e.dataTransfer.getData('text/plain') || draggingItemId;
          setDraggingItemId(null);
          if (!droppedId) return;
          const item = items.find((i) => i.id === droppedId);
          if (item) {
            void handleMoveQuadrant(item, quadrantId);
          }
        }}
        className={[
          'relative overflow-hidden rounded-[10px] border bg-[#121212] p-3.5 sm:p-4 min-h-[210px] sm:min-h-[235px] flex flex-col justify-between gap-3 transition-colors',
          isDropActive
            ? 'border-[#FACC15] bg-[#FACC15]/10'
            : 'border-[#262626] hover:border-[#303030]',
        ].join(' ')}
      >
        {/* Marca de agua translúcida centrada con el nombre de acción */}
        <div
          aria-hidden="true"
          className="pointer-events-none select-none absolute inset-0 flex items-center justify-center px-4 text-center"
        >
          <span
            className={[
              'text-lg sm:text-xl font-bold tracking-tight leading-snug',
              isPriorityQuadrant
                ? 'text-[#FACC15]/15'
                : 'text-[#FAFAFA]/12',
            ].join(' ')}
          >
            {meta.shortTitle}
          </span>
        </div>

        {/* Contenedor de tarjetas chiquitas arrastrables */}
        <div className="relative z-10 flex flex-wrap items-start content-start gap-2">
          {list.map((item) => {
            const isDragging = draggingItemId === item.id;

            return (
              <button
                key={item.id}
                type="button"
                draggable
                onPointerDown={() => {
                  wasDraggedRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    wasDraggedRef.current = false;
                  }
                }}
                onDragStart={(e) => {
                  wasDraggedRef.current = true;
                  setDraggingItemId(item.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', item.id);
                }}
                onDragEnd={() => {
                  setDraggingItemId(null);
                  setDragOverQuadrant(null);
                  wasDraggedRef.current = false;
                }}
                onClick={() => {
                  if (wasDraggedRef.current) return;
                  setModalState({
                    isOpen: true,
                    mode: 'actions',
                    item,
                    defaultQuadrant: item.quadrant,
                  });
                }}
                aria-label={`${item.title}, costo estimado ${formatCurrency(item.estimated_cost, currency)}. Click para editar, eliminar o comprar.`}
                className={[
                  'group min-h-[44px] min-w-0 max-w-full px-3 py-2 rounded-[8px] border bg-[#0A0A0A]/95 flex items-center gap-2 text-left transition-all cursor-pointer md:cursor-grab active:md:cursor-grabbing',
                  isDragging
                    ? 'opacity-45 border-[#FACC15]'
                    : 'border-[#262626] hover:border-[#FACC15]/70 hover:bg-[#171717]',
                ].join(' ')}
              >
                <svg
                  className="w-3.5 h-3.5 text-[#8A8A8A] group-hover:text-[#FACC15] shrink-0 transition-colors"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="5.5" cy="3.5" r="1.2" />
                  <circle cx="10.5" cy="3.5" r="1.2" />
                  <circle cx="5.5" cy="8" r="1.2" />
                  <circle cx="10.5" cy="8" r="1.2" />
                  <circle cx="5.5" cy="12.5" r="1.2" />
                  <circle cx="10.5" cy="12.5" r="1.2" />
                </svg>
                <span
                  title={item.title}
                  className="text-xs sm:text-[13px] font-semibold text-[#FAFAFA] truncate max-w-[160px] sm:max-w-[200px]"
                >
                  {item.title}
                </span>
                <span className="font-mono-num text-xs sm:text-[13px] font-bold text-[#FACC15] shrink-0">
                  {formatCurrency(item.estimated_cost, currency)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Pie discreto del cuadrante: subtotal + botón rápido "+" */}
        <div className="relative z-10 flex items-center justify-between gap-2 pt-1">
          <span className="font-mono-num text-[11px] text-[#8A8A8A]">
            {list.length > 0
              ? `${list.length} ${list.length === 1 ? 'ítem' : 'ítems'} · ${formatCurrency(subtotal, currency)}`
              : isDropActive
                ? 'Soltá aquí'
                : ''}
          </span>
          <button
            type="button"
            aria-label={`Agregar deseo en ${meta.shortTitle}`}
            title={`Agregar en ${meta.shortTitle}`}
            onClick={() =>
              setModalState({
                isOpen: true,
                mode: 'create',
                item: null,
                defaultQuadrant: quadrantId,
              })
            }
            className="btn-press inline-flex items-center justify-center min-w-[44px] min-h-[44px] -m-1.5 rounded-[8px] text-[#8A8A8A] hover:text-[#FACC15] hover:bg-[#1A1A1A]/70 transition-colors cursor-pointer"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageSubnav group="decision" />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Matriz de Prioridad de Compras
          </h1>
          <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
            Arrastrá cada tarjeta entre cuadrantes según su impacto y costo, o hacé click sobre ella para editar, eliminar o registrar la compra real.
          </p>
        </div>

        <Button
          variant="primary"
          className="w-full sm:w-auto"
          onClick={() =>
            setModalState({
              isOpen: true,
              mode: 'create',
              item: null,
              defaultQuadrant: activeMobileQuadrant,
            })
          }
        >
          + Agregar deseo de compra
        </Button>
      </div>

      {/* Resumen compacto */}
      <Card padding="md" className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
            Lista de deseos evaluada
          </span>
          <p className="mt-1 font-mono-num text-xl sm:text-2xl font-bold text-[#FAFAFA]">
            {items.length} {items.length === 1 ? 'ítem' : 'ítems'} &middot;{' '}
            <span className="text-[#FACC15]">
              {formatCurrency(totalEstimatedAll, currency)}
            </span>
          </p>
        </div>
        <p className="text-xs text-[#A3A3A3] max-w-md">
          Al marcar un ítem como comprado, podés registrarlo al contado o en cuotas y desaparecerá automáticamente de la matriz.
        </p>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-sm text-[#FAFAFA]">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void loadMatrixData()}>
            Reintentar carga
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="h-64 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
          <div className="h-64 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Tu Matriz de Prioridad está vacía"
          description="Agregá compras que estás evaluando hacer (tecnología, hogar, gustos) para decidir con cabeza fría qué va primero."
          actionLabel="+ Agregar primer deseo de compra"
          onAction={() =>
            setModalState({
              isOpen: true,
              mode: 'create',
              item: null,
              defaultQuadrant: 'high_impact_low_cost',
            })
          }
        />
      ) : (
        <>
          {/* Navegación móvil por cuadrante (< 768px) */}
          <div
            {...getTabListProps('Seleccionar cuadrante')}
            className="grid grid-cols-2 gap-2 md:hidden"
          >
            {PRIORITY_QUADRANT_ORDER.map((qId) => {
              const meta = PRIORITY_QUADRANT_META[qId];
              const count = itemsByQuadrant[qId].length;
              const isSelected = activeMobileQuadrant === qId;

              return (
                <button
                  key={qId}
                  {...getTabProps(qId)}
                  className={[
                    'min-h-[48px] px-3 py-2 rounded-[6px] border text-left text-xs font-semibold transition-colors cursor-pointer',
                    isSelected
                      ? 'border-[#FACC15] bg-[#FACC15]/15 text-[#FACC15]'
                      : 'border-[#262626] bg-[#121212] text-[#D4D4D4]',
                  ].join(' ')}
                >
                  <span className="block truncate">{meta.title}</span>
                  <span className="block text-[11px] opacity-80 mt-0.5">
                    {count} {count === 1 ? 'ítem' : 'ítems'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Vista móvil: cuadrante activo */}
          <div {...getPanelProps(activeMobileQuadrant)} className="md:hidden">
            {renderQuadrantCell(activeMobileQuadrant)}
          </div>

          {/* Vista escritorio/tablet: matriz cartesiana 2x2 estilo eje Y (Impacto) + eje X (Costo) */}
          <div className="hidden md:flex md:items-stretch md:gap-3">
            {/* Eje Y lateral izquierdo: Impacto (Alto arriba, Bajo abajo) */}
            <div
              aria-hidden="true"
              className="w-11 shrink-0 flex flex-col items-center justify-between pt-2 pb-10 select-none"
            >
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#FACC15]">
                Alto
              </span>

              <div className="relative flex-1 w-full flex items-center justify-center my-1.5">
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[1.5px] bg-[#3A3A3A]" />
                <svg
                  className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 text-[#FACC15]"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 7L6 2.5L10 7" />
                </svg>
                <span className="-rotate-90 bg-[#0A0A0A] px-2 text-xs font-bold uppercase tracking-[0.18em] text-[#D4D4D4] whitespace-nowrap">
                  Impacto
                </span>
              </div>

              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8A8A8A]">
                Bajo
              </span>
            </div>

            {/* Grilla 2x2 + Eje X inferior */}
            <div className="flex-1 min-w-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                {renderQuadrantCell('high_impact_low_cost')}
                {renderQuadrantCell('high_impact_high_cost')}
                {renderQuadrantCell('low_impact_low_cost')}
                {renderQuadrantCell('low_impact_high_cost')}
              </div>

              {/* Eje X inferior: Costo (Bajo izquierda, Alto derecha) */}
              <div aria-hidden="true" className="flex flex-col gap-1.5 pt-0.5 select-none">
                <div className="relative flex items-center w-full h-3">
                  <div className="w-full h-[1.5px] bg-[#3A3A3A]" />
                  <svg
                    className="absolute -right-0.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#A3A3A3]"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 2L9.5 6L5 10" />
                  </svg>
                </div>
                <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider">
                  <span className="text-[#8A8A8A]">Bajo</span>
                  <span className="text-xs font-bold tracking-[0.18em] text-[#D4D4D4]">
                    Costo
                  </span>
                  <span className="text-[#8A8A8A]">Alto</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {user ? (
        <PriorityItemFormModal
          isOpen={modalState.isOpen}
          onClose={() =>
            setModalState((prev) => ({ ...prev, isOpen: false }))
          }
          userId={user.id}
          categories={categories}
          currency={currency}
          mode={modalState.mode}
          initialItem={modalState.item}
          defaultQuadrant={modalState.defaultQuadrant}
          onSaved={loadMatrixData}
          onRequestDelete={(item) => setDeletingTarget(item)}
          onMoveQuadrant={handleMoveQuadrant}
        />
      ) : null}

      <Modal
        isOpen={Boolean(deletingTarget)}
        onClose={() => setDeletingTarget(null)}
        title="Eliminar ítem de la matriz"
        description={
          deletingTarget
            ? `¿Confirmás quitar "${deletingTarget.title}" de tu Matriz de Prioridad?`
            : undefined
        }
        size="sm"
      >
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
            Eliminar ítem
          </Button>
        </div>
      </Modal>
    </div>
  );
}
