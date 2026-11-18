/**
 * Diálogo modal accesible con soporte de teclado (`Escape`), focus trap,
 * restauración de foco al cerrar y bloqueo de scroll.
 *
 * Arquitectura y decisiones técnicas:
 * - Implementamos el modal de forma nativa con `role="dialog"`, `aria-modal="true"`
 *   y un focus trap ligero (`Tab`/`Shift+Tab`) sin librerías externas pesadas,
 *   manteniendo el bundle liviano y sin dependencias UI redundantes.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

const SIZE_MAP: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'textarea:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  size = 'md',
  children,
}: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const dialogEl = dialogRef.current;
    if (dialogEl) {
      const focusables = getFocusableElements(dialogEl);
      const initialTarget = focusables[0] ?? dialogEl;
      initialTarget.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = getFocusableElements(dialogRef.current);
        if (focusables.length === 0) {
          event.preventDefault();
          dialogRef.current.focus();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (event.shiftKey) {
          if (
            active === first ||
            active === dialogRef.current ||
            !dialogRef.current.contains(active)
          ) {
            event.preventDefault();
            last.focus();
          }
        } else if (
          active === last ||
          !dialogRef.current.contains(active)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
        previousActiveElement.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-[2px] overflow-y-auto"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={[
          'w-full bg-[#121212] border border-[#262626] rounded-[8px] my-auto outline-none',
          'max-h-[92vh] flex flex-col overflow-hidden',
          SIZE_MAP[size],
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 sm:px-6 border-b border-[#262626]">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold text-[#FAFAFA] tracking-tight">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-sm text-[#A3A3A3]">{description}</p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ventana"
            className="min-h-[44px] min-w-[44px] -mr-2 -mt-1 inline-flex items-center justify-center rounded-[6px] text-[#A3A3A3] hover:text-[#FAFAFA] hover:bg-[#1E1E1E] cursor-pointer transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-5 sm:px-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
