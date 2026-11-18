# Especificación Funcional — Fase 1 (Core MVP) — SB-Finance

> **Versión:** 1.0.0  
> **Estado:** Aprobado para implementación  
> **Documentos base:** `specs/constitution.md`, `specs/product_roadmap.md`

---

## 1. Objetivo y Alcance Estricto de la Fase 1

### 1.1 Objetivo del MVP
Construir el núcleo operativo de **SB-Finance**: una aplicación web privada de finanzas personales que permita a cada usuario conocer en todo momento su **Disponible Real del mes** (descontando automáticamente desde el día 1 sus gastos fijos, cuotas comprometidas y el dinero destinado a **ahorros**), mantener su ahorro acumulado completamente aislado y oculto del saldo disponible para gastar, gestionar sus categorías, registrar gastos variables e ingresos extra, controlar cuánto dinero le falta abonar de sus compromisos mensuales y analizar su evolución financiera mediante gráficos interactivos e historial inmutable mes a mes.

### 1.2 Qué incluye exactamente la Fase 1 (In-Scope)
1. **Autenticación privada y gestión de cuentas:**
   - Inicio y cierre de sesión con Supabase Auth (`/login`).
   - Sin registro público abierto: las cuentas se dan de alta manualmente desde el panel de Supabase Auth o desde el apartado exclusivo de **Administración de Usuarios** dentro de `/settings` (visible únicamente para el usuario administrador con `is_admin = true`).
   - Aislamiento total de datos por usuario mediante **Row Level Security (`auth.uid()`)**.
2. **Onboarding sin fricción y Categorías iniciales:**
   - Al crearse un usuario, el sistema aprovisiona automáticamente su perfil con valores iniciales en `$0,00` y un set básico de categorías de **Gastos (`expense`)** y de **Ingresos (`income`)**.
   - El usuario ingresa directo al Dashboard; si aún no configuró su sueldo fijo o su límite de gastos fijos, visualiza un **banner de aviso de alto contraste** invitándolo a configurarlos.
3. **Configuraciones del usuario y Snapshots mensuales (`monthly_budgets`):**
   - Definición de **Sueldo Fijo Mensual**, **Ahorro Mensual Objetivo** (monto apartado automáticamente a ahorros desde el día 1) y **Límite Mensual de Gastos Fijos + Cuotas** (monto fijo en dinero).
   - Congelamiento automático del presupuesto mensual (`monthly_budgets`) para garantizar **inmutabilidad histórica**: futuros aumentos de sueldo o cambios de metas/límites no alteran los cierres de meses pasados.
4. **Ahorros y Bóveda Aislada (`/savings`):**
   - El ahorro mensual configurado (`monthly_savings_target`) más cualquier aporte extra voluntario (`savings_entries`) se **restan automáticamente del `Disponible Real`** del mes.
   - **Aislamiento visual estricto:** Aunque el dinero ahorrado siga líquido en la cuenta del usuario, el saldo acumulado de la Bóveda de Ahorros **no se muestra ni se suma dentro del `Disponible Real`** ni en las tarjetas de saldo gastable del Dashboard; se gestiona únicamente dentro de su pantalla dedicada `/savings`.
5. **CRUD de Categorías (Gastos e Ingresos) con Borrado Lógico:**
   - Creación y edición de categorías tanto para gastos (`expense`) como para ingresos extra (`income`).
   - **Borrado lógico (`is_active = false`):** Al eliminar/archivar una categoría que fue utilizada, se oculta de los formularios de nuevos registros pero permanece visible e intacta en el historial de movimientos y gráficos de meses anteriores. Permite reactivación.
6. **Gastos Fijos Recurrentes y Compras en Cuotas (Compromisos Mensuales):**
   - **Plantillas de Gastos Fijos:** Lista de obligaciones recurrentes (alquiler, internet, luz, suscripciones) que generan una instancia mensual en la tabla de compromisos del mes.
   - **Compras en Cuotas:** Registro de compras financiadas ingresando **fecha de la primera cuota**, **monto por cuota** y **cantidad de cuotas (`N`)**, pre-generando automáticamente las `N` filas mensuales vinculadas a la compra padre con `ON DELETE CASCADE`. Soporta edición y anulación.
   - **Apartado desde el día 1 y seguimiento de pago:** Todos los compromisos del mes (fijos + cuotas) se descuentan del `Disponible Real` desde el día 1 del mes. El usuario los marca como `Pagado` o `Pendiente`, visualizando en el Dashboard cuánto dinero resta abonar en el mes.
7. **Movimientos Manuales (`transactions`):**
   - CRUD completo de gastos variables (`expense`) e ingresos extra (`income`) con categoría obligatoria según su tipo, fecha, monto y nota opcional.
