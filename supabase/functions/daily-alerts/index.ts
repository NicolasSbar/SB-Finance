/**
 * Supabase Edge Function (Deno): daily-alerts
 *
 * Arquitectura y decisiones técnicas:
 * - Ejecución multi-timezone sin un cron por usuario: `pg_cron` invoca esta función
 *   cada hora (`0 * * * *`). En memoria evaluamos `getLocalDateParts(user.timezone)` y
 *   procesamos únicamente a los usuarios cuyo reloj local marca las `08:00 AM` (`hour === 8`).
 * - Control anti-spam en `notification_logs`:
 *   - Límites de categoría y tope de gastos fijos (`> 80%` y `>= 100%`): máximo 1 alerta
 *     cada 7 días por `(user_id, month_date, alert_type, reference_id)`.
 *   - Recordatorios de compromisos pendientes (`is_paid = false`): máximo 1 envío el día 15
 *     y 1 envío 7 días antes de fin de mes (`daysInMonth - 7`).
 * - Aislamiento de fallos por usuario: cada consulta a PostgreSQL valida
 *   `.error` explícitamente (sin silenciar fallos de lectura que dispararían spam o
 *   cálculos incompletos), y un error en un usuario no interrumpe el envío al resto.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  addDaysToISODate,
  computeCategoryLimitStatus,
  computeFixedLimitStatus,
  ensureMonthlyPeriodForUser,
  formatCurrencyARS,
  getLocalDateParts,
  roundCurrency,
  type SupabaseAdminLike,
} from '../_shared/financeHelpers.ts';
import { sendTelegramMessage, timingSafeEqualStr } from '../_shared/telegramApi.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sendAlertAndRecordLog(params: {
  supabaseAdmin: SupabaseAdminLike;
  botToken: string;
  userId: string;
  chatId: number;
  monthDate: string;
  alertType: string;
  referenceId: string | null;
  message: string;
}): Promise<boolean> {
  const {
    supabaseAdmin,
    botToken,
    userId,
    chatId,
    monthDate,
    alertType,
    referenceId,
    message,
  } = params;

  try {
    const sent = await sendTelegramMessage(botToken, chatId, message, {
      parseMode: 'HTML',
    });

    if (!sent) {
      console.error('Error al enviar alerta diaria por Telegram:', {
        userId,
        chatId,
        alertType,
        referenceId,
      });
      return false;
    }

    const { error: logInsertError } = await supabaseAdmin
      .from('notification_logs')
      .insert({
        user_id: userId,
        month_date: monthDate,
        alert_type: alertType,
        reference_id: referenceId,
      });

    if (logInsertError) {
      console.error('Error al registrar alerta en notification_logs:', {
        userId,
        alertType,
        referenceId,
        error: logInsertError,
      });
    }

    return true;
  } catch (sendErr) {
    console.error('Excepción al enviar alerta diaria por Telegram:', {
      userId,
      chatId,
      alertType,
      referenceId,
      error: sendErr,
    });
    return false;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método no permitido. Usá POST.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const cronInternalSecret = Deno.env.get('CRON_INTERNAL_SECRET');

  if (!supabaseUrl || !supabaseServiceRoleKey || !cronInternalSecret) {
    return jsonResponse({ error: 'Configuración incompleta en daily-alerts.' }, 500);
  }

  const incomingSecret = req.headers.get('X-Cron-Secret') ?? '';
  if (!incomingSecret || !timingSafeEqualStr(incomingSecret, cronInternalSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!botToken) {
    return jsonResponse({ ok: true, skipped: 'missing_bot_token' }, 200);
  }

  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: links, error: linksError } = await supabaseAdmin
      .from('telegram_links')
      .select('user_id, telegram_chat_id');

    if (linksError) {
      console.error('Error al consultar telegram_links:', linksError);
      return jsonResponse({ error: 'Error al consultar cuentas vinculadas.' }, 500);
    }

    if (!links || links.length === 0) {
      return jsonResponse({ ok: true, processedUsers: 0, alertsSent: 0, userErrors: 0 }, 200);
    }

    const userIds = links.map((l) => l.user_id as string);
    const { data: settingsList, error: settingsError } = await supabaseAdmin
      .from('user_settings')
      .select('user_id, fixed_expenses_limit, currency, timezone')
      .in('user_id', userIds);

    if (settingsError) {
      console.error('Error al consultar user_settings:', settingsError);
      return jsonResponse({ error: 'Error al consultar configuración de usuarios.' }, 500);
    }

    const settingsByUser = new Map<
      string,
      { fixed_expenses_limit: number; currency: string; timezone: string }
    >();
    for (const row of settingsList ?? []) {
      settingsByUser.set(row.user_id as string, {
        fixed_expenses_limit: Number(row.fixed_expenses_limit ?? 0),
        currency: (row.currency as string | undefined) ?? 'ARS',
        timezone:
          (row.timezone as string | undefined) ?? 'America/Argentina/Buenos_Aires',
      });
    }

    const now = new Date();
    const sevenDaysAgoIso = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();
    const supabaseAdminLike = supabaseAdmin as unknown as SupabaseAdminLike;

    let processedUsers = 0;
    let alertsSent = 0;
    let userErrors = 0;

    for (const link of links) {
      const userId = link.user_id as string;
      const chatId = Number(link.telegram_chat_id);
      const userSettings = settingsByUser.get(userId) ?? {
        fixed_expenses_limit: 0,
        currency: 'ARS',
        timezone: 'America/Argentina/Buenos_Aires',
      };

      const local = getLocalDateParts(userSettings.timezone, now);
      if (local.hour !== 8) {
        continue;
      }

      processedUsers += 1;

      try {
        await ensureMonthlyPeriodForUser(
          supabaseAdminLike,
          userId,
          local.monthStart,
        );

        // A. Límites individuales por categoría (> 80% y >= 100%)
        const { data: snapshots, error: snapshotsError } = await supabaseAdmin
          .from('monthly_category_snapshots')
          .select('category_id, monthly_limit')
          .eq('user_id', userId)
          .eq('month_date', local.monthStart)
          .not('monthly_limit', 'is', null)
          .gt('monthly_limit', 0);

        if (snapshotsError) {
          console.error('Error al consultar monthly_category_snapshots:', {
            userId,
            error: snapshotsError,
          });
        } else {
          for (const snap of snapshots ?? []) {
            const categoryId = snap.category_id as string;
            const status = await computeCategoryLimitStatus(
              supabaseAdminLike,
              userId,
              local.monthStart,
              categoryId,
            );

            if (
              status.monthlyLimit === null ||
              status.monthlyLimit <= 0 ||
              status.usagePercent === null
            ) {
              continue;
            }

            let alertType: 'category_exceeded_100' | 'category_warning_80' | null = null;
            if (status.usagePercent >= 100) {
              alertType = 'category_exceeded_100';
            } else if (status.usagePercent > 80) {
              alertType = 'category_warning_80';
            }

            if (!alertType) continue;

            const { data: recentLog, error: recentLogError } = await supabaseAdmin
              .from('notification_logs')
              .select('id')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('alert_type', alertType)
              .eq('reference_id', categoryId)
              .gte('sent_at', sevenDaysAgoIso)
              .limit(1);

            if (recentLogError) {
              console.error('Error al verificar notification_logs (categoría):', {
                userId,
                categoryId,
                error: recentLogError,
              });
              continue;
            }

            if (recentLog && recentLog.length > 0) continue;

            const msg =
              alertType === 'category_exceeded_100'
                ? `🔴 <b>Límite superado en ${escapeHtml(status.categoryName)}</b>\n\nAlcanzaste el <b>${status.usagePercent.toFixed(
                    1,
                  )}%</b> (${escapeHtml(
                    formatCurrencyARS(status.spent, userSettings.currency),
                  )} de ${escapeHtml(
                    formatCurrencyARS(status.monthlyLimit, userSettings.currency),
                  )}).`
                : `⚠️ <b>Cerca del límite en ${escapeHtml(status.categoryName)}</b>\n\nYa consumiste el <b>${status.usagePercent.toFixed(
                    1,
                  )}%</b> de tu tope mensual (${escapeHtml(
                    formatCurrencyARS(status.spent, userSettings.currency),
                  )} de ${escapeHtml(
                    formatCurrencyARS(status.monthlyLimit, userSettings.currency),
                  )}).`;

            const sentOk = await sendAlertAndRecordLog({
              supabaseAdmin: supabaseAdminLike,
              botToken,
              userId,
              chatId,
              monthDate: local.monthStart,
              alertType,
              referenceId: categoryId,
              message: msg,
            });
            if (sentOk) alertsSent += 1;
          }
        }

        // B. Límite mensual de gastos fijos + cuotas no-Gustito (> 80% y >= 100%)
        const { data: monthCommitments, error: commitmentsError } = await supabaseAdmin
          .from('monthly_commitments')
          .select('id, name, amount, due_date, is_paid')
          .eq('user_id', userId)
          .eq('month_date', local.monthStart);

        if (commitmentsError) {
          console.error('Error al consultar monthly_commitments:', {
            userId,
            error: commitmentsError,
          });
        }

        const commitments = (!commitmentsError ? (monthCommitments ?? []) : []) as Array<{
          id: string;
          name: string;
          amount: number;
          due_date: string | null;
          is_paid: boolean;
        }>;

        const fixedStatus = await computeFixedLimitStatus(
          supabaseAdminLike,
          userId,
          local.monthStart,
        );

        if (fixedStatus.fixedLimit > 0 && fixedStatus.usagePercent !== null) {
          const fixedLimit = fixedStatus.fixedLimit;
          const totalCommitted = fixedStatus.spent;
          const pct = fixedStatus.usagePercent;
          const fixedAlertType =
            pct >= 100
              ? 'fixed_limit_exceeded_100'
              : pct > 80
                ? 'fixed_limit_warning_80'
                : null;

          if (fixedAlertType) {
            const { data: recentFixedLog, error: recentFixedError } = await supabaseAdmin
              .from('notification_logs')
              .select('id')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('alert_type', fixedAlertType)
              .is('reference_id', null)
              .gte('sent_at', sevenDaysAgoIso)
              .limit(1);

            if (recentFixedError) {
              console.error('Error al verificar notification_logs (límite fijo):', {
                userId,
                error: recentFixedError,
              });
            } else if (!recentFixedLog || recentFixedLog.length === 0) {
              const fixedMsg =
                fixedAlertType === 'fixed_limit_exceeded_100'
                  ? `🔴 <b>Límite de gastos fijos y cuotas superado</b>\n\nTus compromisos fijos y cuotas no-Gustito de este mes suman <b>${escapeHtml(
                      formatCurrencyARS(totalCommitted, userSettings.currency),
                    )}</b> (${pct.toFixed(1)}% de tu límite de ${escapeHtml(
                      formatCurrencyARS(fixedLimit, userSettings.currency),
                    )}).`
                  : `⚠️ <b>Cerca del límite de gastos fijos y cuotas</b>\n\nTus compromisos fijos y cuotas no-Gustito alcanzan <b>${escapeHtml(
                      formatCurrencyARS(totalCommitted, userSettings.currency),
                    )}</b> (${pct.toFixed(1)}% de tu límite de ${escapeHtml(
                      formatCurrencyARS(fixedLimit, userSettings.currency),
                    )}).`;

              const sentOk = await sendAlertAndRecordLog({
                supabaseAdmin: supabaseAdminLike,
                botToken,
                userId,
                chatId,
                monthDate: local.monthStart,
                alertType: fixedAlertType,
                referenceId: null,
                message: fixedMsg,
              });
              if (sentOk) alertsSent += 1;
            }
          }
        }

        // C. Recordatorios de pagos pendientes (día 15 y 7 días antes de fin de mes)
        const reminderTypes: Array<
          'mid_month_pending_reminder' | 'end_of_month_pending_reminder'
        > = [];
        if (local.day === 15) {
          reminderTypes.push('mid_month_pending_reminder');
        }
        if (local.day === local.daysInMonth - 7) {
          reminderTypes.push('end_of_month_pending_reminder');
        }

        if (reminderTypes.length > 0 && !commitmentsError) {
          const pendingItems = commitments.filter((c) => !c.is_paid);
          if (pendingItems.length > 0) {
            const pendingTotal = pendingItems.reduce(
              (acc, c) => roundCurrency(acc + Number(c.amount)),
              0,
            );

            for (const reminderType of reminderTypes) {
              const { data: existingReminder, error: reminderLogError } =
                await supabaseAdmin
                  .from('notification_logs')
                  .select('id')
                  .eq('user_id', userId)
                  .eq('month_date', local.monthStart)
                  .eq('alert_type', reminderType)
                  .limit(1);

              if (reminderLogError) {
                console.error('Error al verificar notification_logs (recordatorio):', {
                  userId,
                  reminderType,
                  error: reminderLogError,
                });
                continue;
              }

              if (existingReminder && existingReminder.length > 0) continue;

              const topList = pendingItems
                .slice(0, 6)
                .map(
                  (item) =>
                    `• ${escapeHtml(item.name)}: <b>${escapeHtml(
                      formatCurrencyARS(Number(item.amount), userSettings.currency),
                    )}</b>`,
                )
                .join('\n');
              const extraCount =
                pendingItems.length > 6
                  ? `\n<i>...y ${pendingItems.length - 6} compromiso(s) más.</i>`
                  : '';

              const title =
                reminderType === 'mid_month_pending_reminder'
                  ? '📅 <b>Recordatorio de mitad de mes (día 15)</b>'
                  : '⏳ <b>Recordatorio de cierre de mes (faltan 7 días)</b>';

              const reminderMsg = `${title}\n\nTenés <b>${pendingItems.length}</b> compromiso(s) pendiente(s) de pago por un total de <b>${escapeHtml(
                formatCurrencyARS(pendingTotal, userSettings.currency),
              )}</b>:\n\n${topList}${extraCount}`;

              const sentOk = await sendAlertAndRecordLog({
                supabaseAdmin: supabaseAdminLike,
                botToken,
                userId,
                chatId,
                monthDate: local.monthStart,
                alertType: reminderType,
                referenceId: null,
                message: reminderMsg,
              });
              if (sentOk) alertsSent += 1;
            }
          }
        }

        // D. Alertas de vencimientos de Plazos Fijos (3 días antes y el mismo día / vencidos)
        const localPlus3Days = addDaysToISODate(local.yyyyMmDd, 3);
        const { data: activeFixedTerms, error: fixedTermsError } = await supabaseAdmin
          .from('fixed_term_deposits')
          .select(
            'id, institution, principal_amount, expected_return_amount, maturity_date, origin',
          )
          .eq('user_id', userId)
          .eq('status', 'active')
          .lte('maturity_date', localPlus3Days);

        if (fixedTermsError) {
          console.error('Error al consultar fixed_term_deposits:', {
            userId,
            error: fixedTermsError,
          });
        } else {
          for (const ft of (activeFixedTerms ?? []) as Array<{
            id: string;
            institution: string;
            principal_amount: number;
            expected_return_amount: number;
            maturity_date: string;
            origin: string;
          }>) {
            let ftAlertType: 'fixed_term_due_3d' | 'fixed_term_due_today' | null = null;
            if (ft.maturity_date === localPlus3Days) {
              ftAlertType = 'fixed_term_due_3d';
            } else if (ft.maturity_date <= local.yyyyMmDd) {
              ftAlertType = 'fixed_term_due_today';
            }

            if (!ftAlertType) continue;

            const { data: existingFtAlert, error: existingFtError } =
              await supabaseAdmin
                .from('notification_logs')
                .select('id')
                .eq('user_id', userId)
                .eq('alert_type', ftAlertType)
                .eq('reference_id', ft.id)
                .limit(1);

            if (existingFtError) {
              console.error('Error al verificar notification_logs (plazo fijo):', {
                userId,
                fixedTermId: ft.id,
                error: existingFtError,
              });
              continue;
            }

            if (existingFtAlert && existingFtAlert.length > 0) continue;

            const originText =
              ft.origin === 'savings_fund'
                ? 'Bóveda de Ahorros'
                : 'Disponible Real del Mes';

            const ftMsg =
              ftAlertType === 'fixed_term_due_3d'
                ? `⏳ <b>Plazo Fijo próximo a vencer (en 3 días)</b>\n\n🏦 <b>${escapeHtml(ft.institution)}</b>\n• Capital: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.principal_amount), userSettings.currency),
                  )}</b>\n• Retorno esperado: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.expected_return_amount), userSettings.currency),
                  )}</b>\n• Vence: <b>${escapeHtml(ft.maturity_date)}</b>\n• Origen: ${escapeHtml(originText)}`
                : `🔔 <b>¡Plazo Fijo vencido — Listo para acreditar!</b>\n\n🏦 <b>${escapeHtml(ft.institution)}</b>\n• Capital: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.principal_amount), userSettings.currency),
                  )}</b>\n• Retorno esperado: <b>${escapeHtml(
                    formatCurrencyARS(Number(ft.expected_return_amount), userSettings.currency),
                  )}</b>\n• Vencimiento: <b>${escapeHtml(ft.maturity_date)}</b>\n\nIngresá a <b>Inversiones → Plazos Fijos</b> en SB-Finance para acreditar el retorno en tu Bóveda de Ahorros o Disponible Real.`;

            const sentOk = await sendAlertAndRecordLog({
              supabaseAdmin: supabaseAdminLike,
              botToken,
              userId,
              chatId,
              monthDate: local.monthStart,
              alertType: ftAlertType,
              referenceId: ft.id,
              message: ftMsg,
            });
            if (sentOk) alertsSent += 1;
          }
        }

        // E. Alerta de revisión de cierre de Gastos Fijos (<= 3 días para fin de mes)
        const daysRemainingInMonth = local.daysInMonth - local.day;
        if (daysRemainingInMonth <= 3 && fixedStatus.fixedLimit > 0) {
          const [monthBudgetRes, fixedSurplusRes, existingClosingRes] = await Promise.all([
            supabaseAdmin
              .from('monthly_budgets')
              .select('surplus_review_completed_at')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .maybeSingle(),
            supabaseAdmin
              .from('savings_entries')
              .select('amount')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('source_type', 'cap_surplus_fixed'),
            supabaseAdmin
              .from('notification_logs')
              .select('id')
              .eq('user_id', userId)
              .eq('month_date', local.monthStart)
              .eq('alert_type', 'fixed_cap_surplus_closing')
              .limit(1),
          ]);

          if (
            monthBudgetRes.error ||
            fixedSurplusRes.error ||
            existingClosingRes.error
          ) {
            console.error('Error al consultar datos de cierre de gastos fijos:', {
              userId,
              monthBudgetError: monthBudgetRes.error,
              fixedSurplusError: fixedSurplusRes.error,
              existingClosingError: existingClosingRes.error,
            });
          } else {
            const monthBudget = monthBudgetRes.data;
            const fixedSurplusEntries = fixedSurplusRes.data;
            const existingClosingAlert = existingClosingRes.data;
            const alreadyReviewed = Boolean(monthBudget?.surplus_review_completed_at);
            const alreadySent = Boolean(
              existingClosingAlert && existingClosingAlert.length > 0,
            );

            if (monthBudget && !alreadyReviewed && !alreadySent) {
              const transferredToSavings = (fixedSurplusEntries ?? []).reduce(
                (acc, row) =>
                  roundCurrency(acc + Number((row as { amount?: number }).amount ?? 0)),
                0,
              );
              const fixedCapSurplus = Math.max(
                0,
                roundCurrency(
                  fixedStatus.fixedLimit - fixedStatus.spent - transferredToSavings,
                ),
              );

              if (fixedCapSurplus > 0) {
                const daysLabel =
                  daysRemainingInMonth === 0
                    ? 'hoy termina el mes'
                    : daysRemainingInMonth === 1
                      ? 'falta 1 día para terminar el mes'
                      : `faltan ${daysRemainingInMonth} días para terminar el mes`;

                const closingMsg = `⏳ <b>Revisión de cierre de Gastos Fijos (${daysLabel})</b>\n\nTenés <b>${escapeHtml(
                  formatCurrencyARS(fixedCapSurplus, userSettings.currency),
                )}</b> sin usar dentro de tu límite de Gastos Fijos de este mes.\n\nIngresá al <b>Panel de SB-Finance</b> para verificar si olvidaste registrar algún gasto y decidir si enviarlo a tu <b>Bóveda de Ahorros</b> o liberarlo al <b>Disponible Real</b>.`;

                const sentOk = await sendAlertAndRecordLog({
                  supabaseAdmin: supabaseAdminLike,
                  botToken,
                  userId,
                  chatId,
                  monthDate: local.monthStart,
                  alertType: 'fixed_cap_surplus_closing',
                  referenceId: null,
                  message: closingMsg,
                });
                if (sentOk) alertsSent += 1;
              }
            }
          }
        }
      } catch (userErr) {
        userErrors += 1;
        console.error('Error procesando alertas diarias para usuario:', {
          userId,
          error: userErr,
        });
      }
    }

    return jsonResponse({ ok: true, processedUsers, alertsSent, userErrors }, 200);
  } catch (err) {
    console.error('Error fatal en daily-alerts:', err);
    return jsonResponse({ error: 'Error interno al ejecutar alertas diarias.' }, 500);
  }
});
