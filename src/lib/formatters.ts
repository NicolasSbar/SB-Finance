/**
 * Utilidades puras para formateo de moneda, redondeo financiero y fechas locales.
 *
 * Arquitectura y decisiones técnicas:
 * - Fechas locales sin desfase UTC: usar `new Date().toISOString().slice(0, 10)` en
 *   Argentina (UTC-3) después de las 21:00 hs devuelve el día siguiente en UTC, causando
 *   que un gasto cargado el 30/11 a las 22:00 caiga en Diciembre. Por eso construimos
 *   cadenas `YYYY-MM-DD` leyendo `getFullYear()`, `getMonth()` y `getDate()` locales.
 * - Precisión en centavos enteros (`toCents` + `roundCurrency`): JavaScript opera en
 *   punto flotante IEEE 754, donde `(1.005 + Number.EPSILON) * 100` puede truncar mal.
 *   Escalar a centavos enteros mediante desplazamiento decimal y dividir por `100`
 *   garantiza redondeo comercial exacto (`roundCurrency(1.005) === 1.01`).
 */

import type {
  FixedTermOrigin,
  PriorityQuadrant,
  SavingsSourceType,
} from '../types/database.types';

const MONTH_NAMES_ES: readonly string[] = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

const SHORT_MONTH_NAMES_ES: readonly string[] = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Convierte un importe decimal a centavos enteros redondeados (mitad alejándose de cero).
 * Protege contra valores `NaN`, `Infinity` y `-0`.
 */
export function toCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const str = abs.toString();
  const scaled = str.includes('e') ? abs * 100 : Number(`${str}e2`);
  const cents = sign * Math.round(scaled);
  return cents === 0 ? 0 : cents;
}

export function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return toCents(value) / 100;
}

export function formatCurrency(amount: number, currency = 'ARS'): string {
  const safeAmount = Number.isFinite(amount) ? roundCurrency(amount) : 0;
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  }
}

