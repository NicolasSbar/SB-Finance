/**
 * Cabecera ejecutiva de KPIs del Dashboard (`KpiSummaryGrid`).
 *
 * Arquitectura y decisiones técnicas:
 * - Jerarquía visual ejecutiva: posiciona `Disponible Real del Mes` como KPI
 *   protagonista con una línea ejecutiva de porcentaje libre tras apartados y un
 *   toggle opcional `"Ver fórmula"` para inspeccionar el desglose algebraico sin
 *   duplicar la tarjeta contigua `Ingresos y Flujo del Mes`.
 * - Tipografía numérica responsiva sin `break-all`: evita partir montos
 *   monetarios a mitad de dígito en `320px`/`390px` usando escala fluida `clamp(...)`.
 * - Acceso directo a compromisos: `onViewPending` opcional convierte el indicador
 *   `"Pendiente de abonar (X/Y)"` en un botón accesible (`min-h-[44px]`) preservando
 *   compatibilidad retroactiva con callers que no lo provean.
 * - Emparejamiento simétrico de barras `0% → 100%`: presenta la barra de Comprometido
 *   (Fijos + Cuotas No-Gustito) en paridad con la Bolsa de Gustitos (`gustitosSlot`).
 */
import { useId, useState, type ReactNode } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatCurrency, formatPercent, roundCurrency } from '../../lib/formatters';
import type { MonthlyFinancialSummary } from '../../types/database.types';

export interface KpiSummaryGridProps {
  summary: MonthlyFinancialSummary;
  currency: string;
  gustitosSlot?: ReactNode;
  onViewPending?: () => void;
  onAdjustBudget?: () => void;
  isBudgetActionDisabled?: boolean;
  onReviewSurplus?: () => void;
}

