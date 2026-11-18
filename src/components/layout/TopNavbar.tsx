/**
 * Barra de navegación superior fija (Amarillo y Negro) con menús agrupados y drawer móvil.
 *
 * Arquitectura y decisiones técnicas:
 * - Agrupación cognitiva: reduce los ítems de primer nivel a 3 enlaces directos
 *   (`Dashboard`, `Movimientos`, `Fijos y Cuotas`) y 3 menús desplegables accesibles
 *   (`Inversiones`, `Decisión`, `Herramientas`).
 * - Accesibilidad total: cierra desplegables al salir con `Tab` (`onBlur` sobre
 *   `relatedTarget`) y restaura el foco al trigger tras `Escape`; el menú móvil opera
 *   como diálogo modal (`role="dialog"`, `aria-modal="true"`) con trampa de foco y
 *   retorno automático al botón que lo abrió.
 * - Alineación segura en `1024px`: el último desplegable (`Herramientas`) se alinea a la
 *   derecha (`right-0`) para evitar desbordamiento horizontal en pantallas compactas.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../ui/Button';

interface NavLinkItem {
  to: string;
  label: string;
  description?: string;
  end?: boolean;
}

interface NavGroup {
  id: 'investments' | 'decision' | 'tools';
  label: string;
  items: readonly NavLinkItem[];
}

const DIRECT_ITEMS: readonly NavLinkItem[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/transactions', label: 'Movimientos' },
  { to: '/commitments', label: 'Fijos y Cuotas' },
];

const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'investments',
    label: 'Inversiones',
    items: [
      {
        to: '/savings',
        label: 'Bóveda de Ahorros',
        description: 'Saldo líquido, metas y retiros',
      },
      {
        to: '/fixed-terms',
        label: 'Plazos Fijos',
        description: 'Capital inmovilizado y vencimientos',
      },
    ],
  },
  {
    id: 'decision',
    label: 'Decisión',
    items: [
      {
        to: '/priority-matrix',
        label: 'Matriz de Prioridad',
        description: 'Impacto vs. costo en 4 cuadrantes',
      },
      {
        to: '/simulator',
        label: 'Simulador de Gastos',
        description: 'Escenarios efímeros "¿Qué pasa si...?"',
      },
    ],
  },
  {
    id: 'tools',
    label: 'Herramientas',
    items: [
      {
        to: '/budget-assistant',
        label: 'Asistente de Presupuesto IA',
        description: 'Sugerencias de topes con Gemini Flash',
      },
      {
        to: '/categories',
        label: 'Categorías',
        description: 'Rubros, topes e integrantes de Gustitos',
      },
      {
        to: '/settings',
        label: 'Configuración',
        description: 'Sueldo, día de cobro y Telegram',
      },
    ],
  },
];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'textarea:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

export function TopNavbar() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const mobileSheetTitleId = useId();
  const [openDropdown, setOpenDropdown] = useState<NavGroup['id'] | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const navContainerRef = useRef<HTMLElement>(null);
  const dropdownTriggerRefs = useRef<Partial<Record<NavGroup['id'], HTMLButtonElement | null>>>({});
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileSheetRef = useRef<HTMLDivElement>(null);
  const shouldReturnMobileFocusRef = useRef(false);

  function openMobileMenu(): void {
    shouldReturnMobileFocusRef.current = false;
    setIsMobileMenuOpen(true);
  }

  function closeMobileMenu(returnFocus: boolean): void {
    shouldReturnMobileFocusRef.current = returnFocus;
    setIsMobileMenuOpen(false);
  }

  // Cerrar menús al cambiar de ruta
  useEffect(() => {
    setOpenDropdown(null);
    shouldReturnMobileFocusRef.current = false;
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  // Cerrar dropdown al hacer clic fuera o presionar Escape (devolviendo foco al trigger)
  useEffect(() => {
    if (!openDropdown) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        navContainerRef.current &&
        event.target instanceof Node &&
        !navContainerRef.current.contains(event.target)
      ) {
        setOpenDropdown(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        const activeGroup = openDropdown;
        setOpenDropdown(null);
        dropdownTriggerRefs.current[activeGroup]?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openDropdown]);

  // Bloqueo de scroll, trampa de foco, Escape y retorno de foco para diálogo móvil
  useEffect(() => {
    if (!isMobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const sheetEl = mobileSheetRef.current;
    if (sheetEl) {
      const focusables = getFocusableElements(sheetEl);
      const initialTarget = focusables[0] ?? sheetEl;
      initialTarget.focus();
    }

    const desktopMediaQuery = window.matchMedia('(min-width: 1024px)');
    const handleViewportChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        shouldReturnMobileFocusRef.current = false;
        setIsMobileMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        shouldReturnMobileFocusRef.current = true;
        setIsMobileMenuOpen(false);
        return;
      }

      if (event.key === 'Tab' && mobileSheetRef.current) {
        const focusables = getFocusableElements(mobileSheetRef.current);
        if (focusables.length === 0) {
          event.preventDefault();
          mobileSheetRef.current.focus();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (event.shiftKey) {
          if (
            active === first ||
            active === mobileSheetRef.current ||
            !mobileSheetRef.current.contains(active)
          ) {
            event.preventDefault();
            last.focus();
          }
        } else if (
          active === last ||
          !mobileSheetRef.current.contains(active)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    desktopMediaQuery.addEventListener('change', handleViewportChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktopMediaQuery.removeEventListener('change', handleViewportChange);
      window.removeEventListener('keydown', handleKeyDown);
      if (shouldReturnMobileFocusRef.current) {
        shouldReturnMobileFocusRef.current = false;
        mobileMenuButtonRef.current?.focus();
      }
    };
  }, [isMobileMenuOpen]);

  async function handleSignOut(): Promise<void> {
    setIsSigningOut(true);
    try {
      await signOut();
      toast.success('Sesión cerrada.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudo cerrar sesión.';
      toast.error(msg);
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-40 w-full bg-[#0A0A0A] border-b border-[#262626]">
      <div className="wrap h-[68px] flex items-center justify-between gap-4">
        <a href="#main-content" className="skip-link">
          Ir al contenido principal
        </a>

        {/* Marca SB-FINANCE */}
        <Link
          to="/"
          className="inline-flex items-center gap-2.5 text-[#FAFAFA] hover:text-[#FACC15] transition-colors shrink-0"
        >
          <span className="h-8 w-8 rounded-[6px] bg-[#FACC15] text-[#0A0A0A] font-extrabold text-sm flex items-center justify-center tracking-tight">
            SB
          </span>
          <span className="font-extrabold tracking-tight text-[17px]">
            SB-<span className="text-[#FACC15]">FINANCE</span>
          </span>
        </Link>

        {/* Enlaces y menús agrupados Desktop */}
        <nav
          ref={navContainerRef}
          aria-label="Navegación principal"
          className="hidden lg:flex items-center gap-1"
        >
          {DIRECT_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  'relative px-3.5 py-2 text-[15px] font-medium rounded-[6px] whitespace-nowrap transition-colors',
                  isActive
                    ? 'text-[#FACC15] bg-[#141414]'
                    : 'text-[#D4D4D4] hover:text-[#FAFAFA] hover:bg-[#141414]',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <span>{item.label}</span>
                  {isActive ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-3 right-3 bottom-0 h-[2px] bg-[#FACC15]"
                    />
                  ) : null}
                </>
              )}
            </NavLink>
          ))}

          {NAV_GROUPS.map((group) => {
            const isOpen = openDropdown === group.id;
            const isGroupActive = group.items.some(
              (sub) => location.pathname === sub.to,
            );
            const dropdownAlignmentClass =
              group.id === 'tools' ? 'right-0' : 'left-0';

            return (
              <div
                key={group.id}
                className="relative"
                onBlur={(event) => {
                  if (!isOpen) return;
                  const nextFocused = event.relatedTarget;
                  if (
                    !(nextFocused instanceof Node) ||
                    !event.currentTarget.contains(nextFocused)
                  ) {
                    setOpenDropdown(null);
                  }
                }}
              >
                <button
                  ref={(el) => {
                    dropdownTriggerRefs.current[group.id] = el;
                  }}
                  type="button"
                  aria-expanded={isOpen}
                  aria-haspopup="menu"
                  onClick={() =>
                    setOpenDropdown((prev) =>
                      prev === group.id ? null : group.id,
                    )
                  }
                  className={[
                    'relative inline-flex items-center gap-1.5 px-3.5 py-2 text-[15px] font-medium rounded-[6px] whitespace-nowrap transition-colors cursor-pointer',
                    isGroupActive || isOpen
                      ? 'text-[#FACC15] bg-[#141414]'
                      : 'text-[#D4D4D4] hover:text-[#FAFAFA] hover:bg-[#141414]',
                  ].join(' ')}
                >
                  <span>{group.label}</span>
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                    className={[
                      'h-4 w-4 transition-transform duration-150',
                      isOpen ? 'rotate-180' : '',
                    ].join(' ')}
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {isGroupActive ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-3 right-3 bottom-0 h-[2px] bg-[#FACC15]"
                    />
                  ) : null}
                </button>

                {isOpen ? (
                  <div
                    role="menu"
                    tabIndex={-1}
                    aria-label={group.label}
                    className={[
                      'absolute mt-2 w-72 rounded-[8px] border border-[#262626] bg-[#121212] p-1.5 shadow-lg z-50 outline-none',
                      dropdownAlignmentClass,
                    ].join(' ')}
                  >
                    {group.items.map((sub) => (
                      <NavLink
                        key={sub.to}
                        to={sub.to}
                        role="menuitem"
                        onClick={() => setOpenDropdown(null)}
                        className={({ isActive }) =>
                          [
                            'block rounded-[6px] px-3.5 py-2.5 transition-colors',
                            isActive
                              ? 'bg-[#FACC15]/12 text-[#FACC15]'
                              : 'text-[#FAFAFA] hover:bg-[#1A1A1A]',
                          ].join(' ')
                        }
                      >
                        <span className="block text-sm font-semibold">
                          {sub.label}
                        </span>
                        {sub.description ? (
                          <span className="block text-xs text-[#A3A3A3] mt-0.5">
                            {sub.description}
                          </span>
                        ) : null}
                      </NavLink>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        {/* Cuenta y acción de salida en Desktop */}
        <div className="hidden lg:flex items-center gap-3 shrink-0">
          {user?.email ? (
            <span
              title={user.email}
              className="text-[13px] text-[#A3A3A3] max-w-[180px] truncate"
            >
              {user.email}
            </span>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSignOut}
            isLoading={isSigningOut}
            loadingText="Saliendo..."
          >
            Cerrar sesión
          </Button>
        </div>

        {/* Botón menú móvil */}
        <button
          ref={mobileMenuButtonRef}
          type="button"
          onClick={() => (isMobileMenuOpen ? closeMobileMenu(true) : openMobileMenu())}
          aria-expanded={isMobileMenuOpen}
          aria-controls="mobile-navigation-sheet"
          aria-label={isMobileMenuOpen ? 'Cerrar menú' : 'Abrir menú'}
          className="lg:hidden min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[6px] bg-[#141414] border border-[#262626] text-[#FAFAFA] hover:border-[#FACC15] cursor-pointer"
        >
          {isMobileMenuOpen ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          )}
        </button>
      </div>

      {/* Panel completo móvil */}
      {isMobileMenuOpen ? (
        <div
          ref={mobileSheetRef}
          id="mobile-navigation-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={mobileSheetTitleId}
          tabIndex={-1}
          className="lg:hidden fixed inset-x-0 top-[68px] bottom-0 z-50 bg-[#0A0A0A] border-t border-[#262626] overflow-y-auto outline-none"
        >
          <div className="wrap py-5 flex flex-col gap-5">
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-[#262626]">
              <h2
                id={mobileSheetTitleId}
                className="text-sm font-bold text-[#FAFAFA] tracking-tight"
              >
                Menú de navegación
              </h2>
              <button
                type="button"
                onClick={() => closeMobileMenu(true)}
                aria-label="Cerrar menú"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[6px] bg-[#141414] border border-[#262626] text-[#FAFAFA] hover:border-[#FACC15] cursor-pointer"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <nav aria-label="Navegación principal móvil" className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3] px-1">
                  Principal
                </span>
                {DIRECT_ITEMS.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={() => closeMobileMenu(false)}
                    className={({ isActive }) =>
                      [
                        'min-h-[48px] px-4 rounded-[6px] flex items-center justify-between text-base font-semibold border transition-colors',
                        isActive
                          ? 'bg-[#FACC15]/12 border-[#FACC15] text-[#FACC15]'
                          : 'bg-[#121212] border-[#262626] text-[#FAFAFA] hover:border-[#3A3A3A]',
                      ].join(' ')
                    }
                  >
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>

              {NAV_GROUPS.map((group) => (
                <div key={group.id} className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3] px-1">
                    {group.label}
                  </span>
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={() => closeMobileMenu(false)}
                      className={({ isActive }) =>
                        [
                          'min-h-[48px] px-4 py-2.5 rounded-[6px] flex flex-col justify-center border transition-colors',
                          isActive
                            ? 'bg-[#FACC15]/12 border-[#FACC15] text-[#FACC15]'
                            : 'bg-[#121212] border-[#262626] text-[#FAFAFA] hover:border-[#3A3A3A]',
                        ].join(' ')
                      }
                    >
                      <span className="text-sm font-semibold">{item.label}</span>
                      {item.description ? (
                        <span className="text-xs text-[#A3A3A3]">{item.description}</span>
                      ) : null}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>

            <div className="pt-4 border-t border-[#262626] flex flex-col gap-3">
              {user?.email ? (
                <p className="text-sm text-[#A3A3A3] break-all">
                  Cuenta activa: <span className="text-[#FAFAFA] font-medium">{user.email}</span>
                </p>
              ) : null}
              <Button
                variant="secondary"
                className="w-full"
                onClick={handleSignOut}
                isLoading={isSigningOut}
                loadingText="Cerrando sesión..."
              >
                Cerrar sesión
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
