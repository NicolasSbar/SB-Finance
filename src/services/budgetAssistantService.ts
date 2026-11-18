/**
 * Servicio cliente del Asistente de Distribución de Presupuesto con IA (`budgetAssistantService`).
 *
 * Arquitectura y decisiones técnicas:
 * - Deja todo el procesamiento de IA y claves (`GEMINI_API_KEY`) exclusivamente dentro de
 *   la Edge Function `budget-assistant` en Supabase Cloud, extrayendo el JSON de error real
 *   cuando `FunctionsHttpError` devuelve HTTP 4xx/5xx para no ocultar mensajes en español.
 * - Validación y atomicidad (`applySuggestedLimits`): valida la propuesta con
 *   `budgetAssistantProposalSchema` (Zod) y ejecuta una única RPC transaccional
 *   `apply_budget_assistant_limits` en PostgreSQL evitando estados parcialmente guardados.
 */
import { roundCurrency, toMonthStartISODate } from '../lib/formatters';
import { supabase } from '../lib/supabaseClient';
import { budgetAssistantProposalSchema } from '../lib/validations';
import type {
  ApplyBudgetAssistantLimitsArgs,
  ApplyBudgetAssistantLimitsResult,
  BudgetAssistantProposal,
  BudgetAssistantResponse,
} from '../types/database.types';

async function requireAuthenticatedUserId(): Promise<string> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.user?.id) {
    throw new Error('Tu sesión expiró. Iniciá sesión nuevamente para continuar.');
  }

  return session.user.id;
}

async function extractEdgeFunctionErrorMessage(
  error: unknown,
  response?: Response,
): Promise<string> {
  const errObj = error as { context?: unknown; name?: unknown } | null;
  const targetResponse =
    errObj?.context instanceof Response ? errObj.context : response;

  if (targetResponse) {
    try {
      const payload = (await targetResponse.clone().json()) as {
        error?: unknown;
      };
      if (typeof payload?.error === 'string' && payload.error.trim().length > 0) {
        return payload.error.trim();
      }
    } catch {
      // Cuerpo no-JSON o ya consumido; seguimos con mensajes por estado HTTP
    }

    if (targetResponse.status === 429) {
      return 'Alcanzaste el límite de consultas por hora al asistente. Intentá nuevamente más tarde.';
    }
    if (targetResponse.status === 503) {
      return 'El servicio de inteligencia artificial no está disponible en este momento.';
    }
    if (targetResponse.status === 504) {
      return 'El servicio de inteligencia artificial demoró demasiado en responder. Intentá nuevamente.';
    }
  }

  if (errObj?.name === 'FunctionsFetchError') {
    return 'No pudimos conectarnos con el asistente. Verificá tu conexión e intentá nuevamente.';
  }

  return 'No se pudo generar la sugerencia de presupuesto. Intentá nuevamente en unos segundos.';
}

export interface GenerateBudgetProposalInput {
  userGoal?: string;
  audioBase64?: string;
  audioMimeType?: string;
  audioDurationSeconds?: number;
}

export async function generateBudgetProposal(
  input?: string | GenerateBudgetProposalInput,
): Promise<BudgetAssistantResponse> {
  await requireAuthenticatedUserId();

  const normalizedInput: GenerateBudgetProposalInput =
    typeof input === 'string' ? { userGoal: input } : (input ?? {});

  const cleanedGoal = normalizedInput.userGoal?.trim().slice(0, 500) || undefined;
  const payload: Record<string, unknown> = {};
  if (cleanedGoal) {
    payload.userGoal = cleanedGoal;
  }
  if (normalizedInput.audioBase64 && normalizedInput.audioMimeType) {
    payload.audioBase64 = normalizedInput.audioBase64;
    payload.audioMimeType = normalizedInput.audioMimeType;
    payload.audioDurationSeconds = normalizedInput.audioDurationSeconds ?? 1;
  }

  const { data, error, response } = await supabase.functions.invoke(
    'budget-assistant',
    {
      body: payload,
    },
  );

  if (error) {
    const detailedMessage = await extractEdgeFunctionErrorMessage(
      error,
      response,
    );
    throw new Error(detailedMessage);
  }

  if (!data || typeof data !== 'object') {
    throw new Error('El asistente no devolvió una respuesta válida.');
  }

  const typed = data as BudgetAssistantResponse & { error?: string };
  if (typed.error) {
    throw new Error(typed.error);
  }

  if (typed.status === 'insufficient_data') {
    return typed;
  }

  if (typed.status === 'ok') {
    const parsedProposal = budgetAssistantProposalSchema.safeParse(typed.proposal);
    if (!parsedProposal.success) {
      throw new Error(
        'La propuesta recibida del asistente tiene un formato inválido. Intentá nuevamente.',
      );
    }
    return {
      ...typed,
      proposal: parsedProposal.data,
    };
  }

  throw new Error('El asistente devolvió un estado inesperado.');
}

export async function applySuggestedLimits(
  userId: string,
  proposal: BudgetAssistantProposal,
  applyToCurrentMonth: boolean,
): Promise<void> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para aplicar límites a otro usuario.');
  }

  const parsedProposal = budgetAssistantProposalSchema.safeParse(proposal);
  if (!parsedProposal.success) {
    throw new Error(
      'La propuesta de presupuesto contiene datos inválidos y no puede aplicarse.',
    );
  }

  const valid = parsedProposal.data;
  const nextFixedLimit = Math.max(
    0,
    roundCurrency(valid.recommended_fixed_expenses_limit),
  );
  const nextGustitosBudget = Math.max(
    0,
    roundCurrency(valid.recommended_gustitos_budget),
  );
  const nextSavingsTarget = Math.max(
    0,
    roundCurrency(valid.recommended_monthly_savings_target),
  );

  const categoryLimitsPayload = valid.category_limits.map((item) => ({
    category_id: item.category_id,
    suggested_limit:
      item.suggested_limit !== null && item.suggested_limit > 0
        ? roundCurrency(item.suggested_limit)
        : null,
  }));

  const targetMonth = applyToCurrentMonth
    ? toMonthStartISODate(new Date())
    : null;

  const args: ApplyBudgetAssistantLimitsArgs = {
    p_fixed_expenses_limit: nextFixedLimit,
    p_gustitos_budget: nextGustitosBudget,
    p_monthly_savings_target: nextSavingsTarget,
    p_category_limits: categoryLimitsPayload,
    p_apply_to_current_month: applyToCurrentMonth,
    p_target_month_date: targetMonth,
  };

  const { data, error } = await supabase.rpc(
    'apply_budget_assistant_limits',
    args,
  );

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudieron aplicar los límites sugeridos.',
    );
  }

  const result = data as ApplyBudgetAssistantLimitsResult;
  if (!result.ok) {
    throw new Error('No se pudieron aplicar los límites sugeridos.');
  }
}
