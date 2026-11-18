/**
 * Esquemas de validación Zod para todos los formularios y contratos de SB-Finance.
 *
 * Arquitectura y decisiones técnicas:
 * - Validación en dos capas: `zod` en el cliente ofrece retroalimentación inmediata
 *   debajo de cada campo en español claro, mientras que las restricciones CHECK y NOT NULL
 *   de PostgreSQL garantizan la integridad incluso ante peticiones directas a la API.
 * - Fechas de calendario reales (`isValidCalendarDate` + `isoDateSchema`): una regex
 *   `YYYY-MM-DD` por sí sola acepta fechas inexistentes como `2026-02-31`; validar
 *   contra `Date.UTC` evita errores silenciosos al persistir en columnas `DATE`.
 * - Exportamos tipos inferidos (`z.infer`) para mantener sincronizados los estados
 *   de formulario con los esquemas sin duplicar definiciones.
 */
import { z } from 'zod';
import { roundCurrency, toCents } from './formatters';

export const MAX_MONEY = 9999999999.99;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Verifica que `dateStr` tenga formato `YYYY-MM-DD` y corresponda a un día real
 * en el calendario gregoriano (rechaza p. ej. `2026-02-31` o `2026-04-31`).
 */
export function isValidCalendarDate(dateStr: string): boolean {
  if (!ISO_DATE_REGEX.test(dateStr)) return false;
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

function buildIsoDateSchema(
  message = 'Ingresá una fecha válida (AAAA-MM-DD).',
) {
  return z
    .string()
    .regex(ISO_DATE_REGEX, message)
    .refine(isValidCalendarDate, { message });
}

export const isoDateSchema = buildIsoDateSchema();

export const loginSchema = z.object({
  email: z.string().trim().email('Ingresá un correo electrónico válido.'),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.'),
});

export const adminCreateUserSchema = z.object({
  email: z.string().trim().email('Ingresá un correo electrónico válido.'),
  password: z
    .string()
    .min(8, 'La contraseña inicial debe tener al menos 8 caracteres.'),
});

export const userSettingsSchema = z.object({
  fixed_salary: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El sueldo fijo no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  monthly_savings_target: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El ahorro mensual no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  fixed_expenses_limit: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El límite no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  gustitos_budget: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El presupuesto de Gustitos no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  salary_payday: z.coerce
    .number({ invalid_type_error: 'Ingresá un día numérico válido.' })
    .int('El día de cobro debe ser un número entero.')
    .min(0, 'El día de cobro debe ser 0 (último día hábil) o estar entre 1 y 31.')
    .max(31, 'El día de cobro debe estar entre 1 y 31.')
    .default(1),
  timezone: z
    .string()
    .trim()
    .min(3, 'Seleccioná una zona horaria válida.')
    .max(64, 'La zona horaria supera el largo máximo permitido.'),
  update_current_month: z.boolean().default(true),
});

export const monthlyBudgetSnapshotSchema = z.object({
  fixed_salary: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El sueldo fijo no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  monthly_savings_target: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El ahorro mensual no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  fixed_expenses_limit: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El límite no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  gustitos_budget: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
    .min(0, 'El presupuesto de Gustitos no puede ser negativo.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.')
    .default(0),
});

export const savingsEntrySchema = z.object({
  entry_type: z.enum(['deposit', 'withdrawal']),
  amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  entry_date: isoDateSchema,
  description: z
    .string()
    .trim()
    .min(2, 'Ingresá una descripción breve (mínimo 2 caracteres).')
    .max(150, 'La descripción no puede superar los 150 caracteres.'),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar los 500 caracteres.')
    .nullable()
    .optional(),
  credit_to_available: z.boolean().optional().default(false),
});

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'El nombre debe tener al menos 2 caracteres.')
    .max(60, 'El nombre no puede superar los 60 caracteres.'),
  type: z.enum(['expense', 'income'], {
    required_error: 'Seleccioná el tipo de categoría.',
  }),
  icon: z.string().trim().min(1).max(40).default('tag'),
  is_gustito: z.boolean().default(false),
  monthly_limit: z
    .union([
      z.coerce
        .number({ invalid_type_error: 'Ingresá un monto límite válido.' })
        .min(0.01, 'El límite mensual debe ser de al menos $0,01.')
        .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
      z.literal(''),
      z.null(),
    ])
    .optional()
    .transform((val) =>
      val === '' || val === null || val === undefined ? null : Number(val),
    ),
});

