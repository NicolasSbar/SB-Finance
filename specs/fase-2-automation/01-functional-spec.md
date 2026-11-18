# Especificación Funcional — Fase 2 (Automatización e Inteligencia) — SB-Finance

> **Versión:** 1.0.0  
> **Estado:** Aprobado para implementación  
> **Documentos base:** `specs/constitution.md`, `specs/product_roadmap.md`, `specs/fase-1-core/01-functional-spec.md`

---

## 1. Objetivo y Alcance Estricto de la Fase 2

### 1.1 Objetivo de la Fase 2
Reducir al mínimo la fricción de registro y aumentar el control preventivo del usuario sobre sus gastos cotidianos mediante:
1. **Vinculación privada multi-usuario con Telegram** desde `/settings`.
2. **Bolsa compartida de "Gustitos"** (presupuesto discrecional mensual con barra de progreso regresiva hacia `$0` y marcado tanto por categoría como por movimiento individual).
3. **Límites máximos mensuales opcionales por categoría individual** con indicador visual de progreso.
4. **Bot de Telegram con IA multimodal ligera (Gemini Flash)** capaz de interpretar **texto y notas de voz (audio <= 60 s)**, mantener conversaciones multi-turno para aclarar datos faltantes (categoría o datos de cuotas), responder con el saldo restante y ofrecer anulación instantánea mediante `[❌ Anular]`.
5. **Sistema de alertas en tiempo real, proactivas diarias (`pg_cron` + `pg_net`) y keep-alive de desarrollo**.

### 1.2 Qué incluye exactamente la Fase 2 (In-Scope)
1. **Vinculación Multi-Usuario con Telegram en `/settings`:**
   - Generación de un código alfanumérico corto temporal (6 caracteres, validez de **15 minutos**). Al generar uno nuevo, se invalida automáticamente cualquier código vigente anterior del mismo usuario.
   - Vinculación mediante el comando `/vincular <CODIGO>` enviado al bot de Telegram.
   - Restricción estricta 1:1 (`user_id ↔ telegram_chat_id`): si el chat de Telegram ya está vinculado a otra cuenta de SB-Finance, el bot rechaza la operación pidiendo desvincular primero la cuenta original.
   - Botón `"Desvincular Telegram"` en `/settings` y gestión de zona horaria del usuario (`timezone`, por defecto `'America/Argentina/Buenos_Aires'`, editable).
2. **Bolsa Compartida de "Gustitos" y Límites Individuales por Categoría:**
   - Configuración del **Presupuesto mensual de Gustitos** en `/settings` (con snapshot mensual en `monthly_budgets`).
   - Selección de qué categorías de gasto pertenecen a la bolsa de Gustitos (`is_gustito`, iniciando todas las categorías base en `false` para que el usuario elija libremente) desde `/categories` y desde `/settings`.
   - Posibilidad de marcar un **gasto individual o compra en cuotas puntual como Gustito** (`is_gustito = true` en `transactions` y en `installment_purchases`), tanto mediante un interruptor en los formularios web (`TransactionFormModal` e `InstallmentFormModal`) como por lenguaje natural en Telegram (ej. *"gasté 15.000 pesos en café, me di un gustito hoy"*), aunque su categoría general no pertenezca a la bolsa.
   - **Regla de exclusión:** Los gastos fijos (`commitment_type = 'fixed_expense'`) **nunca** cuentan como Gustitos.
   - **Barra regresiva en Dashboard:** Calcula `Presupuesto Gustitos - Gastado en Gustitos` descendiendo hacia `$0`. Si `gustitos_budget <= 0` o no hay categorías marcadas como gustito ni gastos puntuales de Gustitos en el mes (`gustitoCategoriesCount === 0 && gustitosSpent <= 0`), muestra un **aviso de configuración** en lugar de pintarse en rojo. Cuando está configurada y el saldo llega a `<= $0`, pasa a **rojo semántico (`#EF4444`)**.
   - **Límite máximo mensual por categoría individual (`monthly_limit`):** Opcional en categorías de gasto, con barra de progreso visual y snapshots mensuales para respetar la inmutabilidad de meses cerrados.
