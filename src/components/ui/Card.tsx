/**
 * Componente Card de superficie oscura de alto contraste.
 *
 * Arquitectura y decisiones técnicas:
 * - Mantiene un radio uniforme (`rounded-[8px]`) y borde 1px sólido (`#262626`)
 *   sin sombras difusas artificiales ni gradientes decorativos.
 * - Cuando `interactive` es true, aplica la micro-interacción `.card-interactive`
 *   (elevación silenciosa de -2px y acento amarillo sutil en el borde).
 */
import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  highlight?: 'none' | 'yellow' | 'green' | 'red';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: ReactNode;
}

const HIGHLIGHT_CLASSES: Record<NonNullable<CardProps['highlight']>, string> = {
  none: 'border-[#262626]',
  yellow: 'border-[#FACC15]/50',
  green: 'border-[#22C55E]/40',
  red: 'border-[#EF4444]/50',
};

const PADDING_CLASSES: Record<NonNullable<CardProps['padding']>, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5 sm:p-6',
  lg: 'p-4 sm:p-6 lg:p-7',
};

export function Card({
  interactive = false,
  highlight = 'none',
  padding = 'md',
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={[
        'bg-[#121212] border rounded-[8px]',
        HIGHLIGHT_CLASSES[highlight],
        PADDING_CLASSES[padding],
        interactive ? 'card-interactive' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
