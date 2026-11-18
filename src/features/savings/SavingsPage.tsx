/**
 * Pantalla dedicada de la Bóveda de Ahorros Aislada (`/savings`).
 *
 * Arquitectura y decisiones técnicas:
 * - Aislamiento patrimonial: este es el único lugar de la aplicación donde el usuario
 *   visualiza el saldo acumulado total de sus ahorros (metas mensuales congeladas +
 *   aportes extra − retiros).
 * - Privacidad por defecto: la cifra total acumulada inicia oculta (`••••••••`) con un botón
 *   accesible para mostrar u ocultar los montos en pantalla.
 * - Zero-Flash Refresh: distingue la carga inicial (`isLoading`) de las recargas posteriores
 *   (`isRefreshing`) para mantener estables las tarjetas y el listado tras guardar o eliminar.
 * - Integra `PageSubnav` (`group="investments"`) para alternar en 1 clic entre Bóveda y
 *   Plazos Fijos, y reutiliza `linkButtonClasses` en enlaces con jerarquía de botón.
 * - Responsividad a 320px y accesibilidad: evita `break-all` en cifras monetarias
 *   (usa escala tipográfica adaptable y `break-words`), garantiza áreas táctiles
 *   `min-h-[44px]` en enlaces/controles y permite envolver el filtro sin desborde horizontal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { MonthSelectorBar } from '../../components/layout/MonthSelectorBar';
import { PageSubnav } from '../../components/layout/PageSubnav';
import { Badge } from '../../components/ui/Badge';
import { Button, linkButtonClasses } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { useAuth } from '../../hooks/useAuth';
import { useMonthlyPeriod } from '../../hooks/useMonthlyPeriod';
import {
  formatCurrency,
  formatSavingsSourceBadge,
  formatShortDate,
  roundCurrency,
} from '../../lib/formatters';
import {
  deleteSavingsEntry,
  getAccumulatedSavingsBalance,
  getAllSavingsEntries,
  getSavingsEntriesByMonth,
} from '../../services/savingsService';
import { ensureMonthlyPeriod, getMonthlyBudget } from '../../services/settingsService';
import type {
  AccumulatedSavingsSummary,
  MonthlyBudget,
  SavingsEntry,
  SavingsEntryType,
} from '../../types/database.types';
import { SavingsEntryFormModal } from './SavingsEntryFormModal';

const INITIAL_ACCUMULATED: AccumulatedSavingsSummary = {
  totalAccumulated: 0,
  liquidBalance: 0,
  immobilizedInFixedTerms: 0,
  totalPatrimony: 0,
  totalMonthlyTargetsFrozen: 0,
  totalExtraDeposits: 0,
  totalWithdrawals: 0,
};

const MASKED_CURRENCY = '$ ••••••••';

export function SavingsPage() {
  const { user, userSettings } = useAuth();
  const { monthDate, monthLabel, isCurrentMonth, isFutureMonth } = useMonthlyPeriod();

  const [accumulated, setAccumulated] =
    useState<AccumulatedSavingsSummary>(INITIAL_ACCUMULATED);
  const [monthBudget, setMonthBudget] = useState<MonthlyBudget | null>(null);
  const [monthEntries, setMonthEntries] = useState<SavingsEntry[]>([]);
  const [allEntries, setAllEntries] = useState<SavingsEntry[]>([]);
  const [viewMode, setViewMode] = useState<'month' | 'all'>('month');

  // Saldo enmascarado por defecto para privacidad en pantalla
  const [isVaultHidden, setIsVaultHidden] = useState<boolean>(true);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedOnceRef = useRef<boolean>(false);

  // Modales de alta y confirmación de eliminación
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [modalEntryType, setModalEntryType] = useState<SavingsEntryType>('deposit');
  const [deletingTarget, setDeletingTarget] = useState<SavingsEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const currency = userSettings?.currency ?? 'ARS';

  const loadSavingsData = useCallback(async () => {
    if (!user) return;
    if (!hasLoadedOnceRef.current) {
      setIsLoading(true);
    }
    setError(null);

    try {
      const [balanceData, resolvedBudget, monthEntriesData, allEntriesData] =
        await Promise.all([
          getAccumulatedSavingsBalance(),
          isCurrentMonth
            ? ensureMonthlyPeriod(monthDate)
            : getMonthlyBudget(user.id, monthDate),
          getSavingsEntriesByMonth(monthDate),
          getAllSavingsEntries(),
        ]);

      setAccumulated(balanceData);
      setMonthBudget(resolvedBudget);
      setMonthEntries(monthEntriesData);
      setAllEntries(allEntriesData);
      hasLoadedOnceRef.current = true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo cargar tu Bóveda de Ahorros.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [user, monthDate, isCurrentMonth]);

  useEffect(() => {
    void loadSavingsData();
  }, [loadSavingsData]);

  const monthSummary = useMemo(() => {
    const monthlyTarget = monthBudget
      ? monthBudget.monthly_savings_target
      : isFutureMonth
        ? (userSettings?.monthly_savings_target ?? 0)
        : 0;

    let extraDeposits = 0;
    let surplusDeposits = 0;
    let fixedTermReturns = 0;
    let withdrawals = 0;
    for (const entry of monthEntries) {
      if (entry.entry_type === 'deposit') {
        if (
          entry.source_type === 'cap_surplus_fixed' ||
          entry.source_type === 'cap_surplus_gustitos'
        ) {
          surplusDeposits = roundCurrency(surplusDeposits + entry.amount);
        } else if (entry.source_type === 'fixed_term_return') {
          fixedTermReturns = roundCurrency(fixedTermReturns + entry.amount);
        } else {
          extraDeposits = roundCurrency(extraDeposits + entry.amount);
        }
      } else {
        withdrawals = roundCurrency(withdrawals + entry.amount);
      }
    }

    return {
      monthlyTarget,
      extraDeposits,
      surplusDeposits,
      fixedTermReturns,
      withdrawals,
      totalMonthlySavings: roundCurrency(monthlyTarget + extraDeposits),
    };
  }, [monthBudget, monthEntries, isFutureMonth, userSettings]);

  const visibleEntries = viewMode === 'month' ? monthEntries : allEntries;

  function openEntryModal(type: SavingsEntryType): void {
    setModalEntryType(type);
    setIsModalOpen(true);
  }

  async function handleConfirmDelete(): Promise<void> {
    if (!deletingTarget) return;
    setIsDeleting(true);
    try {
      await deleteSavingsEntry(deletingTarget.id);
      toast.success('Movimiento de ahorro eliminado.');
      setDeletingTarget(null);
      await loadSavingsData();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo eliminar el movimiento de ahorro.';
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <PageSubnav group="investments" />

      {/* Encabezado y acciones principales */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Bóveda de Ahorros
          </h1>
          <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
            Tu ahorro mensual y aportes extra quedan aislados del Disponible Real del Dashboard para proteger tus reservas.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2.5">
          <Link
            to="/fixed-terms"
            className={linkButtonClasses('secondary', 'md', 'w-full sm:w-auto text-[#FACC15]')}
          >
            Ver Plazos Fijos
          </Link>
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={() => openEntryModal('withdrawal')}
            disabled={isLoading || accumulated.liquidBalance <= 0}
          >
            Registrar retiro
          </Button>
          <Button
            variant="primary"
            className="w-full sm:w-auto"
            onClick={() => openEntryModal('deposit')}
          >
            + Registrar aporte
          </Button>
        </div>
      </div>

      <MonthSelectorBar />

      {error ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-sm text-[#FAFAFA]">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadSavingsData()}
          >
            Reintentar carga
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 h-52 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
          <div className="h-52 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
        </div>
      ) : (
        <section
          aria-label="Resumen de Bóveda de Ahorros"
          className="grid grid-cols-1 lg:grid-cols-3 gap-4"
        >
          {/* Tarjeta protagonista: Bóveda de Ahorros Acumulada (oculta por defecto) */}
          <Card
            padding="lg"
            highlight="yellow"
            className="lg:col-span-2 flex flex-col justify-between gap-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold uppercase tracking-wider text-[#A3A3A3]">
                  Saldo Acumulado en Bóveda
                </span>
                <Badge variant="yellow">Oculto del Dashboard</Badge>
              </div>

              <Button
                variant="secondary"
                size="sm"
                aria-pressed={!isVaultHidden}
                onClick={() => setIsVaultHidden((prev) => !prev)}
              >
                {isVaultHidden ? (
                  <>
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 12s3.75-7.5 9.75-7.5S21.75 12 21.75 12s-3.75 7.5-9.75 7.5S2.25 12 2.25 12z"
                      />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span>Mostrar saldo</span>
                  </>
                ) : (
                  <>
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
                      />
                    </svg>
                    <span>Ocultar saldo</span>
                  </>
                )}
              </Button>
            </div>

            <div className="min-w-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
                Ahorro Líquido Disponible
              </span>
              <p className="mt-1 font-mono-num text-2xl sm:text-4xl lg:text-[42px] font-extrabold tracking-tight leading-tight text-[#FACC15] break-words">
                {isVaultHidden
                  ? MASKED_CURRENCY
                  : formatCurrency(accumulated.liquidBalance, currency)}
              </p>
              <p className="mt-2.5 text-sm text-[#A3A3A3]">
                {isVaultHidden
                  ? 'Tu ahorro líquido, capital en plazos fijos y patrimonio total están protegidos por privacidad. Presioná "Mostrar saldo" para verlos.'
                  : 'Disponible para retiros o constitución de nuevos Plazos Fijos sin tocar tu Disponible Real.'}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-[#1F1F1F]">
              <div className="min-w-0 rounded-[6px] bg-[#0A0A0A] border border-[#262626] px-3.5 py-2.5">
                <span className="text-[12px] text-[#A3A3A3]">
                  Capital Inmovilizado (Plazos Fijos)
                </span>
                <p className="mt-1 font-mono-num text-base font-bold text-[#FAFAFA] break-words">
                  {isVaultHidden
                    ? MASKED_CURRENCY
                    : formatCurrency(accumulated.immobilizedInFixedTerms, currency)}
                </p>
                <Link
                  to="/fixed-terms"
                  className="mt-1 inline-flex items-center min-h-[44px] text-xs font-semibold text-[#FACC15] hover:underline"
                >
                  Gestionar plazos fijos &rarr;
                </Link>
              </div>

              <div className="min-w-0 rounded-[6px] bg-[#0A0A0A] border border-[#262626] px-3.5 py-2.5">
                <span className="text-[12px] text-[#A3A3A3]">
                  Patrimonio Total Ahorrado
                </span>
                <p className="mt-1 font-mono-num text-base font-bold text-[#22C55E] break-words">
                  {isVaultHidden
                    ? MASKED_CURRENCY
                    : formatCurrency(accumulated.totalPatrimony, currency)}
                </p>
                <span className="mt-1 block text-[11px] text-[#A3A3A3]">
                  Líquido + Inmovilizado
                </span>
              </div>

              <div className="min-w-0 rounded-[6px] bg-[#0A0A0A] border border-[#262626] px-3.5 py-2.5">
                <span className="text-[12px] text-[#A3A3A3]">
                  Metas mensuales congeladas
                </span>
                <p className="mt-1 font-mono-num text-base font-bold text-[#D4D4D4] break-words">
                  {isVaultHidden
                    ? MASKED_CURRENCY
                    : formatCurrency(accumulated.totalMonthlyTargetsFrozen, currency)}
                </p>
                <span className="mt-1 block text-[11px] text-[#A3A3A3] break-words">
                  Retiros acum.:{' '}
                  {isVaultHidden
                    ? MASKED_CURRENCY
                    : formatCurrency(accumulated.totalWithdrawals, currency)}
                </span>
              </div>
            </div>
          </Card>

          {/* Tarjeta lateral: Ahorro destinado en el período seleccionado */}
          <Card padding="lg" className="min-w-0 flex flex-col justify-between gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-[#A3A3A3]">
                Apartado en {monthLabel}
              </span>
              <Badge variant={monthBudget ? 'yellow' : 'neutral'}>
                {monthBudget
                  ? 'Snapshot activo'
                  : isFutureMonth
                    ? 'Proyección'
                    : 'Sin cierre'}
              </Badge>
            </div>

            <div className="min-w-0">
              <p className="font-mono-num text-2xl sm:text-[28px] font-bold text-[#FAFAFA] break-words">
                {formatCurrency(monthSummary.totalMonthlySavings, currency)}
              </p>
              <p className="mt-1 text-[13px] text-[#A3A3A3]">
                Monto operativo descontado del Disponible Real en {monthLabel}.
              </p>

              <div className="mt-4 pt-3 border-t border-[#1F1F1F] flex flex-col gap-1.5 text-sm">
                <div className="flex items-center justify-between gap-2 text-[#A3A3A3]">
                  <span>Ahorro mensual objetivo</span>
                  <span className="font-mono-num text-[#FAFAFA] shrink-0">
                    {formatCurrency(monthSummary.monthlyTarget, currency)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[#A3A3A3]">
                  <span>Aportes operativos del mes</span>
                  <span className="font-mono-num text-[#22C55E] shrink-0">
                    + {formatCurrency(monthSummary.extraDeposits, currency)}
                  </span>
                </div>
                {monthSummary.surplusDeposits > 0 ? (
                  <div className="flex items-center justify-between gap-2 text-[#A3A3A3]">
                    <span>Sobrante de tope trasladado</span>
                    <span className="font-mono-num text-[#FACC15] shrink-0">
                      + {formatCurrency(monthSummary.surplusDeposits, currency)}
                    </span>
                  </div>
                ) : null}
                {monthSummary.fixedTermReturns > 0 ? (
                  <div className="flex items-center justify-between gap-2 text-[#A3A3A3]">
                    <span>Retornos de Plazos Fijos</span>
                    <span className="font-mono-num text-[#22C55E] shrink-0">
                      + {formatCurrency(monthSummary.fixedTermReturns, currency)}
                    </span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-2 text-[#A3A3A3]">
                  <span>Salidas / retiros del mes</span>
                  <span className="font-mono-num text-[#F87171] shrink-0">
                    - {formatCurrency(monthSummary.withdrawals, currency)}
                  </span>
                </div>
              </div>
            </div>

            <Link
              to="/settings"
              className="inline-flex items-center min-h-[44px] text-sm font-semibold text-[#FACC15] hover:underline"
            >
              Ajustar meta mensual base &rarr;
            </Link>
          </Card>
        </section>
      )}

      {/* Historial de aportes extra y retiros */}
      <section aria-labelledby="savings-history-heading" className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2
              id="savings-history-heading"
              className="text-lg font-bold text-[#FAFAFA]"
            >
              Movimientos manuales de la Bóveda
            </h2>
            <p className="text-sm text-[#A3A3A3]">
              Aportes voluntarios y retiros registrados en tu bóveda personal.
            </p>
          </div>

          <div
            role="group"
            aria-label="Filtrar movimientos de ahorro"
            className="flex flex-wrap sm:inline-flex w-full sm:w-auto rounded-[6px] bg-[#121212] border border-[#262626] p-1 gap-1 self-start sm:self-auto"
          >
            <button
              type="button"
              aria-pressed={viewMode === 'month'}
              onClick={() => setViewMode('month')}
              className={[
                'flex-1 sm:flex-initial min-h-[44px] px-3 sm:px-3.5 py-1.5 rounded-[4px] text-xs sm:text-sm font-semibold transition-colors cursor-pointer text-center sm:whitespace-nowrap',
                viewMode === 'month'
                  ? 'bg-[#FACC15] text-[#0A0A0A]'
                  : 'text-[#D4D4D4] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Solo {monthLabel}
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'all'}
              onClick={() => setViewMode('all')}
              className={[
                'flex-1 sm:flex-initial min-h-[44px] px-3 sm:px-3.5 py-1.5 rounded-[4px] text-xs sm:text-sm font-semibold transition-colors cursor-pointer text-center sm:whitespace-nowrap',
                viewMode === 'all'
                  ? 'bg-[#FACC15] text-[#0A0A0A]'
                  : 'text-[#D4D4D4] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Todo el historial ({allEntries.length})
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="h-44 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
        ) : visibleEntries.length === 0 ? (
          <EmptyState
            title={
              viewMode === 'month'
                ? `Sin movimientos de ahorro en ${monthLabel}`
                : 'Todavía no registraste movimientos en tu bóveda'
            }
            description={
              viewMode === 'month'
                ? 'Podés sumar un aporte extra para apartar más dinero este mes o cambiar a "Todo el historial".'
                : 'Registrá tu primer aporte voluntario para construir reserva separada de tu saldo diario.'
            }
            actionLabel="+ Registrar aporte"
            onAction={() => openEntryModal('deposit')}
          />
        ) : (
          <>
            {/* Vista Desktop / Tablet */}
            <Card padding="none" className="hidden md:block overflow-hidden">
              <div className="overflow-x-auto">
                <table
                  aria-label="Historial de movimientos de la bóveda de ahorros"
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
                        Operación
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
                    {visibleEntries.map((entry) => {
                      const isDeposit = entry.entry_type === 'deposit';
                      const sourceBadge = formatSavingsSourceBadge(entry.source_type);
                      const isLinkedFixedTerm = Boolean(entry.fixed_term_id);

                      return (
                        <tr
                          key={entry.id}
                          className="hover:bg-[#171717] transition-colors"
                        >
                          <td className="py-3.5 px-4 font-mono-num text-sm text-[#D4D4D4] whitespace-nowrap">
                            {formatShortDate(entry.entry_date)}
                          </td>
                          <td className="py-3.5 px-4">
                            <p
                              title={entry.description}
                              className="font-semibold text-[#FAFAFA] break-words"
                            >
                              {entry.description}
                            </p>
                            {entry.notes ? (
                              <p
                                title={entry.notes}
                                className="text-[13px] text-[#A3A3A3] mt-0.5 line-clamp-1"
                              >
                                {entry.notes}
                              </p>
                            ) : null}
                          </td>
                          <td className="py-3.5 px-4 whitespace-nowrap">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={isDeposit ? 'yellow' : 'red'}>
                                {isDeposit ? 'Aporte' : 'Retiro'}
                              </Badge>
                              <Badge variant={sourceBadge.variant}>
                                {sourceBadge.label}
                              </Badge>
                            </div>
                          </td>
                          <td
                            className={[
                              'py-3.5 px-4 text-right font-mono-num font-bold whitespace-nowrap',
                              isDeposit ? 'text-[#22C55E]' : 'text-[#F87171]',
                            ].join(' ')}
                          >
                            {isDeposit ? '+' : '-'}{' '}
                            {formatCurrency(entry.amount, currency)}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            {isLinkedFixedTerm ? (
                              <Link
                                to="/fixed-terms"
                                className="inline-flex items-center min-h-[44px] px-2 text-xs font-semibold text-[#FACC15] hover:underline"
                              >
                                Ver Plazo Fijo
                              </Link>
                            ) : (
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => setDeletingTarget(entry)}
                              >
                                Eliminar
                              </Button>
                            )}
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
              {visibleEntries.map((entry) => {
                const isDeposit = entry.entry_type === 'deposit';
                const sourceBadge = formatSavingsSourceBadge(entry.source_type);
                const isLinkedFixedTerm = Boolean(entry.fixed_term_id);

                return (
                  <Card key={entry.id} padding="sm">
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p
                            title={entry.description}
                            className="text-[15px] font-bold text-[#FAFAFA] truncate"
                          >
                            {entry.description}
                          </p>
                          <p className="text-[13px] font-mono-num text-[#A3A3A3]">
                            {formatShortDate(entry.entry_date)}
                          </p>
                        </div>
                        <span
                          className={[
                            'font-mono-num text-base font-bold shrink-0',
                            isDeposit ? 'text-[#22C55E]' : 'text-[#F87171]',
                          ].join(' ')}
                        >
                          {isDeposit ? '+' : '-'}{' '}
                          {formatCurrency(entry.amount, currency)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={isDeposit ? 'yellow' : 'red'}>
                          {isDeposit ? 'Aporte' : 'Retiro'}
                        </Badge>
                        <Badge variant={sourceBadge.variant}>
                          {sourceBadge.label}
                        </Badge>
                      </div>

                      {entry.notes ? (
                        <p className="text-[13px] text-[#A3A3A3] break-words">
                          {entry.notes}
                        </p>
                      ) : null}

                      <div className="flex items-center justify-end pt-2 border-t border-[#1F1F1F]">
                        {isLinkedFixedTerm ? (
                          <Link
                            to="/fixed-terms"
                            className="inline-flex items-center min-h-[44px] px-2 text-xs font-semibold text-[#FACC15] hover:underline"
                          >
                            Gestionar en Plazos Fijos &rarr;
                          </Link>
                        ) : (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setDeletingTarget(entry)}
                          >
                            Eliminar
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* Modales */}
      {user ? (
        <SavingsEntryFormModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          userId={user.id}
          availableAccumulatedBalance={accumulated.liquidBalance}
          currency={currency}
          defaultMonthDate={monthDate}
          initialEntryType={modalEntryType}
          onSaved={loadSavingsData}
        />
      ) : null}

      <Modal
        isOpen={Boolean(deletingTarget)}
        onClose={() => setDeletingTarget(null)}
        title="Eliminar movimiento de ahorro"
        description={
          deletingTarget
            ? `¿Confirmás eliminar "${deletingTarget.description}" por ${formatCurrency(deletingTarget.amount, currency)}?`
            : undefined
        }
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#D4D4D4]">
            El saldo acumulado de tu bóveda y el Disponible Real del mes
            afectado se recalcularán automáticamente al eliminar este registro.
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
    </div>
  );
}
