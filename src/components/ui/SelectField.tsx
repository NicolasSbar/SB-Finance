/**
 * Selector desplegable accesible (`SelectField`) alineado con el sistema de formularios.
 *
 * Arquitectura y decisiones técnicas:
 * - Comparte el mismo contrato de accesibilidad (`<label htmlFor>`, `aria-invalid`,
 *   `aria-describedby` y área táctil >= 44px) que `InputField` para mantener
 *   consistencia visual y de teclado en todos los modales.
 */
import { forwardRef, useId, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: SelectOption[];
  placeholder?: string;
  error?: string;
  hint?: string;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, options, placeholder, error, hint, id, className = '', ...rest },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = `${selectId}-error`;
  const hintId = `${selectId}-hint`;

  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <label
        htmlFor={selectId}
        className="text-[14px] font-medium text-[#FAFAFA] select-none"
      >
        {label}
        {rest.required ? (
          <span aria-hidden="true" className="text-[#FACC15] ml-1">
            *
          </span>
        ) : null}
      </label>

      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className={[
            'w-full min-h-[44px] appearance-none rounded-[6px] bg-[#0A0A0A] border text-[#FAFAFA]',
            'pl-3.5 pr-10 text-base sm:text-[15px] transition-colors cursor-pointer',
            error
              ? 'border-[#EF4444] focus:border-[#EF4444]'
              : 'border-[#262626] hover:border-[#3A3A3A] focus:border-[#FACC15]',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
          ].join(' ')}
          {...rest}
        >
          {placeholder ? (
            <option value="" className="bg-[#121212] text-[#A3A3A3]">
              {placeholder}
            </option>
          ) : null}
          {options.map((opt) => (
            <option
              key={opt.value}
              value={opt.value}
              disabled={opt.disabled}
              className="bg-[#121212] text-[#FAFAFA]"
            >
              {opt.label}
            </option>
          ))}
        </select>

        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#A3A3A3]"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
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
