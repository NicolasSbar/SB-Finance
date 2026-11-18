/**
 * Hook efímero de simulación de gastos "¿Qué pasa si...?" (`useExpenseSimulator`).
 *
 * Arquitectura y decisiones técnicas:
 * - Cero persistencia: mantiene la lista de compras hipotéticas únicamente en
 *   estado React en memoria, sin escribir en Supabase ni en `localStorage`.
 * - Coherencia total con el motor contable principal: aplica exactamente la misma
 *   fórmula de apartados `Math.max(tope, gastado + simulado)`, unifica los umbrales
 *   de exceso en `>= 100%` (`exceedsFixedLimit`, `exceedsGustitosBudget` y categorías)
 *   y valida montos mínimos (`>= $0,01` en centavos enteros) y topes `MAX_MONEY`.
 */
import { useCallback, useMemo, useState } from 'react';
import { roundCurrency, toCents } from '../lib/formatters';
import { MAX_MONEY, simulatorItemSchema } from '../lib/validations';
import type {
  Category,
  MonthlyFinancialSummary,
  SimulatedExpenseItem,
} from '../types/database.types';

export interface SimulatedCategoryImpact {
  categoryId: string;
  categoryName: string;
  baseSpent: number;
  addedAmount: number;
  simulatedSpent: number;
  monthlyLimit: number | null;
  simulatedUsagePercent: number | null;
  exceedsLimit: boolean;
}

export interface SimulatedPeriodProjection {
  monthDate: string;
  baseRealAvailable: number;
  simulatedRealAvailable: number;
  realAvailableDelta: number;
  baseFixedCommitted: number;
  simulatedFixedCommitted: number;
  fixedLimit: number;
  simulatedFixedUsagePercent: number | null;
  exceedsFixedLimit: boolean;
  baseGustitosSpent: number;
  simulatedGustitosSpent: number;
  gustitosBudget: number;
  simulatedGustitosUsagePercent: number | null;
  exceedsGustitosBudget: boolean;
  addedTotalInPeriod: number;
  categoryImpacts: SimulatedCategoryImpact[];
}

export interface UseExpenseSimulatorResult {
  items: SimulatedExpenseItem[];
  addItem: (item: Omit<SimulatedExpenseItem, 'id'>) => boolean;
  removeItem: (id: string) => void;
  clearItems: () => void;
  currentMonthProjection: SimulatedPeriodProjection;
  nextMonthProjection: SimulatedPeriodProjection;
  totalSimulatedOutflow: number;
}

