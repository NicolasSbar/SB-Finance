# Product Roadmap — SB-Finance

> **Propósito:** Aplicación web de gestión de finanzas personales para uso propio y de personas cercanas (no comercial). Cada usuario tiene su cuenta totalmente privada. Enfocada en la baja fricción (registro por Telegram en texto o audio con IA), claridad del dinero realmente disponible (sueldo fijo menos gastos fijos y cuotas apartadas) y toma de decisiones (matriz de prioridad y simulador de gastos).

---

## 1. Mapa de Módulos Principales

### Módulo 1: Autenticación, Perfil y Privacidad
- Registro e inicio de sesión con Supabase Auth.
- Aislamiento total: cada usuario ve únicamente sus propios datos (`user_id = auth.uid()`).
- **Gestión de Perfil y Seguridad (Fase 4):** Todos los usuarios registrados pueden editar sus propios datos personales en la tabla `profiles` (**nombre de usuario**, **foto de perfil** almacenada en Supabase Storage) y realizar **cambio de contraseña** (vía Supabase Auth).
- **Control de acceso (Fase 4):** El alta de nuevos usuarios y la asignación de permisos pasa a ser exclusiva del administrador desde el Módulo 12 (registro público deshabilitado).

### Módulo 2: Configuraciones del Usuario y Snapshots Mensuales
- **Sueldo fijo mensual, ahorro mensual, límite de gastos fijos y día de cobro:** El usuario define su ingreso base mensual, el monto fijo mensual que desea destinar a **ahorros**, el tope máximo que está dispuesto a comprometer en gastos fijos + cuotas y su día de cobro habitual (**último día hábil del mes** lun–vie con `salary_payday = 0`, o un **día fijo del 1 al 31**).
- **Inmutabilidad histórica (Snapshots mensuales):** Al iniciar cada mes (o al registrar movimientos en un mes), se congela un registro mensual (`monthly_budgets`) con el sueldo fijo, el ahorro mensual objetivo y el límite de gastos fijos vigentes para ese mes. Si en el futuro el usuario recibe un aumento o cambia sus metas, los cierres de meses anteriores permanecen intactos.
- **Vinculación multi-usuario con Telegram (en `/settings` — Fase 2):** Cualquier usuario registrado en la plataforma cuenta con un apartado en Configuraciones para vincular su propia cuenta de Telegram mediante un código/token único temporal (ej. enviando `/vincular <codigo>` al bot). El sistema guarda la relación `user_id ↔ telegram_chat_id` para que el bot identifique automáticamente a cada persona y le envíe sus confirmaciones y alertas a su chat privado.

### Módulo 3: Gastos Fijos Mensuales y Compras en Cuotas
- **Gastos fijos recurrentes (Plantilla + Instancias mensuales):** El usuario mantiene una lista de gastos recurrentes obligatorios (alquiler, servicios, suscripciones). Cada mes se generan sus instancias individuales en la tabla de **compromisos mensuales** con el monto vigente de ese mes, preservando el historial pasado ante futuros aumentos o bajas.
- **Compras en cuotas (Arquitectura de Compromisos Pre-generados):**
  - Al registrar una compra financiada (ej. *"6 cuotas de \$30.000"*), se guarda el registro de la **compra padre** y se **pre-generan las `N` filas individuales** correspondientes en la tabla de **compromisos mensuales** (`Cuota 1/6`, `2/6`, ..., `6/6` con su respectivo mes/fecha) vinculadas con `ON DELETE CASCADE`.
