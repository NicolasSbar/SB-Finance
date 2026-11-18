/**
 * Hook y Proveedor de contexto de autenticación privada y perfil del usuario.
 *
 * Arquitectura y decisiones técnicas:
 * - Centralizamos la sesión de Supabase Auth y el registro `user_settings` en un
 *   único Contexto React para que toda la aplicación (Navbar, Dashboard, Settings)
 *   reaccione instantáneamente al iniciar/cerrar sesión o al actualizar el sueldo fijo,
 *   evitando peticiones duplicadas por cada componente montado.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured } from '../lib/supabaseClient';
import { getCurrentSession, onAuthStateChange, signOut as authSignOut } from '../services/authService';
import { getUserSettings } from '../services/settingsService';
import type { UserSettings } from '../types/database.types';

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  userSettings: UserSettings | null;
  isLoading: boolean;
  isConfigured: boolean;
  refreshSettings: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const loadSettingsForUser = useCallback(async (userId: string) => {
    try {
      const settings = await getUserSettings(userId);
      setUserSettings(settings);
    } catch (err) {
      console.error('Error al cargar user_settings:', err);
      setUserSettings(null);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function bootstrap(): Promise<void> {
      if (!isSupabaseConfigured) {
        if (isMounted) setIsLoading(false);
        return;
      }

      try {
        const currentSession = await getCurrentSession();
        if (!isMounted) return;
        setSession(currentSession);
        if (currentSession?.user) {
          await loadSettingsForUser(currentSession.user.id);
        }
      } catch (err) {
        console.error('Error inicializando sesión:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void bootstrap();

    if (!isSupabaseConfigured) {
      return () => {
        isMounted = false;
      };
    }

    const subscription = onAuthStateChange((_event, nextSession) => {
      if (!isMounted) return;
      setSession(nextSession);
      if (nextSession?.user) {
        void loadSettingsForUser(nextSession.user.id);
      } else {
        setUserSettings(null);
      }
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [loadSettingsForUser]);

  const refreshSettings = useCallback(async () => {
    if (!session?.user) return;
    await loadSettingsForUser(session.user.id);
  }, [session, loadSettingsForUser]);

  const handleSignOut = useCallback(async () => {
    await authSignOut();
    setSession(null);
    setUserSettings(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      userSettings,
      isLoading,
      isConfigured: isSupabaseConfigured,
      refreshSettings,
      signOut: handleSignOut,
    }),
    [session, userSettings, isLoading, refreshSettings, handleSignOut],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth debe utilizarse dentro de un AuthProvider.');
  }
  return ctx;
}