export function KpiSummaryGrid({
  summary,
  currency,
  gustitosSlot,
  onViewPending,
  onAdjustBudget,
  isBudgetActionDisabled = false,
  onReviewSurplus,
}: KpiSummaryGridProps) {
  const [showFormula, setShowFormula] = useState(false);
  const formulaId = useId();

  const freePercentOfIncome =
    summary.totalIncome > 0
      ? Math.max(0, roundCurrency((summary.realAvailable / summary.totalIncome) * 100))
      : 0;
  const realAvailableColor =
    summary.realAvailable > 0
      ? 'text-[#22C55E]'
      : summary.realAvailable < 0
        ? 'text-[#EF4444]'
        : 'text-[#FAFAFA]';

  const realAvailableHighlight =
    summary.realAvailable > 0
      ? 'green'
      : summary.realAvailable < 0
        ? 'red'
        : 'yellow';

  const usagePercent = summary.committedLimitUsagePercent;
  const isCaution =
    usagePercent !== null && usagePercent >= 85 && !summary.isOverFixedLimit;
  const barWidth =
    usagePercent !== null ? Math.min(100, Math.max(0, usagePercent)) : 0;
  const excessAmount = summary.isOverFixedLimit
    ? roundCurrency(summary.totalCommitted - summary.fixedExpensesLimit)
    : 0;

  return (
    <section
      aria-label="Indicadores financieros del mes"
      className="flex flex-col gap-4"
    >
      {/* Fila 1: KPI Protagonista Disponible Real + Resumen Compacto */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card
          padding="lg"
          highlight={realAvailableHighlight}
          className="lg:col-span-2 flex flex-col justify-between gap-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[#A3A3A3]">
              Disponible Real del Mes
            </h2>
            <Badge
              variant={
                summary.realAvailable > 0
                  ? 'green'
                  : summary.realAvailable < 0
                    ? 'red'
                    : 'neutral'
              }
            >
              {summary.realAvailable > 0
                ? 'Saldo saludable'
                : summary.realAvailable < 0
                  ? 'Déficit proyectado'
                  : 'En equilibrio'}
            </Badge>
          </div>

          <div>
            <p
              className={[
                'font-mono-num text-[clamp(1.375rem,6.2vw,2.25rem)] sm:text-4xl lg:text-[44px] font-extrabold tracking-tight leading-none',
                realAvailableColor,
              ].join(' ')}
            >
              {formatCurrency(summary.realAvailable, currency)}
            </p>

            {summary.gustitos.isConfigured ? (
              <p className="mt-2 text-xs text-[#D4D4D4]">
                {summary.gustitos.remaining > 0 ? (
                  <>
                    Incluye{' '}
                    <span className="font-mono-num font-semibold text-[#FACC15]">
                      {formatCurrency(summary.gustitos.remaining, currency)}
                    </span>{' '}
                    disponibles para Gustitos (de{' '}
                    <span className="font-mono-num">
                      {formatCurrency(summary.gustitos.budget, currency)}
                    </span>
                    ).
                  </>
                ) : (
                  <>
                    Presupuesto de Gustitos agotado (
                    <span className="font-mono-num text-[#F87171]">
                      {formatCurrency(summary.gustitos.spent, currency)}
                    </span>{' '}
                    gastados).
                  </>
                )}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-xs sm:text-sm text-[#A3A3A3]">
                De{' '}
                <span className="font-mono-num font-semibold text-[#D4D4D4]">
                  {formatCurrency(summary.totalIncome, currency)}
                </span>{' '}
                ingresados &middot;{' '}
                <span className="font-mono-num font-semibold text-[#FAFAFA]">
                  {formatPercent(freePercentOfIncome)}
                </span>{' '}
                libre tras Fijos y Ahorro
              </p>

              <button
                type="button"
                aria-expanded={showFormula}
                aria-controls={formulaId}
                onClick={() => setShowFormula((prev) => !prev)}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-2 -mx-2 -my-2 rounded-[6px] text-xs font-semibold text-[#FACC15] hover:text-[#EAB308] hover:underline underline-offset-4 transition-colors cursor-pointer shrink-0"
              >
                <span>{showFormula ? 'Ocultar fórmula' : 'Ver fórmula'}</span>
                <svg
                  className={[
                    'h-3.5 w-3.5 transition-transform duration-150',
                    showFormula ? 'rotate-180' : '',
                  ].join(' ')}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>

            {showFormula ? (
              <p
                id={formulaId}
                className="mt-2 pt-2.5 border-t border-[#1F1F1F] text-xs text-[#A3A3A3] leading-relaxed"
              >
                Cálculo (el cupo de Gustitos queda dentro):{' '}
                <span className="text-[#D4D4D4]">
                  Ingresos (<span className="font-mono-num">{formatCurrency(summary.totalIncome, currency)}</span>)
                </span>{' '}
                &minus;{' '}
                <span className="text-[#D4D4D4]">
                  Fijos (<span className="font-mono-num">{formatCurrency(summary.fixedReservedAmount, currency)}</span>)
                </span>{' '}
                &minus;{' '}
                <span className="text-[#D4D4D4]">
                  Ahorro (<span className="font-mono-num">{formatCurrency(summary.totalMonthlySavings, currency)}</span>)
                </span>{' '}
                &minus;{' '}
                <span className="text-[#D4D4D4]">
                  Variables (<span className="font-mono-num">{formatCurrency(summary.variableNonGustitoExpensesTotal, currency)}</span>)
                </span>
                {summary.gustitosReservedAmount > 0 ? (
                  <>
                    {' '}
                    &minus;{' '}
                    <span className="text-[#D4D4D4]">
                      Gustitos gastados (<span className="font-mono-num">{formatCurrency(summary.gustitosReservedAmount, currency)}</span>)
                    </span>
                  </>
                ) : null}
                {summary.fixedTermsInvestedFromAvailable > 0 ? (
                  <>
                    {' '}
                    &minus;{' '}
                    <span className="text-[#D4D4D4]">
                      Plazos Fijos (<span className="font-mono-num">{formatCurrency(summary.fixedTermsInvestedFromAvailable, currency)}</span>)
                    </span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>

          <div className="pt-3 border-t border-[#1F1F1F] flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
            {onViewPending ? (
              <button
                type="button"
                onClick={onViewPending}
                className="group inline-flex items-center gap-1.5 min-h-[44px] px-2 -mx-2 -my-2 rounded-[6px] text-left text-[#A3A3A3] hover:text-[#FAFAFA] hover:bg-[#1A1A1A] transition-colors cursor-pointer"
              >
                <span>
                  Pendiente de abonar ({summary.pendingCommitmentsCount}/
                  {summary.totalCommitmentsCount}):{' '}
                  <strong className="font-mono-num text-[#FACC15]">
                    {formatCurrency(summary.pendingCommitmentsTotal, currency)}
                  </strong>
                </span>
                <span
                  aria-hidden="true"
                  className="text-[#FACC15] group-hover:underline underline-offset-4"
                >
                  &rarr;
                </span>
                <span className="sr-only"> (ir a compromisos pendientes)</span>
              </button>
            ) : (
              <span className="text-[#A3A3A3]">
                Pendiente de abonar ({summary.pendingCommitmentsCount}/
                {summary.totalCommitmentsCount}):{' '}
                <strong className="font-mono-num text-[#FACC15]">
                  {formatCurrency(summary.pendingCommitmentsTotal, currency)}
                </strong>
              </span>
            )}
            <span className="text-[#A3A3A3]">
              Abonado:{' '}
              <strong className="font-mono-num text-[#22C55E]">
                {formatCurrency(summary.paidCommitmentsTotal, currency)}
              </strong>
            </span>
          </div>
        </Card>

        {/* Tarjeta 2: Resumen Compacto de Ingresos, Ahorro e Inversiones */}
        <Card padding="lg" className="flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#A3A3A3]">
              Ingresos y Flujo del Mes
            </h2>
            <Badge variant="green">Resumen</Badge>
          </div>

          <div>
            <p className="font-mono-num text-2xl sm:text-[28px] font-bold text-[#FAFAFA]">
              {formatCurrency(summary.totalIncome, currency)}
            </p>
            <span className="text-xs text-[#A3A3A3]">Ingresos totales del período</span>
          </div>

          <div className="pt-3 border-t border-[#1F1F1F] flex flex-col gap-1.5 text-xs sm:text-sm">
            <div className="flex items-center justify-between text-[#A3A3A3]">
              <span>Sueldo fijo</span>
              <span className="font-mono-num text-[#FAFAFA]">
                {formatCurrency(summary.fixedSalary, currency)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[#A3A3A3]">
              <span>Ingresos extra</span>
              <span className="font-mono-num text-[#22C55E]">
                + {formatCurrency(summary.extraIncomeTotal, currency)}
              </span>
            </div>
            {summary.fixedTermsReturnedToAvailable > 0 ? (
              <div className="flex items-center justify-between text-[#A3A3A3]">
                <span>Plazos Fijos acreditados</span>
                <span className="font-mono-num text-[#22C55E]">
                  + {formatCurrency(summary.fixedTermsReturnedToAvailable, currency)}
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between text-[#A3A3A3]">
              <span>Ahorro apartado</span>
              <span className="font-mono-num text-[#FACC15]">
                &minus; {formatCurrency(summary.totalMonthlySavings, currency)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[#A3A3A3]">
              <span>Variables no-Gustito</span>
              <span className="font-mono-num text-[#D4D4D4]">
                &minus; {formatCurrency(summary.variableNonGustitoExpensesTotal, currency)}
              </span>
            </div>
            {summary.fixedTermsInvestedFromAvailable > 0 ? (
              <div className="flex items-center justify-between text-[#A3A3A3]">
                <span>Plazos Fijos desde Disponible</span>
                <span className="font-mono-num text-[#D4D4D4]">
                  &minus; {formatCurrency(summary.fixedTermsInvestedFromAvailable, currency)}
                </span>
              </div>
            ) : null}
          </div>

          {onAdjustBudget ? (
            <div className="pt-2 border-t border-[#1F1F1F]">
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={onAdjustBudget}
                disabled={isBudgetActionDisabled}
              >
                Ajustar presupuesto del mes
              </Button>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Fila 2: Las 2 barras progresivas consistentes 0% -> 100% */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Barra 1: Comprometido (Fijos + Cuotas No-Gustito) */}
        <Card
          padding="md"
          highlight={summary.isOverFixedLimit ? 'red' : 'none'}
          className="flex flex-col justify-between gap-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
                  Comprometido (Fijos + Cuotas)
                </h2>
                {usagePercent !== null ? (
                  <Badge
                    variant={
                      summary.isOverFixedLimit
                        ? 'red'
                        : isCaution
                          ? 'yellow'
                          : 'neutral'
                    }
                  >
                    {formatPercent(usagePercent)}
                  </Badge>
                ) : (
                  <Badge variant="neutral">Sin límite</Badge>
                )}
              </div>
              <p className="mt-2 font-mono-num text-2xl sm:text-3xl font-extrabold tracking-tight text-[#FAFAFA]">
                {formatCurrency(summary.totalCommitted, currency)}
              </p>
              <p className="mt-0.5 text-xs text-[#A3A3A3]">
                Gastos fijos y cuotas no-Gustito
                {summary.gustitosInstallmentsTotal > 0
                  ? ` (excluye ${formatCurrency(summary.gustitosInstallmentsTotal, currency)} en cuotas de Gustitos)`
                  : ''}
              </p>
            </div>

            <div className="text-left sm:text-right flex flex-col gap-1 text-sm">
              <div className="text-[#A3A3A3]">
                Tope:{' '}
                <span className="font-mono-num font-semibold text-[#FAFAFA]">
                  {summary.fixedExpensesLimit > 0
                    ? formatCurrency(summary.fixedExpensesLimit, currency)
                    : 'Sin definir'}
                </span>
              </div>
              {summary.fixedCapSurplus > 0 ? (
                <div className="text-[#A3A3A3]">
                  Sobrante:{' '}
                  <span className="font-mono-num font-semibold text-[#FACC15]">
                    {formatCurrency(summary.fixedCapSurplus, currency)}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {summary.fixedExpensesLimit > 0 ? (
            <div className="flex flex-col gap-2">
              <div
                role="progressbar"
                aria-label="Uso del límite mensual de gastos fijos y cuotas"
                aria-valuenow={Math.round(barWidth)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={
                  usagePercent !== null
                    ? `${formatPercent(usagePercent)} del límite mensual`
                    : undefined
                }
                className="h-3 w-full rounded-full bg-[#262626] overflow-hidden"
              >
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${barWidth}%`,
                    backgroundColor: summary.isOverFixedLimit ? '#EF4444' : '#FACC15',
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-[#A3A3A3]">
                  {summary.fixedCapTransferredToSavings > 0
                    ? `Trasladado a ahorros: ${formatCurrency(summary.fixedCapTransferredToSavings, currency)}`
                    : 'Progreso 0% → 100% del tope fijo'}
                </span>
                {summary.isOverFixedLimit ? (
                  <span className="font-semibold text-[#F87171] font-mono-num">
                    Excedido por {formatCurrency(excessAmount, currency)}
                  </span>
                ) : (
                  <span className="text-[#D4D4D4] font-mono-num">
                    {(usagePercent ?? 0).toFixed(0)}% consumido
                  </span>
                )}
              </div>

              {onReviewSurplus && summary.fixedCapSurplus > 0 ? (
                <div className="pt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={onReviewSurplus}
                    className="inline-flex items-center gap-1 min-h-[44px] px-2 -mx-2 -my-2 rounded-[6px] text-xs font-medium text-[#A3A3A3] hover:text-[#FACC15] hover:underline underline-offset-4 transition-colors cursor-pointer"
                  >
                    <span>Revisar sobrante</span>
                    <span aria-hidden="true">&rarr;</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-[#A3A3A3]">
              Definí un Límite Fijos + Cuotas en Configuración para activar la barra de seguimiento.
            </p>
          )}
        </Card>

        {/* Barra 2: Bolsa de Gustitos 0% -> 100% (inyectada desde DashboardPage) */}
        {gustitosSlot ?? (
          <Card padding="md" className="flex flex-col justify-between gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
                Pendiente de Abonar
              </h2>
              <Badge variant={summary.pendingCommitmentsCount > 0 ? 'yellow' : 'green'}>
                {summary.pendingCommitmentsCount} de {summary.totalCommitmentsCount}
              </Badge>
            </div>
            <p className="font-mono-num text-2xl font-bold text-[#FACC15]">
              {formatCurrency(summary.pendingCommitmentsTotal, currency)}
            </p>
          </Card>
        )}
      </div>
    </section>
  );
}