- **Lógica de negocio (Reglas actualizadas en Fase 3):**
  - Desde el día 1 de cada mes, el sistema aparta únicamente el **límite máximo configurado para gastos fijos** (`max(fixed_expenses_limit, fijos + cuotas no-Gustito + trasladado)`) y el **ahorro mensual objetivo**. Cuando faltan **3 días o menos para terminar el mes** y queda sobrante sin usar en el límite de gastos fijos, el Dashboard y el bot de Telegram avisan para revisar gastos olvidados y enviar el sobrante a ahorros o liberarlo al Disponible Real (con acceso manual discreto dentro de la tarjeta de Comprometido/Fijos).
  - **Separación de cuotas de Gustitos:** Las cuotas cuya categoría pertenezca a **Gustitos** (o estén marcadas como `is_gustito`) **no** impactan ni consumen el límite de gastos fijos (`Comprometido`); se descuentan únicamente del presupuesto de la **Bolsa de Gustitos** mes a mes hasta finalizar las cuotas, pero **sí** permanecen visibles en la lista de **Pendiente de Abonar** para poder marcarlas como pagadas.
  - **Pago múltiple / adelanto de `N` cuotas (Fase 3):** Tanto en la web como vía Telegram (texto o audio, ej. *"Pagué dos cuotas de las zapatillas por un total de $65.000"*), el usuario puede abonar `N` cuotas pendientes juntas en el mes actual. Las cuotas adelantadas se **trasladan contablemente al mes actual** (`month_date` del período en curso) marcadas como pagadas, descontándose del cupo correspondiente de este mes (Gustitos o Fijos) y liberando los meses futuros. Si se indica un monto total `$X` distinto al original, se actualiza el monto de esas `N` cuotas a `$X / N` (ajustando centavos en la última).

### Módulo 4: Movimientos (Gastos Variables e Ingresos Extra)
- Registro manual desde la web y automático desde Telegram.
- **Tipos:**
  - `expense`: Gastos del día a día.
  - `income`: Ingresos adicionales fuera del sueldo fijo (ej. trabajos freelance, ventas), con opción de **acreditarlos directamente a la Bóveda de Ahorros** (`save_to_savings = true`) tanto desde la web como desde Telegram para que sumen al ahorro acumulado sin inflar el `Disponible Real` gastable del mes.
- **Campos:** monto, tipo, categoría, fecha, nota opcional, origen (`web` | `telegram`), marca de gustito (`is_gustito` en gastos) y marca de ahorro directo (`save_to_savings` en ingresos extra).

### Módulo 5: Bot de Telegram + IA Ligera (Texto, Audio, Deshacer y Alertas)
- **Entrada multimodal:** El usuario envía **texto o notas de voz (audio)** en lenguaje natural (ej. *"gasté 15.000 en comida"*, *"cobré 40.000 de un freelance y mandalo directo a ahorros"*, *"compré unas zapatillas en 6 cuotas de 30.000"*, *"pagué dos cuotas de las zapatillas por un total de 60.000"* o *"puse un plazo fijo de 100.000 a 30 días y recibo 103.500"*).
- **Acuse de recibo inmediato:** Apenas el bot recibe un mensaje de texto o audio válido para procesar, envía un primer mensaje instantáneo (`"⏳ Mensaje recibido, estamos procesando la transacción..."`) para dar feedback inmediato al usuario mientras la IA analiza la petición, y luego envía un segundo mensaje separado con el resultado final.
- **Cola de resiliencia ante alta demanda de IA (`503`):** Si Gemini presenta saturación temporal (`503` / `429` / `5xx` o timeout) tras un reintento rápido, el bot guarda los datos recolectados de la solicitud (texto o audio descargado y fecha local original) en una cola persistente (`telegram_pending_requests`), avisa al usuario que quedó en espera con un mensaje claro y la procesa automáticamente en segundo plano vía `pg_cron` (con *backoff* exponencial hasta 2 horas), enviando la confirmación en el chat apenas se restablezca el servicio.
- **Procesamiento:** Una **Supabase Edge Function** (en Deno) recibe el webhook de Telegram, identifica al usuario, descarga el audio (si es voz) o toma el texto, y usa una IA multimodal ligera para extraer la intención (`expense`, `income`, `installment_purchase`, `pay_installments`, `fixed_term_deposit`) y sus datos (incluyendo si un ingreso extra debe enviarse directo a la Bóveda de Ahorros, o la cantidad/monto total de cuotas adelantadas).
- **Confirmación enriquecida con saldo restante y botón `[❌ Anular]`:** Cada vez que el usuario registra un movimiento vía Telegram, el segundo mensaje del bot incluye:
  1. Confirmación del movimiento registrado (monto, categoría y, si es un ingreso enviado a ahorros, aviso de que se destinó directamente a la Bóveda de Ahorros).
  2. **Saldo restante disponible** de la bolsa de **"Gustitos"** (si la categoría pertenece a esa bolsa) y/o del límite individual de la categoría utilizada (ej. *"Gasto registrado: $15.000 en Comida. Te quedan $12.000 disponibles para Gustitos/Ocio este mes"*).
  3. Un botón inline (`[❌ Anular]`) para eliminar el registro al instante si la IA interpretó mal un monto o categoría (si el ingreso se había enviado directo a ahorros, anula tanto el ingreso como el aporte en la Bóveda de Ahorros).
