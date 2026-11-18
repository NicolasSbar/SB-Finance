/**
 * Servicio CRUD de categorías de gastos e ingresos con Borrado Lógico (`is_active`),
 * pertenencia a la bolsa de Gustitos (`is_gustito`) y límites mensuales (`monthly_limit`).
 *
 * Arquitectura y decisiones técnicas:
 * - Patrón de Catálogo Contable: en vez de ejecutar `DELETE` físico (que violaría
 *   `ON DELETE RESTRICT` o destruiría la trazabilidad de meses anteriores), archivamos
 *   las categorías mediante `is_active = false` y permitimos restaurarlas en cualquier momento.
 * - Inmutabilidad de meses cerrados: al editar `is_gustito` o `monthly_limit`, actualizamos
 *   `categories` (meses futuros) y sincronizamos únicamente el snapshot del mes calendario
 *   actual en `monthly_category_snapshots`, sin alterar nunca meses anteriores.
 * - Defensa en profundidad sobre RLS: cada mutación valida la sesión autenticada en
 *   cliente y aplica `.eq('user_id', authUserId)` además de las políticas PostgreSQL.
 * - Sincronización atómica de selección Gustito: `syncGustitoCategoriesSelection`
 *   invoca la RPC `sync_gustito_categories_selection` para actualizar `categories` y el
 *   snapshot del mes actual en una única transacción PostgreSQL sin loops N+1.
 */
import { z } from 'zod';
import { roundCurrency, toMonthStartISODate } from '../lib/formatters';
import { supabase } from '../lib/supabaseClient';
import type {
  Category,
  CategoryInput,
  MonthlyCategorySnapshot,
  TransactionType,
} from '../types/database.types';

const gustitoCategoryIdsSchema = z.array(
  z.string().uuid('Identificador de categoría inválido.'),
);

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

function mapCategory(row: Category): Category {
  return {
    ...row,
    is_gustito: Boolean(row.is_gustito),
    monthly_limit:
      row.monthly_limit !== null && row.monthly_limit !== undefined
        ? Number(row.monthly_limit)
        : null,
  };
}

function mapSnapshot(row: MonthlyCategorySnapshot): MonthlyCategorySnapshot {
  return {
    ...row,
    is_gustito: Boolean(row.is_gustito),
    monthly_limit:
      row.monthly_limit !== null && row.monthly_limit !== undefined
        ? Number(row.monthly_limit)
        : null,
  };
}

async function syncCurrentMonthCategorySnapshot(
  userId: string,
  category: Category,
): Promise<void> {
  if (category.type !== 'expense') return;
  const currentMonth = toMonthStartISODate(new Date());

  const { data: currentBudget } = await supabase
    .from('monthly_budgets')
    .select('id')
    .eq('user_id', userId)
    .eq('month_date', currentMonth)
    .maybeSingle();

  if (!currentBudget) return;

  const { error } = await supabase
    .from('monthly_category_snapshots')
    .upsert(
      {
        user_id: userId,
        month_date: currentMonth,
        category_id: category.id,
        is_gustito: category.is_gustito,
        monthly_limit: category.monthly_limit,
      },
      { onConflict: 'user_id,month_date,category_id' },
    );

  if (error) {
    throw new Error(
      `Categoría guardada, pero falló la sincronización del mes actual: ${error.message}`,
    );
  }
}

export interface GetCategoriesOptions {
  includeInactive?: boolean;
  type?: TransactionType;
}

export async function getCategories(options: GetCategoriesOptions = {}): Promise<Category[]> {
  const { includeInactive = false, type } = options;

  let query = supabase
    .from('categories')
    .select('*')
    .order('is_active', { ascending: false })
    .order('is_system', { ascending: false })
    .order('name', { ascending: true });

  if (!includeInactive) {
    query = query.eq('is_active', true);
  }

  if (type) {
    query = query.eq('type', type);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`No se pudieron cargar las categorías: ${error.message}`);
  }

  return ((data ?? []) as Category[]).map(mapCategory);
}

export async function getMonthlyCategorySnapshots(
  monthDate: string,
): Promise<MonthlyCategorySnapshot[]> {
  const normalizedMonth = toMonthStartISODate(monthDate);
  const { data, error } = await supabase
    .from('monthly_category_snapshots')
    .select('*')
    .eq('month_date', normalizedMonth);

  if (error) {
    throw new Error(
      `No se pudieron cargar los snapshots mensuales de categorías: ${error.message}`,
    );
  }

  return ((data ?? []) as MonthlyCategorySnapshot[]).map(mapSnapshot);
}

