/**
 * Modal de Adelanto / Pago Múltiple de `N` Cuotas (`AdvanceInstallmentsModal`).
 *
 * Arquitectura y decisiones técnicas:
 * - Selección cronológica estricta: toma siempre las `N` cuotas pendientes más próximas
 *   (`is_paid = false ORDER BY installment_number ASC`), trasladándolas al mes
 *   calendario actual como pagadas y liberando los meses futuros.
 * - Ajuste exacto de centavos en vista previa: opera en centavos enteros (`toCents`)
 *   replicando la lógica de PostgreSQL (`TRUNC(X / N, 2)` + resto en la última cuota
 *   del lote) para mostrar con exactitud al centavo el descuento logrado y cada cuota.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import {
  formatCurrency,
  formatMonthLabel,
  roundCurrency,
  toCents,
  toMonthStartISODate,
} from '../../lib/formatters';
import { advanceInstallmentsSchema, MAX_MONEY } from '../../lib/validations';
import {
  advanceInstallments,
  getPendingInstallmentsForPurchase,
} from '../../services/commitmentsService';
import type {
  InstallmentPurchase,
  MonthlyCommitment,
} from '../../types/database.types';

export interface AdvanceInstallmentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  purchase: InstallmentPurchase | null;
  currency: string;
  onCompleted: () => Promise<void>;
}

export function AdvanceInstallmentsModal({
  isOpen,
  onClose,
  purchase,
  currency,
  onCompleted,
}: AdvanceInstallmentsModalProps) {
  const [pendingInstallments, setPendingInstallments] = useState<MonthlyCommitment[]>([]);
  const [isLoadingPending, setIsLoadingPending] = useState(false);
  const [countInput, setCountInput] = useState('1');
  const [useCustomTotal, setUseCustomTotal] = useState(false);
  const [customTotalInput, setCustomTotalInput] = useState('');
  const [errors, setErrors] = useState<{
    count?: string;
    custom_total_amount?: string;
  }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const currentCalendarMonth = toMonthStartISODate(new Date());
  const currentMonthLabel = formatMonthLabel(currentCalendarMonth);

  useEffect(() => {
    if (!isOpen || !purchase) return;
    setErrors({});
    setUseCustomTotal(false);
    setCustomTotalInput('');

    let cancelled = false;
    setIsLoadingPending(true);
    void getPendingInstallmentsForPurchase(purchase.id)
      .then((rows) => {
        if (cancelled) return;
        setPendingInstallments(rows);
        setCountInput(rows.length >= 2 ? '2' : '1');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'No se pudieron consultar las cuotas pendientes.';
        toast.error(msg);
        setPendingInstallments([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, purchase]);

  const parsedCount = Number(countInput);
  const validCount =
    Number.isInteger(parsedCount) &&
    parsedCount >= 1 &&
    parsedCount <= pendingInstallments.length
      ? parsedCount
      : 0;

  const selectedInstallments = useMemo(
    () => pendingInstallments.slice(0, validCount),
    [pendingInstallments, validCount],
  );

  const originalSelectedTotal = useMemo(
    () =>
      selectedInstallments.reduce(
        (acc, item) => roundCurrency(acc + item.amount),
        0,
      ),
    [selectedInstallments],
  );

  const parsedCustomTotal = Number(customTotalInput);
  const finalCustomTotal = roundCurrency(parsedCustomTotal);
  const finalCustomTotalCents = toCents(finalCustomTotal);
  const minCustomTotal = roundCurrency(Math.max(1, validCount) * 0.01);
  const hasValidCustomTotal =
    useCustomTotal &&
    Number.isFinite(parsedCustomTotal) &&
    validCount > 0 &&
    finalCustomTotalCents >= validCount &&
    finalCustomTotal <= MAX_MONEY;

  const previewBreakdown = useMemo(() => {
    if (selectedInstallments.length === 0) return [];
    if (!hasValidCustomTotal) {
      return selectedInstallments.map((item) => ({
        id: item.id,
        label: `Cuota ${item.installment_number ?? '?'}/${item.total_installments ?? '?'}`,
        fromMonth: formatMonthLabel(item.month_date),
        amount: item.amount,
      }));
    }

    const n = selectedInstallments.length;
    const baseUnitCents = Math.floor(finalCustomTotalCents / n);
    const remainderCents = finalCustomTotalCents - baseUnitCents * n;
    const baseUnit = roundCurrency(baseUnitCents / 100);
    const lastUnit = roundCurrency((baseUnitCents + remainderCents) / 100);

    return selectedInstallments.map((item, idx) => ({
      id: item.id,
      label: `Cuota ${item.installment_number ?? '?'}/${item.total_installments ?? '?'}`,
      fromMonth: formatMonthLabel(item.month_date),
      amount: idx === n - 1 ? lastUnit : baseUnit,
    }));
  }, [selectedInstallments, hasValidCustomTotal, finalCustomTotalCents]);

  const discountDelta = hasValidCustomTotal
    ? roundCurrency((toCents(originalSelectedTotal) - finalCustomTotalCents) / 100)
    : 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!purchase) return;
    setErrors({});

    const parsed = advanceInstallmentsSchema.safeParse({
      count: countInput,
      custom_total_amount: useCustomTotal ? customTotalInput : null,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        count: flat.count?.[0],
        custom_total_amount: flat.custom_total_amount?.[0],
      });
      return;
    }

    if (parsed.data.count > pendingInstallments.length) {
      setErrors({
        count: `Solo quedan ${pendingInstallments.length} cuota(s) pendiente(s) para esta compra.`,
      });
      return;
    }

    if (
      parsed.data.custom_total_amount !== null &&
      toCents(roundCurrency(parsed.data.custom_total_amount)) < parsed.data.count
    ) {
      setErrors({
        custom_total_amount:
          'El monto total abonado debe ser de al menos $0,01 por cada cuota adelantada.',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await advanceInstallments({
        purchase_id: purchase.id,
        count: parsed.data.count,
        target_month_date: currentCalendarMonth,
        total_amount: parsed.data.custom_total_amount,
      });

      toast.success(
        `Adelantaste ${res.installments_count} cuota(s) de "${res.purchase_description}" a ${currentMonthLabel}.`,
      );
      await onCompleted();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo completar el adelanto de cuotas.';
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Adelantar / pagar múltiples cuotas"
      description={
        purchase
          ? `"${purchase.description}" — se imputarán en ${currentMonthLabel} como pagadas, liberando los meses futuros.`
          : undefined
      }
      size="md"
    >
      {isLoadingPending ? (
        <div className="h-36 rounded-[8px] bg-[#0A0A0A] border border-[#262626] animate-pulse" />
      ) : pendingInstallments.length === 0 ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#D4D4D4]">
            Esta compra ya tiene todas sus cuotas pagadas. No quedan cuotas pendientes por adelantar.
          </p>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <InputField
              label={`Cantidad de cuotas a adelantar (pendientes: ${pendingInstallments.length})`}
              type="number"
              min="1"
              max={pendingInstallments.length}
              inputMode="numeric"
              value={countInput}
              onChange={(e) => setCountInput(e.target.value)}
              error={errors.count}
              required
            />

            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 6]
                .filter((n) => n <= pendingInstallments.length)
                .map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCountInput(String(n))}
                    className={[
                      'min-h-[44px] px-3.5 rounded-[6px] border text-xs font-semibold cursor-pointer transition-colors',
                      Number(countInput) === n
                        ? 'border-[#FACC15] bg-[#FACC15]/15 text-[#FACC15]'
                        : 'border-[#262626] bg-[#0A0A0A] text-[#D4D4D4] hover:border-[#3A3A3A]',
                    ].join(' ')}
                  >
                    {n} {n === 1 ? 'cuota' : 'cuotas'}
                  </button>
                ))}
              {pendingInstallments.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setCountInput(String(pendingInstallments.length))}
                  className={[
                    'min-h-[44px] px-3.5 rounded-[6px] border text-xs font-semibold cursor-pointer transition-colors',
                    Number(countInput) === pendingInstallments.length
                      ? 'border-[#FACC15] bg-[#FACC15]/15 text-[#FACC15]'
                      : 'border-[#262626] bg-[#0A0A0A] text-[#D4D4D4] hover:border-[#3A3A3A]',
                  ].join(' ')}
                >
                  Todas ({pendingInstallments.length})
                </button>
              ) : null}
            </div>
          </div>

          <label
            htmlFor="advance-use-custom-total"
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3 py-2.5 cursor-pointer hover:border-[#404040]"
          >
            <div className="flex items-center gap-3 min-w-0">
              <input
                id="advance-use-custom-total"
                type="checkbox"
                checked={useCustomTotal}
                onChange={(e) => {
                  const next = e.target.checked;
                  setUseCustomTotal(next);
                  if (next && !customTotalInput && originalSelectedTotal > 0) {
                    setCustomTotalInput(String(originalSelectedTotal));
                  }
                }}
                className="h-4 w-4 shrink-0 accent-[#FACC15]"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-[#FAFAFA]">
                  Indicar monto total abonado distinto (ej. con descuento)
                </span>
                <span className="text-xs text-[#A3A3A3]">
                  Se repartirá proporcionalmente entre las cuotas del lote.
                </span>
              </div>
            </div>
          </label>

          {useCustomTotal ? (
            <InputField
              label="Monto total abonado ($X)"
              type="number"
              step="0.01"
              min={minCustomTotal.toFixed(2)}
              max={String(MAX_MONEY)}
              inputMode="decimal"
              prefixText="$"
              value={customTotalInput}
              onChange={(e) => setCustomTotalInput(e.target.value)}
              error={errors.custom_total_amount}
              hint={`Importe original de estas cuotas: ${formatCurrency(originalSelectedTotal, currency)} · Mínimo: ${formatCurrency(minCustomTotal, currency)}`}
              required
            />
          ) : null}

          {previewBreakdown.length > 0 ? (
            <div className="rounded-[8px] border border-[#262626] bg-[#0A0A0A] p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
                  Vista previa ({currentMonthLabel})
                </span>
                {discountDelta > 0 ? (
                  <Badge variant="green">
                    Ahorro: {formatCurrency(discountDelta, currency)}
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-1">
                {previewBreakdown.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-2 text-xs py-1 border-b last:border-b-0 border-[#1A1A1A]"
                  >
                    <span className="text-[#D4D4D4]">
                      <strong className="text-[#FAFAFA]">{row.label}</strong>{' '}
                      <span className="text-[#A3A3A3]">({row.fromMonth} &rarr; {currentMonthLabel})</span>
                    </span>
                    <span className="font-mono-num font-semibold text-[#FACC15] shrink-0">
                      {formatCurrency(row.amount, currency)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[#262626] text-sm">
                <span className="text-[#A3A3A3]">Total del lote a imputar hoy</span>
                <span className="font-mono-num font-bold text-[#FAFAFA]">
                  {formatCurrency(
                    hasValidCustomTotal
                      ? finalCustomTotal
                      : originalSelectedTotal,
                    currency,
                  )}
                </span>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
            <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              isLoading={isSubmitting}
              loadingText="Adelantando cuotas..."
            >
              Confirmar adelanto
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