- **Alertas proactivas y en tiempo real:** El bot notifica automáticamente al usuario:
  - **En tiempo real (inmediato):** Apenas un gasto (cargado desde la web o desde Telegram) hace que el saldo restante de la **barra de "Gustitos"** llegue a **`$0` o negativo**, enviando una alerta inmediata al chat del usuario.
  - **Diarias (vía `pg_cron` + `pg_net`):**
    - Cuando se acerca o supera el límite individual de una categoría.
    - Cuando se acerca o supera el límite mensual de gastos fijos + cuotas.
    - Cuando está próximo a vencer un plazo fijo.
    - Cuando quedan gastos fijos o cuotas sin marcar como pagados cerca del fin de mes.
    - Cuando faltan **3 días o menos para terminar el mes** y hay sobrante sin usar en el límite de **Gastos Fijos** sin revisión de cierre completada.

### Módulo 6: Categorías, Bolsa de "Gustitos" y Límites de Gasto
- Categorías personalizables de Gastos (`expense`) e Ingresos (`income`), con borrado lógico para preservar el historial.
- **Bolsa compartida de "Gustitos" (Presupuesto discrecional dentro del Disponible Real):**
  - El usuario define un **Presupuesto mensual para Gustitos** como tope de control y marca qué categorías pertenecen a esa bolsa (ej. *Comida / Delivery*, *Ocio y Salidas*, *Gastos Hormiga*, *Compras*).
  - **Integración con el Disponible Real:** El presupuesto de Gustitos **no se resta por adelantado** del `Disponible Real` (permanece visible como parte del dinero disponible del mes); al registrar un gasto o cuota marcada como Gustito, se descuenta simultáneamente del margen restante de la Bolsa de Gustitos y del `Disponible Real`.
  - **Barra de progreso creciente (unificada en Fase 3):** Se llena progresivamente de `0%` a `100%` (igual que la barra de *Comprometido*), mostrando en grande el monto **Gastado**, el **Presupuesto** asignado y el saldo restante. Al alcanzar o superar el **`100%`** (`gastado >= presupuesto`), la barra y los indicadores quedan marcados en **rojo semántico (`#EF4444`)** y disparan la alerta en tiempo real por Telegram.
- Posibilidad de definir además un **monto máximo mensual** individual por categoría con indicador visual de progreso.

### Módulo 7: Matriz de Prioridad Interactiva (Futuras Compras)
- Matriz cartesiana 2×2 con ejes visuales explícitos (**Impacto** en el eje Y lateral izquierdo y **Costo** en el eje X inferior) y marcas de agua translúcidas con el nombre de acción de cada cuadrante.
- Tarjetas compactas arrastrables (`título + costo estimado`) mediante **HTML5 Drag & Drop nativo** (y pestañas/selectores accesibles en móvil); al hacer click en cualquier tarjeta se abre un modal unificado para **Comprar** (permitiendo ajustar el **monto real pagado** al contado o en cuotas y eliminando la tarjeta atómicamente), **Editar** o **Eliminar**.

### Módulo 8: Dashboard, Gráficos e Historial Mensual
- **Fórmula central (actualizada en Fase 3):**
  `Disponible Real = (Sueldo Fijo + Ingresos Extra + Retornos de Plazo Fijo acreditados al mes) - max(Límite Gastos Fijos, Fijos + Cuotas No-Gustito + Sobrante Fijos Trasladado) - (Ahorro Mensual Apartado + Aportes a Ahorros del Mes) - Gastos Variables No-Gustito - (Gastado en Gustitos del Mes + Sobrante Gustitos Trasladado) - Plazos Fijos constituidos desde Disponible del Mes`.
  *(Nota: El Límite máximo de Gastos Fijos y el Ahorro Mensual se apartan desde el día 1 del mes; el presupuesto de Gustitos vive dentro del Disponible Real y descuenta únicamente a medida que se gasta realmente. Las cuotas de Gustitos solo consumen la bolsa de Gustitos, nunca el límite de Fijos).*
