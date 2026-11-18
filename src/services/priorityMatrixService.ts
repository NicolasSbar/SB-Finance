/**
 * Servicio CRUD de la Matriz de Prioridad Interactiva (`priority_items`).
 *
 * Arquitectura y decisiones técnicas:
 * - Aislamiento estricto por `auth.uid()` y validación previa con `priorityItemSchema` (`zod`).
 * - Permite reubicar ítems entre los 4 cuadrantes discretos (`movePriorityItemQuadrant`)
 *   tanto desde Drag & Drop nativo en escritorio como desde controles táctiles/teclado
 * - Conversión atómica (`convertPriorityItemToPurchase`): invoca la RPC
 *   `convert_priority_item_to_purchase` para registrar el gasto al contado o la
 *   compra en cuotas y eliminar el ítem de la matriz dentro de una sola transacción.
 */
import { roundCurrency } from '../lib/formatters';
import { supabase } from '../lib/supabaseClient';
import {
  installmentPurchaseSchema,
  priorityItemSchema,
  transactionSchema,
} from '../lib/validations';
import type {
  ConvertPriorityItemToPurchaseArgs,
  ConvertPriorityItemToPurchaseResult,
  PriorityItem,
  PriorityItemInput,
  PriorityPurchaseMode,
  PriorityQuadrant,
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

function mapPriorityItem(row: PriorityItem): PriorityItem {
  return {
    ...row,
    estimated_cost: Number(row.estimated_cost),
    sort_order: Number(row.sort_order ?? 0),
  };
}

export async function getPriorityItems(): Promise<PriorityItem[]> {
  await requireAuthenticatedUserId();
  const { data, error } = await supabase
    .from('priority_items')
    .select('*, category:categories(*)')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(
      `No se pudieron cargar los ítems de la matriz: ${error.message}`,
    );
  }

  return ((data ?? []) as PriorityItem[]).map(mapPriorityItem);
}

export async function createPriorityItem(
  userId: string,
  input: PriorityItemInput,
): Promise<PriorityItem> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para crear ítems para otro usuario.');
  }

  const parsed = priorityItemSchema.safeParse(input);
  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos del ítem son inválidos.';
    throw new Error(firstErr);
  }

  const { data, error } = await supabase
    .from('priority_items')
    .insert({
      user_id: sessionUserId,
      title: parsed.data.title,
      estimated_cost: roundCurrency(parsed.data.estimated_cost),
      category_id: parsed.data.category_id ?? null,
      quadrant: parsed.data.quadrant,
      notes: parsed.data.notes?.trim() || null,
    })
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo agregar el ítem a la matriz: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  return mapPriorityItem(data as PriorityItem);
}

export async function updatePriorityItem(
  id: string,
  input: PriorityItemInput,
): Promise<PriorityItem> {
  const sessionUserId = await requireAuthenticatedUserId();

  const parsed = priorityItemSchema.safeParse(input);
  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos del ítem son inválidos.';
    throw new Error(firstErr);
  }

  const { data, error } = await supabase
    .from('priority_items')
    .update({
      title: parsed.data.title,
      estimated_cost: roundCurrency(parsed.data.estimated_cost),
      category_id: parsed.data.category_id ?? null,
      quadrant: parsed.data.quadrant,
      notes: parsed.data.notes?.trim() || null,
    })
    .eq('id', id)
    .eq('user_id', sessionUserId)
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo actualizar el ítem: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  return mapPriorityItem(data as PriorityItem);
}

export async function movePriorityItemQuadrant(
  id: string,
  quadrant: PriorityQuadrant,
  sortOrder?: number,
): Promise<PriorityItem> {
  const sessionUserId = await requireAuthenticatedUserId();

  const updates: { quadrant: PriorityQuadrant; sort_order?: number } = {
    quadrant,
  };
  if (typeof sortOrder === 'number' && Number.isFinite(sortOrder)) {
    updates.sort_order = Math.trunc(sortOrder);
  }

  const { data, error } = await supabase
    .from('priority_items')
    .update(updates)
    .eq('id', id)
    .eq('user_id', sessionUserId)
    .select('*, category:categories(*)')
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo mover el ítem de cuadrante: ${error?.message ?? 'Error desconocido'}`,
    );
  }

  return mapPriorityItem(data as PriorityItem);
}

export async function deletePriorityItem(id: string): Promise<void> {
  const sessionUserId = await requireAuthenticatedUserId();

  const { error } = await supabase
    .from('priority_items')
    .delete()
    .eq('id', id)
    .eq('user_id', sessionUserId);

  if (error) {
    throw new Error(`No se pudo eliminar el ítem de la matriz: ${error.message}`);
  }
}

export interface ConvertPriorityItemInput {
  priority_item_id: string;
  mode: PriorityPurchaseMode;
  category_id: string;
  description: string;
  amount: number;
  purchase_date: string;
  installments_count?: number;
  first_installment_date?: string | null;
  notes?: string | null;
  is_gustito?: boolean;
}

export async function convertPriorityItemToPurchase(
  input: ConvertPriorityItemInput,
): Promise<ConvertPriorityItemToPurchaseResult> {
  await requireAuthenticatedUserId();

  let rpcArgs: ConvertPriorityItemToPurchaseArgs;

  if (input.mode === 'cash') {
    const parsed = transactionSchema.safeParse({
      type: 'expense',
      category_id: input.category_id,
      amount: input.amount,
      transaction_date: input.purchase_date,
      description: input.description,
      notes: input.notes ?? null,
      is_gustito: Boolean(input.is_gustito),
      save_to_savings: false,
    });

    if (!parsed.success) {
      const firstErr =
        Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
        'Los datos del gasto son inválidos.';
      throw new Error(firstErr);
    }

    rpcArgs = {
      p_priority_item_id: input.priority_item_id,
      p_purchase_mode: 'cash',
      p_category_id: parsed.data.category_id,
      p_description: parsed.data.description,
      p_amount: roundCurrency(parsed.data.amount),
      p_purchase_date: parsed.data.transaction_date,
      p_installments_count: 1,
      p_first_installment_date: null,
      p_notes: parsed.data.notes?.trim() || null,
      p_is_gustito: parsed.data.is_gustito,
    };
  } else {
    const parsed = installmentPurchaseSchema.safeParse({
      description: input.description,
      category_id: input.category_id,
      installment_amount: input.amount,
      installments_count: input.installments_count ?? 1,
      purchase_date: input.purchase_date,
      first_installment_date: input.first_installment_date ?? input.purchase_date,
      notes: input.notes ?? null,
      is_gustito: Boolean(input.is_gustito),
    });

    if (!parsed.success) {
      const firstErr =
        Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
        'Los datos de la compra en cuotas son inválidos.';
      throw new Error(firstErr);
    }

    rpcArgs = {
      p_priority_item_id: input.priority_item_id,
      p_purchase_mode: 'installments',
      p_category_id: parsed.data.category_id,
      p_description: parsed.data.description,
      p_amount: roundCurrency(parsed.data.installment_amount),
      p_purchase_date: parsed.data.purchase_date,
      p_installments_count: parsed.data.installments_count,
      p_first_installment_date: parsed.data.first_installment_date,
      p_notes: parsed.data.notes?.trim() || null,
      p_is_gustito: parsed.data.is_gustito,
    };
  }

  const { data, error } = await supabase.rpc(
    'convert_priority_item_to_purchase',
    rpcArgs,
  );

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo convertir el ítem de la matriz en compra.',
    );
  }

  return data as ConvertPriorityItemToPurchaseResult;
}
