/**
 * Componente Badge para etiquetas de estado y clasificación financiera.
 *
 * Arquitectura y decisiones técnicas:
 * - Restringe estrictamente los colores semánticos: verde para ingresos/pagado,
 *   rojo para gastos/alertas de límite y amarillo/neutro para estados de marca o pendientes.
 */
import type { ReactNode } from 'react';

export type BadgeVariant = 'yellow' | 'green' | 'red' | 'neutral';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const BADGE_CLASSES: Record<BadgeVariant, string> = {
  yellow: 'bg-[#FACC15]/15 text-[#FACC15] border-[#FACC15]/40',
  green: 'bg-[#22C55E]/12 text-[#22C55E] border-[#22C55E]/35',
  red: 'bg-[#EF4444]/12 text-[#F87171] border-[#EF4444]/40',
  neutral: 'bg-[#1F1F1F] text-[#D4D4D4] border-[#333333]',
};

export function Badge({
  variant = 'neutral',
  children,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] border text-[13px] font-medium leading-none whitespace-nowrap',
        BADGE_CLASSES[variant],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}