export async function createCategory(userId: string, input: CategoryInput): Promise<Category> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para crear categorías para otro usuario.');
  }

  const isExpense = input.type === 'expense';
  const isGustito = isExpense ? Boolean(input.is_gustito) : false;
  const monthlyLimit =
    isExpense && input.monthly_limit !== undefined && input.monthly_limit !== null
      ? roundCurrency(input.monthly_limit)
      : null;

  const { data, error } = await supabase
    .from('categories')
    .insert({
      user_id: sessionUserId,
      name: input.name.trim(),
      type: input.type,
      icon: input.icon?.trim() || 'tag',
      is_system: false,
      is_active: true,
      is_gustito: isGustito,
      monthly_limit: monthlyLimit,
    })
    .select('*')
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
      throw new Error('Ya existe una categoría con ese nombre para el mismo tipo.');
    }
    throw new Error(`No se pudo crear la categoría: ${error?.message ?? 'Error desconocido'}`);
  }

  const created = mapCategory(data as Category);
  await syncCurrentMonthCategorySnapshot(sessionUserId, created);
  return created;
}

export async function updateCategory(
  id: string,
  input: Partial<Pick<CategoryInput, 'name' | 'icon' | 'is_gustito' | 'monthly_limit'>>,
): Promise<Category> {
  const sessionUserId = await requireAuthenticatedUserId();
  const updates: Partial<
    Pick<Category, 'name' | 'icon' | 'is_gustito' | 'monthly_limit'>
  > = {};
  if (input.name !== undefined) updates.name = input.name.trim();
  if (input.icon !== undefined) updates.icon = input.icon.trim() || 'tag';
  if (input.is_gustito !== undefined) updates.is_gustito = Boolean(input.is_gustito);
  if ('monthly_limit' in input) {
    updates.monthly_limit =
      input.monthly_limit !== null && input.monthly_limit !== undefined
        ? roundCurrency(input.monthly_limit)
        : null;
  }

  const { data, error } = await supabase
    .from('categories')
    .update(updates)
    .eq('id', id)
    .eq('user_id', sessionUserId)
    .select('*')
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
      throw new Error('Ya existe otra categoría con ese nombre.');
    }
    throw new Error(`No se pudo actualizar la categoría: ${error?.message ?? 'Error desconocido'}`);
  }

  let updated = mapCategory(data as Category);

  // Garantiza que las categorías de ingresos nunca queden con atributos de gasto
  if (updated.type === 'income' && (updated.is_gustito || updated.monthly_limit !== null)) {
    const { data: cleaned } = await supabase
      .from('categories')
      .update({ is_gustito: false, monthly_limit: null })
      .eq('id', id)
      .eq('user_id', sessionUserId)
      .select('*')
      .single();
    if (cleaned) {
      updated = mapCategory(cleaned as Category);
    }
  }

  if (
    updated.type === 'expense' &&
    (input.is_gustito !== undefined || 'monthly_limit' in input)
  ) {
    await syncCurrentMonthCategorySnapshot(sessionUserId, updated);
  }

  return updated;
}

export async function toggleCategoryGustito(
  id: string,
  isGustito: boolean,
): Promise<Category> {
  return updateCategory(id, { is_gustito: isGustito });
}

export async function syncGustitoCategoriesSelection(
  userId: string,
  selectedExpenseCategoryIds: string[],
  updateCurrentMonth: boolean,
): Promise<void> {
  const sessionUserId = await requireAuthenticatedUserId();
  if (sessionUserId !== userId) {
    throw new Error('No tenés permisos para modificar categorías de otro usuario.');
  }

  const parsed = gustitoCategoryIdsSchema.safeParse(selectedExpenseCategoryIds);
  if (!parsed.success) {
    throw new Error('La selección de categorías Gustito contiene identificadores inválidos.');
  }

  const uniqueSelectedIds = Array.from(new Set(parsed.data));

  const { data, error } = await supabase.rpc('sync_gustito_categories_selection', {
    p_selected_category_ids: uniqueSelectedIds,
    p_update_current_month: Boolean(updateCurrentMonth),
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo guardar la selección de categorías Gustito.',
    );
  }
}

export async function archiveCategory(id: string): Promise<Category> {
  const sessionUserId = await requireAuthenticatedUserId();
  const { data, error } = await supabase
    .from('categories')
    .update({ is_active: false })
    .eq('id', id)
    .eq('user_id', sessionUserId)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`No se pudo archivar la categoría: ${error?.message ?? 'Error desconocido'}`);
  }

  return mapCategory(data as Category);
}

export async function restoreCategory(id: string): Promise<Category> {
  const sessionUserId = await requireAuthenticatedUserId();
  const { data, error } = await supabase
    .from('categories')
    .update({ is_active: true })
    .eq('id', id)
    .eq('user_id', sessionUserId)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`No se pudo restaurar la categoría: ${error?.message ?? 'Error desconocido'}`);
  }

  return mapCategory(data as Category);
}