8. **Dashboard Principal, Gráficos e Historial Mensual:**
   - Tarjetas KPI del mes: **Disponible Real** (neto de fijos, cuotas, ahorro destinado y gastos variables), **Ingresos del Mes** (Sueldo Fijo + Ingresos Extra), **Comprometido en Fijos + Cuotas** (con barra de progreso contra el límite y alerta visual preventiva si se supera), **Gastos Variables**, y **Pendiente de Abonar** (compromisos del mes aún impagos).
   - Gráficos responsivos en **Recharts**: distribución porcentual de gastos por categoría (dona), comparativa Ingresos vs. Compromisos vs. Gastos Variables (barras) y evolución de los últimos 6 meses.
   - Filtros dinámicos de movimientos (categoría, tipo `expense` | `income`, rango de fechas dentro del mes y búsqueda por texto) y selector de mes para recorrer el historial o proyectar cuotas futuras.

### 1.3 Qué queda fuera de la Fase 1 (Out-of-Scope)
- **Fase 2:**
  - Apartado en `/settings` para que **cualquier usuario vincule su propia cuenta de Telegram** (`user_id ↔ telegram_chat_id`).
  - **Bolsa compartida de "Gustitos"** con barra de progreso regresiva en pantalla (se marca en rojo al llegar a `<= $0`) y límites individuales por categoría.
  - Bot de Telegram con IA (texto/audio) que tras cada gasto responde al instante con el saldo restante disponible (ej. *"Gasto registrado: $15.000 en Comida. Te quedan $12.000 para Gustitos/Ocio"*), botón inline `[❌ Anular]`, **alertas en tiempo real** al llegar Gustitos a `$0` y recordatorios diarios (`pg_cron` + `pg_net`).
- **Fase 3:** Matriz de prioridad interactiva (Drag & Drop), Simulador de gastos ("¿Qué pasa si...?"), **Plazos Fijos** (descontados y ocultos del `Disponible Real`, conectados con la Bóveda de Ahorros) y Asistente IA de distribución de presupuesto.

---

## 2. Reglas de Negocio y Fórmulas Financieras

### 2.1 Fórmula del Disponible Real (Fase 1)
En la Fase 1, para cualquier mes seleccionado $M$:

$$\text{Disponible Real}_M = (\text{Sueldo Fijo}_M + \sum \text{Ingresos Extra}_M) - (\sum \text{Gastos Fijos}_M + \sum \text{Cuotas}_M) - \text{Ahorro Destinado}_M - \sum \text{Gastos Variables}_M$$

Donde:
- $\text{Sueldo Fijo}_M$: Valor congelado en `monthly_budgets.fixed_salary` para el mes $M$ (o el valor de `user_settings.fixed_salary` si es una proyección de un mes futuro aún no inicializado).
- $\sum \text{Ingresos Extra}_M$: Suma de `transactions.amount` con `type = 'income'` cuya fecha pertenece al mes $M$.
- $\sum \text{Gastos Fijos}_M + \sum \text{Cuotas}_M$: Suma de `monthly_commitments.amount` correspondientes al mes $M$, **tanto en estado `Pagado` como `Pendiente`** (regla de apartado desde el día 1). Si $M$ es un mes **futuro aún no inicializado** (`monthly_budgets` inexistente), la proyección suma además las plantillas activas de `fixed_expense_templates` (`is_active = true`) que aún no tengan instancia materializada en ese mes.
- $\text{Ahorro Destinado}_M$: Suma del **Ahorro Mensual Objetivo** congelado en `monthly_budgets.monthly_savings_target` para el mes $M$ más los **Aportes Extra a Ahorros** (`savings_entries` con `entry_type = 'deposit'`) registrados en ese mes. **Importante:** Este monto se resta automáticamente y queda oculto del `Disponible Real` incluso si el dinero permanece líquido en la cuenta del usuario.
- $\sum \text{Gastos Variables}_M$: Suma de `transactions.amount` con `type = 'expense'` cuya fecha pertenece al mes $M$.

### 2.2 Indicador de "Pendiente de Abonar en el Mes" (Obligaciones por Pagar)
Dado que el `Disponible Real` ya descuenta desde el día 1 todos los gastos fijos y cuotas del mes, el usuario necesita saber cuánto dinero de su saldo bancario real todavía debe destinar a pagar cuentas de ese mes:

$$\text{Pendiente de Abonar}_M = \sum_{\text{is\_paid = false}} \text{Compromisos Mensuales}_M \quad (\text{Gastos Fijos} + \text{Cuotas})$$

$$\text{Ya Abonado}_M = \sum_{\text{is\_paid = true}} \text{Compromisos Mensuales}_M \quad (\text{Gastos Fijos} + \text{Cuotas})$$

