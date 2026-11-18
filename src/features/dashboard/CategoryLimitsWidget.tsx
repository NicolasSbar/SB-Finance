/**
 * Widget de seguimiento de Límites Individuales por Categoría (`CategoryLimitsWidget`).
 *
 * Arquitectura y decisiones técnicas:
 * - Separa claramente los tres estados semánticos del progreso mensual:
 *   saludable (`<= 80%`, amarillo `#FACC15`), precaución (`> 80% y < 100%`, ámbar
 *   `#EAB308` con badge "Cerca del tope") y superado (`>= 100%`, rojo `#EF4444` nunca
 *   bloqueante).
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { formatCurrency, formatPercent } from '../../lib/formatters';
import type { CategoryLimitProgress } from '../../types/database.types';
import { CategoryIcon } from '../categories/CategoryFormModal';

export interface CategoryLimitsWidgetProps {
  categoryLimits: CategoryLimitProgress[];
  currency: string;
  monthLabel: string;
}

export function CategoryLimitsWidget({
  categoryLimits,
  currency,
  monthLabel,
}: CategoryLimitsWidgetProps) {
  return (
    <Card padding="md" className="flex flex-col justify-between gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
            Límites por Categoría
          </span>
          <h2 className="mt-1 text-base font-bold text-[#FAFAFA]">
            Topes mensuales de {monthLabel}
          </h2>
        </div>

        <Link
          to="/categories"
          className="inline-flex items-center min-h-[44px] px-2 -mx-2 text-xs sm:text-sm font-semibold text-[#FACC15] hover:underline"
        >
          Configurar topes &rarr;
        </Link>
      </div>

      {categoryLimits.length === 0 ? (
        <div className="rounded-[6px] border border-dashed border-[#262626] bg-[#0A0A0A] p-4 flex flex-col gap-2">
          <p className="text-sm font-medium text-[#D4D4D4]">
            Todavía no definiste límites individuales por categoría.
          </p>
          <p className="text-xs text-[#A3A3A3]">
            Podés asignar un tope mensual opcional a rubros sensibles (como Comida o Salidas) desde{' '}
            <Link to="/categories" className="text-[#FACC15] hover:underline font-semibold">
              Categorías
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          {categoryLimits.map((item) => {
            const isExceeded = item.usagePercent >= 100;
            const isWarning = item.usagePercent > 80 && item.usagePercent < 100;
            const barWidth = Math.min(100, Math.max(0, item.usagePercent));
            const barColor = isExceeded
              ? '#EF4444'
              : isWarning
                ? '#EAB308'
                : '#FACC15';

            return (
              <div
                key={item.categoryId}
                className="flex flex-col gap-1.5 pb-3 last:pb-0 border-b last:border-b-0 border-[#1F1F1F]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      aria-hidden="true"
                      className="h-7 w-7 shrink-0 rounded-[6px] bg-[#0A0A0A] border border-[#262626] flex items-center justify-center text-[#FACC15]"
                    >
                      <CategoryIcon icon={item.icon} className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-sm font-semibold text-[#FAFAFA] truncate">
                      {item.categoryName}
                    </span>
                    {item.isGustito ? <Badge variant="yellow">Gustito</Badge> : null}
                  </div>

                  <div className="flex items-center gap-2">
                    {isExceeded ? (
                      <Badge variant="red">Límite superado</Badge>
                    ) : isWarning ? (
                      <Badge variant="yellow">Cerca del tope</Badge>
                    ) : null}
                    <span
                      className={[
                        'font-mono-num text-xs font-bold',
                        isExceeded ? 'text-[#F87171]' : 'text-[#D4D4D4]',
                      ].join(' ')}
                    >
                      {formatPercent(item.usagePercent)}
                    </span>
                  </div>
                </div>

                <div
                  role="progressbar"
                  aria-label={`Consumo de ${item.categoryName}`}
                  aria-valuenow={Math.round(barWidth)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-2 w-full rounded-full bg-[#262626] overflow-hidden"
                >
                  <div
                    className="h-full transition-all duration-300"
                    style={{
                      width: `${barWidth}%`,
                      backgroundColor: barColor,
                    }}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#A3A3A3]">
                  <span className="font-mono-num">
                    {formatCurrency(item.spent, currency)} /{' '}
                    {formatCurrency(item.monthlyLimit, currency)}
                  </span>
                  <span
                    className={[
                      'font-mono-num font-medium',
                      item.remaining < 0 ? 'text-[#F87171]' : 'text-[#D4D4D4]',
                    ].join(' ')}
                  >
                    {item.remaining >= 0
                      ? `Restan ${formatCurrency(item.remaining, currency)}`
                      : `Excedido en ${formatCurrency(Math.abs(item.remaining), currency)}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
