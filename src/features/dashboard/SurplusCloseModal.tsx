/**
 * Modal guiado de Revisión de Cierre y Sobrante de Tope (`SurplusCloseModal`).
 *
 * Arquitectura y decisiones técnicas:
 * - Flujo guiado en 2 pasos: primero recuerda revisar si quedó algún gasto
 *   sin cargar (ofreciendo acceso inmediato al registro rápido) antes de distribuir
 *   el sobrante real del Límite de Gastos Fijos (`p_bucket = 'fixed_limit'`).
 * - Permite elegir monto parcial o total (`<= sobrante`) y decidir entre enviarlo a
 *   la Bóveda de Ahorros (sin doble descuento) o liberarlo al Disponible Real.
 * - Desacoplamiento de efectos: el reinicio al Paso 1 ocurre únicamente en la
 *   transición de apertura (`isOpen`: `false -> true` mediante `useRef`),
 *   separado de la sincronización de montos sugeridos cuando cambia `summary.fixedCapSurplus`.
 */
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import {
  formatCurrency,
  formatMonthLabel,
  roundCurrency,
  toMonthStartISODate,
} from '../../lib/formatters';
import { reconcileSurplusSchema } from '../../lib/validations';
import { reconcileCapSurplus } from '../../services/settingsService';
import type {
  MonthlyFinancialSummary,
  SurplusAction,
} from '../../types/database.types';

export interface SurplusCloseModalProps {
  isOpen: boolean;
  onClose: () => void;
  summary: MonthlyFinancialSummary;
  monthLabel: string;
  currency: string;
  onRegisterForgottenExpense: () => void;
  onReconciled: () => Promise<void>;
}