### 2.3 Límite de Gastos Fijos + Cuotas y Alertas Visuales
- El usuario configura un monto fijo en dinero (`fixed_expenses_limit`, ej. `$ 450.000,00`).
- **Porcentaje comprometido del límite:**
  $$\text{Uso del Límite (\%)} = \frac{\sum \text{Gastos Fijos}_M + \sum \text{Cuotas}_M}{\text{Límite de Gastos Fijos}_M} \times 100$$
- **Comportamiento visual (No bloqueante):**
  - `< 85%`: Estado normal (barra en amarillo de marca `#FACC15` / indicador saludable).
  - `85% a 100%`: Estado de precaución (aviso de proximidad al tope).
  - `> 100%`: **Alerta visual preventiva en rojo semántico (`#EF4444`)** tanto en el Dashboard como en el formulario al cargar una nueva cuota o gasto fijo, indicando en cuánto dinero se excede el tope. **Nunca bloquea el guardado del registro.**

### 2.4 Ciclo de Vida de Snapshots (`monthly_budgets`) e Instancias de Gastos Fijos
1. **Inicialización Automática Bajo Demanda (*Lazy Initialization*):**
   - Cuando el usuario abre la aplicación en el **mes calendario actual** (o registra un movimiento/compromiso en el mes actual o un mes futuro), el sistema verifica si existe el registro en `monthly_budgets` para ese mes (`YYYY-MM-01`).
   - Si no existe, ejecuta una operación atómica que:
     1. Crea el snapshot en `monthly_budgets` copiando `fixed_salary` y `fixed_expenses_limit` desde `user_settings`.
     2. Genera en `monthly_commitments` una instancia por cada plantilla activa en `fixed_expense_templates` (`is_active = true`) con su `default_amount` vigente y estado `is_paid = false`.
2. **Modificación de Sueldo Fijo o Límite a mitad de mes:**
   - Si el usuario edita su sueldo fijo o límite en `/settings`, se actualiza `user_settings` (para meses futuros) **y se actualiza el snapshot del mes actual en curso**.
   - Los snapshots de **meses pasados** (`month_date < mes_actual`) permanecen **100% inmutables**.
   - Adicionalmente, el usuario puede editar puntualmente el sueldo fijo o límite de un mes específico desde el selector mensual si ese mes tuvo una particularidad, sin alterar su configuración base para meses siguientes.
3. **Navegación a meses pasados sin actividad:**
   - Si el usuario selecciona en el historial un mes anterior al actual que no tiene fila en `monthly_budgets`, el sistema **no autogenera** gastos fijos retroactivos automáticamente. Muestra un estado vacío informativo (*"No hay cierre registrado para este mes"*) con un botón opcional `"Inicializar mes para carga histórica"` por si el usuario desea cargar datos pasados manualmente.

### 2.5 Reglas de Plantillas de Gastos Fijos vs. Instancias Mensuales
- **Editar una plantilla de gasto fijo (nombre, categoría, monto por defecto o día de vencimiento):**
  - Actualiza la plantilla en `fixed_expense_templates` (impacta en todos los meses futuros).
  - En el **mes actual en curso**, actualiza automáticamente la instancia en `monthly_commitments` **únicamente si aún está pendiente (`is_paid = false`)**. Si ya fue marcada como `Pagado` (`is_paid = true`), no se modifica para preservar el registro exacto de lo que se pagó.
  - Los meses pasados jamás se modifican.
- **Pausar / Eliminar una plantilla de gasto fijo (`is_active = false`):**
  - La plantilla deja de generar instancias en los meses futuros.
  - Si en el **mes actual** existe una instancia de esa plantilla que todavía está en estado `Pendiente` (`is_paid = false`), el sistema ofrece eliminarla del mes actual o conservarla por última vez. Las instancias de meses pasados o ya pagadas quedan intactas en el historial.
- **Ajuste puntual del mes:** El usuario también puede editar el monto de un gasto fijo **solo para el mes actual** (por ejemplo, una factura de luz que vino más cara este mes) directamente sobre la instancia de `monthly_commitments`, sin cambiar el monto base de la plantilla.

### 2.6 Reglas de Compras en Cuotas (`installment_purchases`)
- **Creación:**
  - El usuario ingresa: `Descripción`, `Categoría` (de tipo `expense`), `Fecha de compra`, `Fecha de la 1.ª cuota` (define en qué mes empieza a descontarse y el día de vencimiento mensual), `Cantidad de cuotas (N)` y `Monto por cuota`.
  - El monto total financiado se calcula como $\text{Monto Total} = \text{Monto por Cuota} \times N$.
  - Se crea el registro padre en `installment_purchases` y se insertan automáticamente las $N$ filas en `monthly_commitments` (`Cuota 1/N`, `Cuota 2/N`, ..., `Cuota N/N`), cada una asignada al mes consecutivo a partir del mes de la `Fecha de la 1.ª cuota`.
