/**
 * Modal de registro y edición de Compras en Cuotas (`InstallmentFormModal`).
 *
 * Arquitectura y decisiones técnicas:
 * - Previsualiza en vivo el monto total financiado, el rango exacto de meses afectados
 *   (`Noviembre 2026 a Abril 2027`) y consulta el compromiso real del mes de la 1.ª cuota
 *   para mostrar una alerta preventiva roja si se excede el tope mensual de gastos fijos,
 *   excluyendo tanto los compromisos previos como la propia compra cuando pertenecen a
 *   Gustitos (`is_gustito` o categoría Gustito) para evitar falsas alarmas.
 * - Al editar una compra con cuotas ya abonadas (`paidCount > 0`), protege esas cuotas
 *   inmutables bloqueando la cantidad de cuotas y fecha de inicio, aplicando el nuevo valor
 *   únicamente a las cuotas pendientes mediante la RPC `update_installment_purchase`.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import {
  calculateLastInstallmentMonthLabel,
  formatCurrency,
  formatMonthLabel,
  formatPercent,
  roundCurrency,
  toLocalISODate,
  toMonthStartISODate,
} from '../../lib/formatters';
import {
  installmentPurchaseSchema,
  isValidCalendarDate,
} from '../../lib/validations';
import { getMonthlyCategorySnapshots } from '../../services/categoriesService';
import {
  createInstallmentPurchase,
  getFixedExpenseTemplates,
  getMonthlyCommitments,
  getPaidInstallmentsCount,
  updateInstallmentPurchase,
} from '../../services/commitmentsService';
import { getMonthlyBudget } from '../../services/settingsService';
import type { Category, InstallmentPurchase } from '../../types/database.types';

export interface InstallmentFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  categories: Category[];
  initialPurchase?: InstallmentPurchase | null;
  defaultLimit: number;
  currency: string;
  onSaved: () => Promise<void>;
}

export function InstallmentFormModal({
  isOpen,
  onClose,
  userId,
  categories,
  initialPurchase,
  defaultLimit,
  currency,
  onSaved,
}: InstallmentFormModalProps) {
  const isEditing = Boolean(initialPurchase);

  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [installmentAmount, setInstallmentAmount] = useState('');
  const [installmentsCount, setInstallmentsCount] = useState('3');
  const [purchaseDate, setPurchaseDate] = useState(toLocalISODate());
  const [firstInstallmentDate, setFirstInstallmentDate] = useState(toLocalISODate());
  const [notes, setNotes] = useState('');
  const [isGustito, setIsGustito] = useState(false);
  const [paidCount, setPaidCount] = useState(0);

  const [startMonthCommittedBase, setStartMonthCommittedBase] = useState<number>(0);
  const [startMonthLimit, setStartMonthLimit] = useState<number>(defaultLimit);
  const [startMonthGustitoCategoryIds, setStartMonthGustitoCategoryIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [errors, setErrors] = useState<{
    description?: string;
    category_id?: string;
    installment_amount?: string;
    installments_count?: string;
    purchase_date?: string;
    first_installment_date?: string;
    notes?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  const availableCategories = useMemo(() => {
    const activeExpenses = categories.filter(
      (c) => c.type === 'expense' && c.is_active,
    );
    if (
      initialPurchase &&
      !activeExpenses.some((c) => c.id === initialPurchase.category_id)
    ) {
      const archived = categories.find((c) => c.id === initialPurchase.category_id);
      if (archived) {
        return [
          ...activeExpenses,
          { ...archived, name: `${archived.name} (Archivada)` },
        ];
      }
    }
    return activeExpenses;
  }, [categories, initialPurchase]);

  const availableCategoriesRef = useRef(availableCategories);
  availableCategoriesRef.current = availableCategories;

  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;

  const selectedCategory = useMemo(
    () => availableCategories.find((c) => c.id === categoryId),
    [availableCategories, categoryId],
  );
  const isCategoryGustito = Boolean(selectedCategory?.is_gustito);

  function handleCategoryChange(nextCategoryId: string): void {
    setCategoryId(nextCategoryId);
    if (!isEditing) {
      const nextCategory = availableCategories.find(
        (c) => c.id === nextCategoryId,
      );
      setIsGustito(Boolean(nextCategory?.is_gustito));
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    setErrors({});
    const today = toLocalISODate();

    if (initialPurchase) {
      setDescription(initialPurchase.description);
      setCategoryId(initialPurchase.category_id);
      setInstallmentAmount(String(initialPurchase.installment_amount));
      setInstallmentsCount(String(initialPurchase.installments_count));
      setPurchaseDate(initialPurchase.purchase_date);
      setFirstInstallmentDate(initialPurchase.first_installment_date);
      setNotes(initialPurchase.notes ?? '');
      setIsGustito(Boolean(initialPurchase.is_gustito));

      void getPaidInstallmentsCount(initialPurchase.id)
        .then(setPaidCount)
        .catch(() => setPaidCount(0));
    } else {
      setDescription('');
      const cats = availableCategoriesRef.current;
      const shoppingCat =
        cats.find((c) => c.name.toLowerCase().includes('compras')) ?? cats[0];
      setCategoryId(shoppingCat?.id ?? '');
      setInstallmentAmount('');
      setInstallmentsCount('3');
      setPurchaseDate(today);
      setFirstInstallmentDate(today);
      setNotes('');
      setIsGustito(Boolean(shoppingCat?.is_gustito));
      setPaidCount(0);
    }
  }, [isOpen, initialPurchase]);

  // Consultar el total ya comprometido en el mes de la 1.ª cuota para la alerta preventiva
  useEffect(() => {
    if (!isOpen || !firstInstallmentDate || !isValidCalendarDate(firstInstallmentDate)) {
      return;
    }

    let cancelled = false;
    const targetMonth = toMonthStartISODate(firstInstallmentDate);
    const currentCalendarMonth = toMonthStartISODate(new Date());
    const isFutureMonth = targetMonth > currentCalendarMonth;

    async function loadStartMonthExposure(): Promise<void> {
      try {
        const [commitments, budget, snapshots] = await Promise.all([
          getMonthlyCommitments(targetMonth),
          getMonthlyBudget(userId, targetMonth),
          getMonthlyCategorySnapshots(targetMonth),
        ]);
        const templates =
          isFutureMonth && !budget ? await getFixedExpenseTemplates() : [];
        if (cancelled) return;

        const snapshotByCatId = new Map(snapshots.map((s) => [s.category_id, s]));
        const hasMonthSnapshots = snapshots.length > 0;
        const gustitoCategoryIds = new Set<string>();

        for (const cat of categoriesRef.current) {
          if (cat.type !== 'expense') continue;
          const snap = snapshotByCatId.get(cat.id);
          const catIsGustito = snap
            ? snap.is_gustito
            : !hasMonthSnapshots
              ? cat.is_gustito
              : false;
          if (catIsGustito) {
            gustitoCategoryIds.add(cat.id);
          }
        }
        for (const snap of snapshots) {
          if (snap.is_gustito) {
            gustitoCategoryIds.add(snap.category_id);
          }
        }

        let baseSum = commitments.reduce((acc, item) => {
          if (initialPurchase && item.installment_purchase_id === initialPurchase.id) {
            return acc;
          }
          // Excluir cuotas de Gustitos del tope mensual de gastos fijos
          if (item.commitment_type === 'installment') {
            const isGustitoCommitment =
              Boolean(item.installment_purchase?.is_gustito) ||
              gustitoCategoryIds.has(item.category_id) ||
              (!hasMonthSnapshots && Boolean(item.category?.is_gustito));
            if (isGustitoCommitment) {
              return acc;
            }
          }
          return roundCurrency(acc + item.amount);
        }, 0);

        // Si el mes de la 1.ª cuota es futuro y aún no fue inicializado, sumamos las plantillas activas
        if (isFutureMonth && !budget) {
          const existingTemplateIds = new Set(
            commitments
              .map((c) => c.fixed_expense_template_id)
              .filter((id): id is string => Boolean(id)),
          );
          for (const tpl of templates) {
            if (tpl.is_active && !existingTemplateIds.has(tpl.id)) {
              baseSum = roundCurrency(baseSum + tpl.default_amount);
            }
          }
        }

        setStartMonthCommittedBase(baseSum);
        setStartMonthLimit(budget ? budget.fixed_expenses_limit : defaultLimit);
        setStartMonthGustitoCategoryIds(gustitoCategoryIds);
      } catch {
        // Silencioso en preview preventiva
      }
    }

    void loadStartMonthExposure();
    return () => {
      cancelled = true;
    };
  }, [isOpen, firstInstallmentDate, userId, defaultLimit, initialPurchase]);

  const parsedAmount = Number(installmentAmount);
  const parsedCount = Number(installmentsCount);
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;
  const validCount =
    Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= 120
      ? parsedCount
      : 0;

  const totalAmountPreview = roundCurrency(validAmount * validCount);
  const startMonthLabel =
    isValidCalendarDate(firstInstallmentDate)
      ? formatMonthLabel(toMonthStartISODate(firstInstallmentDate))
      : '';
  const endMonthLabel =
    isValidCalendarDate(firstInstallmentDate) && validCount >= 1
      ? calculateLastInstallmentMonthLabel(firstInstallmentDate, validCount)
      : '';

  const isPurchaseGustito =
    isCategoryGustito || startMonthGustitoCategoryIds.has(categoryId) || isGustito;
  const projectedFirstMonthCommitted = isPurchaseGustito
    ? startMonthCommittedBase
    : roundCurrency(startMonthCommittedBase + validAmount);
  const exceedsStartMonthLimit =
    !isPurchaseGustito &&
    startMonthLimit > 0 &&
    projectedFirstMonthCommitted > startMonthLimit;
  const excessAmount = exceedsStartMonthLimit
    ? roundCurrency(projectedFirstMonthCommitted - startMonthLimit)
    : 0;
  const usagePercent =
    startMonthLimit > 0
      ? roundCurrency((projectedFirstMonthCommitted / startMonthLimit) * 100)
      : 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});

    const parsed = installmentPurchaseSchema.safeParse({
      description,
      category_id: categoryId,
      installment_amount: installmentAmount,
      installments_count: installmentsCount,
      purchase_date: purchaseDate,
      first_installment_date: firstInstallmentDate,
      notes: notes || null,
      is_gustito: isCategoryGustito ? true : isGustito,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        description: flat.description?.[0],
        category_id: flat.category_id?.[0],
        installment_amount: flat.installment_amount?.[0],
        installments_count: flat.installments_count?.[0],
        purchase_date: flat.purchase_date?.[0],
        first_installment_date: flat.first_installment_date?.[0],
        notes: flat.notes?.[0],
      });
      return;
    }

    setIsSaving(true);
    try {
      if (initialPurchase) {
        await updateInstallmentPurchase(initialPurchase.id, parsed.data);
        toast.success('Compra en cuotas actualizada.');
      } else {
        await createInstallmentPurchase(parsed.data);
        toast.success(
          `Compra registrada en ${parsed.data.installments_count} cuota(s) mensuales.`,
        );
      }

      if (exceedsStartMonthLimit) {
        toast(
          `Alerta: en ${startMonthLabel} superás tu límite de fijos en ${formatCurrency(excessAmount, currency)}.`,
          {
            icon: '⚠️',
            duration: 5000,
          },
        );
      }

      await onSaved();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo registrar la compra en cuotas.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Editar compra en cuotas' : 'Nueva compra en cuotas'}
      description="Pre-genera automáticamente cada cuota mensual en tu Disponible Real desde el mes de inicio."
      size="lg"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {isEditing && paidCount > 0 ? (
          <div className="rounded-[6px] border border-[#FACC15]/50 bg-[#FACC15]/10 p-3.5 text-sm text-[#FAFAFA]">
            Esta compra ya tiene <strong className="text-[#FACC15]">{paidCount}</strong> cuota(s) marcada(s) como pagada(s). Las cuotas abonadas quedarán inmutables y el nuevo monto se aplicará únicamente a las cuotas pendientes.
          </div>
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Descripción de la compra"
            placeholder="Ej. Monitor 27 pulgadas"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={errors.description}
            required
          />

          <SelectField
            label="Categoría de gasto"
            value={categoryId}
            onChange={(e) => handleCategoryChange(e.target.value)}
            placeholder="Seleccioná una categoría"
            options={availableCategories.map((c) => ({
              value: c.id,
              label: c.name,
            }))}
            error={errors.category_id}
            required
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Monto por cuota"
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            prefixText="$"
            placeholder="0.00"
            value={installmentAmount}
            onChange={(e) => setInstallmentAmount(e.target.value)}
            error={errors.installment_amount}
            required
          />

          <InputField
            label="Cantidad de cuotas"
            type="number"
            min="1"
            max="120"
            inputMode="numeric"
            value={installmentsCount}
            onChange={(e) => setInstallmentsCount(e.target.value)}
            error={errors.installments_count}
            disabled={isEditing && paidCount > 0}
            hint={
              isEditing && paidCount > 0
                ? 'Bloqueado porque ya existen cuotas pagadas.'
                : 'Entre 1 y 120 cuotas.'
            }
            required
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Fecha de la compra"
            type="date"
            value={purchaseDate}
            onChange={(e) => setPurchaseDate(e.target.value)}
            error={errors.purchase_date}
            required
          />

          <InputField
            label="Fecha de la 1.ª cuota"
            type="date"
            value={firstInstallmentDate}
            onChange={(e) => setFirstInstallmentDate(e.target.value)}
            error={errors.first_installment_date}
            disabled={isEditing && paidCount > 0}
            hint="Define el mes en que empieza a descontarse."
            required
          />
        </div>

        <InputField
          label="Notas (opcional)"
          placeholder="Ej. Tarjeta Visa 6 cuotas sin interés"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={errors.notes}
        />

        <label
          htmlFor="installment-is-gustito"
          className={[
            'flex min-h-[44px] items-center justify-between gap-3 rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3 py-2.5 transition-colors',
            isCategoryGustito
              ? 'cursor-default opacity-90'
              : 'cursor-pointer hover:border-[#404040]',
          ].join(' ')}
        >
          <div className="flex items-center gap-3 min-w-0">
            <input
              id="installment-is-gustito"
              type="checkbox"
              checked={isCategoryGustito ? true : isGustito}
              disabled={isCategoryGustito}
              onChange={(e) => setIsGustito(e.target.checked)}
              className="h-4 w-4 shrink-0 rounded border-[#262626] bg-[#121212] accent-[#FACC15] focus:ring-2 focus:ring-[#FACC15]/50 disabled:cursor-not-allowed"
            />
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium text-[#FAFAFA]">
                Contar esta compra en la bolsa de Gustitos
              </span>
              {isCategoryGustito ? (
                <span className="text-xs text-[#FACC15]">
                  Incluido automáticamente por la categoría elegida
                </span>
              ) : null}
            </div>
          </div>
          <span className="text-xs text-[#A3A3A3] shrink-0">
            {isCategoryGustito
              ? 'Por categoría'
              : isGustito
                ? 'Incluido'
                : 'Opcional'}
          </span>
        </label>

        {/* Vista previa en vivo del impacto financiero */}
        <div className="rounded-[6px] bg-[#0A0A0A] border border-[#262626] p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <span className="text-[13px] text-[#A3A3A3]">Monto total financiado</span>
            <p className="font-mono-num text-xl font-bold text-[#FACC15]">
              {formatCurrency(totalAmountPreview, currency)}
            </p>
          </div>
          <div className="sm:text-right">
            <span className="text-[13px] text-[#A3A3A3]">Período comprometido</span>
            <p className="text-sm font-semibold text-[#FAFAFA]">
              {startMonthLabel && endMonthLabel
                ? validCount === 1
                  ? startMonthLabel
                  : `${startMonthLabel} a ${endMonthLabel}`
                : 'Completá fecha y cantidad de cuotas'}
            </p>
          </div>
        </div>

        {exceedsStartMonthLimit ? (
          <div
            role="status"
            className="rounded-[6px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-3.5 text-sm text-[#FAFAFA]"
          >
            <p className="font-bold text-[#F87171]">
              Alerta preventiva en {startMonthLabel}: supera el límite ({formatPercent(usagePercent)})
            </p>
            <p className="mt-1 text-[#D4D4D4]">
              Al sumar esta cuota de{' '}
              <strong className="font-mono-num">
                {formatCurrency(validAmount, currency)}
              </strong>
              , tus compromisos de {startMonthLabel} llegarán a{' '}
              <strong className="font-mono-num">
                {formatCurrency(projectedFirstMonthCommitted, currency)}
              </strong>{' '}
              (exceso de{' '}
              <strong className="font-mono-num text-[#F87171]">
                {formatCurrency(excessAmount, currency)}
              </strong>
              ). Podés guardar la compra igual.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={isSaving}
            loadingText="Guardando compra..."
          >
            {isEditing ? 'Guardar cambios' : 'Registrar compra en cuotas'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
