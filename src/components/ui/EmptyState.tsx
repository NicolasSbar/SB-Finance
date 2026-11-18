/**
 * Componente EmptyState para estados vacíos informativos sin ambigüedades.
 *
 * Arquitectura y decisiones técnicas:
 * - En lugar de dejar tablas o gráficos en blanco, comunicamos claramente al usuario
 *   qué falta en el período actual y ofrecemos una acción directa (botón Verbo + Objeto).
 */
import type { ReactNode } from 'react';
import { Button } from './Button';

export interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  isActionLoading?: boolean;
  icon?: ReactNode;
  headingLevel?: 'h2' | 'h3';
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  isActionLoading = false,
  icon,
  headingLevel = 'h3',
}: EmptyStateProps) {
  const HeadingTag = headingLevel;

  return (
    <div className="flex flex-col items-center justify-center text-center px-5 py-10 border border-dashed border-[#262626] rounded-[8px] bg-[#0F0F0F]">
      <div className="h-11 w-11 rounded-[8px] bg-[#1A1A1A] border border-[#262626] flex items-center justify-center text-[#FACC15] mb-3.5">
        {icon ?? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M5 7v11a2 2 0 002 2h10a2 2 0 002-2V7M9 12h6" />
          </svg>
        )}
      </div>
      <HeadingTag className="text-base font-semibold text-[#FAFAFA]">{title}</HeadingTag>
      <p className="mt-1.5 max-w-md text-sm text-[#A3A3A3] leading-relaxed">{description}</p>
      {actionLabel && onAction ? (
        <div className="mt-5">
          <Button
            variant="primary"
            size="sm"
            onClick={onAction}
            isLoading={isActionLoading}
          >
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