- **Edición:**
  - Editar **descripción, notas o categoría** actualiza la compra padre y todas sus cuotas asociadas.
  - Editar **monto por cuota, cantidad de cuotas o fecha de inicio**:
    - Si **ninguna cuota fue pagada aún**, se recalculan y regeneran limpiamente las $N$ cuotas.
    - Si **ya existen cuotas marcadas como `Pagado`**, las cuotas pagadas se preservan inmutables (para no alterar cierres de meses cerrados) y el nuevo monto por cuota se aplica a las cuotas que aún están en estado `Pendiente`.
- **Anulación (Eliminación):**
  - Al anular una compra en cuotas, se elimina el registro padre en `installment_purchases` y, mediante `ON DELETE CASCADE`, PostgreSQL elimina automáticamente todas las cuotas asociadas en `monthly_commitments`.
  - Si la compra tenía cuotas ya marcadas como `Pagado`, el modal de confirmación advierte explícitamente al usuario que también se eliminarán del historial de esos meses antes de confirmar.

### 2.7 Reglas de Ahorros y Aislamiento de la Bóveda (`savings_entries`)
- **Ahorro mensual automático (`monthly_savings_target`):**
  - El usuario configura en `/settings` cuánto dinero desea apartar por mes para ahorrar (por defecto `$0,00`).
  - Al inicializar el mes, ese monto se congela en `monthly_budgets.monthly_savings_target` y se resta automáticamente del `Disponible Real` desde el día 1.
- **Aportes extras y retiros en la Bóveda (`/savings`):**
  - Si durante el mes el usuario decide guardar dinero adicional desde su disponible, registra un **Aporte a Ahorro** (`deposit`), que descuenta ese monto del `Disponible Real` del mes y lo suma a la Bóveda de Ahorros.
  - Si necesita usar dinero guardado en una emergencia, registra un **Retiro de Ahorro** (`withdrawal`), que descuenta saldo de la Bóveda de Ahorros (validando que no exceda el acumulado). Si desea que ese dinero vuelva a estar gastable en el mes, puede registrarlo adicionalmente o elegir `"Acreditar al Disponible del mes"` (creando un ingreso compensatorio o reduciendo el retiro según corresponda). Por defecto, un retiro de ahorro sale de la Bóveda sin inflar silenciosamente el `Disponible Real` mensual a menos que el usuario lo indique.
- **Regla de Invisibilidad en el Dashboard:**
  - El **Saldo Acumulado de la Bóveda de Ahorros** (suma histórica de todos los ahorros mensuales congelados en meses inicializados + aportes extras - retiros) **no se muestra en el Dashboard principal** ni junto al `Disponible Real`.
  - Solo es visible ingresando a la ruta dedicada `/savings` (donde incluso inicia con opción de ocultar/mostrar el monto total por privacidad).

---

## 3. Historias de Usuario y Flujos Principales (*Happy Path*)

### Módulo 1: Autenticación y Gestión de Usuarios

#### US-1.1 — Inicio de sesión privado
- **Como** usuario registrado de SB-Finance,
- **Quiero** iniciar sesión con mi correo y contraseña,
- **Para** acceder de forma privada exclusivamente a mi información financiera.
- **Flujo principal:**
  1. El usuario accede a `/login`. No existe enlace ni pantalla pública de registro.
  2. Ingresa su `email` y `password` y presiona `"Ingresar a mi cuenta"`.
  3. El sistema valida credenciales contra Supabase Auth, establece la sesión y redirige a `/` (Dashboard).

#### US-1.2 — Alta de nuevos usuarios por el Administrador
- **Como** administrador del sistema (`is_admin = true`),
- **Quiero** dar de alta cuentas para personas cercanas desde un apartado privado en Configuraciones (o desde el panel de Supabase),
- **Para** habilitarles acceso sin abrir un registro público en internet.
- **Flujo principal:**
  1. El usuario con `is_admin = true` entra a `/settings`.
  2. Visualiza la sección exclusiva **"Administración de Usuarios"** (oculta para cualquier usuario con `is_admin = false`).
  3. Completa el formulario con `Email del nuevo usuario` y `Contraseña inicial` (mínimo 8 caracteres) y presiona `"Crear usuario"`.
  4. El frontend invoca la Supabase Edge Function `admin-create-user` enviando el JWT del administrador; la función verifica en base de datos que `is_admin = true` y crea el usuario con `email_confirm: true`.
  5. El trigger de base de datos aprovisiona automáticamente la configuración inicial y las categorías por defecto del nuevo usuario.

