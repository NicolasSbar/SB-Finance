/**
 * Componente Button del sistema UI SB-Finance.
 *
 * Arquitectura y decisiones técnicas:
 * - Altura mínima de 44px para cumplir el estándar táctil en mobile (`390px`/`320px`).
 * - Estado `isLoading` integrado que deshabilita automáticamente el botón para evitar
 *   dobles envíos en acciones de escritura contra Supabase y ofrece respaldo visual y
 *   de lector de pantalla bajo `prefers-reduced-motion`.
 * - Exporta `linkButtonClasses` para que enlaces `<Link>` de React Router compartan
 *   exactamente la misma jerarquía visual y estados de `Button` sin duplicar clases.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'sm' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  loadingText?: string;
  children: ReactNode;
}

const BASE_CLASSES =
  'btn-press inline-flex items-center justify-center gap-2 rounded-[6px] whitespace-nowrap select-none cursor-pointer';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-[#FACC15] text-[#0A0A0A] font-bold hover:bg-[#EAB308] border border-[#FACC15] hover:border-[#EAB308]',
  secondary:
    'bg-[#141414] text-[#FAFAFA] font-semibold hover:bg-[#1E1E1E] border border-[#262626] hover:border-[#3A3A3A]',
  danger:
    'bg-[#EF4444]/15 text-[#F87171] font-semibold hover:bg-[#EF4444] hover:text-[#0A0A0A] border border-[#EF4444]/40 hover:border-[#EF4444]',
  ghost:
    'bg-transparent text-[#D4D4D4] font-medium hover:bg-[#1A1A1A] hover:text-[#FAFAFA] border border-transparent',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'min-h-[44px] px-3.5 text-sm',
  md: 'min-h-[44px] px-5 text-sm sm:text-[15px]',
  lg: 'min-h-[48px] px-6 text-base',
};

export function linkButtonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className = '',
): string {
  return [
    BASE_CLASSES,
    'no-underline',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  loadingText,
  disabled,
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = Boolean(disabled || isLoading);

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={isLoading}
      className={[
        BASE_CLASSES,
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {isLoading && (
        <>
          <svg
            className="h-4 w-4 animate-spin shrink-0 motion-reduce:hidden"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
            />
            <path
              className="opacity-90"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
            />
          </svg>
          <svg
            className="hidden h-4 w-4 shrink-0 motion-reduce:inline-block"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="5" cy="12" r="2.2" opacity="0.45" />
            <circle cx="12" cy="12" r="2.2" opacity="0.8" />
            <circle cx="19" cy="12" r="2.2" />
          </svg>
        </>
      )}
      <span>
        {isLoading && loadingText ? loadingText : children}
        {isLoading && !loadingText ? (
          <>
            <span aria-hidden="true" className="hidden motion-reduce:inline">
              ...
            </span>
            <span className="sr-only"> (cargando)</span>
          </>
        ) : null}
      </span>
    </button>
  );
}
