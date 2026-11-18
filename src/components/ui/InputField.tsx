/**
 * Campo de entrada accesible (`InputField`) con etiqueta visible y error individual.
 *
 * Arquitectura y decisiones técnicas:
 * - Toda entrada lleva `<label htmlFor>` visible arriba, tamaño base de 16px en mobile
 *   (evita el auto-zoom en Safari iOS), altura mínima de 44px y mensaje de error
 *   individual bajo el campo vinculado mediante `aria-describedby`.
 */
import { forwardRef, useId, type InputHTMLAttributes } from 'react';

export interface InputFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
  prefixText?: string;
}

export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(function InputField(
  { label, error, hint, prefixText, id, className = '', ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <label
        htmlFor={inputId}
        className="text-[14px] font-medium text-[#FAFAFA] select-none"
      >
        {label}
        {rest.required ? (
          <span aria-hidden="true" className="text-[#FACC15] ml-1">
            *
          </span>
        ) : null}
      </label>

      <div className="relative flex items-center">
        {prefixText ? (
          <span
            aria-hidden="true"
            className="absolute left-3.5 text-[#A3A3A3] text-[15px] font-mono-num pointer-events-none"
          >
            {prefixText}
          </span>
        ) : null}

        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className={[
            'w-full min-h-[44px] rounded-[6px] bg-[#0A0A0A] border text-[#FAFAFA] placeholder-[#8A8A8A]',
            'text-base sm:text-[15px] transition-colors',
            prefixText ? 'pl-9 pr-3.5' : 'px-3.5',
            error
              ? 'border-[#EF4444] focus:border-[#EF4444]'
              : 'border-[#262626] hover:border-[#3A3A3A] focus:border-[#FACC15]',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
          ].join(' ')}
          {...rest}
        />
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-[13px] text-[#EF4444] font-medium">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[13px] text-[#A3A3A3]">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