---

### Módulo 2: Configuraciones y Presupuesto Mensual (`monthly_budgets`)

#### US-2.1 — Configuración de Sueldo Fijo, Ahorro Mensual y Límite de Gastos Fijos
- **Como** usuario autenticado,
- **Quiero** definir mi sueldo fijo mensual, el monto fijo mensual que quiero ahorrar y el tope máximo que acepto destinar a gastos fijos + cuotas,
- **Para** que la aplicación aparte automáticamente mis compromisos y mi ahorro desde el día 1 y me muestre mi Disponible Real real para gastar.
- **Flujo principal:**
  1. Al entrar por primera vez al Dashboard con valores en `$0`, el usuario ve un banner destacado: *"Configurá tu sueldo fijo, ahorro mensual y límite de gastos fijos para calcular tu Disponible Real"* con el botón `"Configurar valores"`.
  2. En `/settings`, ingresa su `Sueldo Fijo Mensual` (ej. `$ 1.200.000,00`), su `Ahorro Mensual Objetivo` (ej. `$ 200.000,00`) y su `Límite de Gastos Fijos + Cuotas` (ej. `$ 500.000,00`).
  3. Al guardar, se actualiza `user_settings` y el snapshot de `monthly_budgets` del mes actual, recalculando instantáneamente el Dashboard y mostrando notificación con `react-hot-toast`.

#### US-2.2 — Gestión de la Bóveda de Ahorros Aislada (`/savings`)
- **Como** usuario autenticado,
- **Quiero** enviar dinero extra a mis ahorros o consultar mi acumulado en una pantalla aparte que no se mezcle con mi Disponible Real,
- **Para** evitar ver mis ahorros como dinero disponible para gastar en el día a día.
- **Flujo principal:**
  1. El usuario accede a `/savings` desde el menú de navegación (`"Ahorros"`).
  2. Visualiza el aporte mensual automático reservado de sus meses activos, puede registrar un `"Aporte extra a ahorros"` (que se resta de inmediato del `Disponible Real` del mes actual) o un `"Retiro de ahorros"`, y consulta su historial de movimientos de ahorro.
  3. Al volver al Dashboard (`/`), el saldo acumulado de su bóveda de ahorros permanece oculto y separado del `Disponible Real`.

---

### Módulo 3: Categorías de Gastos e Ingresos

#### US-3.1 — Gestión y Borrado Lógico de Categorías
- **Como** usuario autenticado,
- **Quiero** contar con categorías iniciales y poder crear, editar o archivar categorías tanto de gastos (`expense`) como de ingresos (`income`),
- **Para** clasificar mis movimientos y compras en cuotas sin perder el historial cuando dejo de usar una categoría.
- **Categorías pre-generadas automáticamente al crear el usuario:**
  - **Gastos (`expense`):** *Comida y Supermercado*, *Transporte y Combustible*, *Servicios y Suscripciones*, *Vivienda y Alquiler*, *Ocio y Salidas*, *Salud y Farmacia*, *Educación*, *Compras e Indumentaria*, *Gastos Extra / Otros*.
  - **Ingresos (`income`):** *Ingresos Extra*, *Freelance / Trabajos*, *Ventas / Reintegros*.
- **Flujo principal:**
  1. En `/categories`, el usuario ve dos pestañas o columnas: **"Categorías de Gastos"** y **"Categorías de Ingresos"**.
  2. Puede crear una categoría indicando `Nombre` y `Tipo` (`Gasto` o `Ingreso`).
  3. Puede editar el nombre de cualquier categoría existente.
  4. Si presiona `"Archivar / Eliminar"` sobre una categoría, se marca como `is_active = false`: deja de aparecer en los selectores de nuevos gastos/ingresos, pero todos los movimientos pasados y gráficos históricos conservan su nombre. Desde la vista de *"Categorías archivadas"* puede restaurarla (`is_active = true`) en cualquier momento.

---

### Módulo 4: Gastos Fijos Recurrentes y Compras en Cuotas

#### US-4.1 — Gestión de Gastos Fijos Recurrentes
- **Como** usuario autenticado,
- **Quiero** mantener mi lista de gastos fijos mensuales y marcar cuáles ya pagué en el mes,
- **Para** que se descuenten automáticamente de mi Disponible Real desde el día 1 y llevar control de qué boletas aún debo abonar.
- **Flujo principal:**
  1. En `/commitments` (sección **Gastos Fijos**), el usuario crea un gasto fijo recurrente indicando `Nombre` (ej. *"Alquiler"*), `Categoría` (tipo `expense`), `Monto mensual` y `Día de vencimiento estimado` (opcional, 1 al 31).
  2. El sistema guarda la plantilla en `fixed_expense_templates` y crea de inmediato su instancia para el mes actual en `monthly_commitments` con estado `Pendiente`.
  3. Cuando el usuario abona ese gasto en la vida real, hace clic en `"Marcar como pagado"` sobre la fila del mes: el estado pasa a `Pagado` (registrando fecha de pago) y disminuye el indicador de **"Pendiente de Abonar"** del Dashboard.