3. **Bot de Telegram con IA Multimodal (Gemini Flash en Edge Function Deno):**
   - Webhook autenticado obligatoriamente mediante el header `X-Telegram-Bot-Api-Secret-Token`.
   - **Acuse de recibo inmediato (dos mensajes separados):** Apenas el bot recibe un mensaje de texto o nota de voz válida de un usuario vinculado para procesar una transacción, envía de inmediato un primer mensaje: *"⏳ Mensaje recibido, estamos procesando la transacción..."* (evitando que el chat quede en silencio mientras se descarga el audio o responde la IA). Una vez finalizado el procesamiento, envía un **segundo mensaje nuevo** debajo con la confirmación, pregunta de aclaración o error.
   - Procesamiento de **texto** y **notas de voz / audio** (límite estricto de hasta **60 segundos**).
   - Extracción de intenciones de Fase 2: `expense`, `income` e `installment_purchase` (si el usuario menciona **Plazos Fijos**, el bot responde indicando que estará disponible en la Fase 3).
   - **Ingresos extra con destino directo a la Bóveda de Ahorros (`save_to_savings`):**
     - Tanto en Telegram (especificándolo en el mismo texto o audio, ej. *"Cobré 40.000 de un diseño freelance y quiero que pase directo a ahorros"*) como en la Web (`TransactionFormModal` al elegir `Ingreso Extra`), el usuario puede indicar que ese ingreso extra se destine directamente a su **Bóveda de Ahorros**.
     - Cuando `save_to_savings = true`, el sistema registra el ingreso extra en `transactions` (`type = 'income'`) y genera simultáneamente un aporte en `savings_entries` (`entry_type = 'deposit'`) vinculado mediante `source_transaction_id` (`ON DELETE CASCADE`). De este modo, el monto incrementa la **Bóveda de Ahorros** (`/savings`) y deja neutro (`$0` de diferencia) el `Disponible Real` gastable del mes.
   - **Flujo conversacional híbrido (rechazo con ejemplo + multi-turno):**
     - Si el mensaje carece de monto y contexto financiero claro, responde de inmediato pidiendo reenviar los datos completos junto a un ejemplo de cómo estructurar el texto/audio.
     - Si detecta la intención pero falta un dato puntual (por ejemplo, la IA no reconoce con certeza la categoría, o en cuotas falta el monto **por cuota** o la fecha de **1.ª cuota**), guarda el borrador temporal (preservando también `is_gustito` o `save_to_savings`) y pregunta paso a paso (incluyendo lista/botones de categorías disponibles) hasta completar el registro.
     - En compras en cuotas, la IA **nunca** divide automáticamente un total; exige el monto de cada cuota y la fecha de vencimiento de la primera cuota.
   - **Confirmación enriquecida + `[❌ Anular]`:** Muestra monto, categoría, confirmación de envío a la **Bóveda de Ahorros** (si fue un ingreso con `save_to_savings = true`), saldo restante de **Gustitos** (si aplica) y saldo restante del **límite individual** de la categoría (si tiene). Incluye botón inline `[❌ Anular]` válido por **24 horas** (bloqueado si es una compra en cuotas que ya tiene al menos una cuota pagada en la web; si es un ingreso con ahorro directo, elimina en cascada tanto el ingreso como el aporte en `savings_entries`).
4. **Alertas en Tiempo Real, Proactivas Diarias y Keep-Alive:**
   - **En tiempo real (Web y Telegram):** Al registrar un gasto de Gustitos que hace que el saldo restante cruce a `<= $0`, y en cada nuevo gasto de Gustitos mientras el saldo permanezca `<= $0`, se envía una alerta inmediata al Telegram del usuario.
   - **Proactivas diarias (`08:00 AM` hora local del usuario vía `pg_cron` + `pg_net`):**
     - Proximidad (`> 80%` y `< 100%`) o superación (`>= 100%`) del límite individual de una categoría (máximo **1 vez por semana** por nivel/categoría/mes).
     - Proximidad (`> 80%` y `< 100%`) o superación (`>= 100%`) del límite mensual de gastos fijos + cuotas (máximo **1 vez por semana** por nivel/mes).
     - Recordatorio de gastos fijos y cuotas pendientes (`is_paid = false`) enviado **el día 15 de cada mes** y nuevamente **7 días antes de fin de mes**.
   - **Keep-alive diario (Etapa 1 — Desarrollo):** Job diario en `pg_cron` + `pg_net` realizando una petición HTTP liviana a la API de Supabase.

### 1.3 Qué queda fuera de la Fase 2 (Out-of-Scope — Reservado para Fase 3)
- Intención de bot `fixed_term_deposit` (Plazos Fijos) y alertas de vencimiento de plazos fijos.
- Matriz de prioridad interactiva (Drag & Drop).
- Simulador de gastos ("¿Qué pasa si...?").
- Asistente de distribución de presupuesto con IA.
- Keep-alive de Etapa 2 (Producción en Vercel `/api/keep-alive` + `vercel.json`).

---

## 2. Reglas de Negocio y Fórmulas de la Fase 2