- **Aislamiento visual estricto (Ahorros y Plazos Fijos ocultos):** Todo el dinero destinado a **Ahorros** (aunque permanezca líquido y disponible en la cuenta del usuario) y todo el capital inmovilizado en **Plazos Fijos** se **restan automáticamente y no son visibles ni se suman** en el `Disponible Real` del Dashboard principal. Su saldo acumulado se consulta únicamente en sus vistas dedicadas (`/savings` y sección de Plazos Fijos).
- **Arquitectura visual ejecutiva mínima + sub-pestañas (Fase 3):**
  - Para evitar saturación visual, la cabecera principal del Dashboard muestra únicamente la vista ejecutiva mínima: selector de mes, acciones rápidas (`+ Movimiento`, `+ Cuota`), KPI protagonista **Disponible Real**, resumen compacto de ingresos/ahorro/apartados y las dos barras consistentes (`0% → 100%`) de **Comprometido (Fijos + Cuotas no-Gustito)** y **Bolsa de Gustitos**.
  - El resto del detalle operativo se organiza en **sub-pestañas internas** dentro del Dashboard (`Resumen y Gráficos` | `Pendientes de Pago` | `Movimientos del Mes`), manteniendo sus vistas dedicadas completas en `/transactions`, `/commitments` y `/categories`.
- **Gráficos interactivos:**
  - **Gráfico de torta / dona:** Distribución porcentual de gastos por categoría.
  - **Gráfico de barras:** Comparativa de ingresos vs. gastos, gastos por categoría contra su límite, y evolución mensual.
- **Filtros dinámicos:** Filtrado rápido por **categoría**, **mes/rango de fechas**, **tipo de movimiento** (`expense` | `income`) y búsqueda por texto.
- **Historial y comparativa:** Selector de meses anteriores para revisar cierres pasados y comparar gastos mes a mes.

### Módulo 9: Simulador de Gastos ("¿Qué pasa si...?")
- Herramienta interactiva en el frontend (sin guardar datos en la base) para probar gastos hipotéticos (al contado o en cuotas).
- Muestra en tiempo real cómo quedarían el **Disponible Real**, el **límite de gastos fijos** (si es en cuotas) y el saldo de la **categoría** afectada.

### Módulo 10: Ahorros y Plazos Fijos (Bóveda Aislada)
- **Modelo de 2 orígenes:** El usuario mantiene separado su **Disponible Real del Mes** de su **Bóveda de Ahorro Acumulado** (`savings_fund`, dinero guardado de meses anteriores o apartado mensualmente para ahorrar, oculto del saldo disponible real desde Fase 1).
- **Registro de Plazos Fijos (Fase 3):** Incluye **fecha de inicio**, **fecha de vencimiento**, **monto invertido**, **monto a recibir** y **origen del capital** (`monthly_available` | `savings_fund`).
  - Si sale de `monthly_available`, se descuenta automáticamente del **Disponible Real** del mes actual y deja de ser visible en el saldo gastable.
  - Si sale de `savings_fund`, no afecta el **Disponible Real** del mes; solo mueve saldo de ahorro líquido a capital invertido dentro de la bóveda aislada.
- **Vencimiento:** Al vencer, el usuario define si el capital + interés se acredita al **Fondo de Ahorro** (por defecto, permaneciendo oculto del Disponible Real) o entra explícitamente al **Disponible Real del Mes**.
- Puede cargarse desde la web o vía Telegram (texto/audio) y muestra claramente en su vista dedicada cuánto dinero está inmovilizado y cuándo se libera.

### Módulo 11: Asistente de Distribución de Presupuesto (IA)
- Ejecutado desde una **Supabase Edge Function** (reutilizando Gemini Flash con reintento automático y modelo fallback ante alta demanda `503`).
- Analiza el **sueldo fijo**, los **gastos fijos + cuotas comprometidas**, las **categorías** existentes, el **historial de gastos**, la **Matriz de Prioridad (`priority_items`)** y el **saldo líquido de la Bóveda de Ahorros**, aceptando consultas por **texto (hasta 500 caracteres) o audio grabado con micrófono (hasta 60 segundos)**.
- Sugiere en formato estructurado (JSON) una distribución recomendada por categoría y ahorro —incluyendo planes en $X$ meses para compras de la matriz dentro del resumen principal—, con opción de **"Aplicar límites sugeridos"** en un clic (incluyendo aviso de que es una guía orientativa, no asesoramiento financiero profesional).

