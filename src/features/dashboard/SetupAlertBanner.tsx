/**
 * Banner de alto contraste para guiar la configuración inicial (`SetupAlertBanner`).
 *
 * Arquitectura y decisiones técnicas:
 * - En lugar de bloquear la aplicación con un wizard forzado, permite entrar
 *   directo al Dashboard y muestra un aviso amarillo/negro visible mientras el
 *   sueldo fijo o el límite mensual sigan en $0,00.
 */
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';

export interface SetupAlertBannerProps {
  fixedSalary: number;
  fixedExpensesLimit: number;
}

export function SetupAlertBanner({
  fixedSalary,
  fixedExpensesLimit,
}: SetupAlertBannerProps) {
  const navigate = useNavigate();

  const needsSetup = fixedSalary === 0 || fixedExpensesLimit === 0;
  if (!needsSetup) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label="Configuración inicial sugerida"
      className="rounded-[8px] border border-[#FACC15] bg-[#141414] px-4 py-4 sm:px-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 h-8 w-8 rounded-[6px] bg-[#FACC15] text-[#0A0A0A] font-extrabold flex items-center justify-center shrink-0"
        >
          !
        </span>
        <div>
          <h2 className="text-[15px] sm:text-base font-bold text-[#FACC15]">
            Configurá tu sueldo fijo, ahorro mensual y límite de gastos fijos para calcular tu Disponible Real
          </h2>
          <p className="mt-1 text-sm text-[#D4D4D4]">
            {fixedSalary === 0 && fixedExpensesLimit === 0
              ? 'Tus valores iniciales están en $0,00. Definí tus montos base para activar alertas preventivas y proyecciones reales.'
              : fixedSalary === 0
                ? 'Todavía falta cargar tu Sueldo Fijo Mensual.'
                : 'Todavía falta definir tu Límite Mensual de Gastos Fijos + Cuotas.'}
          </p>
        </div>
      </div>

      <Button
        variant="primary"
        size="sm"
        onClick={() => navigate('/settings')}
        className="shrink-0"
      >
        Configurar valores
      </Button>
    </div>
  );
}
