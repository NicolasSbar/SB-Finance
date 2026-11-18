/**
 * Modal de creación y edición de Categorías (Gastos e Ingresos) y mapa de íconos SVG.
 *
 * Arquitectura y decisiones técnicas:
 * - Al editar una categoría existente bloqueamos el cambio de `type` (`expense` vs `income`)
 *   para evitar inconsistencias contables con movimientos o compromisos ya registrados.
 * - Exportamos `CategoryIcon` desde este módulo para mantener sincronizado el selector
 *   visual del formulario con la renderización en `CategoriesPage` sin librerías externas.
 */
import { useEffect, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { InputField } from '../../components/ui/InputField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { categorySchema } from '../../lib/validations';
import { createCategory, updateCategory } from '../../services/categoriesService';
import type { Category, TransactionType } from '../../types/database.types';

export interface CategoryFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  initialCategory?: Category | null;
  defaultType: TransactionType;
  onSaved: () => Promise<void>;
}

export const CATEGORY_ICON_OPTIONS = [
  { value: 'tag', label: 'Etiqueta general' },
  { value: 'utensils', label: 'Comida / Supermercado' },
  { value: 'car', label: 'Transporte / Auto' },
  { value: 'home', label: 'Vivienda / Hogar' },
  { value: 'zap', label: 'Servicios / Energía' },
  { value: 'film', label: 'Ocio / Salidas' },
  { value: 'heart-pulse', label: 'Salud / Farmacia' },
  { value: 'graduation-cap', label: 'Educación' },
  { value: 'shopping-bag', label: 'Compras / Indumentaria' },
  { value: 'circle-ellipsis', label: 'Otros gastos' },
  { value: 'wallet', label: 'Ingresos / Billetera' },
  { value: 'briefcase', label: 'Trabajo / Freelance' },
  { value: 'arrow-down-left', label: 'Reintegros / Ventas' },
] as const;

export function CategoryIcon({
  icon,
  className = 'h-4 w-4',
}: {
  icon?: string | null;
  className?: string;
}) {
  const commonProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true as const,
  };

  switch (icon) {
    case 'utensils':
      return (
        <svg {...commonProps}>
          <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
          <path d="M7 2v20" />
          <path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
        </svg>
      );
    case 'car':
      return (
        <svg {...commonProps}>
          <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="17" r="2" />
        </svg>
      );
    case 'home':
      return (
        <svg {...commonProps}>
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case 'zap':
      return (
        <svg {...commonProps}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case 'film':
      return (
        <svg {...commonProps}>
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4" />
        </svg>
      );
    case 'heart-pulse':
      return (
        <svg {...commonProps}>
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          <path d="M3.22 12H9.5l1.5-3 2 6 1.5-3h5.27" />
        </svg>
      );
    case 'graduation-cap':
      return (
        <svg {...commonProps}>
          <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
          <path d="M6 12v5c3 3 9 3 12 0v-5" />
        </svg>
      );
    case 'shopping-bag':
      return (
        <svg {...commonProps}>
          <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
          <path d="M3 6h18" />
          <path d="M16 10a4 4 0 0 1-8 0" />
        </svg>
      );
    case 'circle-ellipsis':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12h.01M12 12h.01M16 12h.01" />
        </svg>
      );
    case 'wallet':
      return (
        <svg {...commonProps}>
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
          <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
        </svg>
      );
    case 'briefcase':
      return (
        <svg {...commonProps}>
          <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
          <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
        </svg>
      );
    case 'arrow-down-left':
      return (
        <svg {...commonProps}>
          <path d="M17 7 7 17" />
          <path d="M17 17H7V7" />
        </svg>
      );
    case 'tag':
    default:
      return (
        <svg {...commonProps}>
          <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z" />
          <path d="M7 7h.01" />
        </svg>
      );
  }
}

