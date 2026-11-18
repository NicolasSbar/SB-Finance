/**
 * Servicio de Plazos Fijos conectados a Bóveda de Ahorros y Disponible Real (`fixedTermsService`).
 *
 * Arquitectura y decisiones técnicas:
 * - Constitución y acreditación mediante RPCs atómicas (`create_fixed_term_deposit` y
 *   `accredit_fixed_term_deposit`): PostgreSQL serializa mutaciones con
 *   `pg_advisory_xact_lock` y valida atómicamente el saldo líquido en Bóveda cuando
 *   `origin = 'savings_fund'`, evitando race conditions desde múltiples pestañas o Telegram.
 * - Anulación atómica (`deleteFixedTermDeposit`): invoca la RPC `cancel_fixed_term_deposit`
 *   para validar `status = 'active'` bajo lock transaccional, revertir asientos en
 *   Bóveda y eliminar el plazo fijo sin exponer `DELETE` directo por PostgREST.
 */
import { roundCurrency, toMonthStartISODate } from '../lib/formatters';
import { supabase } from '../lib/supabaseClient';
import {
  accreditFixedTermSchema,
  fixedTermDepositSchema,
} from '../lib/validations';
import type {
  AccreditFixedTermInput,
  CancelFixedTermDepositResult,
  FixedTermDeposit,
  FixedTermDepositInput,
} from '../types/database.types';
import { ensureMonthlyPeriod } from './settingsService';

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

function mapFixedTerm(row: FixedTermDeposit): FixedTermDeposit {
  return {
    ...row,
    principal_amount: Number(row.principal_amount),
    expected_return_amount: Number(row.expected_return_amount),
    actual_return_amount:
      row.actual_return_amount !== null && row.actual_return_amount !== undefined
        ? Number(row.actual_return_amount)
        : null,
  };
}

export async function getFixedTermDeposits(): Promise<FixedTermDeposit[]> {
  await requireAuthenticatedUserId();
  const { data, error } = await supabase
    .from('fixed_term_deposits')
    .select('*')
    .order('status', { ascending: true })
    .order('maturity_date', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`No se pudieron cargar los plazos fijos: ${error.message}`);
  }

  return ((data ?? []) as FixedTermDeposit[]).map(mapFixedTerm);
}

export async function createFixedTermDeposit(
  input: FixedTermDepositInput,
): Promise<FixedTermDeposit> {
  await requireAuthenticatedUserId();

  const parsed = fixedTermDepositSchema.safeParse(input);
  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos del plazo fijo son inválidos.';
    throw new Error(firstErr);
  }

  const startMonth = toMonthStartISODate(parsed.data.start_date);
  const currentMonth = toMonthStartISODate(new Date());
  if (startMonth === currentMonth) {
    await ensureMonthlyPeriod(startMonth);
  }

  const { data, error } = await supabase.rpc('create_fixed_term_deposit', {
    p_institution: parsed.data.institution.trim(),
    p_principal_amount: roundCurrency(parsed.data.principal_amount),
    p_expected_return_amount: roundCurrency(parsed.data.expected_return_amount),
    p_start_date: parsed.data.start_date,
    p_maturity_date: parsed.data.maturity_date,
    p_origin: parsed.data.origin,
    p_source: 'web',
    p_notes: parsed.data.notes?.trim() || null,
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo constituir el plazo fijo.',
    );
  }

  return mapFixedTerm(data as FixedTermDeposit);
}

export async function accreditFixedTermDeposit(
  fixedTermId: string,
  input: AccreditFixedTermInput,
): Promise<FixedTermDeposit> {
  await requireAuthenticatedUserId();

  const parsed = accreditFixedTermSchema.safeParse(input);
  if (!parsed.success) {
    const firstErr =
      Object.values(parsed.error.flatten().fieldErrors).flat()[0] ??
      'Los datos de acreditación son inválidos.';
    throw new Error(firstErr);
  }

  const accMonth = toMonthStartISODate(parsed.data.accredited_date);
  const currentMonth = toMonthStartISODate(new Date());
  if (accMonth === currentMonth) {
    await ensureMonthlyPeriod(accMonth);
  }

  const { data, error } = await supabase.rpc('accredit_fixed_term_deposit', {
    p_fixed_term_id: fixedTermId,
    p_destination: parsed.data.destination,
    p_actual_return_amount: roundCurrency(parsed.data.actual_return_amount),
    p_accredited_date: parsed.data.accredited_date,
  });

  if (error || !data) {
    throw new Error(
      error?.message ?? 'No se pudo acreditar el vencimiento del plazo fijo.',
    );
  }

  return mapFixedTerm(data as FixedTermDeposit);
}

export async function deleteFixedTermDeposit(id: string): Promise<void> {
  await requireAuthenticatedUserId();

  const { data, error } = await supabase.rpc('cancel_fixed_term_deposit', {
    p_fixed_term_id: id,
  });

  if (error || !data) {
    throw new Error(error?.message ?? 'No se pudo anular el plazo fijo.');
  }

  const result = data as CancelFixedTermDepositResult;
  if (!result.cancelled) {
    if (result.reason === 'not_found') {
      throw new Error('Plazo fijo no encontrado o sin permisos.');
    }
    throw new Error(
      'Solo podés anular plazos fijos activos que aún no fueron acreditados.',
    );
  }
}
