/**
 * Widget de barra progresiva creciente (`0% → 100%`) para la Bolsa Compartida
 * de "Gustitos" (`GustitosProgressWidget`).
 *
 * Arquitectura y decisiones técnicas:
 * - Utiliza la misma mecánica creciente de izquierda a derecha (`0% → 100%`) que
 *   Comprometido, mostrando en amarillo `#FACC15` mientras `gastado < presupuesto`
 *   y pasando a rojo semántico `#EF4444` cuando alcanza o supera el `100%`.
 * - Incluye gastos variables marcados como Gustito y cuotas de Gustitos del mes.
 * - Reutiliza `linkButtonClasses` de `Button.tsx` para mantener paridad
 *   visual y estados interactivos consistentes con los botones del sistema UI.
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { linkButtonClasses } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatCurrency, formatPercent, roundCurrency } from '../../lib/formatters';
import type { GustitosSummary } from '../../types/database.types';

export interface GustitosProgressWidgetProps {
  gustitos: GustitosSummary;
  currency: string;
  monthLabel: string;
}

export function GustitosProgressWidget({
  gustitos,
  currency,
  monthLabel,
}: GustitosProgressWidgetProps) {
  if (!gustitos.isConfigured) {
    const missingBudget = gustitos.budget <= 0;
    const missingCategories = gustitos.gustitoCategoriesCount === 0;

    return (
      <Card
        padding="md"
        className="border-[#FACC15]/40 bg-[#121212] flex flex-col justify-between gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-[#FAFAFA]">
              Bolsa de Gustitos &mdash; {monthLabel}
            </h2>
          </div>
          <Badge variant="yellow">Sin configurar</Badge>
        </div>

        <p className="text-sm text-[#D4D4D4] leading-relaxed">
          {missingBudget && missingCategories
            ? 'Definí tu presupuesto mensual de Gustitos y elegí qué categorías integran la bolsa para activar el control 0% → 100%.'
            : missingBudget
              ? 'Ya elegiste categorías de Gustitos, pero todavía falta definir tu Presupuesto mensual de Gustitos.'
              : 'Ya definiste un presupuesto, pero todavía no marcaste ninguna categoría de gasto como Gustito.'}
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {missingBudget ? (
            <Link
              to="/settings"
              className={linkButtonClasses('primary', 'sm')}
            >
              Definir presupuesto en Configuración
            </Link>
          ) : null}
          {missingCategories ? (
            <Link
              to="/categories"
              className={linkButtonClasses('secondary', 'sm')}
            >
              Elegir categorías Gustito
            </Link>
          ) : null}
        </div>
      </Card>
    );
  }

  const usagePercent =
    gustitos.usagePercent ??
    (gustitos.budget > 0 ? roundCurrency((gustitos.spent / gustitos.budget) * 100) : 0);
  const barWidth = Math.min(100, Math.max(0, usagePercent));
  const isAtOrOverLimit = gustitos.spent >= gustitos.budget;

  return (
    <Card
      padding="md"
      highlight={isAtOrOverLimit ? 'red' : 'none'}
      className={
        isAtOrOverLimit
          ? 'bg-[#EF4444]/10 flex flex-col justify-between gap-4'
          : 'bg-[#121212] flex flex-col justify-between gap-4'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
              Bolsa de Gustitos &mdash; {monthLabel}
            </h2>
            <Badge variant={isAtOrOverLimit ? 'red' : 'yellow'}>
              {formatPercent(usagePercent)}
            </Badge>
          </div>
          <p
            className={[
              'mt-2 font-mono-num text-2xl sm:text-3xl font-extrabold tracking-tight',
              isAtOrOverLimit ? 'text-[#F87171]' : 'text-[#FAFAFA]',
            ].join(' ')}
          >
            {formatCurrency(gustitos.spent, currency)}
          </p>
          <p className="mt-0.5 text-xs text-[#A3A3A3]">
            Gastado en variables y cuotas de Gustitos
          </p>
        </div>

        <div className="text-left sm:text-right flex flex-col gap-1 text-sm">
          <div className="text-[#A3A3A3]">
            Presupuesto:{' '}
            <span className="font-mono-num font-semibold text-[#FAFAFA]">
              {formatCurrency(gustitos.budget, currency)}
            </span>
          </div>
          <div className="text-[#A3A3A3]">
            {gustitos.remaining > 0 ? 'Disponible: ' : 'Estado: '}
            <span
              className={[
                'font-mono-num font-semibold',
                isAtOrOverLimit ? 'text-[#F87171]' : 'text-[#FACC15]',
              ].join(' ')}
            >
              {gustitos.remaining > 0
                ? formatCurrency(gustitos.remaining, currency)
                : gustitos.remaining === 0
                  ? 'Tope alcanzado'
                  : `-${formatCurrency(Math.abs(gustitos.remaining), currency)}`}
            </span>
          </div>
        </div>
      </div>

      {/* Barra progresiva creciente de izquierda a derecha (0% -> 100%) */}
      <div className="flex flex-col gap-2">
        <div
          role="progressbar"
          aria-label="Consumo de la bolsa de Gustitos"
          aria-valuenow={Math.round(barWidth)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${formatPercent(usagePercent)} de ${formatCurrency(gustitos.budget, currency)}`}
          className="h-3 w-full rounded-full bg-[#262626] overflow-hidden"
        >
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${barWidth}%`,
              backgroundColor: isAtOrOverLimit ? '#EF4444' : '#FACC15',
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-[#A3A3A3]">
            {gustitos.gustitoCategoriesCount}{' '}
            {gustitos.gustitoCategoriesCount === 1
              ? 'categoría vinculada'
              : 'categorías vinculadas'}
          </span>
          {isAtOrOverLimit ? (
            <span className="font-semibold text-[#F87171] font-mono-num">
              {gustitos.remaining < 0
                ? `Excedido por ${formatCurrency(Math.abs(gustitos.remaining), currency)}`
                : 'Alcanzaste el 100% del presupuesto'}
            </span>
          ) : (
            <span className="text-[#D4D4D4] font-mono-num">
              {usagePercent.toFixed(0)}% consumido
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