export const fixedExpenseTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'El nombre debe tener al menos 2 caracteres.')
    .max(100, 'El nombre no puede superar los 100 caracteres.'),
  category_id: z.string().uuid('Seleccioná una categoría válida.'),
  default_amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  due_day: z
    .union([
      z.coerce
        .number({ invalid_type_error: 'Ingresá un día numérico.' })
        .int('El día debe ser entero.')
        .min(1, 'Día entre 1 y 31.')
        .max(31, 'Día entre 1 y 31.'),
      z.literal(''),
      z.null(),
    ])
    .optional()
    .transform((val) => (val === '' || val === null || val === undefined ? null : Number(val))),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar los 500 caracteres.')
    .nullable()
    .optional(),
});

export const installmentPurchaseSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(2, 'La descripción debe tener al menos 2 caracteres.')
      .max(150, 'La descripción no puede superar los 150 caracteres.'),
    category_id: z.string().uuid('Seleccioná una categoría de gasto.'),
    installment_amount: z.coerce
      .number({ invalid_type_error: 'Ingresá un monto de cuota válido.' })
      .min(0.01, 'El monto debe ser de al menos $0,01.')
      .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
    installments_count: z.coerce
      .number({ invalid_type_error: 'Ingresá una cantidad entera de cuotas.' })
      .int('La cantidad de cuotas debe ser un número entero.')
      .min(1, 'Debe tener al menos 1 cuota.')
      .max(120, 'No puede superar las 120 cuotas.'),
    purchase_date: buildIsoDateSchema(
      'Ingresá una fecha de compra válida (AAAA-MM-DD).',
    ),
    first_installment_date: buildIsoDateSchema(
      'Ingresá la fecha de la primera cuota (AAAA-MM-DD).',
    ),
    notes: z
      .string()
      .trim()
      .max(500, 'Las notas no pueden superar los 500 caracteres.')
      .nullable()
      .optional(),
    is_gustito: z.boolean().optional().default(false),
  })
  .refine(
    (data) =>
      roundCurrency(data.installment_amount * data.installments_count) <=
      MAX_MONEY,
    {
      message: 'El monto total financiado supera el máximo permitido.',
      path: ['installment_amount'],
    },
  );

export const transactionSchema = z.object({
  type: z.enum(['expense', 'income']),
  category_id: z.string().uuid('Seleccioná una categoría obligatoria.'),
  amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  transaction_date: isoDateSchema,
  description: z
    .string()
    .trim()
    .min(2, 'Ingresá una descripción breve (mínimo 2 caracteres).')
    .max(150, 'La descripción no puede superar los 150 caracteres.'),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar los 500 caracteres.')
    .nullable()
    .optional(),
  is_gustito: z.boolean().default(false),
  save_to_savings: z.boolean().optional().default(false),
});

export const monthlyAmountEditSchema = z.object({
  amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
});

export const advanceInstallmentsSchema = z
  .object({
    count: z.coerce
      .number({ invalid_type_error: 'Ingresá una cantidad válida.' })
      .int('La cantidad de cuotas debe ser un entero.')
      .min(1, 'Debés adelantar al menos 1 cuota.')
      .max(120, 'No podés adelantar más de 120 cuotas a la vez.'),
    custom_total_amount: z
      .union([
        z.coerce
          .number({ invalid_type_error: 'Ingresá un monto total válido.' })
          .min(0.01, 'El monto total abonado debe ser de al menos $0,01.')
          .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
        z.literal(''),
        z.null(),
      ])
      .optional()
      .transform((val) =>
        val === '' || val === null || val === undefined ? null : Number(val),
      ),
  })
  .refine(
    (data) =>
      data.custom_total_amount === null ||
      toCents(data.custom_total_amount) >= data.count,
    {
      message:
        'El monto total abonado debe ser de al menos $0,01 por cada cuota adelantada.',
      path: ['custom_total_amount'],
    },
  );

