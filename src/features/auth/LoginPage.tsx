/**
 * Pantalla de inicio de sesión privado (`LoginPage`).
 *
 * Arquitectura y decisiones técnicas:
 * - Acceso exclusivamente privado: no existe enlace ni formulario de registro público.
 * - Validación cliente con `loginSchema` (`zod`) mostrando errores individuales por campo
 *   y botón con estado `isLoading` deshabilitado durante la petición a Supabase Auth.
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { InputField } from '../../components/ui/InputField';
import { useAuth } from '../../hooks/useAuth';
import { loginSchema } from '../../lib/validations';
import { signInWithPassword } from '../../services/authService';

export function LoginPage() {
  const { session, isLoading: isAuthLoading, isConfigured } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isAuthLoading && session) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFieldErrors({});

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setFieldErrors({
        email: flat.email?.[0],
        password: flat.password?.[0],
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await signInWithPassword(parsed.data.email, parsed.data.password);
      toast.success('Bienvenido a SB-Finance.');
      navigate('/', { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudo iniciar sesión.';
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#FAFAFA] flex flex-col justify-center py-10 px-4">
      <div className="w-full max-w-[440px] mx-auto flex flex-col gap-6">
        {/* Encabezado de marca */}
        <div className="flex flex-col gap-3">
          <div className="inline-flex items-center gap-2.5 self-start">
            <span className="h-9 w-9 rounded-[6px] bg-[#FACC15] text-[#0A0A0A] font-extrabold text-sm flex items-center justify-center">
              SB
            </span>
            <span className="font-extrabold tracking-tight text-xl text-[#FAFAFA]">
              SB-<span className="text-[#FACC15]">FINANCE</span>
            </span>
          </div>
          <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-[#FAFAFA]">
            Controlá tu Disponible Real desde el día 1.
          </h1>
          <p className="text-[15px] text-[#A3A3A3] leading-relaxed">
            Ingresá con tu cuenta privada para gestionar sueldo fijo, compromisos en cuotas y gastos diarios.
          </p>
        </div>

        {!isConfigured ? (
          <div className="rounded-[8px] border border-[#FACC15]/60 bg-[#FACC15]/10 p-4 text-sm text-[#FAFAFA]">
            <p className="font-bold text-[#FACC15]">Configuración de Supabase pendiente</p>
            <p className="mt-1 text-[#D4D4D4] leading-relaxed">
              Creá el archivo <code className="font-mono-num text-[#FACC15]">.env</code> en la raíz a partir de{' '}
              <code className="font-mono-num text-[#FACC15]">.env.example</code> con{' '}
              <code className="font-mono-num">VITE_SUPABASE_URL</code> y{' '}
              <code className="font-mono-num">VITE_SUPABASE_ANON_KEY</code>.
            </p>
          </div>
        ) : null}

        <Card padding="lg" highlight="none">
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <InputField
              label="Correo electrónico"
              type="email"
              autoComplete="email"
              placeholder="tu@correo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              required
            />

            <InputField
              label="Contraseña"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              required
            />

            <div className="pt-2">
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                isLoading={isSubmitting}
                loadingText="Validando acceso..."
              >
                Ingresar a mi cuenta
              </Button>
            </div>
          </form>

          <div className="mt-5 pt-4 border-t border-[#262626]">
            <p className="text-[13px] text-[#A3A3A3] leading-relaxed">
              Acceso privado por invitación. No hay registro público abierto; las cuentas son habilitadas únicamente por el administrador.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