export function CategoryFormModal({
  isOpen,
  onClose,
  userId,
  initialCategory,
  defaultType,
  onSaved,
}: CategoryFormModalProps) {
  const isEditing = Boolean(initialCategory);

  const [name, setName] = useState('');
  const [type, setType] = useState<TransactionType>(defaultType);
  const [icon, setIcon] = useState('tag');
  const [isGustito, setIsGustito] = useState(false);
  const [monthlyLimit, setMonthlyLimit] = useState('');
  const [errors, setErrors] = useState<{
    name?: string;
    type?: string;
    monthly_limit?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setErrors({});
    if (initialCategory) {
      setName(initialCategory.name);
      setType(initialCategory.type);
      setIcon(initialCategory.icon || 'tag');
      setIsGustito(
        initialCategory.type === 'expense' ? Boolean(initialCategory.is_gustito) : false,
      );
      setMonthlyLimit(
        initialCategory.type === 'expense' &&
          initialCategory.monthly_limit !== null &&
          initialCategory.monthly_limit > 0
          ? String(initialCategory.monthly_limit)
          : '',
      );
    } else {
      setName('');
      setType(defaultType);
      setIcon(defaultType === 'income' ? 'wallet' : 'tag');
      setIsGustito(false);
      setMonthlyLimit('');
    }
  }, [isOpen, initialCategory, defaultType]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrors({});

    const parsed = categorySchema.safeParse({
      name,
      type,
      icon,
      is_gustito: type === 'expense' ? isGustito : false,
      monthly_limit: type === 'expense' ? monthlyLimit : null,
    });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({
        name: flat.name?.[0],
        type: flat.type?.[0],
        monthly_limit: flat.monthly_limit?.[0],
      });
      return;
    }

    setIsSaving(true);
    try {
      if (initialCategory) {
        await updateCategory(initialCategory.id, {
          name: parsed.data.name,
          icon: parsed.data.icon,
          is_gustito: parsed.data.type === 'expense' ? parsed.data.is_gustito : false,
          monthly_limit:
            parsed.data.type === 'expense' ? parsed.data.monthly_limit : null,
        });
        toast.success('Categoría actualizada.');
      } else {
        await createCategory(userId, parsed.data);
        toast.success('Categoría creada.');
      }
      await onSaved();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo guardar la categoría.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  const selectedIconOption =
    CATEGORY_ICON_OPTIONS.find((opt) => opt.value === icon) ?? CATEGORY_ICON_OPTIONS[0];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Editar categoría' : 'Nueva categoría'}
      description={
        isEditing
          ? 'Actualizá el nombre de la categoría. Los movimientos históricos reflejarán este nombre.'
          : 'Creá una categoría para clasificar tus gastos o ingresos extra.'
      }
      size="sm"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <InputField
          label="Nombre de la categoría"
          placeholder={type === 'income' ? 'Ej. Inversiones / Bonos' : 'Ej. Mascotas'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          required
        />

        <SelectField
          label="Tipo de movimiento"
          value={type}
          onChange={(e) => setType(e.target.value as TransactionType)}
          options={[
            { value: 'expense', label: 'Gasto (Egreso / Cuota / Fijo)' },
            { value: 'income', label: 'Ingreso Extra' },
          ]}
          error={errors.type}
          disabled={isEditing}
          hint={
            isEditing
              ? 'El tipo no puede modificarse para preservar la coherencia del historial.'
              : undefined
          }
          required
        />

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <SelectField
              label="Referencia visual"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              options={[...CATEGORY_ICON_OPTIONS]}
            />
          </div>
          <div
            title={selectedIconOption.label}
            aria-label={`Vista previa del ícono: ${selectedIconOption.label}`}
            className="h-[44px] w-[44px] shrink-0 rounded-[6px] bg-[#0A0A0A] border border-[#262626] flex items-center justify-center text-[#FACC15]"
          >
            <CategoryIcon icon={icon} className="h-5 w-5" />
          </div>
        </div>

        {type === 'expense' ? (
          <div className="flex flex-col gap-3.5 pt-1 border-t border-[#1F1F1F]">
            <label className="flex items-start gap-3 p-3 rounded-[6px] bg-[#0A0A0A] border border-[#262626] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isGustito}
                onChange={(e) => setIsGustito(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#FACC15] cursor-pointer"
              />
              <span className="flex flex-col gap-0.5 text-sm leading-snug">
                <span className="font-semibold text-[#FAFAFA]">
                  Incluir en bolsa de Gustitos
                </span>
                <span className="text-xs text-[#A3A3A3]">
                  Los gastos variables y cuotas de esta categoría descontarán de tu presupuesto de Gustitos (nunca los gastos fijos).
                </span>
              </span>
            </label>

            <InputField
              label="Límite máximo mensual (opcional)"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              prefixText="$"
              placeholder="Sin límite configurado"
              value={monthlyLimit}
              onChange={(e) => setMonthlyLimit(e.target.value)}
              error={errors.monthly_limit}
              hint="Dejalo vacío si no querés tope mensual ni alertas para esta categoría."
            />
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
            {isEditing ? 'Guardar categoría' : 'Crear categoría'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
