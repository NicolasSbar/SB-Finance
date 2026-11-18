/**
 * Hook de consolidación financiera del Dashboard y períodos mensuales.
 *
 * Arquitectura y decisiones técnicas:
 * - Fórmula contable con apartado de topes desde el día 1:
 *   `Disponible Real = Ingresos Totales − max(Tope Fijos, Fijos + Cuotas No-Gustito + Sobrante Fijos Trasladado)
 *    − max(Presupuesto Gustitos, Gastado Gustitos + Sobrante Gustitos Trasladado)
 *    − (Ahorro Meta + Aportes Operativos) − Variables No-Gustito − Plazos Fijos desde Disponible`.
 * - Aislamiento estricto de cuotas de Gustitos: las cuotas marcadas con `is_gustito`
 *   (o cuya categoría en el mes sea Gustito) descuentan únicamente de la Bolsa de
 *   Gustitos sin consumir el tope de Comprometido, pero permanecen en `Pendientes de Pago`.
 * - Cero doble descuento al ahorrar sobrantes: solo los `savings_entries` con
 *   `source_type IN ('manual', 'direct_income')` se suman a `totalMonthlySavings`; los
 *   traslados `cap_surplus_*` viven dentro del `max(...)` de cada tope y los retornos
 *   `fixed_term_return` se acreditan directo a la Bóveda.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { roundCurrency, toMonthStartISODate } from '../lib/formatters';
import {
  getCategories,
  getMonthlyCategorySnapshots,
} from '../services/categoriesService';
import {
  getFixedExpenseTemplates,
  getMonthlyCommitments,
} from '../services/commitmentsService';
import { getFixedTermDeposits } from '../services/fixedTermsService';
import { getSavingsEntriesByMonth } from '../services/savingsService';
import { ensureMonthlyPeriod, getMonthlyBudget } from '../services/settingsService';
import {
  getSixMonthsEvolution,
  getTransactionsByMonth,
} from '../services/transactionsService';
import type {
  Category,
  CategoryBreakdownItem,
  CategoryLimitProgress,
  FixedExpenseTemplate,
  FixedTermDeposit,
  GustitosSummary,
  MonthlyBudget,
  MonthlyCategorySnapshot,
  MonthlyCommitment,
  MonthlyEvolutionPoint,
  MonthlyFinancialSummary,
  SavingsEntry,
  Transaction,
} from '../types/database.types';
import { useAuth } from './useAuth';
import { useMonthlyPeriod } from './useMonthlyPeriod';

// Paleta de gráficos alineada con Amarillo/Negro y sin verde semántico de ingresos en gastos
const CHART_CATEGORY_COLORS: readonly string[] = [
  '#FACC15', // Amarillo marca
  '#FAFAFA', // Blanco neutro
  '#D4D4D4', // Gris platino neutro
  '#EAB308', // Ámbar dorado
  '#A3A3A3', // Gris claro
  '#EF4444', // Rojo semántico
  '#FDE047', // Amarillo suave
  '#737373', // Gris medio
  '#D97706', // Ámbar oscuro
  '#525252', // Gris oscuro
];

export interface UseDashboardDataOptions {
  includeEvolution?: boolean;
  includeTransactions?: boolean;
}

export interface UseDashboardDataResult {
  budget: MonthlyBudget | null;
  commitments: MonthlyCommitment[];
  transactions: Transaction[];
  categories: Category[];
  fixedTerms: FixedTermDeposit[];
  evolution: MonthlyEvolutionPoint[];
  summary: MonthlyFinancialSummary;
  categoryBreakdown: CategoryBreakdownItem[];
  isLoading: boolean;
  isRefreshing: boolean;
  isInitializingMonth: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  initializeHistoricalMonth: () => Promise<void>;
}

export function useDashboardData(
  overrideMonthDate?: string,
  options?: UseDashboardDataOptions,
): UseDashboardDataResult {
  const includeEvolution = options?.includeEvolution ?? true;
  const includeTransactions = options?.includeTransactions ?? true;

  const { user, userSettings } = useAuth();
  const { monthDate: contextMonthDate, currentCalendarMonth } = useMonthlyPeriod();
  const targetMonth = toMonthStartISODate(overrideMonthDate ?? contextMonthDate);

  const [budget, setBudget] = useState<MonthlyBudget | null>(null);
  const [commitments, setCommitments] = useState<MonthlyCommitment[]>([]);
  const [projectedTemplates, setProjectedTemplates] = useState<FixedExpenseTemplate[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [savingsEntries, setSavingsEntries] = useState<SavingsEntry[]>([]);
  const [fixedTerms, setFixedTerms] = useState<FixedTermDeposit[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categorySnapshots, setCategorySnapshots] = useState<MonthlyCategorySnapshot[]>([]);
  const [evolution, setEvolution] = useState<MonthlyEvolutionPoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isInitializingMonth, setIsInitializingMonth] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadedMonthRef = useRef<string | null>(null);

  const fallbackSalary = userSettings?.fixed_salary ?? 0;
  const fallbackSavingsTarget = userSettings?.monthly_savings_target ?? 0;
  const fallbackLimit = userSettings?.fixed_expenses_limit ?? 0;
  const fallbackGustitosBudget = userSettings?.gustitos_budget ?? 0;

  const loadData = useCallback(async () => {
    if (!user) {
      loadedMonthRef.current = null;
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    const isInitialForMonth = loadedMonthRef.current !== targetMonth;
    if (isInitialForMonth) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }
    setError(null);

    try {
      const isCurrent = targetMonth === currentCalendarMonth;
      const isFuture = targetMonth > currentCalendarMonth;

      const resolvedBudget = isCurrent
        ? await ensureMonthlyPeriod(targetMonth)
        : await getMonthlyBudget(user.id, targetMonth);

      const [
        commitmentsData,
        transactionsData,
        savingsEntriesData,
        fixedTermsData,
        categoriesData,
        snapshotsData,
        evolutionData,
        templatesData,
      ] = await Promise.all([
        getMonthlyCommitments(targetMonth),
        includeTransactions
          ? getTransactionsByMonth(targetMonth)
          : Promise.resolve<Transaction[]>([]),
        getSavingsEntriesByMonth(targetMonth),
        getFixedTermDeposits(),
        getCategories({ includeInactive: true }),
        getMonthlyCategorySnapshots(targetMonth),
        includeEvolution
          ? getSixMonthsEvolution(
              targetMonth,
              fallbackSalary,
              fallbackSavingsTarget,
              fallbackLimit,
              fallbackGustitosBudget,
            )
          : Promise.resolve<MonthlyEvolutionPoint[]>([]),
        isFuture && !resolvedBudget
          ? getFixedExpenseTemplates()
          : Promise.resolve<FixedExpenseTemplate[]>([]),
      ]);

      setBudget(resolvedBudget);
      setCommitments(commitmentsData);
      setProjectedTemplates(templatesData);
      setTransactions(transactionsData);
      setSavingsEntries(savingsEntriesData);
      setFixedTerms(fixedTermsData);
      setCategories(categoriesData);
      setCategorySnapshots(snapshotsData);
      setEvolution(evolutionData);
      loadedMonthRef.current = targetMonth;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudieron cargar los datos del período.';
      setError(msg);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [
    user,
    targetMonth,
    currentCalendarMonth,
    fallbackSalary,
    fallbackSavingsTarget,
    fallbackLimit,
    fallbackGustitosBudget,
    includeEvolution,
    includeTransactions,
  ]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const initializeHistoricalMonth = useCallback(async () => {
    if (!user) return;
    setIsInitializingMonth(true);
    try {
      await ensureMonthlyPeriod(targetMonth);
      await loadData();
    } finally {
      setIsInitializingMonth(false);
    }
  }, [user, targetMonth, loadData]);

  const activeProjectedTemplates = useMemo(() => {
    const isFuture = targetMonth > currentCalendarMonth;
    if (!isFuture || budget !== null || projectedTemplates.length === 0) {
      return [];
    }
    const existingTemplateIds = new Set(
      commitments
        .map((c) => c.fixed_expense_template_id)
        .filter((id): id is string => Boolean(id)),
    );
    return projectedTemplates.filter(
      (tpl) => tpl.is_active && !existingTemplateIds.has(tpl.id),
    );
  }, [targetMonth, currentCalendarMonth, budget, projectedTemplates, commitments]);

  const summary = useMemo<MonthlyFinancialSummary>(() => {
    const isFuture = targetMonth > currentCalendarMonth;
    const isInitialized = budget !== null;

    const fixedSalary = budget
      ? budget.fixed_salary
      : isFuture
        ? fallbackSalary
        : 0;
    const monthlySavingsTarget = budget
      ? budget.monthly_savings_target
      : isFuture
        ? fallbackSavingsTarget
        : 0;
    const fixedExpensesLimit = budget
      ? budget.fixed_expenses_limit
      : isFuture
        ? fallbackLimit
        : 0;
    const gustitosBudget = roundCurrency(
      budget
        ? budget.gustitos_budget
        : isFuture
          ? fallbackGustitosBudget
          : 0,
    );

    const snapshotByCatId = new Map<string, MonthlyCategorySnapshot>();
    for (const snap of categorySnapshots) {
      snapshotByCatId.set(snap.category_id, snap);
    }
    const hasMonthSnapshots = snapshotByCatId.size > 0;

    const gustitoCategoryIds = new Set<string>();
    const effectiveConfigByCat = new Map<
      string,
      { isGustito: boolean; monthlyLimit: number | null }
    >();

    for (const cat of categories) {
      if (cat.type !== 'expense') continue;
      const snap = snapshotByCatId.get(cat.id);
      const isGustito = snap
        ? snap.is_gustito
        : !hasMonthSnapshots
          ? cat.is_gustito
          : false;
      const monthlyLimit = snap
        ? snap.monthly_limit
        : !hasMonthSnapshots
          ? cat.monthly_limit
          : null;

      effectiveConfigByCat.set(cat.id, { isGustito, monthlyLimit });
      if (isGustito) {
        gustitoCategoryIds.add(cat.id);
      }
    }

    let extraIncomeTotal = 0;
    let variableExpensesTotal = 0;
    let variableNonGustitoExpensesTotal = 0;
    let gustitosSpent = 0;
    const spentByCategory = new Map<string, number>();

    for (const tx of transactions) {
      if (tx.type === 'income') {
        extraIncomeTotal = roundCurrency(extraIncomeTotal + tx.amount);
      } else {
        variableExpensesTotal = roundCurrency(variableExpensesTotal + tx.amount);
        spentByCategory.set(
          tx.category_id,
          roundCurrency((spentByCategory.get(tx.category_id) ?? 0) + tx.amount),
        );
        if (tx.is_gustito || gustitoCategoryIds.has(tx.category_id)) {
          gustitosSpent = roundCurrency(gustitosSpent + tx.amount);
        } else {
          variableNonGustitoExpensesTotal = roundCurrency(
            variableNonGustitoExpensesTotal + tx.amount,
          );
        }
      }
    }

    let extraSavingsDeposits = 0;
    let fixedCapTransferredToSavings = 0;
    let gustitosTransferredToSavings = 0;

    for (const entry of savingsEntries) {
      if (entry.entry_type !== 'deposit') continue;
      const sourceType = entry.source_type ?? 'manual';
      if (sourceType === 'cap_surplus_fixed') {
        fixedCapTransferredToSavings = roundCurrency(
          fixedCapTransferredToSavings + entry.amount,
        );
      } else if (sourceType === 'cap_surplus_gustitos') {
        gustitosTransferredToSavings = roundCurrency(
          gustitosTransferredToSavings + entry.amount,
        );
      } else if (sourceType === 'manual' || sourceType === 'direct_income') {
        extraSavingsDeposits = roundCurrency(extraSavingsDeposits + entry.amount);
      }
    }

    const totalMonthlySavings = roundCurrency(
      monthlySavingsTarget + extraSavingsDeposits,
    );

    let fixedExpensesTotal = 0;
    let installmentsTotal = 0; // Solo cuotas No-Gustito
    let gustitosInstallmentsTotal = 0;
    let paidCommitmentsTotal = 0;
    let pendingCommitmentsTotal = 0;
    let pendingCommitmentsCount = 0;

    for (const item of commitments) {
      spentByCategory.set(
        item.category_id,
        roundCurrency((spentByCategory.get(item.category_id) ?? 0) + item.amount),
      );

      if (item.commitment_type === 'fixed_expense') {
        fixedExpensesTotal = roundCurrency(fixedExpensesTotal + item.amount);
      } else {
        const purchaseMarkedGustito = Boolean(item.installment_purchase?.is_gustito);
        const isGustitoInst =
          purchaseMarkedGustito || gustitoCategoryIds.has(item.category_id);

        if (isGustitoInst) {
          gustitosInstallmentsTotal = roundCurrency(
            gustitosInstallmentsTotal + item.amount,
          );
          gustitosSpent = roundCurrency(gustitosSpent + item.amount);
        } else {
          installmentsTotal = roundCurrency(installmentsTotal + item.amount);
        }
      }

      if (item.is_paid) {
        paidCommitmentsTotal = roundCurrency(paidCommitmentsTotal + item.amount);
      } else {
        pendingCommitmentsTotal = roundCurrency(pendingCommitmentsTotal + item.amount);
        pendingCommitmentsCount += 1;
      }
    }

    for (const tpl of activeProjectedTemplates) {
      fixedExpensesTotal = roundCurrency(fixedExpensesTotal + tpl.default_amount);
      pendingCommitmentsTotal = roundCurrency(pendingCommitmentsTotal + tpl.default_amount);
      pendingCommitmentsCount += 1;
      spentByCategory.set(
        tpl.category_id,
        roundCurrency((spentByCategory.get(tpl.category_id) ?? 0) + tpl.default_amount),
      );
    }

    // Plazos Fijos constituidos desde Disponible Real y acreditados a Disponible Real
    let fixedTermsInvestedFromAvailable = 0;
    let fixedTermsReturnedToAvailable = 0;

    for (const ft of fixedTerms) {
      if (ft.status === 'cancelled') continue;
      if (
        ft.origin === 'monthly_available' &&
        toMonthStartISODate(ft.start_date) === targetMonth
      ) {
        fixedTermsInvestedFromAvailable = roundCurrency(
          fixedTermsInvestedFromAvailable + ft.principal_amount,
        );
      }
      if (
        ft.status === 'accredited_available' &&
        ft.accredited_month_date &&
        toMonthStartISODate(ft.accredited_month_date) === targetMonth
      ) {
        fixedTermsReturnedToAvailable = roundCurrency(
          fixedTermsReturnedToAvailable +
            (ft.actual_return_amount ?? ft.expected_return_amount),
        );
      }
    }

    const totalIncome = roundCurrency(
      fixedSalary + extraIncomeTotal + fixedTermsReturnedToAvailable,
    );
    const totalCommitted = roundCurrency(fixedExpensesTotal + installmentsTotal);

    const committedLimitUsagePercent =
      fixedExpensesLimit > 0
        ? roundCurrency((totalCommitted / fixedExpensesLimit) * 100)
        : null;

    // El tope excedido se marca a partir del >= 100% (alineado con Simulador, financeHelpers y daily-alerts)
    const isOverFixedLimit =
      fixedExpensesLimit > 0 && totalCommitted >= fixedExpensesLimit;

    const fixedReservedAmount = roundCurrency(
      Math.max(
        fixedExpensesLimit,
        totalCommitted + fixedCapTransferredToSavings,
      ),
    );
    // El presupuesto de Gustitos ya no se aparta ni se resta desde el día 1:
    // permanece dentro del Disponible Real y solo descuenta cuando se gasta realmente
    // (o si existiera un traslado previo registrado a Bóveda).
    const gustitosReservedAmount = roundCurrency(
      gustitosSpent + gustitosTransferredToSavings,
    );

    const realAvailable = roundCurrency(
      totalIncome -
        fixedReservedAmount -
        gustitosReservedAmount -
        totalMonthlySavings -
        variableNonGustitoExpensesTotal -
        fixedTermsInvestedFromAvailable,
    );

    const fixedCapSurplus = isInitialized
      ? Math.max(
          0,
          roundCurrency(
            fixedExpensesLimit - totalCommitted - fixedCapTransferredToSavings,
          ),
        )
      : 0;
    const gustitosSurplus = 0;

    const gustitoCategoriesCount = gustitoCategoryIds.size;
    const isGustitosConfigured =
      gustitosBudget > 0 && (gustitoCategoriesCount > 0 || gustitosSpent > 0);
    const gustitosRemaining = roundCurrency(gustitosBudget - gustitosSpent);
    const gustitosUsagePercent =
      gustitosBudget > 0
        ? roundCurrency((gustitosSpent / gustitosBudget) * 100)
        : null;
    const gustitos: GustitosSummary = {
      isConfigured: isGustitosConfigured,
      budget: gustitosBudget,
      spent: gustitosSpent,
      remaining: gustitosRemaining,
      usagePercent: gustitosUsagePercent,
      gustitoCategoriesCount,
      isExceeded: isGustitosConfigured && gustitosSpent >= gustitosBudget,
    };

    const surplusReviewCompletedAt = budget?.surplus_review_completed_at ?? null;
    const now = new Date();
    const todayDayOfMonth = now.getDate();
    const daysInCurrentMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    // El aviso proactivo de revisión de cierre se muestra únicamente cuando faltan
    // 3 días o menos para terminar el mes (o en meses pasados sin revisar).
    const daysRemainingInMonth = daysInCurrentMonth - todayDayOfMonth;
    const isCycleReadyForReview =
      targetMonth < currentCalendarMonth ||
      (targetMonth === currentCalendarMonth && daysRemainingInMonth <= 3);
    const shouldPromptSurplusReview =
      isInitialized &&
      !surplusReviewCompletedAt &&
      fixedCapSurplus > 0 &&
      isCycleReadyForReview;

    const categoryLimits: CategoryLimitProgress[] = [];
    for (const cat of categories) {
      if (cat.type !== 'expense') continue;
      const cfg = effectiveConfigByCat.get(cat.id);
      if (!cfg || cfg.monthlyLimit === null || cfg.monthlyLimit <= 0) continue;

      const spent = spentByCategory.get(cat.id) ?? 0;
      if (!cat.is_active && spent <= 0) continue;

      const usagePercent = roundCurrency((spent / cfg.monthlyLimit) * 100);
      const remaining = roundCurrency(cfg.monthlyLimit - spent);
      categoryLimits.push({
        categoryId: cat.id,
        categoryName: cat.name,
        icon: cat.icon,
        isGustito: cfg.isGustito,
        monthlyLimit: cfg.monthlyLimit,
        spent,
        usagePercent,
        remaining,
      });
    }

    categoryLimits.sort((a, b) => b.usagePercent - a.usagePercent);

    return {
      monthDate: targetMonth,
      isInitialized,
      fixedSalary,
      extraIncomeTotal,
      totalIncome,
      fixedExpensesLimit,
      fixedExpensesTotal,
      installmentsTotal,
      fixedAndNonGustitoInstallmentsTotal: totalCommitted,
      gustitosInstallmentsTotal,
      totalCommitted,
      fixedReservedAmount,
      gustitosReservedAmount,
      fixedCapTransferredToSavings,
      gustitosTransferredToSavings,
      fixedCapSurplus,
      gustitosSurplus,
      fixedTermsInvestedFromAvailable,
      fixedTermsReturnedToAvailable,
      committedLimitUsagePercent,
      isOverFixedLimit,
      paidCommitmentsTotal,
      pendingCommitmentsTotal,
      pendingCommitmentsCount,
      totalCommitmentsCount: commitments.length + activeProjectedTemplates.length,
      monthlySavingsTarget,
      extraSavingsDeposits,
      totalMonthlySavings,
      variableExpensesTotal,
      variableNonGustitoExpensesTotal,
      realAvailable,
      surplusReviewCompletedAt,
      shouldPromptSurplusReview,
      gustitos,
      categoryLimits,
    };
  }, [
    targetMonth,
    currentCalendarMonth,
    budget,
    fallbackSalary,
    fallbackSavingsTarget,
    fallbackLimit,
    fallbackGustitosBudget,
    categories,
    categorySnapshots,
    transactions,
    savingsEntries,
    commitments,
    activeProjectedTemplates,
    fixedTerms,
  ]);

  const categoryBreakdown = useMemo<CategoryBreakdownItem[]>(() => {
    const categoryNameMap = new Map<string, string>();
    for (const cat of categories) {
      categoryNameMap.set(cat.id, cat.name);
    }

    const totalsByCat = new Map<string, { name: string; amount: number }>();

    for (const tx of transactions) {
      if (tx.type !== 'expense') continue;
      const catName =
        tx.category?.name ?? categoryNameMap.get(tx.category_id) ?? 'Sin categoría';
      const existing = totalsByCat.get(tx.category_id);
      totalsByCat.set(tx.category_id, {
        name: catName,
        amount: roundCurrency((existing?.amount ?? 0) + tx.amount),
      });
    }

    for (const comm of commitments) {
      const catName =
        comm.category?.name ?? categoryNameMap.get(comm.category_id) ?? 'Sin categoría';
      const existing = totalsByCat.get(comm.category_id);
      totalsByCat.set(comm.category_id, {
        name: catName,
        amount: roundCurrency((existing?.amount ?? 0) + comm.amount),
      });
    }

    for (const tpl of activeProjectedTemplates) {
      const catName =
        tpl.category?.name ?? categoryNameMap.get(tpl.category_id) ?? 'Sin categoría';
      const existing = totalsByCat.get(tpl.category_id);
      totalsByCat.set(tpl.category_id, {
        name: catName,
        amount: roundCurrency((existing?.amount ?? 0) + tpl.default_amount),
      });
    }

    const totalExpenses = Array.from(totalsByCat.values()).reduce(
      (acc, item) => roundCurrency(acc + item.amount),
      0,
    );

    if (totalExpenses <= 0) return [];

    return Array.from(totalsByCat.entries())
      .map(([categoryId, data]) => ({
        categoryId,
        categoryName: data.name,
        amount: data.amount,
        percentage: roundCurrency((data.amount / totalExpenses) * 100),
        color: '#FACC15',
      }))
      .sort((a, b) => b.amount - a.amount)
      .map((item, idx) => ({
        ...item,
        color: CHART_CATEGORY_COLORS[idx % CHART_CATEGORY_COLORS.length] ?? '#FACC15',
      }));
  }, [categories, transactions, commitments, activeProjectedTemplates]);

  return {
    budget,
    commitments,
    transactions,
    categories,
    fixedTerms,
    evolution,
    summary,
    categoryBreakdown,
    isLoading,
    isRefreshing,
    isInitializingMonth,
    error,
    refresh: loadData,
    initializeHistoricalMonth,
  };
}