#### US-4.2 — Registro, Edición y Anulación de Compras en Cuotas
- **Como** usuario autenticado,
- **Quiero** registrar una compra en cuotas indicando la fecha de la primera cuota, el monto por cuota y el número de cuotas, así como poder editarla o anularla,
- **Para** comprometer automáticamente ese gasto en cada uno de los meses futuros afectados.
- **Flujo principal:**
  1. En `/commitments` (o desde la acción rápida `"+ Nueva Compra en Cuotas"` del Dashboard), el usuario completa:
     - `Descripción` (ej. *"Monitor 27 pulgadas"*)
     - `Categoría` (obligatoria, tipo `expense`)
     - `Fecha de compra` (por defecto hoy)
     - `Fecha de 1.ª cuota` (fecha exacta en que vence/impacta la Cuota 1)
     - `Cantidad de cuotas` (ej. `6`)
     - `Monto por cuota` (ej. `$ 45.000,00`)
  2. El formulario muestra en vivo el **Monto Total (`$ 270.000,00`)**, el rango de meses que abarcará (ej. *Noviembre 2026 a Abril 2027*) y, si con esa cuota se supera el límite mensual de gastos fijos del mes de inicio, muestra una **alerta preventiva en rojo** antes de guardar.
  3. Al guardar, el sistema crea la compra padre y las 6 filas en `monthly_commitments` (`Monitor 27 pulgadas (1/6)` ... `(6/6)`).
  4. Si el usuario edita la compra, puede modificar descripción, categoría o monto de cuotas pendientes. Si decide **anularla**, confirma en el modal y se eliminan la compra padre y sus $N$ cuotas en cascada.

---

### Módulo 5: Movimientos Manuales (`transactions`)

#### US-5.1 — Registro de Gastos Variables e Ingresos Extra
- **Como** usuario autenticado,
- **Quiero** registrar mis gastos del día a día (`expense`) y mis ingresos adicionales fuera del sueldo (`income`),
- **Para** que mi Disponible Real refleje exactamente mi actividad financiera.
- **Flujo principal:**
  1. Desde el botón principal `"+ Nuevo Movimiento"` (accesible en el Dashboard y en `/transactions`), el usuario elige el tipo: **Gasto Variable (`expense`)** o **Ingreso Extra (`income`)**.
  2. El selector de `Categoría` (obligatorio) filtra automáticamente las categorías activas según el tipo elegido (ej. si eligió `Ingreso Extra`, muestra *Ingresos Extra*, *Freelance / Trabajos*, etc., preseleccionando *Ingresos Extra* por defecto).
  3. Ingresa `Monto`, `Descripción breve`, `Fecha` (por defecto hoy, formato local `YYYY-MM-DD`) y `Nota` opcional.
  4. Al guardar, el registro impacta inmediatamente en el `Disponible Real`, los gráficos y el listado del mes correspondiente.

---

### Módulo 6: Dashboard Principal, Gráficos e Historial Mensual

#### US-6.1 — Visualización del Dashboard e Historial por Mes
- **Como** usuario autenticado,
- **Quiero** ver en una sola pantalla el resumen financiero del mes seleccionado, gráficos claros y la lista filtrable de movimientos y compromisos,
- **Para** tomar decisiones rápidas sobre cuánto dinero puedo gastar hoy y comparar mi desempeño con meses anteriores.
- **Componentes del Dashboard:**
  1. **Selector de Período Mensual (`< Noviembre 2026 >`):** Permite navegar a meses anteriores (viendo cierres históricos congelados) o meses futuros (viendo la proyección de gastos fijos + cuotas ya comprometidas).
  2. **Fila de KPIs Principales:**
     - **Disponible Real del Mes:** Cifra protagonista de mayor jerarquía tipográfica (verde si `> 0`, rojo si `< 0`).
     - **Ingresos del Mes:** Total (`Sueldo Fijo + Ingresos Extra`) con desglose de ambos.
     - **Comprometido (Fijos + Cuotas) vs. Límite:** Total apartado desde el día 1 comparado contra el `Límite de Gastos Fijos`, con barra de progreso y alerta roja si excede el 100%.
     - **Pendiente de Abonar este Mes:** Suma de los gastos fijos y cuotas del mes que aún están en estado `Pendiente` (y contador ej. *"3 de 7 compromisos pendientes"*).
     - **Gastos Variables del Mes:** Suma acumulada de gastos diarios del mes.
  3. **Sección de Gráficos (Recharts):**
     - **Distribución de Gastos por Categoría (Dona):** Incluye gastos variables + compromisos del mes agrupados por categoría.
     - **Balance del Mes (Barras):** Comparativa visual entre `Ingresos Totales`, `Fijos + Cuotas`, `Gastos Variables` y `Disponible Real`.
     - **Evolución de los últimos 6 meses (Barras agrupadas):** Comparativa mes a mes de `Ingresos` vs. `Gastos Totales (Fijos + Cuotas + Variables)`.
  4. **Panel de Compromisos del Mes + Listado de Movimientos con Filtros Dinámicos:**
     - Checklist rápido de compromisos del mes para tildar `Pagado` / `Pendiente` sin salir del Dashboard.
     - Tabla/lista de movimientos con filtros instantáneos por: `Búsqueda por texto`, `Tipo (Todos | Gastos | Ingresos)`, `Categoría` y `Rango de fechas`.

