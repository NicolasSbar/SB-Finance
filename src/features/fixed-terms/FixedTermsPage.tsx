/**
 * Pantalla de Gestión de Plazos Fijos (`/fixed-terms`).
 *
 * Arquitectura y decisiones técnicas:
 * - Aislamiento patrimonial estricto: los plazos fijos activos jamás se suman al
 *   `Disponible Real`. Al vencer (`hoy >= maturity_date`), pasan al estado visual
 *   `"Vencido — Pendiente de acreditar"` hasta que el usuario decide manualmente
 *   acreditarlos en su `Bóveda de Ahorros` (por defecto) o en el `Disponible Real del Mes`.
 * - Privacidad coherente: la tarjeta auxiliar de saldo líquido en Bóveda inicia oculta
 *   por defecto igual que `/savings`.
 * - Navegación y accesibilidad: integra `PageSubnav` (`group="investments"`), tabs
 *   WAI-ARIA con `useRovingTabs` en grilla responsiva, barra temporal `role="progressbar"`
 *   en depósitos activos, touch targets `>= 44px` y tabla de historial con encabezados
 *   `scope="col"` en desktop / tarjetas apiladas en móvil.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { PageSubnav } from '../../components/layout/PageSubnav';
import { Badge } from '../../components/ui/Badge';
import { Button, linkButtonClasses } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { useAuth } from '../../hooks/useAuth';
import { useRovingTabs } from '../../hooks/useRovingTabs';
import {
  calculateDaysBetweenDates,
  calculateDaysUntilDate,
  formatCurrency,
  formatFixedTermOriginLabel,
  formatShortDate,
  roundCurrency,
} from '../../lib/formatters';
import {
  deleteFixedTermDeposit,
  getFixedTermDeposits,
} from '../../services/fixedTermsService';
import { getAccumulatedSavingsBalance } from '../../services/savingsService';
import type { FixedTermDeposit } from '../../types/database.types';
import { AccreditFixedTermModal } from './AccreditFixedTermModal';
import { FixedTermFormModal } from './FixedTermFormModal';

const MASKED_CURRENCY = '$ ••••••••';
const FIXED_TERM_TABS = ['active', 'accredited'] as const;
type FixedTermTab = (typeof FIXED_TERM_TABS)[number];

export function FixedTermsPage() {
  const { user, userSettings } = useAuth();
  const [deposits, setDeposits] = useState<FixedTermDeposit[]>([]);
  const [liquidSavingsBalance, setLiquidSavingsBalance] = useState<number>(0);
  const [isVaultBalanceHidden, setIsVaultBalanceHidden] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<FixedTermTab>('active');

  const { getTabListProps, getTabProps, getPanelProps } = useRovingTabs<FixedTermTab>({
    tabs: FIXED_TERM_TABS,
    activeTab,
    onChange: setActiveTab,
    orientation: 'horizontal',
    idPrefix: 'fixed-terms',
  });

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  // Modales
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [accreditingTarget, setAccreditingTarget] =
    useState<FixedTermDeposit | null>(null);
  const [deletingTarget, setDeletingTarget] =
    useState<FixedTermDeposit | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const currency = userSettings?.currency ?? 'ARS';

  const loadFixedTermsData = useCallback(async () => {
    if (!user) return;
    if (!hasLoadedRef.current) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const [ftList, balance] = await Promise.all([
        getFixedTermDeposits(),
        getAccumulatedSavingsBalance(),
      ]);
      setDeposits(ftList);
      setLiquidSavingsBalance(balance.liquidBalance);
      hasLoadedRef.current = true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudieron cargar tus plazos fijos.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadFixedTermsData();
  }, [loadFixedTermsData]);

  const activeDeposits = useMemo(
    () => deposits.filter((ft) => ft.status === 'active'),
    [deposits],
  );
  const accreditedDeposits = useMemo(
    () =>
      deposits.filter(
        (ft) =>
          ft.status === 'accredited_savings' ||
          ft.status === 'accredited_available',
      ),
    [deposits],
  );

  const kpiTotals = useMemo(() => {
    let totalInvested = 0;
    let totalExpectedReturn = 0;
    let dueOrMaturedCount = 0;

    for (const ft of activeDeposits) {
      totalInvested = roundCurrency(totalInvested + ft.principal_amount);
      totalExpectedReturn = roundCurrency(
        totalExpectedReturn + ft.expected_return_amount,
      );
      if (calculateDaysUntilDate(ft.maturity_date) <= 0) {
        dueOrMaturedCount += 1;
      }
    }

    return {
      totalInvested,
      totalExpectedReturn,
      projectedProfit: roundCurrency(totalExpectedReturn - totalInvested),
      dueOrMaturedCount,
    };
  }, [activeDeposits]);

  async function handleConfirmDelete(): Promise<void> {
    if (!deletingTarget) return;
    setIsDeleting(true);
    try {
      await deleteFixedTermDeposit(deletingTarget.id);
      toast.success(
        `Plazo fijo "${deletingTarget.institution}" anulado correctamente.`,
      );
      setDeletingTarget(null);
      await loadFixedTermsData();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo anular el plazo fijo.';
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  }

  const visibleList = activeTab === 'active' ? activeDeposits : accreditedDeposits;

  return (
    <div className="flex flex-col gap-6">
      <PageSubnav group="investments" />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Plazos Fijos
          </h1>
          <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
            Registrá inversiones a plazo fijo desde tu Disponible del Mes o Bóveda de Ahorros y acreditá sus vencimientos sin mezclar saldos.
          </p>
        </div>

        <Button
          variant="primary"
          className="w-full sm:w-auto"
          onClick={() => setIsCreateModalOpen(true)}
        >
          + Nuevo Plazo Fijo
        </Button>
      </div>

      {/* KPIs superiores */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card padding="md" highlight="yellow" className="flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
              Capital Activo Inmovilizado
            </span>
            <Badge variant="neutral">{activeDeposits.length} activos</Badge>
          </div>
          <p className="font-mono-num text-2xl sm:text-3xl font-extrabold text-[#FACC15]">
            {formatCurrency(kpiTotals.totalInvested, currency)}
          </p>
          <p className="text-xs text-[#A3A3A3]">
            Aislado del Disponible Real hasta que elijas acreditarlo.
          </p>
        </Card>

        <Card padding="md" className="flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
              Retorno Total Esperado
            </span>
            {kpiTotals.dueOrMaturedCount > 0 ? (
              <Badge variant="yellow">
                {kpiTotals.dueOrMaturedCount} vencido(s)
              </Badge>
            ) : (
              <Badge variant="green">Proyectado</Badge>
            )}
          </div>
          <p className="font-mono-num text-2xl sm:text-3xl font-extrabold text-[#FAFAFA]">
            {formatCurrency(kpiTotals.totalExpectedReturn, currency)}
          </p>
          <p className="text-xs text-[#22C55E] font-mono-num font-medium">
            Interés estimado: + {formatCurrency(kpiTotals.projectedProfit, currency)}
          </p>
        </Card>

        <Card padding="md" className="flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
              Saldo Líquido en Bóveda
            </span>
            <button
              type="button"
              aria-pressed={!isVaultBalanceHidden}
              aria-label={
                isVaultBalanceHidden
                  ? 'Mostrar saldo líquido en Bóveda'
                  : 'Ocultar saldo líquido en Bóveda'
              }
              onClick={() => setIsVaultBalanceHidden((prev) => !prev)}
              className="btn-press min-h-[44px] px-3.5 rounded-[6px] border border-[#262626] bg-[#0A0A0A] text-xs font-semibold text-[#D4D4D4] hover:border-[#FACC15] hover:text-[#FAFAFA] cursor-pointer transition-colors shrink-0"
            >
              {isVaultBalanceHidden ? 'Mostrar' : 'Ocultar'}
            </button>
          </div>
          <p className="font-mono-num text-2xl sm:text-3xl font-extrabold text-[#FAFAFA]">
            {isVaultBalanceHidden
              ? MASKED_CURRENCY
              : formatCurrency(liquidSavingsBalance, currency)}
          </p>
          <Link
            to="/savings"
            className={linkButtonClasses(
              'secondary',
              'sm',
              'w-full justify-between text-[#FACC15] hover:text-[#FACC15]',
            )}
          >
            <span>Ir a Bóveda de Ahorros</span>
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </Card>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-[8px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-sm text-[#FAFAFA]">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void loadFixedTermsData()}>
            Reintentar carga
          </Button>
        </div>
      ) : null}

      {/* Pestañas Activos vs Acreditados */}
      <div
        {...getTabListProps('Filtrar plazos fijos')}
        className="grid grid-cols-2 w-full sm:inline-flex sm:w-auto rounded-[6px] bg-[#121212] border border-[#262626] p-1 gap-1 sm:self-start"
      >
        <button
          {...getTabProps('active')}
          className={[
            'min-h-[44px] px-2.5 sm:px-4 rounded-[4px] text-xs sm:text-sm font-semibold transition-colors cursor-pointer text-center leading-tight sm:whitespace-nowrap',
            activeTab === 'active'
              ? 'bg-[#FACC15] text-[#0A0A0A]'
              : 'text-[#D4D4D4] hover:text-[#FAFAFA]',
          ].join(' ')}
        >
          Activos y por acreditar ({activeDeposits.length})
        </button>
        <button
          {...getTabProps('accredited')}
          className={[
            'min-h-[44px] px-2.5 sm:px-4 rounded-[4px] text-xs sm:text-sm font-semibold transition-colors cursor-pointer text-center leading-tight sm:whitespace-nowrap',
            activeTab === 'accredited'
              ? 'bg-[#FACC15] text-[#0A0A0A]'
              : 'text-[#D4D4D4] hover:text-[#FAFAFA]',
          ].join(' ')}
        >
          Historial acreditados ({accreditedDeposits.length})
        </button>
      </div>

      <div
        {...getPanelProps(activeTab)}
        className="outline-none focus-visible:ring-2 focus-visible:ring-[#FACC15]/60 rounded-[8px]"
      >
        {isLoading ? (
          <div className="h-44 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
        ) : visibleList.length === 0 ? (
          <EmptyState
            title={
              activeTab === 'active'
                ? 'No tenés plazos fijos activos'
                : 'Todavía no acreditaste plazos fijos'
            }
            description={
              activeTab === 'active'
                ? 'Registrá un plazo fijo indicando si el capital sale del Disponible del Mes o de tu Bóveda de Ahorros.'
                : 'Cuando venza un plazo fijo activo y confirmes su acreditación, aparecerá en este historial.'
            }
            actionLabel={activeTab === 'active' ? '+ Nuevo Plazo Fijo' : undefined}
            onAction={
              activeTab === 'active' ? () => setIsCreateModalOpen(true) : undefined
            }
          />
        ) : activeTab === 'active' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activeDeposits.map((ft) => {
              const daysUntil = calculateDaysUntilDate(ft.maturity_date);
              const totalDays = Math.max(
                1,
                calculateDaysBetweenDates(ft.start_date, ft.maturity_date),
              );
              const elapsedDays = Math.min(
                totalDays,
                Math.max(0, totalDays - daysUntil),
              );
              const progressPercent = Math.min(
                100,
                Math.max(0, Math.round((elapsedDays / totalDays) * 100)),
              );
              const isMatured = daysUntil <= 0;
              const isDueSoon = daysUntil > 0 && daysUntil <= 3;
              const expectedProfit = roundCurrency(
                ft.expected_return_amount - ft.principal_amount,
              );

              return (
                <Card
                  key={ft.id}
                  padding="md"
                  highlight={isMatured ? 'yellow' : 'none'}
                  className="flex flex-col justify-between gap-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="text-base font-bold text-[#FAFAFA] truncate">
                        {ft.institution}
                      </h2>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="neutral">
                          Origen: {formatFixedTermOriginLabel(ft.origin)}
                        </Badge>
                        {isMatured ? (
                          <Badge variant="yellow">
                            Vencido &mdash; Pendiente de acreditar
                          </Badge>
                        ) : isDueSoon ? (
                          <Badge variant="yellow">
                            Vence en {daysUntil} {daysUntil === 1 ? 'día' : 'días'}
                          </Badge>
                        ) : (
                          <Badge variant="neutral">Vence en {daysUntil} días</Badge>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="text-xs text-[#A3A3A3] block">A recibir</span>
                      <span className="font-mono-num text-lg font-extrabold text-[#FACC15]">
                        {formatCurrency(ft.expected_return_amount, currency)}
                      </span>
                    </div>
                  </div>

                  {/* Barra de progreso temporal del plazo */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-[#A3A3A3]">Plazo transcurrido</span>
                      <span className="font-mono-num font-medium text-[#D4D4D4]">
                        {elapsedDays}/{totalDays}{' '}
                        {totalDays === 1 ? 'día' : 'días'} ({progressPercent}%)
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`Progreso del plazo de ${ft.institution}`}
                      aria-valuenow={progressPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="h-2 w-full overflow-hidden rounded-full bg-[#262626]"
                    >
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${progressPercent}%`,
                          backgroundColor: isMatured ? '#22C55E' : '#FACC15',
                        }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 rounded-[6px] bg-[#0A0A0A] border border-[#262626] p-3 text-xs">
                    <div>
                      <span className="text-[#A3A3A3] block">Capital invertido</span>
                      <span className="font-mono-num text-sm font-bold text-[#FAFAFA]">
                        {formatCurrency(ft.principal_amount, currency)}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[#A3A3A3] block">Rendimiento</span>
                      <span
                        className={[
                          'font-mono-num text-sm font-bold',
                          expectedProfit < 0 ? 'text-[#F87171]' : 'text-[#22C55E]',
                        ].join(' ')}
                      >
                        {expectedProfit >= 0 ? '+ ' : ''}
                        {formatCurrency(expectedProfit, currency)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#A3A3A3] block">Inicio</span>
                      <span className="font-mono-num text-[#D4D4D4]">
                        {formatShortDate(ft.start_date)}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[#A3A3A3] block">Vencimiento</span>
                      <span className="font-mono-num text-[#D4D4D4]">
                        {formatShortDate(ft.maturity_date)}
                      </span>
                    </div>
                  </div>

                  {ft.notes ? (
                    <p className="text-xs text-[#A3A3A3]">{ft.notes}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#1F1F1F]">
                    <Button
                      variant={isMatured ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setAccreditingTarget(ft)}
                    >
                      Acreditar vencimiento
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setDeletingTarget(ft)}
                    >
                      Anular
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <>
            {/* Historial acreditados: tabla contable en desktop */}
            <Card padding="none" className="hidden md:block overflow-hidden">
              <div className="overflow-x-auto">
                <table
                  aria-label="Historial de plazos fijos acreditados"
                  className="w-full text-left border-collapse"
                >
                  <thead>
                    <tr className="border-b border-[#262626] bg-[#0F0F0F] text-[13px] font-semibold text-[#A3A3A3]">
                      <th scope="col" className="py-3.5 px-4">
                        Entidad
                      </th>
                      <th scope="col" className="py-3.5 px-4">
                        Origen y destino
                      </th>
                      <th scope="col" className="py-3.5 px-4">
                        Inicio / Vencimiento
                      </th>
                      <th scope="col" className="py-3.5 px-4 text-right">
                        Capital
                      </th>
                      <th scope="col" className="py-3.5 px-4 text-right">
                        Rendimiento
                      </th>
                      <th scope="col" className="py-3.5 px-4 text-right">
                        Acreditado
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E1E1E] text-[15px]">
                    {accreditedDeposits.map((ft) => {
                      const accreditedAmount =
                        ft.actual_return_amount ?? ft.expected_return_amount;
                      const netProfit = roundCurrency(
                        accreditedAmount - ft.principal_amount,
                      );

                      return (
                        <tr
                          key={ft.id}
                          className="hover:bg-[#171717] transition-colors"
                        >
                          <td className="py-3.5 px-4">
                            <p className="font-semibold text-[#FAFAFA]">
                              {ft.institution}
                            </p>
                            {ft.notes ? (
                              <p
                                title={ft.notes}
                                className="text-[13px] text-[#A3A3A3] mt-0.5 line-clamp-1"
                              >
                                {ft.notes}
                              </p>
                            ) : null}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="neutral">
                                Origen: {formatFixedTermOriginLabel(ft.origin)}
                              </Badge>
                              <Badge variant="green">
                                {ft.status === 'accredited_savings'
                                  ? 'Acreditado en Bóveda'
                                  : 'Acreditado en Disponible'}
                              </Badge>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-mono-num text-sm text-[#D4D4D4] whitespace-nowrap">
                            {formatShortDate(ft.start_date)} &rarr;{' '}
                            {formatShortDate(ft.maturity_date)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono-num font-semibold text-[#FAFAFA] whitespace-nowrap">
                            {formatCurrency(ft.principal_amount, currency)}
                          </td>
                          <td
                            className={[
                              'py-3.5 px-4 text-right font-mono-num font-bold whitespace-nowrap',
                              netProfit < 0 ? 'text-[#F87171]' : 'text-[#22C55E]',
                            ].join(' ')}
                          >
                            {netProfit >= 0 ? '+ ' : ''}
                            {formatCurrency(netProfit, currency)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono-num font-extrabold text-[#FACC15] whitespace-nowrap">
                            {formatCurrency(accreditedAmount, currency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Historial acreditados: tarjetas apiladas en móvil */}
            <div className="grid grid-cols-1 gap-4 md:hidden">
              {accreditedDeposits.map((ft) => {
                const accreditedAmount =
                  ft.actual_return_amount ?? ft.expected_return_amount;
                const netProfit = roundCurrency(
                  accreditedAmount - ft.principal_amount,
                );

                return (
                  <Card
                    key={ft.id}
                    padding="md"
                    className="flex flex-col justify-between gap-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="text-base font-bold text-[#FAFAFA] truncate">
                          {ft.institution}
                        </h2>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge variant="neutral">
                            Origen: {formatFixedTermOriginLabel(ft.origin)}
                          </Badge>
                          <Badge variant="green">
                            {ft.status === 'accredited_savings'
                              ? 'Acreditado en Bóveda'
                              : 'Acreditado en Disponible'}
                          </Badge>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-xs text-[#A3A3A3] block">
                          Acreditado
                        </span>
                        <span className="font-mono-num text-lg font-extrabold text-[#FACC15]">
                          {formatCurrency(accreditedAmount, currency)}
                        </span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 rounded-[6px] bg-[#0A0A0A] border border-[#262626] p-3 text-xs">
                      <div>
                        <span className="text-[#A3A3A3] block">Capital invertido</span>
                        <span className="font-mono-num text-sm font-bold text-[#FAFAFA]">
                          {formatCurrency(ft.principal_amount, currency)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-[#A3A3A3] block">Rendimiento</span>
                        <span
                          className={[
                            'font-mono-num text-sm font-bold',
                            netProfit < 0 ? 'text-[#F87171]' : 'text-[#22C55E]',
                          ].join(' ')}
                        >
                          {netProfit >= 0 ? '+ ' : ''}
                          {formatCurrency(netProfit, currency)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#A3A3A3] block">Inicio</span>
                        <span className="font-mono-num text-[#D4D4D4]">
                          {formatShortDate(ft.start_date)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-[#A3A3A3] block">Vencimiento</span>
                        <span className="font-mono-num text-[#D4D4D4]">
                          {formatShortDate(ft.maturity_date)}
                        </span>
                      </div>
                    </div>

                    {ft.notes ? (
                      <p className="text-xs text-[#A3A3A3]">{ft.notes}</p>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>

      <FixedTermFormModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        liquidSavingsBalance={liquidSavingsBalance}
        currency={currency}
        onSaved={loadFixedTermsData}
      />

      <AccreditFixedTermModal
        isOpen={Boolean(accreditingTarget)}
        onClose={() => setAccreditingTarget(null)}
        fixedTerm={accreditingTarget}
        currency={currency}
        onAccredited={loadFixedTermsData}
      />

      <Modal
        isOpen={Boolean(deletingTarget)}
        onClose={() => setDeletingTarget(null)}
        title="Anular plazo fijo activo"
        description={
          deletingTarget
            ? `¿Confirmás anular "${deletingTarget.institution}" por ${formatCurrency(deletingTarget.principal_amount, currency)}?`
            : undefined
        }
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#D4D4D4]">
            {deletingTarget?.origin === 'savings_fund'
              ? 'El retiro asociado en tu Bóveda de Ahorros también se revertirá automáticamente.'
              : 'El capital dejará de descontarse del Disponible Real del mes de inicio.'}
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
              loadingText="Anulando..."
            >
              Confirmar anulación
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
