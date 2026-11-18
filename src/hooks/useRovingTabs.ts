/**
 * Hook accesible `useRovingTabs` para listas y grillas de pestañas (patrón WAI-ARIA Tabs).
 *
 * Arquitectura y decisiones técnicas:
 * - Implementa "roving tabindex" (`tabIndex={0}` en la pestaña activa y `-1` en el resto)
 *   para que el lector de pantalla y la tecla `Tab` entren y salgan del `tablist` en una
 *   sola parada, delegando la navegación interna a las flechas, `Home` y `End`.
 * - Soporta orientación `horizontal`, `vertical` y `grid` (por ejemplo, la grilla `2x2`
 *   móvil de la Matriz de Prioridad) sin instalar dependencias externas.
 * - Al navegar por teclado, actualiza la pestaña seleccionada y traslada explícitamente
 *   el foco DOM al `<button>` destino mediante un mapa de referencias estable.
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';

export type RovingTabsOrientation = 'horizontal' | 'vertical' | 'grid';

export interface UseRovingTabsOptions<T extends string> {
  tabs: readonly T[];
  activeTab: T;
  onChange: (nextTab: T) => void;
  orientation?: RovingTabsOrientation;
  columns?: number;
  idPrefix?: string;
}

export interface RovingTabItemOptions {
  id?: string;
  controlsId?: string;
}

export interface RovingTabPanelOptions {
  id?: string;
  labelledById?: string;
}

export interface RovingTabListProps {
  role: 'tablist';
  'aria-orientation': 'horizontal' | 'vertical';
  'aria-label'?: string;
}

export interface RovingTabProps {
  role: 'tab';
  type: 'button';
  tabIndex: 0 | -1;
  'aria-selected': boolean;
  id?: string;
  'aria-controls'?: string;
  ref: (element: HTMLButtonElement | null) => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface RovingTabPanelProps {
  role: 'tabpanel';
  tabIndex: 0;
  id?: string;
  'aria-labelledby'?: string;
}

export interface UseRovingTabsReturn<T extends string> {
  focusTab: (tab: T) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLElement>, currentTab: T) => void;
  getTabListProps: (ariaLabel?: string) => RovingTabListProps;
  getTabProps: (tab: T, options?: RovingTabItemOptions) => RovingTabProps;
  getPanelProps: (tab: T, options?: RovingTabPanelOptions) => RovingTabPanelProps;
}

function resolveNextTabIndex(
  key: string,
  currentIndex: number,
  total: number,
  orientation: RovingTabsOrientation,
  columns: number,
): number | null {
  if (total <= 0) return null;

  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;

  if (orientation === 'horizontal') {
    if (key === 'ArrowRight') return (currentIndex + 1) % total;
    if (key === 'ArrowLeft') return (currentIndex - 1 + total) % total;
    return null;
  }

  if (orientation === 'vertical') {
    if (key === 'ArrowDown') return (currentIndex + 1) % total;
    if (key === 'ArrowUp') return (currentIndex - 1 + total) % total;
    return null;
  }

  const safeColumns = Math.max(1, Math.floor(columns));
  if (key === 'ArrowRight') return (currentIndex + 1) % total;
  if (key === 'ArrowLeft') return (currentIndex - 1 + total) % total;
  if (key === 'ArrowDown') return (currentIndex + safeColumns) % total;
  if (key === 'ArrowUp') return (((currentIndex - safeColumns) % total) + total) % total;

  return null;
}

export function useRovingTabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  orientation = 'horizontal',
  columns = 2,
  idPrefix,
}: UseRovingTabsOptions<T>): UseRovingTabsReturn<T> {
  const tabElementsRef = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const refCallbacksRef = useRef<
    Partial<Record<T, (element: HTMLButtonElement | null) => void>>
  >({});

  const focusTab = useCallback((tab: T) => {
    tabElementsRef.current[tab]?.focus();
  }, []);

  const getRefCallback = useCallback((tab: T) => {
    const existing = refCallbacksRef.current[tab];
    if (existing) return existing;

    const callback = (element: HTMLButtonElement | null) => {
      tabElementsRef.current[tab] = element;
    };
    refCallbacksRef.current[tab] = callback;
    return callback;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, currentTab: T) => {
      if (tabs.length === 0) return;

      const rawIndex = tabs.indexOf(currentTab);
      const currentIndex = rawIndex >= 0 ? rawIndex : 0;

      const nextIndex = resolveNextTabIndex(
        event.key,
        currentIndex,
        tabs.length,
        orientation,
        columns,
      );

      if (nextIndex === null) return;

      const nextTab = tabs[nextIndex];
      if (nextTab === undefined) return;

      event.preventDefault();
      if (nextTab !== activeTab) {
        onChange(nextTab);
      }
      focusTab(nextTab);
    },
    [tabs, orientation, columns, activeTab, onChange, focusTab],
  );

  const getTabListProps = useCallback(
    (ariaLabel?: string): RovingTabListProps => ({
      role: 'tablist',
      'aria-orientation': orientation === 'vertical' ? 'vertical' : 'horizontal',
      ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    }),
    [orientation],
  );

  const getTabProps = useCallback(
    (tab: T, options?: RovingTabItemOptions): RovingTabProps => {
      const isSelected = tab === activeTab;
      const tabId = options?.id ?? (idPrefix ? `${idPrefix}-tab-${tab}` : undefined);
      const controlsId =
        options?.controlsId ?? (idPrefix ? `${idPrefix}-panel-${tab}` : undefined);

      return {
        role: 'tab',
        type: 'button',
        tabIndex: isSelected ? 0 : -1,
        'aria-selected': isSelected,
        ...(tabId ? { id: tabId } : {}),
        ...(controlsId ? { 'aria-controls': controlsId } : {}),
        ref: getRefCallback(tab),
        onClick: () => {
          onChange(tab);
        },
        onKeyDown: (event) => {
          handleKeyDown(event, tab);
        },
      };
    },
    [activeTab, idPrefix, getRefCallback, onChange, handleKeyDown],
  );

  const getPanelProps = useCallback(
    (tab: T, options?: RovingTabPanelOptions): RovingTabPanelProps => {
      const panelId = options?.id ?? (idPrefix ? `${idPrefix}-panel-${tab}` : undefined);
      const labelledById =
        options?.labelledById ?? (idPrefix ? `${idPrefix}-tab-${tab}` : undefined);

      return {
        role: 'tabpanel',
        tabIndex: 0,
        ...(panelId ? { id: panelId } : {}),
        ...(labelledById ? { 'aria-labelledby': labelledById } : {}),
      };
    },
    [idPrefix],
  );

  return {
    focusTab,
    handleKeyDown,
    getTabListProps,
    getTabProps,
    getPanelProps,
  };
}