---

## 4. Casos Borde (*Edge Cases*), Validaciones y Manejo de Errores

| Caso / Escenario | Regla de Validación y Comportamiento del Sistema |
| :--- | :--- |
| **Usuario recién creado (`fixed_salary = 0`)** | Entra directo al Dashboard sin bloqueo. Se muestra un banner destacado amarillo/negro en la parte superior para configurar Sueldo Fijo y Límite. Si aún no los configura y carga gastos, el `Disponible Real` se mostrará en negativo (color rojo semántico) sin errores de división por cero. |
| **División por cero en % de Límite de Gastos Fijos** | Si `fixed_expenses_limit = 0`, el porcentaje de uso del límite no divide por cero: muestra `"Límite sin configurar"` e invita a definirlo. |
| **Superación del Límite de Gastos Fijos + Cuotas** | Si `Fijos + Cuotas > fixed_expenses_limit`, el sistema **permite guardar** el registro, muestra un `toast` informativo de advertencia y pinta el indicador/barra del límite en rojo semántico (`#EF4444`) indicando el monto excedido. |
| **Fechas de compras en cuotas en fin de mes (ej. 31 de enero)** | Al sumar meses en PostgreSQL (`first_installment_date + (i - 1) * INTERVAL '1 month'`), PostgreSQL ajusta automáticamente al último día válido del mes siguiente (ej. `2026-01-31 + 1 month` $\rightarrow$ `2026-02-28`, `2026-01-31 + 2 months` $\rightarrow$ `2026-03-31`), evitando fechas inválidas. |
| **Anulación de compra en cuotas con cuotas ya pagadas** | El sistema detecta cuántas cuotas tienen `is_paid = true` y muestra un aviso explícito en el modal de confirmación: *"Esta compra tiene X cuota(s) ya marcada(s) como pagada(s). Si la anulás, se eliminarán todas las cuotas del historial. ¿Confirmás la anulación?"*. |
| **Borrado de categoría en uso** | Nunca se ejecuta `DELETE` físico si tiene registros o si el usuario elige archivarla: se actualiza `is_active = false`. Los formularios de alta solo listan categorías con `is_active = true`, pero al editar un movimiento antiguo cuya categoría fue archivada, esa categoría se incluye en el selector como `"(Archivada)"` para no forzar un cambio involuntario. |
| **Doble clic o concurrencia al inicializar un mes** | La función `ensure_monthly_period` utiliza `ON CONFLICT DO NOTHING` respaldado por restricciones `UNIQUE` en base de datos, evitando que dos pestañas abiertas generen doble snapshot o duplicados de gastos fijos. |
| **Montos inválidos o fuera de rango** | Validación `zod` y `CHECK` en SQL: todos los montos de transacciones, cuotas y plantillas deben ser `>= 0.01` (`$ 0,01`) y `<= 9999999999.99` (`NUMERIC(12,2)`). En compras en cuotas, el monto total financiado (`installment_amount * installments_count`) también debe ser `<= 9999999999.99`. En configuraciones (`fixed_salary`, `fixed_expenses_limit`) se permite `>= 0`. |
| **Errores de red o de Supabase** | Todo botón de escritura se deshabilita durante la petición (`isLoading = true`) mostrando estado visual de carga y dispara un `toast.error(...)` claro en español si la operación falla, manteniendo los datos del formulario para que el usuario no pierda lo que escribió. |

---

## 5. Criterios de Aceptación Verificables (*Dado / Cuando / Entonces*)

### CA-01: Privacidad RLS y Autenticación sin registro público
- **Dado** un visitante no autenticado que navega a la aplicación,
- **Cuando** intenta acceder a cualquier ruta privada (`/`, `/transactions`, `/commitments`, `/categories`, `/settings`),
- **Entonces** es redirigido inmediatamente a `/login`, donde no existe opción de registro público, y cualquier consulta directa a las tablas de Supabase sin sesión o con otro `auth.uid()` devuelve `0` filas gracias a las políticas RLS.