export function SurplusCloseModal({
  isOpen,
  onClose,
  summary,
  monthLabel,
  currency,
  onRegisterForgottenExpense,
  onReconciled,
}: SurplusCloseModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [fixedAmountInput, setFixedAmountInput] = useState<string>('');
  const [fixedError, setFixedError] = useState<string | undefined>(undefined);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  const currentCalendarMonth = toMonthStartISODate(new Date());
  const isClosingPastMonth = summary.monthDate < currentCalendarMonth;
  const currentMonthLabel = formatMonthLabel(currentCalendarMonth);

  // Reinicia al Paso 1 solo al abrir el modal (false -> true)
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setStep(1);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  // Sincroniza el monto sugerido de Gastos Fijos cuando el modal está abierto o cambia su sobrante
  useEffect(() => {
    if (!isOpen) return;
    setFixedError(undefined);
    setFixedAmountInput(
      summary.fixedCapSurplus > 0 ? String(summary.fixedCapSurplus) : '',
    );
  }, [isOpen, summary.fixedCapSurplus]);

  const totalSurplus = roundCurrency(summary.fixedCapSurplus);

  async function handleAction(
    action: Exclude<SurplusAction, 'mark_reviewed'>,
  ): Promise<void> {
    setFixedError(undefined);

    const parsed = reconcileSurplusSchema.safeParse({
      bucket: 'fixed_limit',
      action,
      amount: fixedAmountInput,
    });

    if (!parsed.success) {
      setFixedError(parsed.error.flatten().fieldErrors.amount?.[0]);
      return;
    }

    if (parsed.data.amount > summary.fixedCapSurplus) {
      setFixedError(
        `El monto supera el sobrante disponible (${formatCurrency(summary.fixedCapSurplus, currency)}).`,
      );
      return;
    }

    const opKey = `fixed_limit:${action}`;
    setBusyKey(opKey);
    try {
      await reconcileCapSurplus({
        month_date: summary.monthDate,
        bucket: 'fixed_limit',
        action,
        amount: parsed.data.amount,
        target_income_month: isClosingPastMonth ? currentCalendarMonth : null,
      });

      toast.success(
        action === 'to_savings'
          ? `Trasladaste ${formatCurrency(parsed.data.amount, currency)} a tu Bóveda de Ahorros sin doble descuento.`
          : isClosingPastMonth
            ? `Liberaste ${formatCurrency(parsed.data.amount, currency)} al Disponible Real de ${currentMonthLabel}.`
            : `Liberaste ${formatCurrency(parsed.data.amount, currency)} al Disponible Real de ${monthLabel}.`,
      );

      await onReconciled();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo procesar el sobrante seleccionado.';
      toast.error(msg);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleMarkReviewedAndClose(): Promise<void> {
    setBusyKey('mark_reviewed');
    try {
      await reconcileCapSurplus({
        month_date: summary.monthDate,
        bucket: 'fixed_limit',
        action: 'mark_reviewed',
        amount: 0,
      });
      toast.success(`Revisión de cierre de ${monthLabel} completada.`);
      await onReconciled();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo marcar la revisión como completada.';
      toast.error(msg);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Revisión de cierre y sobrante — ${monthLabel}`}
      description="Confirmá que tus gastos estén completos y decidí qué hacer con el cupo que no usaste."
      size="lg"
    >
      <div className="flex flex-col gap-5">
        {/* Indicador de pasos */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setStep(1)}
            aria-current={step === 1 ? 'step' : undefined}
            className={[
              'min-h-[44px] px-3 py-2 rounded-[6px] border text-left text-sm font-semibold transition-colors cursor-pointer',
              step === 1
                ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
            ].join(' ')}
          >
            1. Verificar gastos olvidados
          </button>
          <button
            type="button"
            onClick={() => setStep(2)}
            aria-current={step === 2 ? 'step' : undefined}
            className={[
              'min-h-[44px] px-3 py-2 rounded-[6px] border text-left text-sm font-semibold transition-colors cursor-pointer',
              step === 2
                ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
            ].join(' ')}
          >
            2. Destino del sobrante ({formatCurrency(totalSurplus, currency)})
          </button>
        </div>

        {step === 1 ? (
          <div className="flex flex-col gap-4 rounded-[8px] border border-[#262626] bg-[#0A0A0A] p-5">
            <div className="flex flex-col gap-1.5">
              <h3 className="text-base font-bold text-[#FAFAFA]">
                ¿Te olvidaste de registrar algún gasto en {monthLabel}?
              </h3>
              <p className="text-sm text-[#A3A3A3] leading-relaxed">
                Antes de enviar o liberar dinero sobrante de tu tope de gastos fijos,
                verificá que no haya quedado ningún gasto chico, compra con débito o
                cuota pendiente sin cargar en el período.
              </p>
            </div>

            <div className="rounded-[6px] border border-[#262626] bg-[#121212] p-3.5">
              <span className="text-xs text-[#A3A3A3]">
                Sobrante actual en Límite de Gastos Fijos
              </span>
              <p className="mt-1 font-mono-num text-lg font-bold text-[#FACC15]">
                {formatCurrency(summary.fixedCapSurplus, currency)}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 pt-2">
              <Button
                variant="secondary"
                onClick={() => {
                  onClose();
                  onRegisterForgottenExpense();
                }}
              >
                + Registrar gasto olvidado
              </Button>
              <Button variant="primary" onClick={() => setStep(2)}>
                Todo al día, decidir destino &rarr;
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {totalSurplus <= 0 ? (
              <div className="rounded-[8px] border border-[#22C55E]/40 bg-[#22C55E]/10 p-5 text-sm text-[#FAFAFA]">
                <p className="font-bold text-[#22C55E]">
                  No queda saldo sobrante pendiente en {monthLabel}.
                </p>
                <p className="mt-1 text-[#D4D4D4]">
                  Tu tope de gastos fijos ya fue utilizado o conciliado correctamente.
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-[#A3A3A3] leading-relaxed">
                  {isClosingPastMonth
                    ? `Al enviar a la Bóveda de Ahorros aumenta tu reserva sin doble descuento. Al liberar al Disponible Real se ajusta el cierre de ${monthLabel} y se acredita un ingreso trazable en ${currentMonthLabel}.`
                    : `Al enviar a la Bóveda de Ahorros aumenta tu reserva sin doble descuento. Al liberar al Disponible Real se reduce el tope reservado de ${monthLabel} y tu Disponible Real sube al instante.`}
                </p>

                {summary.fixedCapSurplus > 0 ? (
                  <div className="rounded-[8px] border border-[#262626] bg-[#0A0A0A] p-4 flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-sm font-bold text-[#FAFAFA]">
                          Sobrante de Límite de Fijos
                        </span>
                        <p className="text-xs text-[#A3A3A3]">
                          Tope {formatCurrency(summary.fixedExpensesLimit, currency)} &minus; Comprometido{' '}
                          {formatCurrency(summary.totalCommitted, currency)}
                          {summary.fixedCapTransferredToSavings > 0
                            ? ` − Ya trasladado ${formatCurrency(summary.fixedCapTransferredToSavings, currency)}`
                            : ''}
                        </p>
                      </div>
                      <Badge variant="yellow">
                        Disponible: {formatCurrency(summary.fixedCapSurplus, currency)}
                      </Badge>
                    </div>

                    <InputField
                      label="Monto a distribuir (parcial o total)"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={summary.fixedCapSurplus}
                      inputMode="decimal"
                      prefixText="$"
                      value={fixedAmountInput}
                      onChange={(e) => setFixedAmountInput(e.target.value)}
                      error={fixedError}
                    />

                    <div className="flex flex-col sm:flex-row gap-2.5">
                      <Button
                        variant="primary"
                        className="flex-1"
                        onClick={() => void handleAction('to_savings')}
                        isLoading={busyKey === 'fixed_limit:to_savings'}
                        disabled={busyKey !== null}
                      >
                        Enviar a Bóveda de Ahorros
                      </Button>
                      <Button
                        variant="secondary"
                        className="flex-1"
                        onClick={() => void handleAction('to_available')}
                        isLoading={busyKey === 'fixed_limit:to_available'}
                        disabled={busyKey !== null}
                      >
                        Liberar al Disponible Real
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}

            <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2.5 pt-2 border-t border-[#1F1F1F]">
              <Button variant="ghost" onClick={onClose} disabled={busyKey !== null}>
                Cerrar sin marcar revisión
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleMarkReviewedAndClose()}
                isLoading={busyKey === 'mark_reviewed'}
                disabled={busyKey !== null}
              >
                Finalizar revisión de {monthLabel}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
