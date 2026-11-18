/**
 * Hook y Proveedor para gestionar el período mensual activo (`YYYY-MM-01`).
 *
 * Arquitectura y decisiones técnicas:
 * - Compartir el mes seleccionado mediante un Contexto permite que el usuario navegue
 *   a Octubre 2026 en el Dashboard y, al pasar a Movimientos o Fijos y Cuotas, siga
 *   inspeccionando el mismo período sin perder contexto.
 * - Siempre normalizamos el mes al día 1 en hora local (`toMonthStartISODate`) para
 *   alinearnos exactamente con `monthly_budgets.month_date`.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  addMonthsToMonthDate,
  formatMonthLabel,
  toMonthStartISODate,
} from '../lib/formatters';
import type { PeriodClassification } from '../types/database.types';

export interface MonthlyPeriodContextValue {
  monthDate: string;
  monthLabel: string;
  currentCalendarMonth: string;
  classification: PeriodClassification;
  isCurrentMonth: boolean;
  isPastMonth: boolean;
  isFutureMonth: boolean;
  setMonthDate: (nextMonth: string) => void;
  goToPreviousMonth: () => void;
  goToNextMonth: () => void;
  goToCurrentMonth: () => void;
}

const MonthlyPeriodContext = createContext<MonthlyPeriodContextValue | undefined>(undefined);

export function MonthlyPeriodProvider({ children }: { children: ReactNode }) {
  const currentCalendarMonth = toMonthStartISODate(new Date());
  const [monthDate, setMonthDateState] = useState<string>(currentCalendarMonth);

  const setMonthDate = useCallback((nextMonth: string) => {
    setMonthDateState(toMonthStartISODate(nextMonth));
  }, []);

  const goToPreviousMonth = useCallback(() => {
    setMonthDateState((prev) => addMonthsToMonthDate(prev, -1));
  }, []);

  const goToNextMonth = useCallback(() => {
    setMonthDateState((prev) => addMonthsToMonthDate(prev, 1));
  }, []);

  const goToCurrentMonth = useCallback(() => {
    setMonthDateState(toMonthStartISODate(new Date()));
  }, []);

  const value = useMemo<MonthlyPeriodContextValue>(() => {
    const todayMonth = toMonthStartISODate(new Date());
    const classification: PeriodClassification =
      monthDate < todayMonth ? 'past' : monthDate > todayMonth ? 'future' : 'current';

    return {
      monthDate,
      monthLabel: formatMonthLabel(monthDate),
      currentCalendarMonth: todayMonth,
      classification,
      isCurrentMonth: classification === 'current',
      isPastMonth: classification === 'past',
      isFutureMonth: classification === 'future',
      setMonthDate,
      goToPreviousMonth,
      goToNextMonth,
      goToCurrentMonth,
    };
  }, [monthDate, setMonthDate, goToPreviousMonth, goToNextMonth, goToCurrentMonth]);

  return createElement(MonthlyPeriodContext.Provider, { value }, children);
}

export function useMonthlyPeriod(): MonthlyPeriodContextValue {
  const ctx = useContext(MonthlyPeriodContext);
  if (!ctx) {
    throw new Error('useMonthlyPeriod debe utilizarse dentro de un MonthlyPeriodProvider.');
  }
  return ctx;
}
