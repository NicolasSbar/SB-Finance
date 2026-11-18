/**
 * Panel de Administración de Usuarios (renderizado exclusivamente si `is_admin = true`).
 *
 * Arquitectura y decisiones técnicas:
 * - El alta real se delega a la Edge Function `admin-create-user`, manteniendo la
 *   `SUPABASE_SERVICE_ROLE_KEY` protegida en el servidor Deno y evitando reemplazar
 *   la sesión activa del administrador en el navegador.
 */
import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { InputField } from '../../components/ui/InputField';
import { useAuth } from '../../hooks/useAuth';
import { adminCreateUserSchema } from '../../lib/validations';
import { adminCreateUser } from '../../services/authService';

export function AdminUserCreationCard() {
  const { userSettings } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [isCreating, setIsCreating] = useState(false);

  // Doble guardia defensiva: jamás renderizar si el usuario no es administrador
  if (!userSettings?.is_admin) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFieldErrors({});

    const parsed = adminCreateUserSchema.safeParse({ email, password });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setFieldErrors({
        email: flat.email?.[0],
        password: flat.password?.[0],
      });
      return;
    }

    setIsCreating(true);
    try {
      const res = await adminCreateUser(parsed.data.email, parsed.data.password);
      toast.success(`Cuenta creada para ${res.user.email}. Ya puede iniciar sesión.`);
      setEmail('');
      setPassword('');
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo dar de alta el usuario.';
      toast.error(msg);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Card padding="lg" highlight="yellow">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h2 className="text-lg font-bold text-[#FAFAFA]">Administración de Usuarios</h2>
          <p className="mt-1 text-sm text-[#A3A3A3]">
            Creá cuentas privadas para personas de confianza sin abrir el registro público.
          </p>
        </div>
        <Badge variant="yellow">Solo Administrador</Badge>
      </div>

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InputField
            label="Email del nuevo usuario"
            type="email"
            placeholder="persona@correo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors.email}
            required
          />

          <InputField
            label="Contraseña inicial (mín. 8 caracteres)"
            type="password"
            placeholder="Mínimo 8 caracteres"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password}
            required
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
          <p className="text-[13px] text-[#A3A3A3]">
            El nuevo usuario recibirá sus categorías base y configuración inicial en $0,00 automáticamente.
          </p>
          <Button
            type="submit"
            variant="primary"
            isLoading={isCreating}
            loadingText="Creando usuario..."
          >
            Crear usuario
          </Button>
        </div>
      </form>

      <div className="mt-5 pt-4 border-t border-[#262626] text-[13px] text-[#A3A3A3] leading-relaxed">
        <strong className="text-[#FAFAFA]">Alternativa desde Supabase Cloud:</strong> También podés
        invitar o dar de alta cuentas manualmente desde{' '}
        <span className="text-[#D4D4D4]">Authentication &rarr; Users &rarr; Add user</span> en tu
        panel de Supabase. El trigger <code className="font-mono-num text-[#FACC15]">on_auth_user_created</code>{' '}
        aprovisionará su perfil al instante.
      </div>
    </Card>
  );
}