export function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(safe)}%`;
}

/**
 * Devuelve la fecha local en formato `YYYY-MM-DD` sin conversión a UTC.
 */
export function toLocalISODate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

/**
 * Normaliza un objeto Date o cadena `YYYY-MM-DD` al primer día del mes (`YYYY-MM-01`).
 */
export function toMonthStartISODate(input: Date | string = new Date()): string {
  if (typeof input === 'string') {
    const match = /^(\d{4})-(\d{2})/.exec(input.trim());
    if (match) {
      return `${match[1]}-${match[2]}-01`;
    }
    const parsed = parseLocalISODate(input);
    return toMonthStartISODate(parsed);
  }
  const year = input.getFullYear();
  const month = pad2(input.getMonth() + 1);
  return `${year}-${month}-01`;
}

/**
 * Parsea `YYYY-MM-DD` en zona horaria local (evitando `new Date('YYYY-MM-DD')` que interpreta UTC).
 */
export function parseLocalISODate(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!match) {
    return new Date();
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  return new Date(year, monthIndex, day);
}

/**
 * Devuelve el último día del mes en formato `YYYY-MM-DD` para consultas por rango.
 */
export function getMonthEndISODate(monthDate: string): string {
  const start = parseLocalISODate(toMonthStartISODate(monthDate));
  const lastDayDate = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return toLocalISODate(lastDayDate);
}

/**
 * Devuelve el último día hábil (lunes a viernes) del mes indicado (1..12).
 */
export function getLastBusinessDayOfMonth(
  year: number,
  month1Based: number,
): number {
  const lastDate = new Date(year, month1Based, 0);
  const weekday = lastDate.getDay();
  if (weekday === 0) return lastDate.getDate() - 2; // Domingo -> viernes
  if (weekday === 6) return lastDate.getDate() - 1; // Sábado -> viernes
  return lastDate.getDate();
}

/**
 * Resuelve el día calendario efectivo de cobro del mes:
 * - `salaryPayday === 0`: último día hábil (lunes a viernes) del mes.
 * - `1..31`: se ajusta al último día disponible en meses cortos (ej. feb/abr/nov).
 */
export function resolveEffectivePayday(
  salaryPayday: number,
  year: number,
  month1Based: number,
): number {
  const daysInMonth = new Date(year, month1Based, 0).getDate();
  const normalized = Math.trunc(salaryPayday);
  if (normalized === 0) {
    return getLastBusinessDayOfMonth(year, month1Based);
  }
  return Math.min(Math.max(1, normalized || 1), daysInMonth);
}

/**
 * Suma o resta `delta` meses a una fecha de mes (`YYYY-MM-01`) devolviendo `YYYY-MM-01`.
 */
export function addMonthsToMonthDate(monthDate: string, delta: number): string {
  const start = parseLocalISODate(toMonthStartISODate(monthDate));
  const target = new Date(start.getFullYear(), start.getMonth() + delta, 1);
  return toMonthStartISODate(target);
}

/**
 * Formatea `'2026-11-01'` como `'Noviembre 2026'`.
 */
export function formatMonthLabel(monthDate: string): string {
  const start = parseLocalISODate(toMonthStartISODate(monthDate));
  const monthName = MONTH_NAMES_ES[start.getMonth()] ?? '';
  return `${monthName} ${start.getFullYear()}`;
}

/**
 * Formatea `'2026-11-01'` como `'Nov 2026'` para ejes de gráficos.
 */
export function formatShortMonthLabel(monthDate: string): string {
  const start = parseLocalISODate(toMonthStartISODate(monthDate));
  const shortName = SHORT_MONTH_NAMES_ES[start.getMonth()] ?? '';
  return `${shortName} ${String(start.getFullYear()).slice(-2)}`;
}

/**
 * Formatea `'2026-11-15'` como `'15/11/2026'`.
 */
export function formatShortDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!match) return isoDate;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Calcula la fecha proyectada de la última cuota (en forma de mes `'Noviembre 2026'`)
 * replicando la lógica de fin de mes de PostgreSQL.
 */
export function calculateLastInstallmentMonthLabel(
  firstInstallmentDate: string,
  installmentsCount: number,
): string {
  if (!firstInstallmentDate || installmentsCount < 1) return '';
  const startMonth = toMonthStartISODate(firstInstallmentDate);
  const endMonth = addMonthsToMonthDate(startMonth, installmentsCount - 1);
  return formatMonthLabel(endMonth);
}

export interface TimezoneOption {
  value: string;
  label: string;
}

export const IANA_TIMEZONE_OPTIONS: readonly TimezoneOption[] = [
  {
    value: 'America/Argentina/Buenos_Aires',
    label: 'Argentina — Buenos Aires (UTC-3)',
  },
  {
    value: 'America/Montevideo',
    label: 'Uruguay — Montevideo (UTC-3)',
  },
  {
    value: 'America/Santiago',
    label: 'Chile — Santiago (UTC-4/-3)',
  },
  {
    value: 'America/Sao_Paulo',
    label: 'Brasil — São Paulo (UTC-3)',
  },
  {
    value: 'America/Asuncion',
    label: 'Paraguay — Asunción (UTC-4/-3)',
  },
  {
    value: 'America/La_Paz',
    label: 'Bolivia — La Paz (UTC-4)',
  },
  {
    value: 'America/Lima',
    label: 'Perú — Lima (UTC-5)',
  },
  {
    value: 'America/Bogota',
    label: 'Colombia — Bogotá (UTC-5)',
  },
  {
    value: 'America/Mexico_City',
    label: 'México — Ciudad de México (UTC-6)',
  },
  {
    value: 'America/New_York',
    label: 'EE. UU. — Nueva York (UTC-5/-4)',
  },
  {
    value: 'Europe/Madrid',
    label: 'España — Madrid (UTC+1/+2)',
  },
  {
    value: 'UTC',
    label: 'Tiempo Universal Coordinado (UTC)',
  },
];

/**
 * Calcula el tiempo restante en formato `MM:SS` para códigos de vinculación temporales.
 */
export function formatCountdownMMSS(
  expiresAtIso: string,
  nowMs: number = Date.now(),
): {
  formatted: string;
  remainingSeconds: number;
  isExpired: boolean;
} {
  const expiresMs = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(expiresMs)) {
    return { formatted: '00:00', remainingSeconds: 0, isExpired: true };
  }
  const diffSeconds = Math.max(0, Math.floor((expiresMs - nowMs) / 1000));
  const mins = Math.floor(diffSeconds / 60);
  const secs = diffSeconds % 60;
  return {
    formatted: `${pad2(mins)}:${pad2(secs)}`,
    remainingSeconds: diffSeconds,
    isExpired: diffSeconds <= 0,
  };
}

export function addDaysToLocalISODate(isoDate: string, daysToAdd: number): string {
  const base = parseLocalISODate(isoDate);
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysToAdd);
  return toLocalISODate(next);
}

export function calculateDaysUntilDate(
  targetIsoDate: string,
  referenceDate: Date = new Date(),
): number {
  const target = parseLocalISODate(targetIsoDate);
  const today = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
  );
  const diffMs = target.getTime() - today.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

export function calculateDaysBetweenDates(
  startIsoDate: string,
  endIsoDate: string,
): number {
  const start = parseLocalISODate(startIsoDate);
  const end = parseLocalISODate(endIsoDate);
  const diffMs = end.getTime() - start.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

export interface PriorityQuadrantMeta {
  id: PriorityQuadrant;
  title: string;
  shortTitle: string;
  actionHint: string;
  badgeVariant: 'yellow' | 'green' | 'neutral';
}

export const PRIORITY_QUADRANT_ORDER: readonly PriorityQuadrant[] = [
  'high_impact_low_cost',
  'high_impact_high_cost',
  'low_impact_low_cost',
  'low_impact_high_cost',
];

export const PRIORITY_QUADRANT_META: Record<PriorityQuadrant, PriorityQuadrantMeta> = {
  high_impact_low_cost: {
    id: 'high_impact_low_cost',
    title: 'Alto Impacto / Bajo Costo',
    shortTitle: 'Prioridad inmediata',
    actionHint: 'Compras accesibles que mejoran mucho tu día a día.',
    badgeVariant: 'yellow',
  },
  high_impact_high_cost: {
    id: 'high_impact_high_cost',
    title: 'Alto Impacto / Alto Costo',
    shortTitle: 'Planificar / Ahorrar',
    actionHint: 'Valen la pena; conviene planificarlas o ahorrar antes.',
    badgeVariant: 'neutral',
  },
  low_impact_low_cost: {
    id: 'low_impact_low_cost',
    title: 'Bajo Impacto / Bajo Costo',
    shortTitle: 'Evaluar si sobra cupo',
    actionHint: 'Gustos menores para evaluar solo si tenés margen.',
    badgeVariant: 'neutral',
  },
  low_impact_high_cost: {
    id: 'low_impact_high_cost',
    title: 'Bajo Impacto / Alto Costo',
    shortTitle: 'Postergar / Descartar',
    actionHint: 'Costo alto frente al valor que aportan hoy.',
    badgeVariant: 'neutral',
  },
};

export function formatSavingsSourceBadge(sourceType?: SavingsSourceType): {
  label: string;
  variant: 'yellow' | 'green' | 'red' | 'neutral';
} {
  switch (sourceType) {
    case 'direct_income':
      return { label: 'Ingreso directo', variant: 'green' };
    case 'cap_surplus_fixed':
      return { label: 'Sobrante Fijos', variant: 'yellow' };
    case 'cap_surplus_gustitos':
      return { label: 'Sobrante Gustitos', variant: 'yellow' };
    case 'fixed_term_constitution':
      return { label: 'Constitución Plazo Fijo', variant: 'neutral' };
    case 'fixed_term_return':
      return { label: 'Vencimiento Plazo Fijo', variant: 'green' };
    case 'manual':
    default:
      return { label: 'Manual', variant: 'neutral' };
  }
}

export function formatFixedTermOriginLabel(origin: FixedTermOrigin): string {
  return origin === 'savings_fund'
    ? 'Bóveda de Ahorros'
    : 'Disponible Real del Mes';
}