### 2.1 Bolsa de "Gustitos" (`gustitos_budget`)
Para cualquier mes $M$:
$$\text{Gastado en Gustitos}_M = \sum \text{Gastos Variables Gustitos}_M + \sum \text{Cuotas de Categorías Gustitos}_M$$

Donde:
- **Gastos Variables Gustitos ($M$):** Transacciones con `type = 'expense'` del mes $M$ donde se cumpla al menos una de las dos condiciones:
  1. La transacción fue marcada explícitamente como gustito (`transactions.is_gustito = true`), **o**
  2. La categoría de la transacción pertenece a la bolsa de Gustitos en el mes $M$ (`monthly_category_snapshots.is_gustito = true`, o `categories.is_gustito = true` si el mes aún no tiene snapshot).
- **Cuotas de Categorías Gustitos ($M$):** Compromisos del mes $M$ con `commitment_type = 'installment'` cuya categoría pertenece a la bolsa de Gustitos en el mes $M$ (o cuya compra padre fue marcada como gustito).
- **Exclusión obligatoria:** Compromisos con `commitment_type = 'fixed_expense'` **nunca** suman a $\text{Gastado en Gustitos}_M$, incluso si comparten categoría con gastos variables.

$$\text{Saldo Restante Gustitos}_M = \text{Presupuesto Gustitos}_M - \text{Gastado en Gustitos}_M$$

- **Regla de visualización en Dashboard:**
  - Si $\text{Presupuesto Gustitos}_M \le 0$ **o** no existen categorías marcadas como gustito ni gastos de Gustitos registrados en el mes (`gustitoCategoriesCount === 0 && gustitosSpent <= 0`), se muestra un **aviso de configuración** invitando a definir el presupuesto en `/settings` y elegir categorías en `/categories` (no se pinta en rojo).
  - Caso contrario, la barra regresiva parte del 100% disponible (`Presupuesto Gustitos`) y desciende hacia `$0`:
    - Si $\text{Saldo Restante Gustitos}_M > 0$: color de marca amarillo `#FACC15` (o indicador saludable).
    - Si $\text{Saldo Restante Gustitos}_M \le 0$: color **rojo semántico (`#EF4444`)** mostrando el excedente en negativo.

### 2.2 Límites Individuales por Categoría (`monthly_limit`)
Para cada categoría de gasto $C$ que tenga definido un límite mensual ($\text{Límite}_{C,M} > 0$):
$$\text{Consumido}_{C,M} = \sum \text{Gastos Variables}_{C,M} + \sum \text{Compromisos (Fijos + Cuotas)}_{C,M}$$
$$\text{Uso}_{C,M}(\%) = \frac{\text{Consumido}_{C,M}}{\text{Límite}_{C,M}} \times 100$$

- **Indicador visual:**
  - `<= 80%`: Barra en amarillo marca (`#FACC15`).
  - `> 80%` y `< 100%`: Estado de precaución (amarillo/ámbar destacado con aviso `"Cerca del límite"`).
  - `>= 100%`: Estado superado en **rojo semántico (`#EF4444`)**, nunca bloqueante.

### 2.3 Inmutabilidad Histórica (Snapshots Mensuales)
- Al igual que `fixed_salary`, `monthly_savings_target` y `fixed_expenses_limit`, `gustitos_budget` se guarda en `user_settings` (valor base) y se congela en `monthly_budgets` cada mes mediante `ensure_monthly_period`.
- Para los atributos por categoría (`is_gustito` y `monthly_limit`), `ensure_monthly_period` congela en `monthly_category_snapshots` la configuración vigente de cada categoría para ese mes `YYYY-MM-01`.
- Editar `is_gustito` o `monthly_limit` en el mes actual actualiza `categories` (futuro) y el snapshot del **mes calendario actual**, preservando intactos los cierres de meses anteriores.

### 2.4 Reglas de Tiempo, Zona Horaria y Vencimientos del Bot
- **Zona horaria local (`timezone`):** Cada usuario posee un campo IANA `timezone` en `user_settings` (default `'America/Argentina/Buenos_Aires'`). Toda fecha `DATE` (`YYYY-MM-DD`) registrada por Telegram y todo cálculo de hora local (`08:00 AM` para el cron, día `15` y `7 días antes de fin de mes`) se evalúa usando la zona horaria configurada del usuario.
- **Código de vinculación:** Alfanumérico de 6 caracteres sin caracteres ambiguos (ej. `K7M9P2`), TTL de **15 minutos**, de un solo uso.
- **Límite de audio:** Duración máxima **60 segundos** (y máximo **5 MB** de archivo).
- **Ventana del botón `[❌ Anular]`:** Válido durante **24 horas** exactas desde la creación del registro (`created_at + 24 hours`). Si es compra en cuotas con al menos una cuota marcada como `is_paid = true`, la anulación desde Telegram queda bloqueada.