export const reconcileSurplusSchema = z.object({
  bucket: z.enum(['fixed_limit', 'gustitos']),
  action: z.enum(['to_savings', 'to_available']),
  amount: z.coerce
    .number({ invalid_type_error: 'Ingresá un monto válido.' })
    .min(0.01, 'El monto debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
});

export const fixedTermDepositSchema = z
  .object({
    institution: z
      .string()
      .trim()
      .min(2, 'Ingresá el banco o nombre del plazo fijo (mínimo 2 caracteres).')
      .max(100, 'El nombre no puede superar los 100 caracteres.'),
    principal_amount: z.coerce
      .number({ invalid_type_error: 'Ingresá un capital numérico válido.' })
      .min(0.01, 'El capital invertido debe ser de al menos $0,01.')
      .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
    expected_return_amount: z.coerce
      .number({ invalid_type_error: 'Ingresá el monto a recibir al vencimiento.' })
      .min(0.01, 'El monto a recibir debe ser de al menos $0,01.')
      .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
    start_date: buildIsoDateSchema(
      'Ingresá una fecha de inicio válida (AAAA-MM-DD).',
    ),
    maturity_date: buildIsoDateSchema(
      'Ingresá una fecha de vencimiento válida (AAAA-MM-DD).',
    ),
    origin: z.enum(['monthly_available', 'savings_fund'], {
      required_error: 'Seleccioná el origen del capital.',
    }),
    notes: z
      .string()
      .trim()
      .max(500, 'Las notas no pueden superar los 500 caracteres.')
      .nullable()
      .optional(),
  })
  .refine((data) => data.maturity_date > data.start_date, {
    message: 'La fecha de vencimiento debe ser posterior a la fecha de inicio.',
    path: ['maturity_date'],
  })
  .refine((data) => data.expected_return_amount >= data.principal_amount, {
    message: 'El monto a recibir no puede ser menor al capital invertido.',
    path: ['expected_return_amount'],
  });

export const accreditFixedTermSchema = z
  .object({
    destination: z.enum(['savings_fund', 'monthly_available']),
    actual_return_amount: z.coerce
      .number({ invalid_type_error: 'Ingresá un monto acreditado válido.' })
      .min(0.01, 'El monto acreditado debe ser mayor a cero.')
      .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
    accredited_date: buildIsoDateSchema(
      'Ingresá una fecha de acreditación válida (AAAA-MM-DD).',
    ),
    start_date: isoDateSchema.optional(),
  })
  .refine(
    (data) => !data.start_date || data.accredited_date >= data.start_date,
    {
      message:
        'La fecha de acreditación no puede ser anterior a la fecha de inicio del plazo fijo.',
      path: ['accredited_date'],
    },
  );

export const priorityItemSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, 'Ingresá un nombre breve (mínimo 2 caracteres).')
    .max(150, 'El nombre no puede superar los 150 caracteres.'),
  estimated_cost: z.coerce
    .number({ invalid_type_error: 'Ingresá un costo estimado válido.' })
    .min(0.01, 'El costo estimado debe ser de al menos $0,01.')
    .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
  category_id: z
    .union([z.string().uuid('Seleccioná una categoría válida.'), z.literal(''), z.null()])
    .optional()
    .transform((val) => (!val || val === '' ? null : val)),
  quadrant: z.enum([
    'high_impact_low_cost',
    'high_impact_high_cost',
    'low_impact_low_cost',
    'low_impact_high_cost',
  ]),
  notes: z
    .string()
    .trim()
    .max(500, 'Las notas no pueden superar los 500 caracteres.')
    .nullable()
    .optional(),
});

