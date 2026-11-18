/**
 * Modal de constitución de Plazos Fijos (`FixedTermFormModal`).
 *
 * Arquitectura y decisiones técnicas:
 * - Validación preventiva de saldo líquido: cuando el usuario elige `savings_fund`
 *   ("Bóveda de Ahorros"), mostramos el saldo líquido disponible en vivo y bloqueamos
 *   el envío si el capital supera ese saldo (reforzado atómicamente en PostgreSQL).
 * - Calculadora auxiliar por `%` o TNA sin fallbacks silenciosos: rechaza tasas
 *   negativas y fechas inválidas (`maturity_date <= start_date`) mostrando mensajes
 *   explícitos en español en lugar de asumir plazos por defecto.
 * - Chips de plazo rápido (`+30/+60/+90 días`) con altura mínima táctil de `44px`.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import {
  addDaysToLocalISODate,
  calculateDaysBetweenDates,
  formatCurrency,
  roundCurrency,
  toLocalISODate,
} from '../../lib/formatters';
import {
  fixedTermDepositSchema,
  isValidCalendarDate,
} from '../../lib/validations';
import { createFixedTermDeposit } from '../../services/fixedTermsService';
import type { FixedTermOrigin } from '../../types/database.types';

export interface FixedTermFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  liquidSavingsBalance: number;
  currency: string;
  onSaved: () => Promise<void>;
}

export function FixedTermFormModal({
  isOpen,
  onClose,
  liquidSavingsBalance,
  currency,
  onSaved,
}: FixedTermFormModalProps) {
  const [institution, setInstitution] = useState('Plazo Fijo');
  const [origin, setOrigin] = useState<FixedTermOrigin>('monthly_available');
  const [principalAmount, setPrincipalAmount] = useState('');
  const [expectedReturnAmount, setExpectedReturnAmount] = useState('');
  const [startDate, setStartDate] = useState(toLocalISODate());
  const [maturityDate, setMaturityDate] = useState(
    addDaysToLocalISODate(toLocalISODate(), 30),
  );
  const [notes, setNotes] = useState('');

  // Calculadora auxiliar opcional por tasa
  const [helperRate, setHelperRate] = useState('');
  const [helperMode, setHelperMode] = useState<'period' | 'annual'>('period');

  const [errors, setErrors] = useState<{
    institution?: string;
    principal_amount?: string;
    expected_return_amount?: string;
    start_date?: string;
    maturity_date?: string;
    notes?: string;
    helper_rate?: string;
    helper_date?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const today = toLocalISODate();
    setErrors({});
    setInstitution('');
    setOrigin('monthly_available');
    setPrincipalAmount('');
    setExpectedReturnAmount('');
    setStartDate(today);
    setMaturityDate(addDaysToLocalISODate(today, 30));
    setNotes('');
    setHelperRate('');
    setHelperMode('period');
  }, [isOpen]);

  const termDays = useMemo(() => {
    if (!isValidCalendarDate(startDate) || !isValidCalendarDate(maturityDate)) {
      return 0;
    }
    return Math.max(0, calculateDaysBetweenDates(startDate, maturityDate));
  }, [startDate, maturityDate]);

  const parsedPrincipal = Number(principalAmount);
  const parsedExpected = Number(expectedReturnAmount);
  const netProfitPreview =
    Number.isFinite(parsedPrincipal) &&
    Number.isFinite(parsedExpected) &&
    parsedPrincipal > 0 &&
    parsedExpected >= parsedPrincipal
      ? roundCurrency(parsedExpected - parsedPrincipal)
      : 0;

  function applyRateHelper(): void {
    const cap = Number(principalAmount);
    const rate = Number(helperRate);
    const hasInvalidPrincipal =
      principalAmount.trim() === '' || !Number.isFinite(cap) || cap <= 0;
    const hasEmptyOrNaNRate =
      helperRate.trim() === '' || !Number.isFinite(rate);
    const hasNegativeRate = !hasEmptyOrNaNRate && rate < 0;
    const hasValidDates =
      isValidCalendarDate(startDate) &&
      isValidCalendarDate(maturityDate) &&
      maturityDate > startDate &&
      termDays > 0;

    if (
      hasInvalidPrincipal ||
      hasEmptyOrNaNRate ||
      hasNegativeRate ||
      !hasValidDates
    ) {
      setErrors((prev) => ({
        ...prev,
        principal_amount: hasInvalidPrincipal
          ? 'Ingresá primero el capital invertido.'
          : prev.principal_amount,
        helper_rate: hasEmptyOrNaNRate
          ? 'Ingresá una tasa porcentual válida (0 o mayor).'
          : hasNegativeRate
            ? 'La tasa no puede ser negativa (ingresá 0% o más).'
            : undefined,
        maturity_date: !hasValidDates
          ? 'La fecha de vencimiento debe ser posterior a la fecha de inicio.'
          : prev.maturity_date,
        helper_date: !hasValidDates
          ? 'Definí una fecha de vencimiento posterior al inicio para calcular el rendimiento.'
          : undefined,
      }));
      return;
    }

    const computed =
      helperMode === 'annual'
        ? roundCurrency(cap * (1 + (rate / 100) * (termDays / 365)))
        : roundCurrency(cap * (1 + rate / 100));
    setExpectedReturnAmount(String(computed));
    setErrors((prev) => ({
      ...prev,
      expected_return_amount: undefined,
      helper_rate: undefined,
      helper_date: undefined,
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});

    const normalizedInstitution = institution.trim() || 'Plazo Fijo';

    const parsed = fixedTermDepositSchema.safeParse({
      institution: normalizedInstitution,
      principal_amount: principalAmount,
      expected_return_amount: expectedReturnAmount,
      start_date: startDate,
      maturity_date: maturityDate,
      origin,
      notes: notes || null,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        institution: flat.institution?.[0],
        principal_amount: flat.principal_amount?.[0],
        expected_return_amount: flat.expected_return_amount?.[0],
        start_date: flat.start_date?.[0],
        maturity_date: flat.maturity_date?.[0],
        notes: flat.notes?.[0],
      });
      return;
    }

    if (
      parsed.data.origin === 'savings_fund' &&
      parsed.data.principal_amount > liquidSavingsBalance
    ) {
      setErrors({
        principal_amount: `El capital supera tu saldo líquido en Bóveda (${formatCurrency(liquidSavingsBalance, currency)}).`,
      });
      return;
    }

    setIsSaving(true);
    try {
      await createFixedTermDeposit(parsed.data);
      toast.success(
        parsed.data.origin === 'savings_fund'
          ? 'Plazo fijo constituido con capital de tu Bóveda de Ahorros.'
          : 'Plazo fijo constituido y descontado de tu Disponible Real del Mes.',
      );
      await onSaved();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo constituir el plazo fijo.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Nuevo Plazo Fijo"
      description="Inmovilizá capital por un plazo definido sin mezclarlo con tu saldo gastable diario."
      size="lg"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {/* Origen del capital */}
        <div className="flex flex-col gap-1.5">
          <span
            id="ft-origin-group-label"
            className="text-[14px] font-medium text-[#FAFAFA]"
          >
            Origen del capital{' '}
            <span aria-hidden="true" className="text-[#FACC15]">
              *
            </span>
          </span>
          <div
            role="group"
            aria-labelledby="ft-origin-group-label"
            className="grid grid-cols-1 sm:grid-cols-2 gap-2.5"
          >
            <button
              type="button"
              aria-pressed={origin === 'monthly_available'}
              onClick={() => {
                setOrigin('monthly_available');
                setErrors((prev) => ({ ...prev, principal_amount: undefined }));
              }}
              className={[
                'min-h-[52px] px-3.5 py-2.5 rounded-[6px] border text-left transition-colors cursor-pointer',
                origin === 'monthly_available'
                  ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FAFAFA]'
                  : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              <span className="block text-sm font-bold text-[#FAFAFA]">
                Disponible Real del Mes
              </span>
              <span className="block text-xs text-[#A3A3A3] mt-0.5">
                Se descuenta del Disponible del mes de inicio.
              </span>
            </button>

            <button
              type="button"
              aria-pressed={origin === 'savings_fund'}
              onClick={() => {
                setOrigin('savings_fund');
                setErrors((prev) => ({ ...prev, principal_amount: undefined }));
              }}
              className={[
                'min-h-[52px] px-3.5 py-2.5 rounded-[6px] border text-left transition-colors cursor-pointer',
                origin === 'savings_fund'
                  ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FAFAFA]'
                  : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              <span className="block text-sm font-bold text-[#FAFAFA]">
                Bóveda de Ahorros
              </span>
              <span className="block text-xs text-[#FACC15] font-mono-num mt-0.5">
                Líquido disponible: {formatCurrency(liquidSavingsBalance, currency)}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Entidad o referencia"
            placeholder="Ej. Banco Nación / Brubank / Plazo Fijo"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            error={errors.institution}
          />

          <InputField
            label="Capital invertido"
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            prefixText="$"
            placeholder="0.00"
            value={principalAmount}
            onChange={(e) => {
              setPrincipalAmount(e.target.value);
              setErrors((prev) => ({ ...prev, principal_amount: undefined }));
            }}
            error={errors.principal_amount}
            required
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Fecha de inicio"
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setErrors((prev) => ({
                ...prev,
                start_date: undefined,
                maturity_date: undefined,
                helper_date: undefined,
              }));
            }}
            error={errors.start_date}
            required
          />

          <div className="flex flex-col gap-2">
            <InputField
              label="Fecha de vencimiento"
              type="date"
              value={maturityDate}
              onChange={(e) => {
                setMaturityDate(e.target.value);
                setErrors((prev) => ({
                  ...prev,
                  maturity_date: undefined,
                  helper_date: undefined,
                }));
              }}
              error={errors.maturity_date}
              required
            />
            <div className="flex flex-wrap gap-2">
              {[30, 60, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => {
                    const baseDate = isValidCalendarDate(startDate)
                      ? startDate
                      : toLocalISODate();
                    setMaturityDate(addDaysToLocalISODate(baseDate, days));
                    setErrors((prev) => ({
                      ...prev,
                      maturity_date: undefined,
                      helper_date: undefined,
                    }));
                  }}
                  className="btn-press min-h-[44px] px-3 rounded-[6px] border border-[#262626] bg-[#0A0A0A] text-xs font-semibold text-[#D4D4D4] hover:border-[#FACC15] hover:text-[#FACC15] cursor-pointer transition-colors"
                >
                  +{days} días
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Calculadora auxiliar por rendimiento % o TNA */}
        <div className="rounded-[6px] border border-[#262626] bg-[#0A0A0A] p-3.5 flex flex-col gap-2.5">
          <span className="text-xs font-semibold text-[#A3A3A3]">
            Calculadora opcional por tasa (%) &rarr; completa el monto a recibir
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 items-start">
            <InputField
              label="Rendimiento (%)"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              placeholder="Ej. 3.5"
              value={helperRate}
              onChange={(e) => {
                setHelperRate(e.target.value);
                setErrors((prev) => ({ ...prev, helper_rate: undefined }));
              }}
              error={errors.helper_rate}
            />
            <div className="flex gap-1.5 sm:mt-[27px]">
              <button
                type="button"
                aria-pressed={helperMode === 'period'}
                onClick={() => setHelperMode('period')}
                className={[
                  'flex-1 min-h-[44px] rounded-[6px] border text-xs font-semibold cursor-pointer transition-colors',
                  helperMode === 'period'
                    ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                    : 'border-[#262626] bg-[#121212] text-[#A3A3A3] hover:text-[#FAFAFA]',
                ].join(' ')}
              >
                % del plazo
              </button>
              <button
                type="button"
                aria-pressed={helperMode === 'annual'}
                onClick={() => setHelperMode('annual')}
                className={[
                  'flex-1 min-h-[44px] rounded-[6px] border text-xs font-semibold cursor-pointer transition-colors',
                  helperMode === 'annual'
                    ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                    : 'border-[#262626] bg-[#121212] text-[#A3A3A3] hover:text-[#FAFAFA]',
                ].join(' ')}
              >
                TNA anual
              </button>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={applyRateHelper}
              className="w-full sm:mt-[27px]"
            >
              Calcular monto
            </Button>
          </div>
          {errors.helper_date ? (
            <p role="alert" className="text-[13px] text-[#EF4444] font-medium">
              {errors.helper_date}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Monto total a recibir al vencimiento"
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            prefixText="$"
            placeholder="0.00"
            value={expectedReturnAmount}
            onChange={(e) => setExpectedReturnAmount(e.target.value)}
            error={errors.expected_return_amount}
            required
          />

          <InputField
            label="Notas (opcional)"
            placeholder="Ej. Renovación automática desactivada"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            error={errors.notes}
          />
        </div>

        {/* Vista previa de ganancia e inmovilización */}
        <div className="rounded-[6px] border border-[#262626] bg-[#0A0A0A] p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <span className="text-xs text-[#A3A3A3]">Ganancia neta proyectada</span>
            <p className="font-mono-num text-lg font-bold text-[#22C55E]">
              + {formatCurrency(netProfitPreview, currency)}
            </p>
          </div>
          <div className="sm:text-right">
            <span className="text-xs text-[#A3A3A3]">Plazo de inmovilización</span>
            <p className="font-mono-num text-sm font-semibold text-[#FAFAFA]">
              {termDays > 0 ? `${termDays} día(s)` : 'Definí fechas válidas'}
            </p>
          </div>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={isSaving}
            loadingText="Constituyendo..."
          >
            Registrar Plazo Fijo
          </Button>
        </div>
      </form>
    </Modal>
  );
}