### Módulo 12: Panel de Administración y Control de Acceso (RBAC)
- **Administrador inicial:** El usuario creador del sistema inicia como único administrador (`role = 'admin'`).
- **Alta manual exclusiva:** Se deshabilita el registro abierto; únicamente un administrador puede dar de alta nuevos usuarios manualmente (creando sus credenciales iniciales desde una **Supabase Edge Function**).
- **Gestión de permisos y roles:** El administrador puede consultar el listado de usuarios dados de alta (email, nombre de usuario, rol/permisos actuales, fecha de alta y último acceso) y **asignar o revocar el rol de administrador** a otros usuarios.
- **Privacidad mantenida:** El panel administrativo gestiona acceso y roles, pero no expone los movimientos, saldos ni ahorros privados de los demás usuarios.

---

## 2. Roadmap de Construcción (Por Fases)

Para construir de forma ordenada y tener una versión usable rápido:

- **Fase 1 (Core MVP):** Autenticación + Configuraciones (sueldo fijo, ahorro mensual apartado, límite de fijos y snapshots mensuales) + Bóveda de Ahorros aislada (descontada y oculta del Disponible Real) + CRUD básico de Categorías (Gastos e Ingresos) + Gastos Fijos y Compromisos de Cuotas pre-generados + Movimientos manuales + Dashboard (gráficos/filtros) e Historial mensual.
- **Fase 2 (Automatización e Inteligencia):** Vinculación multi-usuario de Telegram en `/settings` + Bolsa compartida de **"Gustitos"** con barra regresiva (alerta visual en rojo al llegar a `$0`) + Límites mensuales por categoría + Bot de Telegram con IA (texto y audio) con respuesta inmediata del saldo restante tras cada gasto + Botón `[❌ Anular]` + Alertas en tiempo real (cuando Gustitos llega a `$0`) y proactivas diarias (`pg_cron` + `pg_net`).
- **Fase 3 (Herramientas de Decisión, Inversiones y Refinamiento Core):**
  - **Refinamiento financiero y UX:** Fórmula de Disponible Real con apartado automático del límite de gastos fijos + ahorros (manteniendo el presupuesto de Gustitos dentro del Disponible Real y descontándolo al gastarse); día de cobro configurable (`último día hábil` o `1..31`); revisión de cierre de gastos fijos a `<= 3` días de fin de mes (web + Telegram); exclusión de cuotas de Gustitos del límite de fijos; pago múltiple/adelanto de `N` cuotas (web y Telegram texto/audio); barra creciente (`0% → 100%`) unificada en Bolsa de Gustitos; y refactorización visual del Dashboard (vista ejecutiva mínima + sub-pestañas internas).
  - **Nuevos módulos:** Matriz de prioridad interactiva + Simulador de gastos + Plazos fijos (conectados a la Bóveda de Ahorros y ocultos del Disponible Real, con carga web y Telegram + alertas cron) + Asistente de Distribución de Presupuesto con IA.
- **Fase 4 (Perfil, Seguridad de Cuenta y Administración RBAC):** Tabla `profiles` (reemplazando/migrando `is_admin` hacia `role`), bucket privado `avatars` en Supabase Storage (URLs firmadas), edición de perfil y cambio de contraseña para todos los usuarios, deshabilitación de registro público, Panel de Administración (`/admin`) exclusivo para `role = 'admin'` y Edge Functions de administración (`admin-create-user`, `admin-list-users`, `admin-update-user`). Spec técnica previa disponible en `specs/fase-4-admin-profiles/02-tech-spec.md`.

---

## Decisiones de Arquitectura
- **Pre-generación de cuotas en compromisos mensuales:** En lugar de calcular cuotas al vuelo en el frontend o crear lógica compleja por cada consulta, guardar la compra padre y pre-generar las `N` filas mensuales permite que el cálculo del disponible real de cualquier mes (pasado, actual o futuro) sea una simple suma (`SUM`) en SQL. Además, garantiza que el historial de meses pasados permanezca exacto aunque en el futuro cambie el sueldo fijo o se agreguen nuevos gastos.
