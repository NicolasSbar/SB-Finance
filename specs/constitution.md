# Constitution — SB-Finance

> Este documento define las reglas de tecnología, arquitectura, seguridad y diseño para **SB-Finance**. Toda implementación debe respetar estrictamente estas definiciones.

---

## 1. Stack Tecnológico (Arquitectura BaaS + Serverless)

### Frontend (SPA)
- **Framework y Lenguaje:** React + TypeScript + Vite
- **Estilos:** Tailwind CSS
- **Sistema de Diseño y UI/UX:** Interfaz de alto contraste, jerarquía visual clara, tipografía tabular en montos y cero sobrecarga cognitiva.
- **Identidad Visual (Paleta Principal):** **Amarillo y Negro** como los dos colores principales de toda la aplicación (tema oscuro de alto contraste). Se permiten colores semánticos estándar (**verde** y **rojo**) únicamente para indicadores de estado financiero (ingresos/disponible vs. gastos/alertas/límites superados).
- **Interactividad de UI (Matriz de Prioridad y Audio Web):** Implementar la matriz interactiva usando **HTML5 Drag & Drop nativo** (con modal/controles nativos accesibles en móvil) y la grabación de audio en el Asistente IA usando **`MediaRecorder` nativo del navegador** (sin instalar librerías externas de drag & drop ni de audio).
- **Gráficos:** Recharts (gráficos responsivos de torta, barras y evolución mensual)
- **Notificaciones en pantalla:** `react-hot-toast`
- **Validación de formularios y esquemas:** `zod`
- **Cliente BaaS:** `@supabase/supabase-js`
- **Despliegue Frontend:** Vercel o Netlify (sitio estático generado por Vite)

### Backend as a Service (Supabase Cloud)
- **Base de datos:** PostgreSQL (con Row Level Security obligatorio)
- **Autenticación:** Supabase Auth (cuentas privadas e independientes por usuario; en Fase 4 se suman tabla `profiles`, edición de perfil, cambio de contraseña desde el perfil y panel de administración con registro público deshabilitado)
- **Almacenamiento (Storage):** Supabase Storage (bucket privado `avatars` para fotos de perfil en Fase 4, protegido con políticas RLS por `auth.uid()`, URLs firmadas y restricción de tipo/tamaño de imagen)
- **Serverless / Webhooks:** Supabase Edge Functions
  - **Runtime:** **Deno** (NO Node.js).
  - **Ubicación:** Carpeta aislada `supabase/functions/`.
  - **Importaciones:** Deben realizarse exclusivamente por URL (`https://...`), `jsr:` o `npm:` según el estándar de Deno (y `deno.json` si aplica). **Está prohibido importar paquetes desde el `package.json` del frontend.**
- **Tareas Programadas (Cron):**
  - Extensiones nativas de PostgreSQL en Supabase (**`pg_cron` + `pg_net`**) para ejecutar alertas proactivas diarias (vencimiento de plazos fijos, recordatorios de pagos pendientes y revisión de cierre de límite de gastos fijos a `<= 3` días de fin de mes).
  - **Keep-alive diario (en dos etapas):**
    - *Etapa de desarrollo (sin hosting):* Cron 100% dentro de Supabase (`pg_cron` + `pg_net`) haciendo una petición HTTP liviana diaria a la API de Supabase.
    - *Etapa de producción (hosteado en Vercel):* Vercel Function en `/api/keep-alive` configurada mediante Vercel Cron en `vercel.json` (reemplazando el keep-alive interno de Supabase).
- **Bot de Mensajería (v1):** Telegram Bot API (100% gratuito, vía Webhook hacia Edge Function)
- **Procesamiento de Lenguaje Natural:** IA multimodal ligera (ej. Gemini Flash) invocada exclusivamente desde Supabase Edge Functions

---

## 2. Reglas Globales de Arquitectura, Seguridad y Código

### Seguridad y Datos (Crítico en BaaS)
- **Row Level Security (RLS) obligatorio:** Todas las tablas en Supabase deben tener RLS activado filtrando por `auth.uid()`. Ningún usuario puede leer, insertar, editar o borrar registros de otro usuario.
- **Control de Acceso (RBAC) y Operaciones Administrativas:**
  - Las operaciones privilegiadas (alta manual de usuarios, listado global de cuentas, cambio de permisos/rol `admin` | `user`) se ejecutan exclusivamente mediante **Supabase Edge Functions** (usando `SUPABASE_SERVICE_ROLE_KEY` en servidor Deno), verificando primero el JWT del solicitante y comprobando en PostgreSQL que posea `role = 'admin'`.
  - **Compatibilidad `sb_secret_` en RPCs invocadas por Edge Functions:** Toda RPC dual o de servidor invocada con `SUPABASE_SERVICE_ROLE_KEY` debe ser compatible tanto con JWT legado (`request.jwt.claim.role = 'service_role'`) como con claves `sb_secret_...` (`SECURITY INVOKER` verificando `current_user = 'service_role'`, nunca dependiendo únicamente de `request.jwt.claim.role` dentro de `SECURITY DEFINER`).
  - **Anti-escalamiento de privilegios:** Ningún usuario puede modificar su propia columna `role` desde el cliente (protegido por RLS/triggers en PostgreSQL).
  - **Privacidad financiera:** El rol `admin` gestiona accesos y permisos de cuentas, pero los datos financieros de cada usuario (`transactions`, `fixed_expenses`, `savings`, etc.) continúan aislados estrictamente por `user_id = auth.uid()`.