function buildPeriodProjection(
  base: MonthlyFinancialSummary,
  categories: Category[],
  items: SimulatedExpenseItem[],
  period: 'current' | 'next',
): SimulatedPeriodProjection {
  const catMap = new Map<string, Category>(categories.map((c) => [c.id, c]));
  const baseLimitMap = new Map(
    base.categoryLimits.map((cl) => [cl.categoryId, cl]),
  );

  let addedFixedCommitted = 0;
  let addedGustitos = 0;
  let addedVariableNonGustito = 0;
  let addedTotalInPeriod = 0;
  const addedByCategory = new Map<string, number>();

  for (const item of items) {
    let applies = false;
    if (period === 'current') {
      applies = item.startMonth === 'current';
    } else {
      applies =
        item.startMonth === 'next' ||
        (item.startMonth === 'current' &&
          item.mode === 'installments' &&
          item.installmentsCount >= 2);
    }

    if (!applies) continue;

    const unitAmount = roundCurrency(item.unitAmount);
    if (
      !Number.isFinite(item.unitAmount) ||
      item.unitAmount < 0.01 ||
      toCents(unitAmount) < 1 ||
      unitAmount > MAX_MONEY
    ) {
      continue;
    }

    addedTotalInPeriod = roundCurrency(addedTotalInPeriod + unitAmount);

    const cat = item.categoryId ? catMap.get(item.categoryId) : undefined;
    const isGustitoItem = Boolean(item.isGustito) || Boolean(cat?.is_gustito);

    if (item.mode === 'installments') {
      if (isGustitoItem) {
        addedGustitos = roundCurrency(addedGustitos + unitAmount);
      } else {
        addedFixedCommitted = roundCurrency(addedFixedCommitted + unitAmount);
      }
    } else {
      if (isGustitoItem) {
        addedGustitos = roundCurrency(addedGustitos + unitAmount);
      } else {
        addedVariableNonGustito = roundCurrency(addedVariableNonGustito + unitAmount);
      }
    }

    if (item.categoryId) {
      addedByCategory.set(
        item.categoryId,
        roundCurrency((addedByCategory.get(item.categoryId) ?? 0) + unitAmount),
      );
    }
  }

  const simulatedFixedCommitted = roundCurrency(
    base.totalCommitted + addedFixedCommitted,
  );
  const simulatedFixedReserved = roundCurrency(
    Math.max(
      base.fixedExpensesLimit,
      simulatedFixedCommitted + base.fixedCapTransferredToSavings,
    ),
  );

  const simulatedGustitosSpent = roundCurrency(base.gustitos.spent + addedGustitos);
  // El cupo de Gustitos permanece en el Disponible Real; solo descuenta lo gastado.
  const simulatedGustitosReserved = roundCurrency(
    simulatedGustitosSpent + base.gustitosTransferredToSavings,
  );

  const simulatedVariableNonGustito = roundCurrency(
    base.variableNonGustitoExpensesTotal + addedVariableNonGustito,
  );

  const simulatedRealAvailable = roundCurrency(
    base.totalIncome -
      simulatedFixedReserved -
      simulatedGustitosReserved -
      base.totalMonthlySavings -
      simulatedVariableNonGustito -
      base.fixedTermsInvestedFromAvailable,
  );

  const realAvailableDelta = roundCurrency(
    simulatedRealAvailable - base.realAvailable,
  );

  const simulatedFixedUsagePercent =
    base.fixedExpensesLimit > 0
      ? roundCurrency((simulatedFixedCommitted / base.fixedExpensesLimit) * 100)
      : null;

  const simulatedGustitosUsagePercent =
    base.gustitos.budget > 0
      ? roundCurrency((simulatedGustitosSpent / base.gustitos.budget) * 100)
      : null;

  const categoryImpacts: SimulatedCategoryImpact[] = [];
  for (const [categoryId, addedAmount] of addedByCategory.entries()) {
    const cat = catMap.get(categoryId);
    const limitEntry = baseLimitMap.get(categoryId);
    const monthlyLimit =
      limitEntry?.monthlyLimit ??
      (cat?.monthly_limit !== null && cat?.monthly_limit !== undefined
        ? Number(cat.monthly_limit)
        : null);
    const baseSpent = limitEntry?.spent ?? 0;
    const simulatedSpent = roundCurrency(baseSpent + addedAmount);
    const simulatedUsagePercent =
      monthlyLimit !== null && monthlyLimit > 0
        ? roundCurrency((simulatedSpent / monthlyLimit) * 100)
        : null;

    categoryImpacts.push({
      categoryId,
      categoryName: cat?.name ?? limitEntry?.categoryName ?? 'Categoría',
      baseSpent,
      addedAmount,
      simulatedSpent,
      monthlyLimit,
      simulatedUsagePercent,
      exceedsLimit: monthlyLimit !== null && simulatedSpent >= monthlyLimit,
    });
  }

  return {
    monthDate: base.monthDate,
    baseRealAvailable: base.realAvailable,
    simulatedRealAvailable,
    realAvailableDelta,
    baseFixedCommitted: base.totalCommitted,
    simulatedFixedCommitted,
    fixedLimit: base.fixedExpensesLimit,
    simulatedFixedUsagePercent,
    exceedsFixedLimit:
      base.fixedExpensesLimit > 0 &&
      toCents(simulatedFixedCommitted) >= toCents(base.fixedExpensesLimit),
    baseGustitosSpent: base.gustitos.spent,
    simulatedGustitosSpent,
    gustitosBudget: base.gustitos.budget,
    simulatedGustitosUsagePercent,
    exceedsGustitosBudget:
      base.gustitos.budget > 0 && simulatedGustitosSpent >= base.gustitos.budget,
    addedTotalInPeriod,
    categoryImpacts,
  };
}

export function useExpenseSimulator(
  currentSummary: MonthlyFinancialSummary,
  nextSummary: MonthlyFinancialSummary,
  categories: Category[],
): UseExpenseSimulatorResult {
  const [items, setItems] = useState<SimulatedExpenseItem[]>([]);

  const addItem = useCallback((item: Omit<SimulatedExpenseItem, 'id'>): boolean => {
    if (!Number.isFinite(item.unitAmount) || item.unitAmount < 0.01) {
      return false;
    }

    const normalizedUnitAmount = roundCurrency(item.unitAmount);
    if (toCents(normalizedUnitAmount) < 1) {
      return false;
    }

    const parsed = simulatorItemSchema.safeParse({
      ...item,
      unitAmount: normalizedUnitAmount,
    });
    if (!parsed.success) {
      return false;
    }

    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setItems((prev) => [
      ...prev,
      {
        id,
        description: parsed.data.description,
        mode: parsed.data.mode,
        unitAmount: parsed.data.unitAmount,
        installmentsCount:
          parsed.data.mode === 'installments' ? parsed.data.installmentsCount : 1,
        categoryId: parsed.data.categoryId,
        isGustito: parsed.data.isGustito,
        startMonth: parsed.data.startMonth,
      },
    ]);
    return true;
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearItems = useCallback(() => {
    setItems([]);
  }, []);

  const currentMonthProjection = useMemo(
    () => buildPeriodProjection(currentSummary, categories, items, 'current'),
    [currentSummary, categories, items],
  );

  const nextMonthProjection = useMemo(
    () => buildPeriodProjection(nextSummary, categories, items, 'next'),
    [nextSummary, categories, items],
  );

  const totalSimulatedOutflow = useMemo(
    () =>
      items.reduce(
        (acc, item) =>
          roundCurrency(
            acc +
              roundCurrency(
                roundCurrency(item.unitAmount) *
                  (item.mode === 'installments' ? item.installmentsCount : 1),
              ),
          ),
        0,
      ),
    [items],
  );

  return {
    items,
    addItem,
    removeItem,
    clearItems,
    currentMonthProjection,
    nextMonthProjection,
    totalSimulatedOutflow,
  };
}
