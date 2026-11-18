/**
 * Contenedor principal de rutas autenticadas (`AppShell`).
 *
 * Arquitectura y decisiones técnicas:
 * - Separa la estructura global persistente (`TopNavbar` + región `main.wrap` simétrica)
 *   de las páginas de dominio cargadas vía `<Outlet />` de React Router.
 */
import { Outlet } from 'react-router-dom';
import { TopNavbar } from './TopNavbar';

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col bg-[#0A0A0A] text-[#FAFAFA]">
      <TopNavbar />

      <main id="main-content" className="wrap flex-1 py-6 sm:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-[#1E1E1E] py-5 mt-8">
        <div className="wrap flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[13px] text-[#A3A3A3]">
          <span>SB-Finance — Control de Disponible Real</span>
          <span>Datos aislados por usuario con Row Level Security</span>
        </div>
      </footer>
    </div>
  );
}