- **Seguridad en Storage (Avatares):** El bucket de fotos de perfil debe aplicar políticas RLS para que cada usuario solo pueda subir, sobrescribir o eliminar archivos dentro de su propia carpeta (`auth.uid()`), validando extensión y peso máximo en cliente y bucket.
- **Secretos fuera del frontend:** Las claves de la IA y el token del Bot de Telegram **jamás** van en el código de React/Vite. Viven exclusivamente como secretos/variables de entorno dentro de **Supabase Edge Functions**.
- **Autenticación del Webhook de Telegram:** La Edge Function de Telegram debe validar obligatoriamente el header `X-Telegram-Bot-Api-Secret-Token` en cada petición entrante para rechazar llamadas externas no autorizadas.
- **Integridad referencial en anulaciones:** Las compras en cuotas deben relacionar sus compromisos mensuales mediante llave foránea con `ON DELETE CASCADE`, garantizando que anular una compra padre elimine todas sus cuotas asociadas.
- **Variables de entorno en Vite:** Usar `.env` (ignorado en `.gitignore`) únicamente para `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`. Nunca exponer la `service_role` key en el cliente.
- **Manejo de dinero:** Usar `NUMERIC(12, 2)` en PostgreSQL para evitar errores de redondeo con decimales flotantes.
- **Manejo de fechas:** Almacenar fechas de movimientos, cuotas y vencimientos como tipo `DATE` (`YYYY-MM-DD`) en la zona horaria local del usuario para evitar desfases de día por UTC en los cierres mensuales.

### Estructura del Código
- **Frontend (`src/`):**
  - `src/components/`: Componentes de UI reutilizables.
  - `src/features/` (o `src/pages/`): Módulos por dominio (`auth`, `profile`, `admin`, `dashboard`, `transactions`, `categories`, `fixed-expenses`, `installments`, `priority-matrix`, `simulator`, `fixed-terms`, `settings`).
  - `src/services/` (o `src/lib/`): Cliente de Supabase y funciones de acceso a datos (evitar queries complejas dentro de componentes visuales).
  - `src/hooks/`: Custom hooks para estado y llamadas a Supabase.
- **Edge Functions (`supabase/functions/`):**
  - Cada función en su propia subcarpeta (ej. `supabase/functions/telegram-webhook/index.ts`).
- **Vercel Functions (`api/`):**
  - Reservada exclusivamente para endpoints serverless de producción en Vercel (ej. `/api/keep-alive.ts` + `vercel.json`).
- **Tipado estricto:** TypeScript con `strict: true`.
- **Feedback al usuario:** Toda acción de escritura debe mostrar estado de carga (`loading`) y notificar el resultado (éxito o error) con `react-hot-toast`.

### Calidad y Mantenimiento
- **Validación:** Validar formularios con `zod` en el cliente y reforzar con restricciones (`CHECK`, `NOT NULL`) en PostgreSQL.
- **Idioma del código:** Variables, funciones, tablas y columnas en **inglés**; textos de la interfaz de usuario (UI) en **español**.
- **Commits claros:** Mensajes descriptivos (ej. `feat: add monthly commitments table for installments`).

- **Control de dependencias:** Todas las librerías de `npm` y módulos `Deno` utilizados deben estar explícitamente declarados en el stack del proyecto sin dependencias UI externas innecesarias.

---

## Decisiones de Arquitectura
- **Separación `constitution.md` vs `product_roadmap.md`:** Se separa el *cómo se construye y bajo qué reglas* (`constitution.md`) del *qué se construye y en qué orden* (`product_roadmap.md`) para evitar que cambios funcionales alteren accidentalmente las restricciones técnicas o de seguridad.
- **Aislamiento explícito de Deno en `supabase/functions/`:** El frontend usa Vite/Node para desarrollo, mientras que las Edge Functions corren en Deno. Documentarlo explícitamente evita errores de compatibilidad de módulos y fallos en el despliegue de Supabase Cloud.