### CA-02: Aprovisionamiento inicial y Banner de Configuración en `$0`
- **Dado** un nuevo usuario recién dado de alta en Supabase Auth,
- **Cuando** inicia sesión por primera vez,
- **Entonces** tiene creadas automáticamente sus categorías base de gastos (`Comida`, `Transporte`, `Servicios`, `Gastos Extra / Otros`, etc.) y de ingresos (`Ingresos Extra`, `Freelance / Trabajos`, etc.), su configuración inicia en `$ 0,00`, y el Dashboard muestra el banner visible de configuración inicial.

### CA-03: Inmutabilidad histórica de Snapshots (`monthly_budgets`)
- **Dado** que un usuario tenía en Octubre un sueldo fijo de `$ 1.000.000,00` registrado en su snapshot de Octubre,
- **Cuando** en Noviembre actualiza su sueldo fijo en Configuraciones a `$ 1.300.000,00`,
- **Entonces** el Dashboard de Noviembre muestra `$ 1.300.000,00`, pero al cambiar el selector de mes a Octubre, el sueldo fijo de Octubre continúa siendo exactamente `$ 1.000.000,00`.

### CA-04: Pre-generación, Apartado desde el Día 1 y Anulación en Cascada de Cuotas
- **Dado** que el usuario tiene un sueldo fijo de `$ 1.000.000,00` y `$ 0,00` de otros gastos en Noviembre 2026,
- **Cuando** registra una compra en cuotas con `Fecha de 1.ª cuota = 2026-11-15`, `Cantidad de cuotas = 3` y `Monto por cuota = $ 50.000,00`,
- **Entonces** se crean 3 compromisos mensuales (`Noviembre 2026`, `Diciembre 2026`, `Enero 2027`) por `$ 50.000,00` cada uno en estado `Pendiente`; el `Disponible Real` de Noviembre baja inmediatamente a `$ 950.000,00` y el indicador `Pendiente de Abonar` sube a `$ 50.000,00`.
- **Y cuando** el usuario anula esa compra padre, las 3 cuotas desaparecen automáticamente de los 3 meses y el `Disponible Real` de Noviembre vuelve a `$ 1.000.000,00`.

### CA-05: Estado Pagado vs. Pendiente no altera el Disponible Real pero sí el Pendiente de Abonar
- **Dado** un compromiso mensual (gasto fijo o cuota) de `$ 80.000,00` en estado `Pendiente` en el mes actual,
- **Cuando** el usuario lo marca como `Pagado`,
- **Entonces** el `Disponible Real` del mes **no cambia** (porque ya estaba apartado desde el día 1), mientras que el indicador `Pendiente de Abonar` disminuye en `$ 80.000,00`.

### CA-06: Alerta preventiva no bloqueante al superar el Límite de Gastos Fijos
- **Dado** que el usuario configuró un `Límite de Gastos Fijos + Cuotas` de `$ 300.000,00` y ya tiene `$ 280.000,00` comprometidos en el mes,
- **Cuando** agrega una nueva cuota o gasto fijo de `$ 50.000,00` (total `$ 330.000,00`),
- **Entonces** el sistema guarda el registro sin bloquearlo y muestra la alerta visual en rojo indicando que superó su límite en `$ 30.000,00` (`110%`).

### CA-07: Borrado lógico de Categorías y Categorías de Ingresos/Gastos
- **Dado** que una categoría `"Ocio y Salidas"` tiene gastos registrados en el mes pasado,
- **Cuando** el usuario la elimina/archiva desde `/categories`,
- **Entonces** `"Ocio y Salidas"` ya no aparece en el desplegable al crear un nuevo gasto, pero al consultar el Dashboard y movimientos del mes pasado, los gastos de `"Ocio y Salidas"` siguen mostrando su categoría correctamente.

### CA-08: Descuento automático y aislamiento visual de Ahorros
- **Dado** que un usuario tiene un sueldo fijo de `$ 1.000.000,00`, `$ 0,00` en gastos y configura un `Ahorro Mensual Objetivo` de `$ 200.000,00`,
- **Cuando** accede al Dashboard del mes actual y luego registra un `Aporte extra a ahorros` de `$ 50.000,00` desde `/savings`,
- **Entonces** su `Disponible Real` en el Dashboard pasa a `$ 750.000,00`, y en el Dashboard principal **no se muestra** el saldo acumulado total de su Bóveda de Ahorros (`$ 250.000,00`), el cual solo puede verse ingresando a `/savings`.
