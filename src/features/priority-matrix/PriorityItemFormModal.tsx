/**
 * Modal unificado de la Matriz de Prioridad (`PriorityItemFormModal`):
 * alta/edición de ítems deseados y conversión directa a gasto o compra en cuotas.
 *
 * Arquitectura y decisiones técnicas:
 * - Conversión atómica (`convertPriorityItemToPurchase`): al marcar un ítem como
 *   comprado (`mode === 'convert'`), validamos los campos con `transactionSchema` o
 *   `installmentPurchaseSchema` y delegamos en una única RPC transaccional en
 *   PostgreSQL que crea la compra real y elimina el ítem de `priority_items`,
 *   evitando duplicación de gastos ante cortes de red.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import {
  PRIORITY_QUADRANT_META,
  PRIORITY_QUADRANT_ORDER,
  formatCurrency,
  roundCurrency,
  toLocalISODate,
} from '../../lib/formatters';
import {
  installmentPurchaseSchema,
  priorityItemSchema,
  transactionSchema,
} from '../../lib/validations';
import {
  convertPriorityItemToPurchase,
  createPriorityItem,
  updatePriorityItem,
} from '../../services/priorityMatrixService';
import type {
  Category,
  PriorityItem,
  PriorityQuadrant,
} from '../../types/database.types';

export type PriorityModalMode = 'actions' | 'create' | 'edit' | 'convert';

export interface PriorityItemFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  categories: Category[];
  currency: string;
  mode: PriorityModalMode;
  initialItem?: PriorityItem | null;
  defaultQuadrant?: PriorityQuadrant;
  onSaved: () => Promise<void>;
  onRequestDelete?: (item: PriorityItem) => void;
  onMoveQuadrant?: (
    item: PriorityItem,
    nextQuadrant: PriorityQuadrant,
  ) => Promise<void>;
}

export function PriorityItemFormModal({
  isOpen,
  onClose,
  userId,
  categories,
  currency,
  mode,
  initialItem,
  defaultQuadrant = 'high_impact_low_cost',
  onSaved,
  onRequestDelete,
  onMoveQuadrant,
}: PriorityItemFormModalProps) {
  const expenseCategories = useMemo(
    () => categories.filter((c) => c.type === 'expense' && c.is_active),
    [categories],
  );

  const [activeMode, setActiveMode] = useState<PriorityModalMode>(mode);
  const [isMovingQuadrant, setIsMovingQuadrant] = useState(false);

  // Estado formulario crear / editar
  const [title, setTitle] = useState('');
  const [estimatedCost, setEstimatedCost] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [quadrant, setQuadrant] = useState<PriorityQuadrant>(defaultQuadrant);
  const [notes, setNotes] = useState('');

  // Estado formulario conversión a compra real
  const [convertType, setConvertType] = useState<'cash' | 'installments'>('cash');
  const [finalAmount, setFinalAmount] = useState('');
  const [installmentsCount, setInstallmentsCount] = useState('3');
  const [purchaseDate, setPurchaseDate] = useState(toLocalISODate());
  const [firstInstallmentDate, setFirstInstallmentDate] = useState(toLocalISODate());
  const [isGustito, setIsGustito] = useState(false);

  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setActiveMode(mode);
    setErrors({});
    const today = toLocalISODate();

    if (initialItem) {
      setConvertType('cash');
      setTitle(initialItem.title);
      setEstimatedCost(String(initialItem.estimated_cost));
      setQuadrant(initialItem.quadrant);
      const fallbackCatId =
        initialItem.category_id &&
        expenseCategories.some((c) => c.id === initialItem.category_id)
          ? initialItem.category_id
          : mode === 'convert'
            ? (expenseCategories[0]?.id ?? '')
            : (initialItem.category_id ?? '');
      setCategoryId(fallbackCatId);
      const cat = expenseCategories.find((c) => c.id === fallbackCatId);
      setIsGustito(Boolean(cat?.is_gustito));
      setFinalAmount(String(initialItem.estimated_cost));
      setInstallmentsCount('3');
      setPurchaseDate(today);
      setFirstInstallmentDate(today);
      setNotes(initialItem.notes ?? '');
      return;
    }

    setTitle('');
    setEstimatedCost('');
    setCategoryId('');
    setQuadrant(defaultQuadrant);
    setNotes('');
  }, [isOpen, mode, initialItem, defaultQuadrant, expenseCategories]);

  function switchToMode(nextMode: PriorityModalMode): void {
    setErrors({});
    if (nextMode === 'convert' && initialItem) {
      const today = toLocalISODate();
      setConvertType('cash');
      setTitle(initialItem.title);
      const fallbackCatId =
        initialItem.category_id &&
        expenseCategories.some((c) => c.id === initialItem.category_id)
          ? initialItem.category_id
          : (expenseCategories[0]?.id ?? '');
      setCategoryId(fallbackCatId);
      const cat = expenseCategories.find((c) => c.id === fallbackCatId);
      setIsGustito(Boolean(cat?.is_gustito));
      setFinalAmount(String(initialItem.estimated_cost));
      setInstallmentsCount('3');
      setPurchaseDate(today);
      setFirstInstallmentDate(today);
      setNotes(initialItem.notes ?? '');
    } else if (nextMode === 'edit' && initialItem) {
      setTitle(initialItem.title);
      setEstimatedCost(String(initialItem.estimated_cost));
      setCategoryId(initialItem.category_id ?? '');
      setQuadrant(initialItem.quadrant);
      setNotes(initialItem.notes ?? '');
    }
    setActiveMode(nextMode);
  }

  async function handleQuickQuadrantSelect(
    nextQuadrant: PriorityQuadrant,
  ): Promise<void> {
    setQuadrant(nextQuadrant);
    if (!initialItem || !onMoveQuadrant || initialItem.quadrant === nextQuadrant) {
      return;
    }
    setIsMovingQuadrant(true);
    try {
      await onMoveQuadrant(initialItem, nextQuadrant);
    } finally {
      setIsMovingQuadrant(false);
    }
  }

  const selectedCategory = useMemo(
    () => expenseCategories.find((c) => c.id === categoryId),
    [expenseCategories, categoryId],
  );
  const isCategoryGustito = Boolean(selectedCategory?.is_gustito);

  function handleCategoryChange(nextCatId: string): void {
    setCategoryId(nextCatId);
    const cat = expenseCategories.find((c) => c.id === nextCatId);
    setIsGustito(Boolean(cat?.is_gustito));
  }

  function handleConvertTypeChange(nextType: 'cash' | 'installments'): void {
    setConvertType(nextType);
    if (!initialItem) return;
    if (nextType === 'installments') {
      const count = Math.max(1, Number(installmentsCount) || 3);
      setFinalAmount(String(roundCurrency(initialItem.estimated_cost / count)));
    } else {
      setFinalAmount(String(initialItem.estimated_cost));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});

    if (activeMode === 'convert' && initialItem) {
      if (convertType === 'cash') {
        const parsed = transactionSchema.safeParse({
          type: 'expense',
          category_id: categoryId,
          amount: finalAmount,
          transaction_date: purchaseDate,
          description: title,
          notes: notes || null,
          is_gustito: isCategoryGustito || isGustito,
          save_to_savings: false,
        });

        if (!parsed.success) {
          const flat = parsed.error.flatten().fieldErrors;
          setErrors({
            title: flat.description?.[0],
            category_id: flat.category_id?.[0],
            finalAmount: flat.amount?.[0],
            purchaseDate: flat.transaction_date?.[0],
            notes: flat.notes?.[0],
          });
          return;
        }

        setIsSaving(true);
        try {
          await convertPriorityItemToPurchase({
            priority_item_id: initialItem.id,
            mode: 'cash',
            category_id: parsed.data.category_id,
            description: parsed.data.description,
            amount: parsed.data.amount,
            purchase_date: parsed.data.transaction_date,
            notes: parsed.data.notes ?? null,
            is_gustito: parsed.data.is_gustito,
          });
          toast.success(
            `"${parsed.data.description}" registrado como gasto y eliminado de la matriz.`,
          );
          await onSaved();
          onClose();
        } catch (err) {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo convertir el ítem en gasto.';
          toast.error(msg);
        } finally {
          setIsSaving(false);
        }
        return;
      }

      const parsedInst = installmentPurchaseSchema.safeParse({
        description: title,
        category_id: categoryId,
        installment_amount: finalAmount,
        installments_count: installmentsCount,
        purchase_date: purchaseDate,
        first_installment_date: firstInstallmentDate,
        notes: notes || null,
        is_gustito: isCategoryGustito || isGustito,
      });

      if (!parsedInst.success) {
        const flat = parsedInst.error.flatten().fieldErrors;
        setErrors({
          title: flat.description?.[0],
          category_id: flat.category_id?.[0],
          finalAmount: flat.installment_amount?.[0],
          installmentsCount: flat.installments_count?.[0],
          purchaseDate: flat.purchase_date?.[0],
          firstInstallmentDate: flat.first_installment_date?.[0],
          notes: flat.notes?.[0],
        });
        return;
      }

      setIsSaving(true);
      try {
        await convertPriorityItemToPurchase({
          priority_item_id: initialItem.id,
          mode: 'installments',
          category_id: parsedInst.data.category_id,
          description: parsedInst.data.description,
          amount: parsedInst.data.installment_amount,
          purchase_date: parsedInst.data.purchase_date,
          installments_count: parsedInst.data.installments_count,
          first_installment_date: parsedInst.data.first_installment_date,
          notes: parsedInst.data.notes ?? null,
          is_gustito: parsedInst.data.is_gustito,
        });
        toast.success(
          `"${parsedInst.data.description}" registrado en ${parsedInst.data.installments_count} cuota(s) y eliminado de la matriz.`,
        );
        await onSaved();
        onClose();
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'No se pudo convertir el ítem en compra en cuotas.';
        toast.error(msg);
      } finally {
        setIsSaving(false);
      }
      return;
    }

    // Modo crear / editar ítem de matriz
    const parsed = priorityItemSchema.safeParse({
      title,
      estimated_cost: estimatedCost,
      category_id: categoryId || null,
      quadrant,
      notes: notes || null,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        title: flat.title?.[0],
        estimated_cost: flat.estimated_cost?.[0],
        category_id: flat.category_id?.[0],
        quadrant: flat.quadrant?.[0],
        notes: flat.notes?.[0],
      });
      return;
    }

    setIsSaving(true);
    try {
      if (activeMode === 'edit' && initialItem) {
        await updatePriorityItem(initialItem.id, parsed.data);
        toast.success('Ítem de prioridad actualizado.');
      } else {
        await createPriorityItem(userId, parsed.data);
        toast.success('Ítem agregado a tu Matriz de Prioridad.');
      }
      await onSaved();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'No se pudo guardar el ítem en la matriz.';
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
        activeMode === 'actions' && initialItem
          ? initialItem.title
          : activeMode === 'convert'
            ? 'Registrar compra real'
            : activeMode === 'edit'
              ? 'Editar deseo de compra'
              : 'Agregar ítem a Matriz de Prioridad'
      }
      description={
        activeMode === 'actions'
          ? 'Elegí si querés registrar la compra real, editar sus datos o quitarlo de la matriz.'
          : activeMode === 'convert'
            ? 'Ingresá el monto real que gastaste. Al confirmar, se registra el gasto y se elimina la tarjeta de la matriz.'
            : 'Evaluá su impacto real en tu día a día frente al costo estimado.'
      }
      size="lg"
    >
      {activeMode === 'actions' && initialItem ? (
        <div className="flex flex-col gap-5">
          <div className="rounded-[8px] border border-[#262626] bg-[#0A0A0A] p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
                Costo estimado
              </span>
              <span className="font-mono-num text-xl font-bold text-[#FACC15]">
                {formatCurrency(initialItem.estimated_cost, currency)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-[#D4D4D4]">
              <span className="rounded-full border border-[#262626] bg-[#121212] px-2.5 py-1">
                {PRIORITY_QUADRANT_META[quadrant].shortTitle}
              </span>
              {initialItem.category ? (
                <span className="rounded-full border border-[#262626] bg-[#121212] px-2.5 py-1 text-[#A3A3A3]">
                  {initialItem.category.name}
                </span>
              ) : null}
            </div>

            {initialItem.notes ? (
              <p className="text-sm text-[#D4D4D4] leading-relaxed border-t border-[#1A1A1A] pt-2.5">
                {initialItem.notes}
              </p>
            ) : null}
          </div>

          {onMoveQuadrant ? (
            <SelectField
              label="Mover de cuadrante"
              value={quadrant}
              disabled={isMovingQuadrant}
              onChange={(e) =>
                void handleQuickQuadrantSelect(e.target.value as PriorityQuadrant)
              }
              options={PRIORITY_QUADRANT_ORDER.map((qId) => ({
                value: qId,
                label: `${PRIORITY_QUADRANT_META[qId].title} (${PRIORITY_QUADRANT_META[qId].shortTitle})`,
              }))}
            />
          ) : null}

          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2.5 pt-2 border-t border-[#1F1F1F]">
            <div className="flex flex-col-reverse sm:flex-row gap-2.5">
              {onRequestDelete ? (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => {
                    onClose();
                    onRequestDelete(initialItem);
                  }}
                >
                  Eliminar
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                onClick={() => switchToMode('edit')}
              >
                Editar
              </Button>
            </div>

            <Button
              type="button"
              variant="primary"
              onClick={() => switchToMode('convert')}
            >
              Comprar y registrar gasto
            </Button>
          </div>
        </div>
      ) : activeMode === 'convert' ? (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={convertType === 'cash'}
              onClick={() => handleConvertTypeChange('cash')}
              className={[
                'min-h-[44px] px-3 rounded-[6px] border text-sm font-bold cursor-pointer transition-colors',
                convertType === 'cash'
                  ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                  : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Movimiento al contado
            </button>
            <button
              type="button"
              aria-pressed={convertType === 'installments'}
              onClick={() => handleConvertTypeChange('installments')}
              className={[
                'min-h-[44px] px-3 rounded-[6px] border text-sm font-bold cursor-pointer transition-colors',
                convertType === 'installments'
                  ? 'border-[#FACC15] bg-[#FACC15]/12 text-[#FACC15]'
                  : 'border-[#262626] bg-[#0A0A0A] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Compra en cuotas
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <InputField
              label="Descripción"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={errors.title}
              required
            />
            <SelectField
              label="Categoría de gasto"
              value={categoryId}
              onChange={(e) => handleCategoryChange(e.target.value)}
              placeholder="Seleccioná una categoría"
              options={expenseCategories.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
              error={errors.category_id}
              required
            />
          </div>

          {convertType === 'cash' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InputField
                label="Monto real pagado"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                prefixText="$"
                value={finalAmount}
                onChange={(e) => setFinalAmount(e.target.value)}
                error={errors.finalAmount}
                hint={
                  initialItem
                    ? `Estimado en matriz: ${formatCurrency(initialItem.estimated_cost, currency)}`
                    : undefined
                }
                required
              />
              <InputField
                label="Fecha del gasto"
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                error={errors.purchaseDate}
                required
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InputField
                label="Monto real por cuota"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                prefixText="$"
                value={finalAmount}
                onChange={(e) => setFinalAmount(e.target.value)}
                error={errors.finalAmount}
                hint={
                  Number.isFinite(Number(finalAmount)) &&
                  Number.isFinite(Number(installmentsCount)) &&
                  Number(finalAmount) > 0 &&
                  Number(installmentsCount) >= 1
                    ? `Total real: ${formatCurrency(
                        roundCurrency(Number(finalAmount) * Number(installmentsCount)),
                        currency,
                      )}${
                        initialItem
                          ? ` · Estimado: ${formatCurrency(initialItem.estimated_cost, currency)}`
                          : ''
                      }`
                    : undefined
                }
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
                error={errors.installmentsCount}
                required
              />
              <InputField
                label="Fecha de la compra"
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                error={errors.purchaseDate}
                required
              />
              <InputField
                label="Fecha de la 1.ª cuota"
                type="date"
                value={firstInstallmentDate}
                onChange={(e) => setFirstInstallmentDate(e.target.value)}
                error={errors.firstInstallmentDate}
                required
              />
            </div>
          )}

          <label
            htmlFor="priority-convert-gustito"
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3 py-2.5 cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <input
                id="priority-convert-gustito"
                type="checkbox"
                checked={isCategoryGustito || isGustito}
                disabled={isCategoryGustito}
                onChange={(e) => setIsGustito(e.target.checked)}
                className="h-4 w-4 accent-[#FACC15]"
              />
              <span className="text-sm font-medium text-[#FAFAFA]">
                Contar en Bolsa de Gustitos
              </span>
            </div>
            <span className="text-xs text-[#A3A3A3]">
              {isCategoryGustito ? 'Por categoría' : isGustito ? 'Incluido' : 'Opcional'}
            </span>
          </label>

          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2.5 pt-2">
            <div>
              {mode === 'actions' ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => switchToMode('actions')}
                  disabled={isSaving}
                >
                  &larr; Volver
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-2.5">
              <Button variant="secondary" onClick={onClose} disabled={isSaving}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="primary"
                isLoading={isSaving}
                loadingText="Registrando compra..."
              >
                Confirmar compra
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <InputField
              label="¿Qué querés comprar?"
              placeholder="Ej. Silla ergonómica / Auriculares"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={errors.title}
              required
            />
            <InputField
              label="Costo estimado"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              prefixText="$"
              placeholder="0.00"
              value={estimatedCost}
              onChange={(e) => setEstimatedCost(e.target.value)}
              error={errors.estimated_cost}
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SelectField
              label="Cuadrante de prioridad"
              value={quadrant}
              onChange={(e) => setQuadrant(e.target.value as PriorityQuadrant)}
              options={PRIORITY_QUADRANT_ORDER.map((qId) => ({
                value: qId,
                label: PRIORITY_QUADRANT_META[qId].title,
              }))}
              error={errors.quadrant}
              required
            />
            <SelectField
              label="Categoría estimada (opcional)"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              placeholder="Sin categoría asignada"
              options={expenseCategories.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
              error={errors.category_id}
            />
          </div>

          <InputField
            label="Notas (opcional)"
            placeholder="Ej. Esperar oferta o comprar en 6 cuotas sin interés"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            error={errors.notes}
          />

          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2.5 pt-2">
            <div>
              {mode === 'actions' && activeMode === 'edit' ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => switchToMode('actions')}
                  disabled={isSaving}
                >
                  &larr; Volver
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-2.5">
              <Button variant="secondary" onClick={onClose} disabled={isSaving}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="primary"
                isLoading={isSaving}
                loadingText="Guardando..."
              >
                {activeMode === 'edit' ? 'Guardar cambios' : 'Agregar a matriz'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
