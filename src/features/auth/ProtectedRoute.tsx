/**
 * Guardia de rutas privadas (`ProtectedRoute`).
 *
 * Arquitectura y decisiones técnicas:
 * - Bloquea el renderizado de cualquier vista privada mientras se valida el JWT
 *   de Supabase Auth; si no existe sesión activa, redirige de forma declarativa a `/login`.
 */
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

export function ProtectedRoute() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3">
          <div className="h-9 w-9 rounded-[6px] bg-[#FACC15] text-[#0A0A0A] font-extrabold text-sm flex items-center justify-center animate-pulse">
            SB
          </div>
          <p className="text-sm text-[#A3A3A3]">Verificando sesión privada...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
