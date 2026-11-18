/**
 * Modal de registro de Aportes Extra y Retiros de la Bóveda de Ahorros.
 *
 * Arquitectura y decisiones técnicas:
 * - Separa explícitamente los `deposit` (aportes extra que se descuentan automáticamente
 *   del `Disponible Real` del mes correspondiente) de los `withdrawal` (retiros de la bóveda
 *   validados contra el saldo acumulado disponible, sin alterar el Disponible Real mensual).
 * - Valida en el cliente con `savingsEntrySchema` (`zod`) y verifica el tope disponible
 *   antes de invocar `createSavingsEntry` para ofrecer errores claros bajo el campo monto.
 */
import { useEffect, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { formatCurrency, toLocalISODate, toMonthStartISODate } from '../../lib/formatters';
import { savingsEntrySchema } from '../../lib/validations';
import { createSavingsEntry } from '../../services/savingsService';
import type { SavingsEntryType } from '../../types/database.types';

export interface SavingsEntryFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  availableAccumulatedBalance: number;
  currency: string;
  defaultMonthDate?: string;
  initialEntryType?: SavingsEntryType;
  onSaved: () => Promise<void>;
}

export function SavingsEntryFormModal({
  isOpen,
  onClose,
  userId,
  availableAccumulatedBalance,
  currency,
  defaultMonthDate,
  initialEntryType = 'deposit',
  onSaved,
}: SavingsEntryFormModalProps) {
  const [entryType, setEntryType] = useState<SavingsEntryType>(initialEntryType);
  const [amount, setAmount] = useState<string>('');
  const [entryDate, setEntryDate] = useState<string>(toLocalISODate());
  const [description, setDescription] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [creditToAvailable, setCreditToAvailable] = useState<boolean>(false);
  const [errors, setErrors] = useState<{
    amount?: string;
    entry_date?: string;
    description?: string;
    notes?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setErrors({});

    const today = toLocalISODate();
    const todayMonth = toMonthStartISODate(today);
    const targetDefaultDate =
      defaultMonthDate && defaultMonthDate !== todayMonth ? defaultMonthDate : today;

    setEntryType(initialEntryType);
    setAmount('');
    setEntryDate(targetDefaultDate);
    setDescription('');
    setNotes('');
    setCreditToAvailable(false);
  }, [isOpen, defaultMonthDate, initialEntryType]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});

    const shouldCreditToAvailable = entryType === 'withdrawal' && creditToAvailable;

    const parsed = savingsEntrySchema.safeParse({
      entry_type: entryType,
      amount,
      entry_date: entryDate,
      description,
      notes: notes || null,
      credit_to_available: shouldCreditToAvailable,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        amount: flat.amount?.[0],
        entry_date: flat.entry_date?.[0],
        description: flat.description?.[0],
        notes: flat.notes?.[0],
      });
      return;
    }

    if (
      parsed.data.entry_type === 'withdrawal' &&
      parsed.data.amount > availableAccumulatedBalance
    ) {
      setErrors({
        amount: `El retiro supera el saldo disponible en tu bóveda (${formatCurrency(availableAccumulatedBalance, currency)}).`,
      });
      return;
    }

    setIsSaving(true);
    try {
      await createSavingsEntry(userId, parsed.data);
      toast.success(
        parsed.data.entry_type === 'deposit'
          ? 'Aporte guardado en tu Bóveda de Ahorros y apartado del Disponible Real.'
          : parsed.data.credit_to_available
            ? 'Retiro registrado en tu Bóveda de Ahorros y acreditado al Disponible Real del mes.'
            : 'Retiro registrado en tu Bóveda de Ahorros.',
      );
      await onSaved();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo registrar el movimiento de ahorro.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        entryType === 'deposit'
          ? 'Registrar aporte a ahorros'
          : 'Registrar retiro de ahorros'
      }
      description="Gestioná los movimientos de tu Bóveda de Ahorros aislada del saldo gastable del Dashboard."
      size="md"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {/* Selector táctil de tipo de movimiento de ahorro */}
        <div className="flex flex-col gap-1.5">
          <span
            id="savings-type-group-label"
            className="text-[14px] font-medium text-[#FAFAFA]"
          >
            Tipo de operación{' '}
            <span aria-hidden="true" className="text-[#FACC15]">
              *
            </span>
          </span>
          <div
            role="group"
            aria-labelledby="savings-type-group-label"
            className="grid grid-cols-1 sm:grid-cols-2 gap-2"
          >
            <button
              type="button"
              aria-pressed={entryType === 'deposit'}
              onClick={() => {
                setEntryType('deposit');
                setCreditToAvailable(false);
                setErrors({});
              }}
              className={[
                'min-h-[44px] px-3 rounded-[6px] border text-sm font-bold transition-colors cursor-pointer',
                entryType === 'deposit'
                  ? 'bg-[#FACC15]/15 border-[#FACC15] text-[#FACC15]'
                  : 'bg-[#0A0A0A] border-[#262626] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Aporte extra a ahorros
            </button>
            <button
              type="button"
              aria-pressed={entryType === 'withdrawal'}
              onClick={() => {
                setEntryType('withdrawal');
                setErrors({});
              }}
              className={[
                'min-h-[44px] px-3 rounded-[6px] border text-sm font-bold transition-colors cursor-pointer',
                entryType === 'withdrawal'
                  ? 'bg-[#EF4444]/15 border-[#EF4444] text-[#F87171]'
                  : 'bg-[#0A0A0A] border-[#262626] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Retiro de ahorros
            </button>
          </div>
        </div>

        {/* Aviso contextual del impacto en Disponible Real / Bóveda */}
        <div
          className={[
            'rounded-[6px] border px-3.5 py-3 text-sm leading-relaxed',
            entryType === 'deposit'
              ? 'border-[#FACC15]/40 bg-[#FACC15]/8 text-[#D4D4D4]'
              : 'border-[#EF4444]/40 bg-[#EF4444]/10 text-[#D4D4D4]',
          ].join(' ')}
        >
          {entryType === 'deposit' ? (
            <p>
              Este aporte se sumará a tu{' '}
              <strong className="text-[#FACC15]">Bóveda de Ahorros</strong> y se
              descontará automáticamente del{' '}
              <strong className="text-[#FAFAFA]">Disponible Real</strong> del mes de
              la fecha elegida.
            </p>
          ) : (
            <p>
              Saldo disponible actual en bóveda:{' '}
              <strong className="font-mono-num text-[#FAFAFA]">
                {formatCurrency(availableAccumulatedBalance, currency)}
              </strong>
              .{' '}
              {creditToAvailable
                ? 'El retiro descontará de tu bóveda y registrará un ingreso compensatorio para sumarse al Disponible Real del mes.'
                : 'El retiro descuenta de tu bóveda acumulada sin modificar automáticamente tu Disponible Real mensual.'}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Monto"
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            prefixText="$"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amount}
            required
          />

          <InputField
            label="Fecha de operación"
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            error={errors.entry_date}
            required
          />
        </div>

        <InputField
          label="Descripción breve"
          placeholder={
            entryType === 'deposit'
              ? 'Ej. Aporte extra por venta o aguinaldo'
              : 'Ej. Uso de reserva por imprevisto'
          }
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={errors.description}
          required
        />

        <InputField
          label="Nota (opcional)"
          placeholder="Detalle adicional..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={errors.notes}
        />

        {entryType === 'withdrawal' ? (
          <label
            htmlFor="credit-to-available-checkbox"
            className="flex items-start gap-3 min-h-[44px] rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3.5 py-3 cursor-pointer hover:border-[#404040] transition-colors"
          >
            <input
              id="credit-to-available-checkbox"
              type="checkbox"
              checked={creditToAvailable}
              onChange={(e) => setCreditToAvailable(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-[#404040] bg-[#141414] accent-[#FACC15] cursor-pointer"
            />
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-[#FAFAFA]">
                Acreditar al Disponible del mes
              </span>
              <span className="text-xs text-[#A3A3A3] leading-relaxed">
                Registra además un ingreso compensatorio en Movimientos para que puedas
                gastar este retiro dentro del Disponible Real del mes elegido.
              </span>
            </span>
          </label>
        ) : null}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant={entryType === 'deposit' ? 'primary' : 'danger'}
            isLoading={isSaving}
            loadingText="Guardando..."
          >
            {entryType === 'deposit' ? 'Guardar aporte' : 'Confirmar retiro'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
