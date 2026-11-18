/**
 * Modal de creación y edición de Movimientos Manuales (Gasto Variable o Ingreso Extra).
 *
 * Arquitectura y decisiones técnicas:
 * - El selector de categoría es obligatorio para ambos tipos y filtra dinámicamente
 *   las categorías activas del tipo seleccionado; si se edita un movimiento histórico
 *   cuya categoría fue archivada, la conserva como opción `(Archivada)` para no forzar
 *   un cambio involuntario.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { toLocalISODate, toMonthStartISODate } from '../../lib/formatters';
import { transactionSchema } from '../../lib/validations';
import { createTransaction, updateTransaction } from '../../services/transactionsService';
import type { Category, Transaction, TransactionType } from '../../types/database.types';

export interface TransactionFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  categories: Category[];
  defaultMonthDate?: string;
  initialTransaction?: Transaction | null;
  onSaved: () => Promise<void>;
}

export function TransactionFormModal({
  isOpen,
  onClose,
  userId,
  categories,
  defaultMonthDate,
  initialTransaction,
  onSaved,
}: TransactionFormModalProps) {
  const isEditing = Boolean(initialTransaction);

  const [type, setType] = useState<TransactionType>('expense');
  const [categoryId, setCategoryId] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [transactionDate, setTransactionDate] = useState<string>(toLocalISODate());
  const [description, setDescription] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [isGustito, setIsGustito] = useState<boolean>(false);
  const [saveToSavings, setSaveToSavings] = useState<boolean>(false);
  const [errors, setErrors] = useState<{
    category_id?: string;
    amount?: string;
    transaction_date?: string;
    description?: string;
    notes?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;

  const availableCategories = useMemo(() => {
    const activeByType = categories.filter(
      (c) => c.type === type && c.is_active,
    );

    if (
      initialTransaction &&
      initialTransaction.type === type &&
      !activeByType.some((c) => c.id === initialTransaction.category_id)
    ) {
      const archived = categories.find(
        (c) => c.id === initialTransaction.category_id,
      );
      if (archived) {
        return [
          ...activeByType,
          { ...archived, name: `${archived.name} (Archivada)` },
        ];
      }
    }

    return activeByType;
  }, [categories, type, initialTransaction]);

  const selectedCategory = useMemo(
    () => availableCategories.find((c) => c.id === categoryId),
    [availableCategories, categoryId],
  );
  const isCategoryGustito =
    type === 'expense' && Boolean(selectedCategory?.is_gustito);

  // Inicialización al abrir modal (dependencias estables para no resetear inputs mientras está abierto)
  useEffect(() => {
    if (!isOpen) return;
    setErrors({});

    if (initialTransaction) {
      setType(initialTransaction.type);
      setCategoryId(initialTransaction.category_id);
      setAmount(String(initialTransaction.amount));
      setTransactionDate(initialTransaction.transaction_date);
      setDescription(initialTransaction.description);
      setNotes(initialTransaction.notes ?? '');
      setIsGustito(
        initialTransaction.type === 'expense'
          ? Boolean(initialTransaction.is_gustito)
          : false,
      );
      setSaveToSavings(
        initialTransaction.type === 'income'
          ? Boolean(initialTransaction.save_to_savings)
          : false,
      );
    } else {
      const today = toLocalISODate();
      const todayMonth = toMonthStartISODate(today);
      const targetDefaultDate =
        defaultMonthDate && defaultMonthDate !== todayMonth
          ? defaultMonthDate
          : today;

      setType('expense');
      const firstExpense = categoriesRef.current.find(
        (c) => c.type === 'expense' && c.is_active,
      );
      setCategoryId(firstExpense?.id ?? '');
      setAmount('');
      setTransactionDate(targetDefaultDate);
      setDescription('');
      setNotes('');
      setIsGustito(Boolean(firstExpense?.is_gustito));
      setSaveToSavings(false);
    }
  }, [isOpen, initialTransaction, defaultMonthDate]);

  function handleTypeChange(nextType: TransactionType): void {
    setType(nextType);
    const activeOfNextType = categories.filter(
      (c) => c.type === nextType && c.is_active,
    );

    if (nextType === 'income') {
      const preferredIncome =
        activeOfNextType.find((c) =>
          c.name.toLowerCase().includes('ingresos extra'),
        ) ?? activeOfNextType[0];
      setCategoryId(preferredIncome?.id ?? '');
      setIsGustito(false);
    } else {
      const preferredExpense = activeOfNextType[0];
      setCategoryId(preferredExpense?.id ?? '');
      setSaveToSavings(false);
      if (!isEditing) {
        setIsGustito(Boolean(preferredExpense?.is_gustito));
      }
    }
  }

  function handleCategoryChange(nextCategoryId: string): void {
    setCategoryId(nextCategoryId);
    if (!isEditing && type === 'expense') {
      const selectedCat = categories.find((c) => c.id === nextCategoryId);
      setIsGustito(Boolean(selectedCat?.is_gustito));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});

    const parsed = transactionSchema.safeParse({
      type,
      category_id: categoryId,
      amount,
      transaction_date: transactionDate,
      description,
      notes: notes || null,
      is_gustito: type === 'expense' ? isCategoryGustito || isGustito : false,
      save_to_savings: type === 'income' ? saveToSavings : false,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        category_id: flat.category_id?.[0],
        amount: flat.amount?.[0],
        transaction_date: flat.transaction_date?.[0],
        description: flat.description?.[0],
        notes: flat.notes?.[0],
      });
      return;
    }

    setIsSaving(true);
    try {
      if (initialTransaction) {
        await updateTransaction(initialTransaction.id, parsed.data);
        toast.success('Movimiento actualizado.');
      } else {
        await createTransaction(userId, parsed.data);
        toast.success(
          parsed.data.type === 'income'
            ? parsed.data.save_to_savings
              ? 'Ingreso extra registrado y enviado a tu Bóveda de Ahorros.'
              : 'Ingreso extra registrado.'
            : 'Gasto variable registrado.',
        );
      }
      await onSaved();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo guardar el movimiento.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Editar movimiento' : 'Nuevo movimiento manual'}
      description="Registrá un gasto variable diario o un ingreso extra fuera de tu sueldo fijo."
      size="md"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {/* Selector táctil de tipo */}
        <div className="flex flex-col gap-1.5">
          <span id="tx-type-group-label" className="text-[14px] font-medium text-[#FAFAFA]">
            Tipo de movimiento{' '}
            <span aria-hidden="true" className="text-[#FACC15]">
              *
            </span>
          </span>
          <div
            role="group"
            aria-labelledby="tx-type-group-label"
            className="grid grid-cols-2 gap-2"
          >
            <button
              type="button"
              aria-pressed={type === 'expense'}
              onClick={() => handleTypeChange('expense')}
              className={[
                'min-h-[44px] rounded-[6px] border text-sm font-bold transition-colors cursor-pointer',
                type === 'expense'
                  ? 'bg-[#EF4444]/15 border-[#EF4444] text-[#F87171]'
                  : 'bg-[#0A0A0A] border-[#262626] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Gasto Variable
            </button>
            <button
              type="button"
              aria-pressed={type === 'income'}
              onClick={() => handleTypeChange('income')}
              className={[
                'min-h-[44px] rounded-[6px] border text-sm font-bold transition-colors cursor-pointer',
                type === 'income'
                  ? 'bg-[#22C55E]/15 border-[#22C55E] text-[#22C55E]'
                  : 'bg-[#0A0A0A] border-[#262626] text-[#A3A3A3] hover:text-[#FAFAFA]',
              ].join(' ')}
            >
              Ingreso Extra
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SelectField
            label="Categoría"
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
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Descripción breve"
            placeholder={
              type === 'income'
                ? 'Ej. Diseño web freelance'
                : 'Ej. Supermercado semanal'
            }
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={errors.description}
            required
          />

          <InputField
            label="Fecha del movimiento"
            type="date"
            value={transactionDate}
            onChange={(e) => setTransactionDate(e.target.value)}
            error={errors.transaction_date}
            required
          />
        </div>

        <InputField
          label="Nota (opcional)"
          placeholder="Detalle adicional..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={errors.notes}
        />

        {type === 'expense' ? (
          <label
            htmlFor="transaction-is-gustito"
            className={[
              'flex min-h-[44px] items-center justify-between gap-3 rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3 py-2.5 transition-colors',
              isCategoryGustito
                ? 'cursor-default opacity-90'
                : 'cursor-pointer hover:border-[#404040]',
            ].join(' ')}
          >
            <div className="flex items-center gap-3 min-w-0">
              <input
                id="transaction-is-gustito"
                type="checkbox"
                checked={isCategoryGustito ? true : isGustito}
                disabled={isCategoryGustito}
                onChange={(e) => setIsGustito(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-[#262626] bg-[#121212] accent-[#FACC15] focus:ring-2 focus:ring-[#FACC15]/50 disabled:cursor-not-allowed"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-[#FAFAFA]">
                  Contar este gasto en la bolsa de Gustitos
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
        ) : (
          <label
            htmlFor="transaction-save-to-savings"
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-[6px] border border-[#262626] bg-[#0A0A0A] px-3 py-2.5 transition-colors cursor-pointer hover:border-[#404040]"
          >
            <div className="flex items-center gap-3 min-w-0">
              <input
                id="transaction-save-to-savings"
                type="checkbox"
                checked={saveToSavings}
                onChange={(e) => setSaveToSavings(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-[#262626] bg-[#121212] accent-[#FACC15] focus:ring-2 focus:ring-[#FACC15]/50"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-[#FAFAFA]">
                  Enviar este ingreso directamente a la Bóveda de Ahorros
                </span>
                <span className="text-xs text-[#A3A3A3]">
                  Se apartará automáticamente en Ahorros sin sumarse al Disponible Real gastable.
                </span>
              </div>
            </div>
            <span className="text-xs text-[#A3A3A3] shrink-0">
              {saveToSavings ? 'Ahorro directo' : 'Opcional'}
            </span>
          </label>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={isSaving}
            loadingText="Guardando..."
          >
            {isEditing ? 'Guardar movimiento' : 'Registrar movimiento'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