### 2.5 Reglas de Alertas en Tiempo Real y Proactivas Diarias
1. **Alerta en tiempo real de Gustitos (`<= $0`):**
   - Condición de disparo: `gustitos_budget > 0`, la operación involucra un gasto de Gustitos y tras guardar el movimiento el $\text{Saldo Restante Gustitos} \le 0$.
   - Aplica tanto si el gasto se cargó desde **Telegram** como desde la **Web**.
   - Se dispara en el gasto que cruza de `> $0` a `<= $0` **y** en cada nuevo gasto de Gustitos registrado mientras el saldo continúe en `<= $0`.
2. **Alertas proactivas diarias (`08:00 AM` hora local del usuario):**
   - **Límite por categoría (> 80% y >= 100%):** Máximo **1 notificación cada 7 días** por `(usuario, categoría, nivel_alerta, mes)`.
   - **Límite de gastos fijos + cuotas (> 80% y >= 100%):** Máximo **1 notificación cada 7 días** por `(usuario, nivel_alerta, mes)`.
   - **Recordatorio de pagos pendientes (`is_paid = false`):**
     - Día **15** del mes local del usuario.
     - **7 días antes del último día del mes** local del usuario (`último_día_del_mes - 7`).
     - Máximo 1 envío por hito en el mes.

---

## 3. Historias de Usuario y Flujos Principales (*Happy Path*)

### Módulo 1: Vinculación Multi-Usuario y Zona Horaria (`/settings`)

#### US-2.1 — Generar código temporal y vincular Telegram
- **Como** usuario autenticado de SB-Finance,
- **Quiero** generar un código temporal en `/settings` y enviarlo al bot de Telegram,
- **Para** registrar mis gastos por chat/audio de forma privada en mi propia cuenta.
- **Flujo principal:**
  1. En `/settings`, en la tarjeta **"Vinculación con Telegram"**, el usuario presiona `"Generar código de vinculación"`.
  2. El sistema invalida cualquier código previo no usado del usuario, genera un código alfanumérico de 6 caracteres (ej. `A7K9M2`) válido por 15 minutos y muestra la instrucción: *"Enviá `/vincular A7K9M2` al bot de SB-Finance"* con un temporizador de expiración y botón para copiar.
  3. El usuario abre Telegram y envía `/vincular A7K9M2` al bot.
  4. La Edge Function `telegram-webhook` valida el código, comprueba que el `chat_id` no pertenezca a otra cuenta, crea el vínculo en `telegram_links`, marca el código como usado y responde en Telegram: *"✅ Cuenta vinculada correctamente. Ya podés enviarme tus gastos por texto o audio."*
  5. En la web (`/settings`), el usuario ve el estado `"Vinculado"` y el botón `"Desvincular Telegram"`.

#### US-2.2 — Configuración de Zona Horaria y Presupuesto de Gustitos
- **Como** usuario autenticado,
- **Quiero** configurar mi presupuesto mensual de "Gustitos" y mi zona horaria en `/settings`,
- **Para** que mi barra regresiva y mis alertas diarias funcionen según mi dinero discrecional y mi reloj local.
- **Flujo principal:**
  1. En `/settings`, el usuario completa `Presupuesto mensual de Gustitos` (ej. `$ 120.000,00`) y verifica o modifica su `Zona horaria` (por defecto `America/Argentina/Buenos_Aires (UTC-3)`).
  2. Puede tildar rápidamente qué categorías de gasto pertenecen a la bolsa de Gustitos (sincronizado con `/categories`).
  3. Al presionar `"Guardar configuración"`, se actualizan `user_settings`, el snapshot del mes actual en `monthly_budgets` y `monthly_category_snapshots`.

---

### Módulo 2: Bolsa de "Gustitos" y Límites por Categoría (`/categories`, `/transactions` y Dashboard)

#### US-2.3 — Configurar categorías como Gustitos y definir límites individuales
- **Como** usuario autenticado,
- **Quiero** marcar qué categorías integran mi bolsa de "Gustitos" y asignar un tope mensual opcional a categorías clave,
- **Para** monitorear tanto mis gustos generales como el gasto específico en rubros sensibles (ej. *Comida y Supermercado*).
- **Flujo principal:**
  1. En `/categories`, al crear o editar una categoría de tipo `expense`, el usuario ve el interruptor `"Incluir en bolsa de Gustitos"` (por defecto apagado en todas las categorías base) y el campo opcional `"Límite máximo mensual ($)"`.
  2. En las tarjetas de categorías de gasto, visualiza la barra de consumo del mes actual contra su límite individual (si tiene) y el distintivo `"Gustito"` si pertenece a la bolsa.

