/**
 * Listado y gestión de Plantillas de Gastos Fijos Recurrentes (`FixedExpensesList`).
 *
 * Arquitectura y decisiones técnicas:
 * - Muestra las plantillas recurrentes junto con el estado de su instancia en el mes
 *   seleccionado (`Pagado` o `Pendiente`), permitiendo marcarla con un clic o pausar
 *   la plantilla preguntando qué hacer si el mes en curso tiene una boleta pendiente.
 */
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { formatCurrency } from '../../lib/formatters';
import {
  getCurrentMonthPendingForTemplate,
  toggleCommitmentPaidStatus,
  toggleFixedExpenseTemplateActive,
} from '../../services/commitmentsService';
import type {
  FixedExpenseTemplate,
  MonthlyCommitment,
} from '../../types/database.types';

export interface FixedExpensesListProps {
  userId: string;
  currentCalendarMonth: string;
  templates: FixedExpenseTemplate[];
  monthCommitments: MonthlyCommitment[];
  currency: string;
  onNewTemplate: () => void;
  onEditTemplate: (template: FixedExpenseTemplate) => void;
  onRefresh: () => Promise<void>;
}

export function FixedExpensesList({
  userId,
  currentCalendarMonth,
  templates,
  monthCommitments,
  currency,
  onNewTemplate,
  onEditTemplate,
  onRefresh,
}: FixedExpensesListProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pausePromptTemplate, setPausePromptTemplate] =
    useState<FixedExpenseTemplate | null>(null);

  const commitmentByTemplateId = useMemo(() => {
    const map = new Map<string, MonthlyCommitment>();
    for (const c of monthCommitments) {
      if (c.fixed_expense_template_id) {
        map.set(c.fixed_expense_template_id, c);
      }
    }
    return map;
  }, [monthCommitments]);

  async function handleTogglePaid(commitment: MonthlyCommitment): Promise<void> {
    setBusyId(commitment.id);
    try {
      await toggleCommitmentPaidStatus(commitment.id, !commitment.is_paid);
      toast.success(
        !commitment.is_paid
          ? `"${commitment.name}" marcado como pagado.`
          : `"${commitment.name}" marcado como pendiente.`,
      );
      await onRefresh();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo actualizar el estado.';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRequestToggleActive(
    template: FixedExpenseTemplate,
  ): Promise<void> {
    if (!template.is_active) {
      setBusyId(template.id);
      try {
        await toggleFixedExpenseTemplateActive(
          userId,
          template.id,
          true,
          currentCalendarMonth,
          false,
        );
        toast.success(`Plantilla "${template.name}" reactivada.`);
        await onRefresh();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'No se pudo reactivar la plantilla.';
        toast.error(msg);
      } finally {
        setBusyId(null);
      }
      return;
    }

    setBusyId(template.id);
    try {
      const pending = await getCurrentMonthPendingForTemplate(
        userId,
        template.id,
        currentCalendarMonth,
      );
      if (pending) {
        setPausePromptTemplate(template);
      } else {
        await toggleFixedExpenseTemplateActive(
          userId,
          template.id,
          false,
          currentCalendarMonth,
          false,
        );
        toast.success(
          `Plantilla "${template.name}" pausada. No generará instancias en meses futuros.`,
        );
        await onRefresh();
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo pausar la plantilla.';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmPause(removePendingCurrentMonth: boolean): Promise<void> {
    if (!pausePromptTemplate) return;
    const target = pausePromptTemplate;
    setBusyId(target.id);
    try {
      await toggleFixedExpenseTemplateActive(
        userId,
        target.id,
        false,
        currentCalendarMonth,
        removePendingCurrentMonth,
      );
      toast.success(
        removePendingCurrentMonth
          ? `Plantilla "${target.name}" pausada y quitada del mes actual.`
          : `Plantilla "${target.name}" pausada (se conserva en el mes actual por última vez).`,
      );
      setPausePromptTemplate(null);
      await onRefresh();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo pausar la plantilla.';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="fixed-templates-heading" className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 id="fixed-templates-heading" className="text-lg font-bold text-[#FAFAFA]">
            Plantillas de Gastos Fijos Recurrentes
          </h2>
          <p className="text-sm text-[#A3A3A3]">
            Cada plantilla activa genera automáticamente su compromiso mensual el día 1.
          </p>
        </div>

        <Button variant="primary" size="sm" onClick={onNewTemplate}>
          + Nuevo gasto fijo
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          title="Todavía no cargaste gastos fijos"
          description="Agregá tus compromisos mensuales como alquiler, internet, expensas o suscripciones para apartarlos desde el día 1."
          actionLabel="Crear primer gasto fijo"
          onAction={onNewTemplate}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((tpl) => {
            const monthInstance = commitmentByTemplateId.get(tpl.id);
            const isBusy =
              busyId === tpl.id || (monthInstance ? busyId === monthInstance.id : false);

            return (
              <Card
                key={tpl.id}
                padding="md"
                interactive={tpl.is_active}
                className={!tpl.is_active ? 'opacity-75 border-dashed' : ''}
              >
                <div className="flex flex-col gap-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-[#FAFAFA] truncate">
                        {tpl.name}
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="neutral">
                          {tpl.category?.name ?? 'Sin categoría'}
                        </Badge>
                        {tpl.due_day ? (
                          <Badge variant="neutral">Vence día {tpl.due_day}</Badge>
                        ) : null}
                        {!tpl.is_active ? (
                          <Badge variant="neutral">Pausada</Badge>
                        ) : null}
                      </div>
                    </div>

                    <span className="font-mono-num text-lg font-bold text-[#FAFAFA] shrink-0">
                      {formatCurrency(tpl.default_amount, currency)}
                    </span>
                  </div>

                  {tpl.notes ? (
                    <p className="text-[13px] text-[#A3A3A3] line-clamp-2">{tpl.notes}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#1F1F1F]">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onEditTemplate(tpl)}
                        disabled={isBusy}
                      >
                        Editar plantilla
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRequestToggleActive(tpl)}
                        isLoading={busyId === tpl.id}
                      >
                        {tpl.is_active ? 'Pausar' : 'Reactivar'}
                      </Button>
                    </div>

                    {monthInstance ? (
                      <Button
                        variant={monthInstance.is_paid ? 'secondary' : 'primary'}
                        size="sm"
                        onClick={() => void handleTogglePaid(monthInstance)}
                        isLoading={busyId === monthInstance.id}
                      >
                        {monthInstance.is_paid ? 'Pagado ✓' : 'Marcar como pagado'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={Boolean(pausePromptTemplate)}
        onClose={() => setPausePromptTemplate(null)}
        title="Pausar gasto fijo recurrente"
        description={
          pausePromptTemplate
            ? `"${pausePromptTemplate.name}" tiene un pago todavía Pendiente en el mes en curso.`
            : undefined
        }
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#D4D4D4] leading-relaxed">
            La plantilla dejará de generarse en los meses futuros. ¿Qué querés hacer con el compromiso pendiente de este mes?
          </p>

          <div className="flex flex-col gap-2.5">
            <Button
              variant="danger"
              onClick={() => void confirmPause(true)}
              isLoading={Boolean(pausePromptTemplate && busyId === pausePromptTemplate.id)}
            >
              Pausar y quitar del mes actual
            </Button>
            <Button
              variant="secondary"
              onClick={() => void confirmPause(false)}
              isLoading={Boolean(pausePromptTemplate && busyId === pausePromptTemplate.id)}
            >
              Pausar y conservar este mes por última vez
            </Button>
            <Button variant="ghost" onClick={() => setPausePromptTemplate(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
