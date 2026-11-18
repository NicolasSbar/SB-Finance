/**
 * Página de Configuraciones de cuenta, presupuesto base, vinculación con Telegram y administración.
 *
 * Arquitectura y decisiones técnicas:
 * - Compone el resumen de la cuenta autenticada, el formulario de presupuesto base y
 *   Gustitos/zona horaria, la tarjeta de vinculación privada con Telegram y,
 *   exclusivamente cuando `userSettings.is_admin === true`, monta `AdminUserCreationCard`.
 * - Integra `PageSubnav` (`group="tools"`) para navegar en 1 clic entre los módulos
 *   hermanos de Herramientas (`Asistente IA ↔ Categorías ↔ Configuración`).
 */
import { PageSubnav } from '../../components/layout/PageSubnav';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { useAuth } from '../../hooks/useAuth';
import { AdminUserCreationCard } from './AdminUserCreationCard';
import { BudgetSettingsForm } from './BudgetSettingsForm';
import { TelegramLinkCard } from './TelegramLinkCard';

export function SettingsPage() {
  const { user, userSettings } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <PageSubnav group="tools" />

      <div>
        <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
          Configuración
        </h1>
        <p className="mt-1 text-sm sm:text-[15px] text-[#A3A3A3]">
          Administrá tu presupuesto base, bolsa de Gustitos, zona horaria local y la vinculación privada con el bot de Telegram.
        </p>
      </div>

      {/* Información de la cuenta */}
      <Card padding="md">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium text-[#A3A3A3]">Cuenta autenticada</span>
            <span className="text-base font-semibold text-[#FAFAFA] break-all">
              {user?.email ?? 'Sin correo'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">Moneda: {userSettings?.currency ?? 'ARS'}</Badge>
            {userSettings?.is_admin ? (
              <Badge variant="yellow">Administrador</Badge>
            ) : (
              <Badge variant="neutral">Usuario privado</Badge>
            )}
          </div>
        </div>
      </Card>

      <BudgetSettingsForm />

      <TelegramLinkCard />

      {userSettings?.is_admin === true ? <AdminUserCreationCard /> : null}
    </div>
  );
}