#### US-2.4 — Visualización de Barra Regresiva de Gustitos y Registro Web
- **Como** usuario autenticado,
- **Quiero** ver en el Dashboard cuánto dinero me queda para "Gustitos" este mes y poder marcar un gasto puntual como gustito al cargarlo en la web,
- **Para** saber al instante cuánto margen discrecional me resta antes de llegar a `$0`.
- **Flujo principal:**
  1. En el Dashboard, el widget **"Bolsa de Gustitos"** muestra el presupuesto inicial, lo consumido (excluyendo gastos fijos) y el saldo restante en una barra regresiva descendente.
  2. En los modales `"+ Nuevo Movimiento"` (para `type = 'expense'`) y `"+ Nueva Compra en Cuotas"`, aparece el checkbox `"Contar en la bolsa de Gustitos"`: se pre-marca automáticamente si la categoría elegida es de Gustitos, pero el usuario puede activarlo manualmente para un gasto o compra puntual de cualquier otra categoría.
  3. En las tablas/listados de movimientos y compras en cuotas se muestran distintivos (`Gustito` y `Telegram`) para auditar qué registros descontaron de la bolsa y cuáles ingresaron por el bot.
  4. Si al guardar o editar desde la web el saldo restante llega a `<= $0`, el Dashboard pinta la barra en rojo semántico y el sistema envía la alerta inmediata al Telegram vinculado del usuario.

---

### Módulo 3: Bot de Telegram con IA Multimodal y Botón `[❌ Anular]`

#### US-2.5 — Registro por Texto o Nota de Voz (Audio <= 60 s), Acuse Inmediato e Ingresos Extra a Ahorro
- **Como** usuario vinculado,
- **Quiero** enviarle un texto o una nota de voz al bot (ej. *"Gasté 15.000 en delivery, me di un gustito hoy"* o *"Cobré 40.000 de un diseño freelance y quiero que pase directo a ahorros"*), recibir confirmación instantánea de lectura y luego el resultado final,
- **Para** cargar movimientos sin quedarme con la duda de si el bot leyó mi mensaje, conocer mi saldo restante al instante y poder enviar ingresos extra directo a mi Bóveda de Ahorros.
- **Flujo principal (Gasto con Gustito):**
  1. El usuario envía una nota de voz de 8 segundos: *"Gasté quince mil pesos en café y medialunas, me di un gustito"*.
  2. Telegram envía el `POST` al webhook con `X-Telegram-Bot-Api-Secret-Token`.
  3. La Edge Function verifica la firma, identifica al `user_id` por su `chat_id`, verifica que `voice.duration <= 60` y envía de inmediato un **primer mensaje**: *"⏳ Mensaje recibido, estamos procesando la transacción..."*.
  4. A continuación, descarga el audio `.ogg` y lo envía junto al catálogo de categorías activas del usuario y su fecha local a Gemini Flash.
  5. Gemini retorna JSON estructurado: `intent: 'expense'`, `amount: 15000`, `description: 'Café y medialunas'`, `category_id: '<Ocio y Salidas>'`, `is_gustito: true`, `save_to_savings: false`, `transaction_date: '<hoy_local>'`.
  6. La función guarda la transacción (`source = 'telegram'`), calcula los saldos restantes y envía un **segundo mensaje nuevo** debajo con el resultado:
     - *"✅ Gasto registrado: **$ 15.000,00** en **Ocio y Salidas** (Café y medialunas)."*
     - *"🍿 Bolsa de Gustitos: te quedan **$ 65.000,00** disponibles este mes."* (o alerta roja si llegó a `<= $0`).
     - *"📊 Límite de Ocio y Salidas: te quedan **$ 25.000,00** de $ 40.000,00."* (si la categoría tiene límite).
     - Botón inline: **`[❌ Anular]`**.
- **Flujo alternativo (Ingreso Extra enviado directamente a Ahorros):**
  1. El usuario envía por texto o audio: *"Cobré 40.000 de un diseño freelance y quiero que pase directo a ahorros"*.
  2. El bot envía de inmediato el primer mensaje *"⏳ Mensaje recibido, estamos procesando la transacción..."*.
  3. Gemini extrae `intent: 'income'`, `amount: 40000`, `description: 'Diseño freelance'`, `save_to_savings: true`.
  4. El sistema registra el ingreso en `transactions` (`type = 'income'`, `save_to_savings = true`) y crea simultáneamente el depósito vinculado en `savings_entries` (`entry_type = 'deposit'`, `source_transaction_id = transaction.id`).
  5. El bot envía el segundo mensaje confirmando el ingreso extra, informando que fue apartado directamente en la **Bóveda de Ahorros** (sin sumarse al `Disponible Real` gastable) e incluyendo el botón **`[❌ Anular]`**.

