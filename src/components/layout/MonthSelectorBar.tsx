/**
 * Selector de período mensual (`< Mes Año >`) con clasificación histórica.
 *
 * Arquitectura y decisiones técnicas:
 * - Diferencia visualmente si el usuario está viendo el `Mes Actual`, un `Historial Cerrado`
 *   (snapshots inmutables) o una `Proyección Futura` (cuotas pre-generadas + sueldo proyectado),
 *   ofreciendo un acceso de un clic para regresar al mes calendario en curso.
 */
import { useMonthlyPeriod } from '../../hooks/useMonthlyPeriod';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

export interface MonthSelectorBarProps {
  rightSlot?: React.ReactNode;
}

export function MonthSelectorBar({ rightSlot }: MonthSelectorBarProps) {
  const {
    monthLabel,
    classification,
    isCurrentMonth,
    goToPreviousMonth,
    goToNextMonth,
    goToCurrentMonth,
  } = useMonthlyPeriod();

  const badgeConfig =
    classification === 'current'
      ? { label: 'Mes actual', variant: 'yellow' as const }
      : classification === 'past'
        ? { label: 'Historial cerrado', variant: 'neutral' as const }
        : { label: 'Proyección futura', variant: 'neutral' as const };

  return (
    <div className="bg-[#121212] border border-[#262626] rounded-[8px] px-4 py-3.5 sm:px-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
        <div className="inline-flex items-center rounded-[6px] bg-[#0A0A0A] border border-[#262626]">
          <button
            type="button"
            onClick={goToPreviousMonth}
            aria-label="Mes anterior"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-[#D4D4D4] hover:text-[#FACC15] hover:bg-[#1A1A1A] rounded-l-[6px] transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z"
                clipRule="evenodd"
              />
            </svg>
          </button>

          <span className="px-3 sm:px-4 text-[15px] sm:text-base font-bold text-[#FAFAFA] min-w-[146px] text-center select-none">
            {monthLabel}
          </span>

          <button
            type="button"
            onClick={goToNextMonth}
            aria-label="Mes siguiente"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-[#D4D4D4] hover:text-[#FACC15] hover:bg-[#1A1A1A] rounded-r-[6px] transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        <Badge variant={badgeConfig.variant}>{badgeConfig.label}</Badge>

        {!isCurrentMonth ? (
          <Button variant="ghost" size="sm" onClick={goToCurrentMonth}>
            Volver a hoy
          </Button>
        ) : null}
      </div>

      {rightSlot ? (
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2.5">
          {rightSlot}
        </div>
      ) : null}
    </div>
  );
}
