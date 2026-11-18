/**
 * Sub-navegación contextual en pills para cambiar en 1 clic entre módulos hermanos.
 *
 * Arquitectura y decisiones técnicas:
 * - Reúne las pantallas secundarias bajo las mismas familias del menú superior
 *   (`Inversiones`, `Decisión`, `Herramientas`) para evitar regresar al navbar al
 *   alternar entre vistas relacionadas (ej. Bóveda ↔ Plazos Fijos).
 * - Touch targets de al menos 44px (`min-h-[44px]`) con separación de 8px (`gap-2`)
 *   y `flex-wrap` seguro para evitar desbordes horizontales en `390px` y `320px`.
 * - Acepta prop explícito `group` o deduce automáticamente la familia según la ruta
 *   activa, resaltando el módulo actual con `aria-current="page"` (vía `NavLink`) y
 *   estado activo Amarillo/Negro de alto contraste.
 */
import { NavLink, useLocation } from 'react-router-dom';

export type PageSubnavGroup = 'investments' | 'decision' | 'tools';

export interface PageSubnavItem {
  to: string;
  label: string;
}

interface SubnavGroupConfig {
  label: string;
  items: readonly PageSubnavItem[];
}

const SUBNAV_GROUPS: Record<PageSubnavGroup, SubnavGroupConfig> = {
  investments: {
    label: 'Inversiones',
    items: [
      { to: '/savings', label: 'Bóveda de Ahorros' },
      { to: '/fixed-terms', label: 'Plazos Fijos' },
    ],
  },
  decision: {
    label: 'Decisión',
    items: [
      { to: '/simulator', label: 'Simulador' },
      { to: '/priority-matrix', label: 'Matriz de Prioridad' },
    ],
  },
  tools: {
    label: 'Herramientas',
    items: [
      { to: '/budget-assistant', label: 'Asistente IA' },
      { to: '/categories', label: 'Categorías' },
      { to: '/settings', label: 'Configuración' },
    ],
  },
};

export interface PageSubnavProps {
  group?: PageSubnavGroup;
  className?: string;
}

function resolveGroupFromPath(pathname: string): PageSubnavGroup | null {
  for (const [groupKey, config] of Object.entries(SUBNAV_GROUPS) as Array<
    [PageSubnavGroup, SubnavGroupConfig]
  >) {
    if (config.items.some((item) => item.to === pathname)) {
      return groupKey;
    }
  }
  return null;
}

export function PageSubnav({ group, className = '' }: PageSubnavProps) {
  const { pathname } = useLocation();
  const resolvedGroupKey = group ?? resolveGroupFromPath(pathname);

  if (!resolvedGroupKey) {
    return null;
  }

  const config = SUBNAV_GROUPS[resolvedGroupKey];

  return (
    <nav
      aria-label={`Sub-navegación de ${config.label}`}
      className={['w-full min-w-0', className].filter(Boolean).join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {config.items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                'btn-press min-h-[44px] inline-flex items-center justify-center rounded-full px-4 text-sm whitespace-nowrap border transition-colors no-underline',
                isActive
                  ? 'bg-[#FACC15] text-[#0A0A0A] border-[#FACC15] font-bold'
                  : 'bg-[#121212] text-[#D4D4D4] border-[#262626] font-medium hover:bg-[#1A1A1A] hover:text-[#FAFAFA] hover:border-[#363636]',
              ].join(' ')
            }
          >
            {item.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
