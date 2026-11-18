/**
 * Modal de Acreditación Manual de Plazo Fijo (`AccreditFixedTermModal`).
 *
 * Arquitectura y decisiones técnicas:
 * - Destino seguro por defecto (`savings_fund`): al acreditar un plazo fijo, propone
 *   enviarlo a la Bóveda de Ahorros sin contaminar el Disponible Real del mes,
 *   ofreciendo la opción explícita de acreditarlo al `Disponible Real del Mes` cuando
 *   el usuario desee gastar ese dinero.
 * - Validación temporal y advertencias explícitas: prellena la fecha local actual
 *   (`today`) en lugar de una fecha futura de vencimiento, valida
 *   `accredited_date >= start_date` vía `accreditFixedTermSchema`, y muestra alertas
 *   visibles si el usuario acredita anticipadamente (`accredited_date < maturity_date`)
 *   o con pérdida respecto del capital invertido (`actual_return_amount < principal_amount`).
 */
import { useEffect, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import {
  formatCurrency,
  formatMonthLabel,
  formatShortDate,
  roundCurrency,
  toLocalISODate,
  toMonthStartISODate,
} from '../../lib/formatters';
import {
  accreditFixedTermSchema,
  isValidCalendarDate,
} from '../../lib/validations';
import { accreditFixedTermDeposit } from '../../services/fixedTermsService';
import type { FixedTermDeposit, FixedTermOrigin } from '../../types/database.types';

export interface AccreditFixedTermModalProps {
  isOpen: boolean;
  onClose: () => void;
  fixedTerm: FixedTermDeposit | null;
  currency: string;
  onAccredited: () => Promise<void>;
}

export function AccreditFixedTermModal({
  isOpen,
  onClose,
  fixedTerm,
  currency,
  onAccredited,
}: AccreditFixedTermModalProps) {
  const [destination, setDestination] = useState<FixedTermOrigin>('savings_fund');
  const [actualReturnInput, setActualReturnInput] = useState('');
  const [accreditedDate, setAccreditedDate] = useState(toLocalISODate());
  const [errors, setErrors] = useState<{
    actual_return_amount?: string;
    accredited_date?: string;
  }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen || !fixedTerm) return;
    setErrors({});
    setDestination('savings_fund');
    setActualReturnInput(String(fixedTerm.expected_return_amount));
    setAccreditedDate(toLocalISODate());
  }, [isOpen, fixedTerm]);

  const targetMonthLabel = isValidCalendarDate(accreditedDate)
    ? formatMonthLabel(toMonthStartISODate(accreditedDate))
    : '';

  const parsedActualReturn = Number(actualReturnInput);
  const hasNumericReturn =
    actualReturnInput.trim() !== '' && Number.isFinite(parsedActualReturn);
  const effectiveReturn = hasNumericReturn
    ? parsedActualReturn
    : (fixedTerm?.expected_return_amount ?? 0);
  const netYield = fixedTerm
    ? roundCurrency(effectiveReturn - fixedTerm.principal_amount)
    : 0;
  const isEarlyAccreditation = Boolean(
    fixedTerm &&
      isValidCalendarDate(accreditedDate) &&
      accreditedDate < fixedTerm.maturity_date,
  );
  const isLossReturn = Boolean(
    fixedTerm &&
      hasNumericReturn &&
      parsedActualReturn < fixedTerm.principal_amount,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!fixedTerm) return;
    setErrors({});

    const parsed = accreditFixedTermSchema.safeParse({
      destination,
      actual_return_amount: actualReturnInput,
      accredited_date: accreditedDate,
      start_date: fixedTerm.start_date,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        actual_return_amount: flat.actual_return_amount?.[0],
        accredited_date: flat.accredited_date?.[0],
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await accreditFixedTermDeposit(fixedTerm.id, {
        destination: parsed.data.destination,
        actual_return_amount: parsed.data.actual_return_amount,
        accredited_date: parsed.data.accredited_date,
      });
      toast.success(
        parsed.data.destination === 'savings_fund'
          ? `Acreditaste ${formatCurrency(parsed.data.actual_return_amount, currency)} en tu Bóveda de Ahorros.`
          : `Acreditaste ${formatCurrency(parsed.data.actual_return_amount, currency)} al Disponible Real de ${targetMonthLabel}.`,
      );
      await onAccredited();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo acreditar el plazo fijo.';
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Acreditar vencimiento de Plazo Fijo"
      description={
        fixedTerm
          ? `${fixedTerm.institution} — Capital original: ${formatCurrency(fixedTerm.principal_amount, currency)}`
          : undefined
      }
      size="md"
    >
      {fixedTerm ? (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span
              id="accredit-dest-label"
              className="text-[14px] font-medium text-[#FAFAFA]"
            >
              ¿Dónde querés acreditar el dinero?{' '}
              <span aria-hidden="true" className="text-[#FACC15]">
                *
              </span>
            </span>
            <div
              role="group"
              aria-labelledby="accredit-dest-label"
              className="grid grid-cols-1 sm:grid-cols-2 gap-2.5"
            >
              <button
                type="button"
                aria-pressed={destination === 'savings_fund'}
                onClick={() => setDestination('savings_fund')}
                className={[
                  'min-h-[52px] px-3.5 py-2.5 rounded-[6px] border text-left transition-colors cursor-pointer',
                  destination === 'savings_fund'
                    ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FAFAFA]'
                    : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
                ].join(' ')}
              >
                <span className="block text-sm font-bold text-[#FAFAFA]">
                  Bóveda de Ahorros (Por defecto)
                </span>
                <span className="block text-xs text-[#A3A3A3] mt-0.5">
                  Suma a tus reservas líquidas ocultas del Dashboard.
                </span>
              </button>

              <button
                type="button"
                aria-pressed={destination === 'monthly_available'}
                onClick={() => setDestination('monthly_available')}
                className={[
                  'min-h-[52px] px-3.5 py-2.5 rounded-[6px] border text-left transition-colors cursor-pointer',
                  destination === 'monthly_available'
                    ? 'border-[#22C55E] bg-[#22C55E]/12 text-[#FAFAFA]'
                    : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
                ].join(' ')}
              >
                <span className="block text-sm font-bold text-[#FAFAFA]">
                  Disponible Real del Mes
                </span>
                <span className="block text-xs text-[#22C55E] mt-0.5">
                  Se suma al ingreso disponible de{' '}
                  {targetMonthLabel || 'el mes seleccionado'}.
                </span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <InputField
              label="Monto final recibido"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              prefixText="$"
              value={actualReturnInput}
              onChange={(e) => {
                setActualReturnInput(e.target.value);
                setErrors((prev) => ({
                  ...prev,
                  actual_return_amount: undefined,
                }));
              }}
              error={errors.actual_return_amount}
              hint={`Esperado: ${formatCurrency(fixedTerm.expected_return_amount, currency)}`}
              required
            />

            <InputField
              label="Fecha de acreditación"
              type="date"
              min={fixedTerm.start_date}
              value={accreditedDate}
              onChange={(e) => {
                setAccreditedDate(e.target.value);
                setErrors((prev) => ({ ...prev, accredited_date: undefined }));
              }}
              error={errors.accredited_date}
              required
            />
          </div>

          {isEarlyAccreditation ? (
            <div
              role="status"
              className="rounded-[6px] border border-[#FACC15]/50 bg-[#FACC15]/10 p-3 text-xs text-[#FEF08A]"
            >
              <strong className="font-semibold text-[#FACC15]">
                Acreditación anticipada:
              </strong>{' '}
              la fecha elegida es anterior al vencimiento pactado (
              {formatShortDate(fixedTerm.maturity_date)}). Verificá que el monto
              recibido corresponda a una cancelación anticipada.
            </div>
          ) : null}

          {isLossReturn ? (
            <div
              role="alert"
              className="rounded-[6px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-3 text-xs text-[#FCA5A5]"
            >
              <strong className="font-semibold text-[#F87171]">
                Retorno menor al capital invertido:
              </strong>{' '}
              el monto final ingresado (
              {formatCurrency(parsedActualReturn, currency)}) es inferior al
              capital original (
              {formatCurrency(fixedTerm.principal_amount, currency)}). Confirmá
              si querés registrar esta pérdida.
            </div>
          ) : null}

          <div className="rounded-[6px] border border-[#262626] bg-[#0A0A0A] p-3.5 text-sm flex items-center justify-between gap-2">
            <span className="text-[#A3A3A3]">Rendimiento neto obtenido</span>
            <span
              className={[
                'font-mono-num font-bold',
                netYield < 0 ? 'text-[#F87171]' : 'text-[#22C55E]',
              ].join(' ')}
            >
              {netYield > 0 ? '+ ' : ''}
              {formatCurrency(netYield, currency)}
            </span>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
            <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              isLoading={isSubmitting}
              loadingText="Acreditando..."
            >
              Confirmar acreditación
            </Button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}