#### US-2.6 — Flujo Conversacional Multi-Turno y Compra en Cuotas vía Telegram
- **Como** usuario vinculado,
- **Quiero** que si la IA no está segura de la categoría o si olvidé indicar cuándo vence la primera cuota, el bot me lo pregunte paso a paso,
- **Para** completar la carga sin errores ni divisiones automáticas incorrectas.
- **Flujo principal (aclaración de categoría):**
  1. El usuario escribe: *"Gasté 12.000 en un trámite del registro"*.
  2. La IA detecta el monto y descripción pero marca `category_confidence: 'low'` / `category_id: null`.
  3. El bot guarda una sesión temporal (`telegram_conversation_sessions`, TTL 15 min) y responde con los botones inline numerados de las categorías activas del usuario: *"No estoy seguro a qué categoría pertenece **$ 12.000,00** (Trámite del registro). Elegí una de la lista o respondé con el nombre:"*.
  4. El usuario toca el botón de categoría (o escribe el nombre); el bot completa el registro, limpia la sesión y envía la confirmación final con `[❌ Anular]`.
- **Flujo principal (compra en cuotas):**
  1. El usuario dice: *"Compré auriculares en 3 cuotas de 25.000, primera cuota el 10 de diciembre"*.
  2. La IA valida que el usuario especificó el **monto por cuota** (`25000`), la **cantidad** (`3`) y la **fecha de 1.ª cuota** (`2026-12-10`), crea la compra padre + 3 compromisos y responde con el resumen y botón `[❌ Anular]`.
  3. Si el usuario solo hubiera dicho *"Compré auriculares en 3 cuotas de 25.000"* (sin fecha de 1.ª cuota), el bot guarda el borrador y pregunta: *"¿En qué fecha vence o impacta la primera cuota? (ej. 10/12/2026)"*.

#### US-2.7 — Anulación Instantánea con Botón `[❌ Anular]`
- **Como** usuario vinculado,
- **Quiero** tocar `[❌ Anular]` si me equivoqué o la IA entendió mal un dato,
- **Para** revertir inmediatamente el movimiento (o las $N$ cuotas en cascada) desde Telegram.
- **Flujo principal:**
  1. Dentro de las 24 horas posteriores al registro, el usuario presiona `[❌ Anular]`.
  2. La Edge Function verifica la vigencia de 24 horas y, si es compra en cuotas, comprueba que ninguna cuota tenga `is_paid = true`.
  3. Elimina la transacción o la compra en cuotas padre (`ON DELETE CASCADE`), marca el log como anulado, edita el mensaje original quitando el botón inline y muestra: *"❌ Registro anulado correctamente."*

---

## 4. Casos Borde (*Edge Cases*), Validaciones y Manejo de Errores