export const simulatorItemSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(2, 'Ingresá una descripción breve (mínimo 2 caracteres).')
      .max(150, 'La descripción no puede superar los 150 caracteres.'),
    mode: z.enum(['cash', 'installments']),
    unitAmount: z.coerce
      .number({ invalid_type_error: 'Ingresá un monto numérico válido.' })
      .min(0.01, 'El monto debe ser de al menos $0,01.')
      .max(MAX_MONEY, 'El monto supera el máximo permitido.'),
    installmentsCount: z.coerce
      .number({ invalid_type_error: 'Ingresá una cantidad entera de cuotas.' })
      .int('La cantidad de cuotas debe ser un entero.')
      .min(1, 'La cantidad de cuotas debe estar entre 1 y 120.')
      .max(120, 'La cantidad de cuotas debe estar entre 1 y 120.')
      .default(1),
    categoryId: z
      .union([z.string().uuid('Seleccioná una categoría válida.'), z.literal(''), z.null()])
      .optional()
      .transform((val) => (!val || val === '' ? null : val)),
    isGustito: z.boolean().default(false),
    startMonth: z.enum(['current', 'next']).default('current'),
  })
  .refine(
    (data) =>
      data.mode !== 'installments' ||
      roundCurrency(data.unitAmount * data.installmentsCount) <= MAX_MONEY,
    {
      message: 'El monto total simulado en cuotas supera el máximo permitido.',
      path: ['unitAmount'],
    },
  );

export const budgetAssistantCategorySuggestionSchema = z.object({
  category_id: z.string().uuid('El identificador de categoría es inválido.'),
  category_name: z.string().trim().min(1).max(100),
  current_limit: z.number().finite().min(0).max(MAX_MONEY).nullable(),
  suggested_limit: z.number().finite().min(0).max(MAX_MONEY).nullable(),
  reason: z.string().trim().max(500),
});

export const budgetAssistantProposalSchema = z.object({
  summary_reasoning: z
    .string()
    .trim()
    .min(1, 'La propuesta no incluye un resumen válido.')
    .max(1200, 'El resumen de la propuesta supera el largo máximo permitido.'),
  recommended_fixed_expenses_limit: z.number().finite().min(0).max(MAX_MONEY),
  recommended_gustitos_budget: z.number().finite().min(0).max(MAX_MONEY),
  recommended_monthly_savings_target: z.number().finite().min(0).max(MAX_MONEY),
  category_limits: z.array(budgetAssistantCategorySuggestionSchema),
  warnings: z.array(z.string().max(500)),
  disclaimer: z.string().trim().min(1).max(1000),
});

export type LoginFormValues = z.infer<typeof loginSchema>;
export type AdminCreateUserFormValues = z.infer<typeof adminCreateUserSchema>;
export type UserSettingsFormValues = z.infer<typeof userSettingsSchema>;
export type MonthlyBudgetSnapshotFormValues = z.infer<typeof monthlyBudgetSnapshotSchema>;
export type CategoryFormValues = z.infer<typeof categorySchema>;
export type FixedExpenseTemplateFormValues = z.infer<typeof fixedExpenseTemplateSchema>;
export type InstallmentPurchaseFormValues = z.infer<typeof installmentPurchaseSchema>;
export type TransactionFormValues = z.infer<typeof transactionSchema>;
export type MonthlyAmountEditFormValues = z.infer<typeof monthlyAmountEditSchema>;
export type SavingsEntryFormValues = z.infer<typeof savingsEntrySchema>;
export type AdvanceInstallmentsFormValues = z.infer<typeof advanceInstallmentsSchema>;
export type ReconcileSurplusFormValues = z.infer<typeof reconcileSurplusSchema>;
export type FixedTermDepositFormValues = z.infer<typeof fixedTermDepositSchema>;
export type AccreditFixedTermFormValues = z.infer<typeof accreditFixedTermSchema>;
export type PriorityItemFormValues = z.infer<typeof priorityItemSchema>;
export type SimulatorItemFormValues = z.infer<typeof simulatorItemSchema>;
export type BudgetAssistantProposalValues = z.infer<
  typeof budgetAssistantProposalSchema
>;
