/**
 * Modal de creación y edición de Plantillas de Gastos Fijos Recurrentes.
 *
 * Arquitectura y decisiones técnicas:
 * - Al editar una plantilla, la sincronización afecta la plantilla base (futuro) y la
 *   instancia del mes en curso solo si aún no fue abonada (`is_paid = false`), evitando
 *   reescribir historia pagada.
 * - Incluye alerta preventiva en rojo semántico cuando el nuevo gasto fijo hace que el
 *   compromiso mensual supere el `fixed_expenses_limit`, sin bloquear nunca el guardado.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { formatCurrency, formatPercent, roundCurrency } from '../../lib/formatters';
import { fixedExpenseTemplateSchema } from '../../lib/validations';
import {
  createFixedExpenseTemplate,
  updateFixedExpenseTemplate,
} from '../../services/commitmentsService';
import type { Category, FixedExpenseTemplate } from '../../types/database.types';

export interface FixedExpenseFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  currentCalendarMonth: string;
  categories: Category[];
  initialTemplate?: FixedExpenseTemplate | null;
  currentCommittedTotal: number;
  fixedExpensesLimit: number;
  currency: string;
  onSaved: () => Promise<void>;
}

export function FixedExpenseFormModal({
  isOpen,
  onClose,
  userId,
  currentCalendarMonth,
  categories,
  initialTemplate,
  currentCommittedTotal,
  fixedExpensesLimit,
  currency,
  onSaved,
}: FixedExpenseFormModalProps) {
  const isEditing = Boolean(initialTemplate);

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [defaultAmount, setDefaultAmount] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{
    name?: string;
    category_id?: string;
    default_amount?: string;
    due_day?: string;
    notes?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  const availableCategories = useMemo(() => {
    const activeExpenses = categories.filter(
      (c) => c.type === 'expense' && c.is_active,
    );
    if (
      initialTemplate &&
      !activeExpenses.some((c) => c.id === initialTemplate.category_id)
    ) {
      const archived = categories.find((c) => c.id === initialTemplate.category_id);
      if (archived) {
        return [
          ...activeExpenses,
          { ...archived, name: `${archived.name} (Archivada)` },
        ];
      }
    }
    return activeExpenses;
  }, [categories, initialTemplate]);

  const availableCategoriesRef = useRef(availableCategories);
  availableCategoriesRef.current = availableCategories;

  useEffect(() => {
    if (!isOpen) return;
    setErrors({});
    if (initialTemplate) {
      setName(initialTemplate.name);
      setCategoryId(initialTemplate.category_id);
      setDefaultAmount(String(initialTemplate.default_amount));
      setDueDay(initialTemplate.due_day ? String(initialTemplate.due_day) : '');
      setNotes(initialTemplate.notes ?? '');
    } else {
      setName('');
      const cats = availableCategoriesRef.current;
      const servicesCat =
        cats.find((c) => c.name.toLowerCase().includes('servicios')) ?? cats[0];
      setCategoryId(servicesCat?.id ?? '');
      setDefaultAmount('');
      setDueDay('');
      setNotes('');
    }
  }, [isOpen, initialTemplate]);

  // Cálculo preventivo en vivo del impacto sobre el límite de gastos fijos
  const parsedAmount = Number(defaultAmount);
  const projectedTotal = useMemo(() => {
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return roundCurrency(currentCommittedTotal);
    }
    // Solo descontamos el monto anterior si la plantilla estaba activa en el mes actual
    const previousAmount =
      initialTemplate?.is_active === true ? initialTemplate.default_amount : 0;
    return roundCurrency(
      Math.max(0, currentCommittedTotal - previousAmount + parsedAmount),
    );
  }, [parsedAmount, currentCommittedTotal, initialTemplate]);

  const exceedsLimit =
    fixedExpensesLimit > 0 && projectedTotal > fixedExpensesLimit;
  const excessAmount = exceedsLimit
    ? roundCurrency(projectedTotal - fixedExpensesLimit)
    : 0;
  const usagePercent =
    fixedExpensesLimit > 0
      ? roundCurrency((projectedTotal / fixedExpensesLimit) * 100)
      : 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});

    const parsed = fixedExpenseTemplateSchema.safeParse({
      name,
      category_id: categoryId,
      default_amount: defaultAmount,
      due_day: dueDay,
      notes: notes || null,
    });

    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        name: flat.name?.[0],
        category_id: flat.category_id?.[0],
        default_amount: flat.default_amount?.[0],
        due_day: flat.due_day?.[0],
        notes: flat.notes?.[0],
      });
      return;
    }

    setIsSaving(true);
    try {
      if (initialTemplate) {
        await updateFixedExpenseTemplate(
          userId,
          initialTemplate.id,
          parsed.data,
          currentCalendarMonth,
        );
        toast.success('Gasto fijo actualizado.');
      } else {
        await createFixedExpenseTemplate(
          userId,
          parsed.data,
          currentCalendarMonth,
        );
        toast.success('Gasto fijo creado e incluido en el mes actual.');
      }

      if (exceedsLimit) {
        toast(
          `Aviso: superaste tu límite mensual de gastos fijos en ${formatCurrency(excessAmount, currency)}.`,
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
        err instanceof Error ? err.message : 'No se pudo guardar el gasto fijo.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Editar gasto fijo recurrente' : 'Nuevo gasto fijo recurrente'}
      description="Se descontará automáticamente de tu Disponible Real desde el día 1 de cada mes."
      size="md"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <InputField
          label="Nombre del gasto fijo"
          placeholder="Ej. Alquiler, Internet Fibra, Expensas"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          required
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SelectField
            label="Categoría de gasto"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            placeholder="Seleccioná una categoría"
            options={availableCategories.map((c) => ({
              value: c.id,
              label: c.name,
            }))}
            error={errors.category_id}
            required
          />

          <InputField
            label="Monto mensual por defecto"
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            prefixText="$"
            placeholder="0.00"
            value={defaultAmount}
            onChange={(e) => setDefaultAmount(e.target.value)}
            error={errors.default_amount}
            required
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InputField
            label="Día estimado de vencimiento (opcional)"
            type="number"
            min="1"
            max="31"
            inputMode="numeric"
            placeholder="Ej. 10"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            error={errors.due_day}
            hint="Entre 1 y 31 de cada mes."
          />

          <InputField
            label="Notas (opcional)"
            placeholder="Ej. Débito automático / CBU"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            error={errors.notes}
          />
        </div>

        {exceedsLimit ? (
          <div
            role="status"
            className="rounded-[6px] border border-[#EF4444]/60 bg-[#EF4444]/12 p-3.5 text-sm text-[#FAFAFA]"
          >
            <p className="font-bold text-[#F87171]">
              Alerta preventiva: supera tu límite mensual ({formatPercent(usagePercent)})
            </p>
            <p className="mt-1 text-[#D4D4D4]">
              Con este gasto fijo, tus compromisos proyectados suman{' '}
              <strong className="font-mono-num text-[#FAFAFA]">
                {formatCurrency(projectedTotal, currency)}
              </strong>{' '}
              y exceden el tope en{' '}
              <strong className="font-mono-num text-[#F87171]">
                {formatCurrency(excessAmount, currency)}
              </strong>
              . Podés guardarlo igual si lo necesitás.
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
            loadingText="Guardando..."
          >
            {isEditing ? 'Guardar gasto fijo' : 'Crear gasto fijo'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