| Caso / Escenario | Regla de Validación y Comportamiento del Sistema |
| :--- | :--- |
| **Webhook sin header `X-Telegram-Bot-Api-Secret-Token` válido** | Se rechaza inmediatamente con HTTP `401 Unauthorized` sin consultar Gemini ni modificar datos. |
| **Usuario no vinculado escribe al bot** | Cualquier mensaje distinto a `/vincular <codigo>` o `/start` de un `chat_id` sin fila en `telegram_links` recibe: *"Tu chat aún no está vinculado. Generá un código en Configuraciones de SB-Finance y enviá `/vincular TU_CODIGO`."* |
| **Código `/vincular` expirado, inexistente o ya usado** | El bot responde: *"El código es inválido o expiró (dura 15 minutos). Generá uno nuevo desde `/settings`."* |
| **`chat_id` ya vinculado a otra cuenta de SB-Finance** | El bot rechaza el intento: *"Este Telegram ya está vinculado a otra cuenta de SB-Finance. Desvinculalo primero desde Configuración de esa cuenta."* |
| **Audio > 60 segundos o > 5 MB** | Antes de descargar el archivo de Telegram, la función revisa `duration` y `file_size`. Si supera 60 s, responde: *"El audio no puede durar más de 60 segundos. Enviá uno más corto o escribilo por texto."* |
| **Mensaje sin monto ni intención financiera clara** | Ej. *"hola"*, *"gasté plata"*, *"me compré algo"*. El bot no abre sesión multi-turno vacía: responde pidiendo los datos completos y muestra un ejemplo claro de texto/audio válido. |
| **Mención de Plazo Fijo en Telegram** | La IA o el router detecta intención fuera de alcance de Fase 2 y responde: *"El registro de Plazos Fijos estará disponible en la Fase 3. Por ahora puedo registrar gastos, ingresos extra y compras en cuotas."* |
| **Compra en cuotas con monto total en vez de valor por cuota** | Ej. *"Compré una bici a 300.000 en 6 cuotas"*. La IA **no divide** automáticamente; marca que falta `installment_amount` por cuota y el bot pregunta en multi-turno: *"¿Cuánto vas a pagar en cada una de las 6 cuotas y cuándo vence la primera?"*. |
| **Usuario quiere cancelar conversación multi-turno** | Escribir `/cancelar` (o tocar botón `"Cancelar"`) o enviar un nuevo comando limpia `telegram_conversation_sessions`. Si pasan > 15 minutos, la sesión expira automáticamente. |
| **Doble clic en `[❌ Anular]` o registro ya borrado desde la web** | El manejo es idempotente: si `voided_at` ya tiene fecha o el registro ya no existe en BD, responde el callback, quita el botón del mensaje y actualiza el texto indicando que ya fue anulado/eliminado. |
| **`[❌ Anular]` después de 24 horas** | Se rechaza la anulación desde Telegram, se quita el botón y se indica editar o eliminar el movimiento desde la web. |
| **`[❌ Anular]` en cuotas con al menos 1 cuota `is_paid = true`** | Se bloquea la anulación desde Telegram y se responde: *"Esta compra en cuotas ya tiene pagos marcados en la web. Para anularla hacelo desde Compromisos en la app."* |
| **Bolsa de Gustitos sin configurar (`gustitos_budget = 0` o sin categorías/gastos Gustitos)** | El Dashboard muestra el aviso amarillo/negro de configuración pendiente en lugar de mostrar barra roja de exceso; no dispara alertas en tiempo real de Gustitos hasta que `gustitos_budget > 0`. |
| **Falla temporal de Gemini Flash o red (`503`, `429`, `5xx`, timeout)** | Tras 1 reintento rápido (1,5 s) con `gemini-3.8-flash`, si persiste la falla transitoria, no se registra ningún movimiento parcial: el bot guarda la solicitud completa (texto o audio en Base64, fecha local original y borrador multi-turno si existía) en `telegram_pending_requests` y responde de inmediato: *"⚠️ En este momento estoy teniendo un problema de alta demanda y no puedo procesar tu solicitud ahora mismo. Tus datos quedaron guardados: apenas se habilite el servicio voy a realizar la carga automáticamente y te enviaré la confirmación por acá."* Un worker en segundo plano (`pg_cron` cada 1 minuto) reintenta con *backoff* hasta un máximo de 2 horas. Si el error no es transitorio (irrecuperable), informa error general devolviendo HTTP `200`. |

---

## 5. Criterios de Aceptación Verificables (*Dado / Cuando / Entonces*)

### CA-01: Vinculación multi-usuario segura con código alfanumérico temporal
- **Dado** un usuario A autenticado en `/settings` que genera un código de vinculación `K7M9P2` (y un código previo vigente `X1B2C3`),
- **Cuando** el usuario A envía `/vincular X1B2C3` desde Telegram, **entonces** el bot lo rechaza por estar invalidado;
- **Y cuando** envía `/vincular K7M9P2` dentro de los 15 minutos, **entonces** se asocia `user_id ↔ telegram_chat_id` en `telegram_links`, el código queda inutilizable y `/settings` refleja el estado vinculado.
- **Y si** un usuario B intenta vincular ese mismo `telegram_chat_id` con otro código, **entonces** el bot rechaza la operación pidiendo desvincular la cuenta A primero.

### CA-02: Bolsa de Gustitos, exclusión de gastos fijos y aviso de configuración
- **Dado** un usuario nuevo con todas sus categorías base en `is_gustito = false` y `gustitos_budget = 0`,
- **Cuando** abre el Dashboard,
- **Entonces** visualiza un **aviso de configuración** para Gustitos (no una barra en rojo).
- **Y cuando** configura `gustitos_budget = $ 50.000`, marca *"Ocio y Salidas"* como gustito, registra un gasto fijo de `$ 30.000` en *"Vivienda"* (o incluso en *"Ocio y Salidas"*) y un gasto variable de `$ 20.000` en *"Ocio y Salidas"*,
- **Entonces** el gasto fijo **no** descuenta de Gustitos y la barra regresiva muestra exactamente **`$ 30.000,00` restantes**.

### CA-03: Registro multimodal en Telegram (texto/voz), acuse inmediato, ingreso extra a ahorro, saldo restante y alerta en tiempo real `<= $0`
- **Dado** un usuario vinculado con `$ 15.000,00` restantes en su bolsa de Gustitos,
- **Cuando** envía una nota de voz de 6 segundos: *"Gasté 20.000 pesos en comida, me di un gustito hoy"*,
- **Entonces** el bot envía primero el mensaje inmediato *"⏳ Mensaje recibido, estamos procesando la transacción..."*, procesa el audio con Gemini Flash, registra el gasto de `$ 20.000,00` con `source = 'telegram'` y `is_gustito = true` en la fecha local de su `timezone`,
- **Y** envía un segundo mensaje nuevo confirmando el gasto, mostrando el nuevo saldo de Gustitos (`-$ 5.000,00`), el botón `[❌ Anular]` y enviando/notificando la alerta de saldo `<= $0`.
- **Y cuando** envía *"Cobré 40.000 de un diseño freelance y mandalo directo a ahorros"* (o tilda `"Enviar este ingreso directamente a la Bóveda de Ahorros"` en la web), **entonces** se registra el ingreso en `transactions` (`save_to_savings = true`) junto con el depósito vinculado en `savings_entries` (`source_transaction_id`), incrementando la Bóveda de Ahorros sin alterar el `Disponible Real` gastable; si presiona `[❌ Anular]`, se eliminan ambos registros en cascada.
- **Y si** luego registra otro gasto de `$ 2.000,00` desde la Web marcado como gustito, **entonces** recibe una nueva alerta inmediata en Telegram porque el saldo sigue en `<= $0`.

### CA-04: Audio > 60 s, Multi-turno de categoría y Cuotas sin división automática
- **Dado** un usuario vinculado que envía un audio de 65 segundos,
- **Cuando** llega al webhook, **entonces** el bot responde `"El audio no puede durar más de 60 segundos..."` sin invocar a Gemini.
- **Dado** que envía *"Compré una silla en 3 cuotas de 40.000"* sin aclarar cuándo vence la 1.ª cuota,
- **Cuando** Gemini analiza el mensaje, **entonces** el bot **no** crea la compra ni inventa una fecha: guarda la sesión temporal y pregunta en qué fecha vence la primera cuota.

### CA-05: Botón `[❌ Anular]` con ventana de 24 h y bloqueo por cuotas pagadas
- **Dado** un gasto registrado vía Telegram hace menos de 24 horas,
- **Cuando** el usuario presiona `[❌ Anular]` (incluso dos veces seguidas),
- **Entonces** el gasto se elimina de `transactions`, el mensaje se edita quitando el botón e indicando `"❌ Anulado"` y el segundo clic responde de forma idempotente sin error.
- **Y dado** que una compra en cuotas creada por Telegram ya tiene la Cuota 1/3 marcada como pagada en la Web (o han pasado más de 24 horas),
- **Cuando** presiona `[❌ Anular]`, **entonces** el bot bloquea la anulación y le informa el motivo.

### CA-06: Alertas proactivas diarias (`08:00 AM` local) y Keep-Alive
- **Dado** un usuario con `timezone = 'America/Argentina/Buenos_Aires'` cuyo consumo en *"Comida"* alcanzó el `85%` de su límite individual y tiene 2 compromisos pendientes (`is_paid = false`),
- **Cuando** el job diario corre a las `08:00 AM` hora local del día 15 del mes (o 7 días antes de fin de mes),
- **Entonces** envía una única alerta de proximidad (`> 80%`) para esa categoría (no repetible hasta pasados 7 días) y el recordatorio de compromisos pendientes de pago.

### CA-07: Resiliencia ante error `503` de Gemini con cola persistente y carga automática diferida
- **Dado** un usuario vinculado que envía un texto o nota de voz (ej. *"Gasté 8.000 en farmacia hoy"*) mientras la API de `gemini-3.8-flash` devuelve `HTTP 503 UNAVAILABLE`,
- **Cuando** fallan el intento inicial y el reintento inmediato (1,5 s) con el mismo modelo,
- **Entonces** el webhook guarda la solicitud (incluyendo `local_date` original y el audio descargado si aplica) en `telegram_pending_requests` y responde al usuario avisando que hay un problema temporal, que sus datos quedaron guardados y que se procesará automáticamente apenas se restablezca el servicio;
- **Y cuando** en los minutos siguientes Gemini vuelve a responder con normalidad, el worker programado (`process-telegram-queue` cada 1 minuto vía `pg_cron`) procesa la cola en orden cronológico (`created_at ASC`), registra el movimiento con la fecha local original, limpia el payload de audio temporal y envía al chat la confirmación final con el botón `[❌ Anular]`.
- **Y si** transcurren más de **2 horas** de indisponibilidad continua de Gemini, el worker marca la solicitud como `failed_permanent` y envía un único aviso final al usuario pidiéndole reenviar el movimiento.
