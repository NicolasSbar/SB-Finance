# Especificación Funcional — Fase 3 (Herramientas de Decisión, Inversiones y Refinamiento Core) — SB-Finance

> **Versión:** 1.0.0  
> **Estado:** Aprobado para implementación  
> **Documentos base:** `specs/constitution.md`, `specs/product_roadmap.md`, `specs/fase-1-core/01-functional-spec.md`, `specs/fase-2-automation/01-functional-spec.md`

---

## 1. Objetivo y Alcance Estricto de la Fase 3

### 1.1 Objetivo de la Fase 3
Consolidar la precisión contable del **Disponible Real** mediante el apartado automático de topes desde el día 1, transformar el Dashboard en una vista ejecutiva sin sobrecarga cognitiva e incorporar cuatro herramientas orientadas a la toma de decisiones y la inversión patrimonial (**Matriz de Prioridad**, **Simulador de Gastos**, **Plazos Fijos conectados a la Bóveda de Ahorros** y **Asistente de Presupuesto con IA**), extendiendo el bot de Telegram para operar adelanto de cuotas y plazos fijos por texto y audio.

### 1.2 Qué incluye exactamente la Fase 3 (In-Scope)

#### Bloque A: Refinamiento Financiero, Telegram y UX Core
1. **Nueva fórmula de `Disponible Real` (con apartado de Fijos y Ahorro; Gustitos integrado al Disponible):**
   - El **Límite de Gastos Fijos** y el **Ahorro Mensual** se apartan íntegramente desde el día 1 (`max(tope, gastado)`), sumando también los retornos de plazo fijo acreditados al mes y descontando los plazos fijos constituidos desde el `Disponible Real` del mes.
   - El **Presupuesto de Gustitos** **no** se resta por adelantado: forma parte visible del `Disponible Real` del mes (indicando cuánto margen queda disponible para Gustitos). Cuando el usuario registra efectivamente un gasto o cuota de Gustitos, ese monto descuenta tanto del margen restante de Gustitos como del `Disponible Real`.
2. **Día de cobro del sueldo (`salary_payday`) y Revisión de Cierre / Sobrante de Gastos Fijos:**
   - Configurable en `/settings` eligiendo entre **Último día hábil del mes (lunes a viernes)** (`salary_payday = 0`) o **Día fijo del mes (`1..31`)** (default `1`).
   - La alerta proactiva de **Revisión de Cierre de Período** (banner en el Dashboard + mensaje vía Bot de Telegram) se dispara automáticamente cuando **faltan 3 días o menos para que termine el mes** (o al consultar meses pasados no revisados) y exista un sobrante `> $0` dentro de `Límite Gastos Fijos`:
     1. Verifica si olvidó registrar algún gasto pendiente antes de cerrar (con acceso inmediato a `+ Registrar gasto olvidado`).
     2. Decide el destino del saldo sobrante de Gastos Fijos (monto **parcial o total**, solo cuando `sobrante > $0`): **enviarlo a la Bóveda de Ahorros** (sin volver a descontarlo del Disponible Real) o **liberarlo al Disponible Real**.
   - El acceso manual a `"Revisar sobrante"` permanece de forma discreta dentro de la tarjeta de **Comprometido (Fijos + Cuotas)** en el Dashboard (cuando `fixedCapSurplus > 0`), sin ocupar espacio en la barra superior de meses.
3. **Separación de cuotas de Gustitos:**
   - Las compras en cuotas cuya categoría pertenezca a Gustitos o marcadas como `is_gustito = true` **no** consumen el límite de gastos fijos (`Comprometido`); se descuentan mes a mes únicamente de la **Bolsa de Gustitos**, aunque siguen visibles en **Pendiente de Abonar** con un distintivo claro.
4. **Pago múltiple / adelanto de `N` cuotas (Web y Telegram texto/audio):**
   - Permite adelantar `N` cuotas pendientes juntas (tomando siempre las **`N` cuotas pendientes más próximas en orden cronológico**, `is_paid = false ORDER BY installment_number ASC`), trasladando su `month_date` contable al **mes calendario actual** marcadas como pagadas y liberando los meses futuros.
   - Soporta indicar un monto total `$X` distinto al original (ej. por descuento por pago anticipado), actualizando esas `N` cuotas a `$X / N` (con ajuste de centavos en la última cuota del lote) y recalculando el total real de la compra padre.
   - **Reversibilidad completa:** Registro por lote (`payment_batch`) que permite deshacer/anular el adelanto tanto desde la **Web** como mediante `[❌ Anular]` en **Telegram** (dentro de 24 h), restaurando `month_date`, `due_date`, `amount` e `is_paid = false`.
5. **Unificación de barra de Gustitos (`0% → 100%`) y Refactorización Visual del Dashboard:**
   - La barra de **Bolsa de Gustitos** pasa a ser **progresiva creciente (`0% → 100%`)**, idéntica en mecánica visual a la de *Comprometido*, cambiando a rojo semántico (`#EF4444`) al alcanzar o superar el `100%` (`gastado >= presupuesto`).
   - El Dashboard adopta una **vista ejecutiva mínima** en su cabecera (selector de mes, acciones rápidas, KPI protagonista `Disponible Real`, resumen compacto de ingresos/apartados/inversiones y las 2 barras `0% → 100%`), organizando todo el detalle operativo en **3 sub-pestañas internas**: `Resumen y Gráficos` (incluyendo `CategoryLimitsWidget`) | `Pendientes de Pago` | `Movimientos del Mes` (donde los compromisos abonados del mes también se visualizan en modo solo lectura con badge `Cuota pagada` / `Fijo pagado` sin duplicar su descuento en `Disponible Real`).
   - Reorganización de la navegación superior (`TopNavbar`) con menús desplegables limpios: **`Inversiones`** (`/savings`, `/fixed-terms`), **`Decisión`** (`/priority-matrix`, `/simulator`) y **`Herramientas`** (`/budget-assistant`, `/categories`, `/settings`), junto a `Dashboard`, `Movimientos` y `Fijos y Cuotas`.

#### Bloque B: Nuevos Módulos de Decisión e Inversiones
6. **Matriz de Prioridad Interactiva (`/priority-matrix`):**
   - Matriz cartesiana **2×2** con ejes explícitos (**Impacto** en el eje vertical izquierdo y **Costo** en el eje horizontal inferior) y 4 cuadrantes con **marca de agua translúcida** de su acción recomendada:
     1. *Alto Impacto / Bajo Costo* (`Prioridad inmediata`)
     2. *Alto Impacto / Alto Costo* (`Planificar / Ahorrar`)
     3. *Bajo Impacto / Bajo Costo* (`Evaluar si sobra cupo`)
     4. *Bajo Impacto / Alto Costo* (`Postergar / Descartar`)
   - Desktop: tarjetas compactas arrastrables (**solo grip, nombre y costo estimado**) con **HTML5 Drag & Drop nativo** entre cuadrantes.
   - Móvil táctil y teclado: pestañas por cuadrante (`useRovingTabs`).
   - Al hacer click sobre cualquier tarjeta se abre un **modal de acciones** para **Comprar y registrar gasto**, **Editar**, **Mover de cuadrante** o **Eliminar**; al elegir comprar, permite ingresar el **monto real pagado** (prellenado con el estimado, al contado o en cuotas), registrando el gasto real y eliminando el ítem de la matriz de manera **atómica**.
7. **Simulador de Gastos ("¿Qué pasa si...?" — `/simulator`):**
   - Herramienta efímera en frontend (sin persistencia en base de datos) que permite armar una **lista temporal combinada de 1 o varias compras hipotéticas** (al contado o en cuotas, Gustito o Fijo/Variable, con elección de inicio en el mes actual o mes siguiente), mostrando en tiempo real el impacto conjunto sobre el `Disponible Real`, el tope de Fijos, la Bolsa de Gustitos y la categoría afectada.
8. **Plazos Fijos conectados a la Bóveda de Ahorros (`/fixed-terms` y `/savings`):**
   - Registro desde Web y Telegram (texto/audio) con: entidad/nombre opcional, fecha de inicio, fecha de vencimiento, monto invertido, monto a recibir (o porcentaje de rendimiento / TNA en Telegram calculado determinísticamente) y origen del capital (`monthly_available` | `savings_fund`).
   - Bloqueo estricto si `origin = 'savings_fund'` supera el **saldo líquido disponible** en la Bóveda de Ahorros.
   - Aislamiento visual estricto: el capital inmovilizado nunca se suma al `Disponible Real`. En `/savings` se discrimina **Ahorro Líquido Disponible**, **Capital Inmovilizado en Plazos Fijos** y **Patrimonio Total Ahorrado** (todo protegido bajo privacidad `$ ••••••••` por defecto).
   - Al vencer (`hoy >= maturity_date`), pasa a estado **"Vencido — Pendiente de acreditar"** hasta que el usuario elige manualmente acreditar el retorno final (permitiendo confirmar/ajustar `actual_return_amount`) hacia **`savings_fund`** (por defecto, oculto del Disponible Real) o hacia **`monthly_available`** (sumándose al Disponible Real del mes de acreditación).
   - Alertas proactivas diarias (`daily-alerts` vía `pg_cron`) **3 días antes** y **el mismo día** del vencimiento.
9. **Asistente de Distribución de Presupuesto con IA (`/budget-assistant`):**
   - Página dedicada servida por la Edge Function (`budget-assistant`) que analiza el sueldo fijo, compromisos fijos y cuotas vigentes, categorías activas, **los últimos 3 meses con datos**, la **Matriz de Prioridad (`priority_items`)** y el **saldo líquido en Bóveda (`get_liquid_savings_balance`)**.
   - Acepta instrucciones por **texto (hasta 500 caracteres)** o mediante **grabación de audio con micrófono desde la pantalla (máximo 60 segundos)** usando `MediaRecorder` nativo, para responder planes de compra en $X$ meses sobre ítems de la matriz dentro del resumen principal.
   - Devuelve JSON estructurado con propuesta de `fixed_expenses_limit`, `gustitos_budget`, `monthly_savings_target` y límites por categoría de gasto, con botón `"Aplicar límites sugeridos"` en un clic, checkbox `"Aplicar también al mes en curso"` y aviso orientativo/legal visible.

### 1.3 Qué queda fuera de la Fase 3 (Out-of-Scope — Reservado para Fase 4)
- Tabla `profiles`, edición de nombre de usuario y foto de perfil.
- Bucket privado `avatars` en Supabase Storage con URLs firmadas.
- Cambio de contraseña desde el perfil.
- Deshabilitación de registro público, migración de `user_settings.is_admin` hacia `role` (`'admin' | 'user'`) y Panel de Administración (`/admin`) con Edge Functions `admin-*`.
- Keep-alive de Etapa 2 en Vercel (`/api/keep-alive` + `vercel.json`).

---

## 2. Reglas de Negocio y Fórmulas Exactas de la Fase 3

### 2.1 Fórmula Central de `Disponible Real`
Para cualquier período mensual $M$ (`YYYY-MM-01`):

$$\text{Disponible Real}_M = \text{Ingresos Totales}_M - \text{Apartado Fijos}_M - \text{Ahorro Neto Apartado}_M - \text{Variables No-Gustito}_M - \text{Gustitos Consumidos}_M - \text{Plazos Fijos desde Disponible}_M$$

Desglose exacto de cada término:
1. **$\text{Ingresos Totales}_M$:**
   $$\text{Sueldo Fijo}_M + \sum \text{Ingresos Extra}_M + \sum \text{Retornos Plazo Fijo acreditados a Disponible}_M$$
   - $\text{Retornos Plazo Fijo acreditados a Disponible}_M$: suma de `actual_return_amount` de registros en `fixed_term_deposits` con `status = 'accredited_available'` y `accredited_month_date = M`.
2. **$\text{Apartado Fijos}_M$:**
   $$\max\Big(\text{Límite Gastos Fijos}_M,\; \text{Fijos}_M + \text{Cuotas No-Gustito}_M + \text{Sobrante Fijos Trasladado a Ahorros}_M\Big)$$
   - $\text{Fijos}_M$: suma de `monthly_commitments` con `commitment_type = 'fixed_expense'` del mes $M$.
   - $\text{Cuotas No-Gustito}_M$: suma de `monthly_commitments` con `commitment_type = 'installment'` del mes $M$ que **no** pertenecen a Gustitos (`installment_purchases.is_gustito = false` y la categoría en el mes $M$ tiene `is_gustito = false`).
   - $\text{Sobrante Fijos Trasladado a Ahorros}_M$: suma de depósitos en `savings_entries` del mes $M$ con `source_type = 'cap_surplus_fixed'`. Incluirlo dentro del `max(...)` garantiza que trasladar el sobrante del tope a la Bóveda de Ahorros **no** produzca doble descuento cuando no se excede el límite, pero sí impacte si luego se agregan nuevos gastos que superen el tope junto con lo ya trasladado.
3. **$\text{Gustitos Consumidos}_M$ (Presupuesto incluido en `Disponible Real`):**
   $$\text{Gastado en Gustitos}_M + \text{Sobrante Gustitos Trasladado Histórico}_M$$
   - El **Presupuesto de Gustitos** (`gustitos_budget`) **no** se aparta ni se resta desde el día 1: permanece contenido dentro del `Disponible Real`.
   - $\text{Gastado en Gustitos}_M$: suma de `transactions` (`type = 'expense'`) de Gustitos + `monthly_commitments` (`commitment_type = 'installment'`) de Gustitos en el mes $M$. Al registrarse, descuenta tanto del saldo restante de la Bolsa de Gustitos (`budget - spent`) como del `Disponible Real`.
4. **$\text{Ahorro Neto Apartado}_M$:**
   $$\text{Ahorro Mensual Objetivo}_M + \sum \text{Aportes a Ahorros Operativos}_M$$
   - $\text{Aportes a Ahorros Operativos}_M$: suma de `savings_entries` del mes $M$ con `entry_type = 'deposit'` cuyo `source_type IN ('manual', 'direct_income')`.
   - **Regla contable crítica (sin doble descuento):** Los depósitos con `source_type IN ('cap_surplus_fixed', 'cap_surplus_gustitos', 'fixed_term_return')` **incrementan la Bóveda de Ahorros** pero **no** se suman aquí, porque su origen ya fue apartado en los topes o proviene de un plazo fijo vencido.
5. **$\text{Variables No-Gustito}_M$:**
   - Suma de `transactions` del mes $M$ con `type = 'expense'` que **no** son Gustito (`transactions.is_gustito = false` y su categoría en $M$ tiene `is_gustito = false`).
   - *(Los gastos variables que sí son Gustito ya están contabilizados en $\text{Gastado en Gustitos}_M$; excluirlos aquí evita descontarlos dos veces).*
6. **$\text{Plazos Fijos desde Disponible}_M$:**
   - Suma de `principal_amount` de `fixed_term_deposits` con `origin = 'monthly_available'`, `status != 'cancelled'` y `date_trunc('month', start_date) = M`.

### 2.2 Cálculo de Sobrante Transferible de Gastos Fijos y Cierre de Período
Para cualquier mes $M$ inicializado:
- **Sobrante de Límite de Fijos ($M$):**
  $$\text{Sobrante Fijos}_M = \max\Big(0,\; \text{Límite Gastos Fijos}_M - \text{Fijos}_M - \text{Cuotas No-Gustito}_M - \text{Trasladado Fijos}_M\Big)$$
- *(El presupuesto de Gustitos ya forma parte del `Disponible Real`, por lo que la alerta y el modal de cierre aplican únicamente al sobrante de Límite de Gastos Fijos).*
- **Acciones permitidas (solo si $\text{Sobrante Fijos}_M > 0$, eligiendo monto parcial o total $\le \text{Sobrante Fijos}_M$):**
  1. **Enviar a Bóveda de Ahorros:** Registra un `deposit` en `savings_entries` del mes $M$ con `source_type = 'cap_surplus_fixed'`. La Bóveda sube y el `Disponible Real` de $M$ no sufre doble descuento.
  2. **Liberar al Disponible Real:**
     - **En el mes en curso:** Reduce `fixed_expenses_limit` en `monthly_budgets` por el monto liberado (garantizando que nunca quede por debajo de `gastado + trasladado`), aumentando de inmediato el `Disponible Real` de ese mes.
     - **Al cerrar el mes anterior desde la ventana de cierre (en el mes nuevo):** Reduce `fixed_expenses_limit` del mes cerrado $M_{\text{prev}}$ por el monto liberado y registra un `income` trazable en el mes en curso $M_{\text{actual}}$ (`"Remanente Límite Fijos mes anterior"`) para trasladar esa liquidez al nuevo período.
- **Disparador de Revisión de Cierre (`<= 3` días para fin de mes) y Día de Cobro (`salary_payday`):**
  - `user_settings.salary_payday` admite `0` (**último día hábil del mes**, lunes a viernes) o `1..31` (**día fijo del mes**, default `1`).
  - La revisión proactiva de cierre (banner en Dashboard y alerta diaria en Telegram `daily-alerts` a las 08:00 AM locales vía `fixed_cap_surplus_closing`) se activa **únicamente cuando faltan 3 días o menos para terminar el mes** ($\text{días\_del\_mes} - \text{día\_local} \le 3$) o en meses anteriores ya finalizados, siempre que $\text{Sobrante Fijos}_M > 0$ y `surplus_review_completed_at IS NULL`.
  - Como acceso manual en cualquier momento del mes (sin ensuciar la barra superior), el usuario dispone del botón discreto `"Revisar sobrante"` dentro de la tarjeta de **Comprometido (Fijos + Cuotas)** del Dashboard.

### 2.3 Barra Progresiva de Bolsa de Gustitos (`0% → 100%`)
$$\text{Uso Gustitos}_M(\%) = \frac{\text{Gastado en Gustitos}_M}{\text{Presupuesto Gustitos}_M} \times 100$$
- La barra crece de izquierda a derecha de `0%` a `100%` (anchura visual acotada a `min(100, max(0, Uso))`).
- Muestra en grande el **Presupuesto asignado** y el monto **Gastado** (más el saldo restante o excedido).
- Colores:
  - Si $\text{Uso} < 100\%$ (`gastado < presupuesto`): barra en amarillo de marca (`#FACC15`).
  - Si $\text{Uso} \ge 100\%$ (`gastado >= presupuesto`): tarjeta, badge y barra en **rojo semántico (`#EF4444`)**, manteniendo el disparo de la alerta inmediata en Telegram al cruzar o permanecer en `>= 100%`.

### 2.4 Adelanto / Pago Múltiple de `N` Cuotas
- **Selección cronológica:** Dado un `installment_purchase_id` y una cantidad $N \ge 1$, se seleccionan estrictamente las $N$ primeras cuotas pendientes (`is_paid = false ORDER BY installment_number ASC LIMIT N`). Si hay menos de $N$ pendientes, se rechaza la operación informando cuántas cuotas pendientes quedan realmente.
- **Mes contable destino:** Siempre el **mes calendario actual** del usuario (`YYYY-MM-01` local). Si alguna de las $N$ cuotas ya estaba en un mes futuro, su `month_date` pasa al mes calendario actual y `is_paid = true`, `paid_at = NOW()`.
- **Ajuste de monto total `$X`:**
  - Si no se especifica `$X`, cada cuota conserva su monto original.
  - Si se especifica un monto total `$X`: debe cumplir $X \ge N \times 0{,}01$ (para garantizar que ninguna cuota quede en `$0,00`), operando en centavos enteros tanto en frontend como en PostgreSQL:
    $$\text{base} = \frac{\lfloor \text{centavos}(X) / N \rfloor}{100}, \qquad \text{resto} = X - (\text{base} \times N)$$
    Las primeras $N - 1$ cuotas del lote toman `amount = base` y la $N$-ésima cuota del lote toma `amount = base + resto` (garantizando suma exacta al centavo).
  - Se recalcula `installment_purchases.total_amount = SUM(monthly_commitments.amount)` de toda la compra.
- **Trazabilidad y Reversión (Web y Telegram `[❌ Anular]`):**
  - Antes de mutar cada cuota se preservan sus valores originales (`original_month_date`, `original_due_date`, `original_amount`) y se agrupan en un lote (`installment_payment_batches`).
  - Al anular/deshacer el lote: todas las cuotas del lote vuelven a `is_paid = false`, `paid_at = NULL`, `month_date = original_month_date`, `due_date = original_due_date`, `amount = original_amount`, se limpian las columnas `original_* = NULL` para no contaminar re-adelantos posteriores si luego se edita la compra, y se recalcula `installment_purchases.total_amount`.

### 2.5 Plazos Fijos e Integración con la Bóveda de Ahorros
- **Saldo Líquido vs. Capital Inmovilizado:**
  - `Saldo Líquido Bóveda` = Metas mensuales congeladas hasta mes actual + Depósitos en `savings_entries` - Retiros en `savings_entries` (incluyendo salidas por constitución de plazos fijos con `origin = 'savings_fund'`).
  - `Capital Inmovilizado` = Suma de `principal_amount` de `fixed_term_deposits` con `status = 'active'`.
  - Si `origin = 'savings_fund'`, se exige $\text{principal\_amount} \le \text{Saldo Líquido Bóveda}$.
  - Si `origin = 'monthly_available'`, se descuenta del `Disponible Real` del mes de `start_date` sin consumir el saldo de la Bóveda.
- **Cálculo determinístico en Telegram por `%` o TNA:**
  - Si el usuario indica monto a recibir explícito: se usa ese valor.
  - Si indica un rendimiento porcentual $r\%$ del período (ej. *"a 30 días con 3,5% de rendimiento"*): $\text{monto\_a\_recibir} = \text{round}(\text{capital} \times (1 + r/100), 2)$.
  - Si indica explícitamente tasa nominal anual ($r\%$ TNA / anual) y plazo $d$ días: $\text{monto\_a\_recibir} = \text{round}(\text{capital} \times (1 + (r/100) \times (d / 365)), 2)$.
  - Si no indica ni monto a recibir ni rendimiento/tasa, el bot pregunta el monto o rendimiento antes de guardar.

---

## 3. Historias de Usuario y Flujos Principales (*Happy Path*)

### Bloque A — Refinamiento Core y Telegram

#### US-3.1 — Configuración de Día de Cobro y Revisión de Sobrante de Gastos Fijos
- **Como** usuario de SB-Finance,
- **Quiero** configurar mi día de cobro habitual (incluyendo la opción **"Último día hábil del mes"**) y recibir un recordatorio automático en los últimos 3 días del mes (web y Telegram) cuando sobre saldo en el tope de Gastos Fijos,
- **Para** asegurarme de no haber olvidado registrar gastos y decidir si ese sobrante va a mi Bóveda de Ahorros o se libera al Disponible Real.
- **Flujo principal:**
  1. En `/settings`, elige entre `"Último día hábil del mes (lun–vie)"` (`0`) o `"Día fijo del mes (1–31)"` junto a `Sueldo fijo mensual`.
  2. Cuando faltan `<= 3` días para fin de mes (o al entrar manualmente desde `"Revisar sobrante"` dentro de la tarjeta de Comprometido/Fijos) y `fixedCapSurplus > 0`, el sistema muestra el aviso de **Revisión de Cierre** (y envía 1 alerta por Telegram vía `daily-alerts`):
     - Paso 1: Muestra un recordatorio *"¿Te olvidaste de registrar algún gasto?"* con acceso directo al modal de carga rápida.
     - Paso 2: Muestra el sobrante exacto de `Límite de Gastos Fijos`, permitiendo elegir monto parcial o total (`<= sobrante`) y seleccionar **"Enviar a Bóveda de Ahorros"** o **"Liberar al Disponible Real"**.
  3. Al confirmar, se actualiza la Bóveda / el `Disponible Real` sin doble descuento y queda registrado el cierre del período.

#### US-3.2 — Cuotas de Gustitos aisladas del Límite de Fijos
- **Como** usuario que compra algo discrecional en cuotas (ej. ropa o entradas en 3 cuotas),
- **Quiero** que esas cuotas consuman únicamente mi **Bolsa de Gustitos** y no mi límite de **Gastos Fijos**,
- **Para** no distorsionar mi presupuesto de compromisos esenciales mientras mantengo visible cada vencimiento en **Pendiente de Abonar**.
- **Flujo principal:**
  1. El usuario crea una compra en cuotas en una categoría marcada como Gustito (o tildando `Contar en Bolsa de Gustitos`).
  2. En el Dashboard y en `/commitments`, la barra de **Comprometido (Fijos + Cuotas)** no incluye esa cuota, mientras la barra de **Bolsa de Gustitos** sí refleja su monto mensual.
  3. En la sub-pestaña **Pendientes de Pago** y en `/commitments`, la cuota aparece normalmente con el badge `Gustito` para poder tildarla como pagada.

#### US-3.3 — Adelanto / Pago Múltiple de `N` Cuotas (Web y Telegram)
- **Como** usuario con compras en cuotas activas,
- **Quiero** adelantar varias cuotas pendientes juntas en el mes actual (opcionalmente con un monto total con descuento), tanto en la Web como por Telegram,
- **Para** reflejar pagos anticipados en mi flujo de caja real del mes y liberar los meses futuros.
- **Flujo principal (Web):**
  1. En `/commitments` (tarjeta de la compra en cuotas), presiona `"Adelantar cuotas"`.
  2. Elige cuántas cuotas pendientes adelantar (`N`, por defecto 1..restantes) y opcionalmente modifica el `Monto total abonado` (ej. `$65.000` en lugar de `$70.000`).
  3. El sistema muestra una vista previa de qué cuotas (`Cuota 3/6`, `Cuota 4/6`) pasarán al mes calendario actual como pagadas y el valor unitario resultante.
  4. Al confirmar, se ejecuta la RPC atómica y la tarjeta ofrece la opción `"Deshacer último adelanto"` si se cometió un error.
- **Flujo principal (Telegram texto/audio):**
  1. Envía *"Pagué 2 cuotas de las zapatillas por un total de 65.000"*.
  2. El bot envía `"⏳ Mensaje recibido, estamos procesando la transacción..."`, identifica `intent = 'pay_installments'`, busca la compra activa coincidente (si hay ambigüedad, presenta botones inline para elegir la compra), ejecuta el adelanto en el mes local actual y responde con el detalle de las cuotas adelantadas, el impacto en Gustitos/Límite si aplica y el botón `[❌ Anular]`.

#### US-3.4 — Dashboard Ejecutivo Mínimo con Sub-pestañas y Barra Creciente de Gustitos
- **Como** usuario que entra a diario al Dashboard,
- **Quiero** ver de un vistazo solo mi `Disponible Real`, resumen compacto y las dos barras consistentes `0% → 100%`,
- **Para** evitar saturación visual y profundizar en gráficos, pendientes o movimientos únicamente cuando lo necesito.
- **Flujo principal:**
  1. La cabecera ejecutiva muestra de forma limpia y compacta (garantizando visibilidad de `Disponible Real` en el primer pantallazo tanto en desktop como en mobile `390px`): selector de mes, acciones rápidas (`+ Movimiento`, `+ Compra en Cuotas`, `+ Plazo Fijo`), el KPI protagonista `Disponible Real` con resumen ejecutivo en 1 línea y desglose contable único (con detalle algebraico bajo demanda), resumen compacto de Ingresos (con acceso a `"Editar topes"` del mes), y las 2 barras `0% → 100%` (*Comprometido* y *Bolsa de Gustitos*).
  2. Debajo, 3 sub-pestañas accesibles (`Resumen y Gráficos` | `Pendientes de Pago` | `Movimientos del Mes`) cargan y muestran únicamente la sección elegida (`CategoryLimitsWidget` + gráficos Recharts en `Resumen y Gráficos`, y buscador rápido + filtros esenciales en `Movimientos del Mes`).

---

### Bloque B — Módulos de Decisión e Inversiones

#### US-3.5 — Matriz de Prioridad Interactiva (`/priority-matrix`)
- **Como** usuario que planifica futuras compras,
- **Quiero** ordenar mis deseos de compra en una matriz cartesiana de 4 cuadrantes (*Impacto* en el eje Y vs. *Costo* en el eje X) con tarjetas compactas arrastrables,
- **Para** decidir qué compra me aporta más valor primero y registrar el monto real gastado cuando decida adquirirla.
- **Flujo principal:**
  1. El usuario accede a `Decisión → Matriz de Prioridad` (`/priority-matrix`) (con sub-navegación contextual hacia `/simulator`) y crea un ítem indicando nombre, costo estimado, categoría opcional y cuadrante inicial.
  2. En desktop arrastra las tarjetas compactas (grip + título + costo estimado) entre los 4 cuadrantes con **HTML5 Drag & Drop** sobre marcas de agua translúcidas; en móvil o teclado utiliza las pestañas por cuadrante (`useRovingTabs`).
  3. Al hacer click sobre cualquier tarjeta se abre el modal de acciones (**Comprar y registrar gasto**, **Editar**, **Mover de cuadrante** o **Eliminar**). Al elegir comprar, ingresa el **monto real pagado** (prellenado con el costo estimado, al contado o en cuotas); la creación del registro financiero y la eliminación del ítem de la matriz se ejecutan de manera **atómica**.

#### US-3.6 — Simulador de Gastos ("¿Qué pasa si...?" — `/simulator`)
- **Como** usuario antes de realizar una o más compras importantes,
- **Quiero** simular el impacto combinado de gastos hipotéticos al contado o en cuotas sin guardar nada en mi cuenta,
- **Para** saber si mi `Disponible Real`, mi tope de Fijos, mi Bolsa de Gustitos o el límite de una categoría soportan la decisión.
- **Flujo principal:**
  1. El usuario accede a `Decisión → Simulador de Gastos` (`/simulator`), que carga como línea base el estado real del mes actual (y del mes próximo si simula cuotas futuras); si la carga inicial falla, muestra un error explícito con reintento (nunca simula silenciosamente sobre `$0`).
  2. En desktop, el constructor de ítems (izquierda) convive lado a lado con el panel comparativo en vivo fijo/sticky (derecha) y en mobile muestra una barra resumen compacta arriba, permitiendo ver cada cambio sin perder contexto ni hacer scroll constante.
  3. En tiempo real ve la comparativa **Actual vs. Simulado** para `Disponible Real`, `% de Comprometido` (alerta roja consistente al `>= 100%`), `% de Gustitos` y categoría afectada, con botón para limpiar o convertir la simulación en un registro real.

#### US-3.7 — Plazos Fijos Conectados a la Bóveda de Ahorros (`/fixed-terms`, `/savings` y Telegram)
- **Como** usuario inversor conservador,
- **Quiero** registrar mis plazos fijos indicando si salen de mi Disponible del Mes o de mi Bóveda de Ahorros, y decidir qué hacer al vencimiento,
- **Para** saber cuánto capital tengo inmovilizado, recibir avisos antes de que venzan y no mezclar ese dinero con mi saldo gastable diario.
- **Flujo principal (Web):**
  1. En `Inversiones → Plazos Fijos` (`/fixed-terms`), crea un plazo fijo con entidad opcional, monto invertido, monto a recibir, fecha de inicio, fecha de vencimiento y origen (`Disponible Real del Mes` | `Bóveda de Ahorros`).
  2. Si elige `Bóveda de Ahorros`, valida que alcance el saldo líquido; si elige `Disponible del Mes`, resta del `Disponible Real` del mes de inicio.
  3. Al llegar `maturity_date`, el estado pasa a *"Vencido — Pendiente de acreditar"*. El usuario presiona `"Acreditar vencimiento"`, confirma/ajusta el monto final recibido y elige **`Bóveda de Ahorros` (por defecto)** o **`Disponible Real del Mes`**.
- **Flujo principal (Telegram texto/audio y Alertas):**
  1. El usuario envía *"Puse un plazo fijo de 100.000 a 30 días con un 3,5% de rendimiento"* (o *"recibo 103.500"*).
  2. La IA extrae capital, plazo y rendimiento; el servidor calcula determinísticamente `maturity_date` y `expected_return_amount = $103.500`. Como falta el origen del capital, el bot pregunta con botones inline (`💰 Disponible del Mes` | `🏦 Bóveda de Ahorros`).
  3. Al tocar un botón, persiste el plazo fijo (validando saldo líquido si es `savings_fund`) y envía confirmación con botón `[❌ Anular]`.
  4. `daily-alerts` notifica a las 08:00 AM locales **3 días antes** y **el mismo día** de `maturity_date`.

#### US-3.8 — Asistente de Distribución de Presupuesto con IA (`/budget-assistant`)
- **Como** usuario que busca optimizar sus finanzas y planificar compras de mi matriz,
- **Quiero** consultar al asistente por texto o audio (hasta 60 segundos) para que analice mis últimos 3 meses, mi sueldo fijo, mis compromisos, mi Bóveda y mi Matriz de Prioridad,
- **Para** recibir límites realistas, un plan de compra en el resumen principal y aplicar la distribución en un clic.
- **Flujo principal:**
  1. El usuario entra a `Herramientas → Asistente de Presupuesto IA` (`/budget-assistant`), escribe una meta/consulta (ej. *"Quiero comprarme X ítem de mi matriz en 3 meses, ¿cómo me planifico?"*) y/o graba un audio de hasta 60 segundos con el micrófono, y presiona `"Analizar y sugerir presupuesto"`.
  2. La Edge Function `budget-assistant` analiza sueldo fijo, fijos + cuotas actuales, últimos 3 meses con datos, `priority_items` y saldo líquido en Bóveda, devolviendo límites sugeridos y la explicación/plan dentro del resumen principal (`summary_reasoning`) junto a un aviso orientativo.
  3. El usuario revisa la tabla comparativa (*Actual vs. Sugerido*), decide si tildar `"Aplicar también al mes en curso"` y presiona `"Aplicar límites sugeridos"`.

---

## 4. Casos Borde (*Edge Cases*), Validaciones y Manejo de Errores

1. **Doble descuento al trasladar sobrantes:**
   - Si el usuario traslada `$30.000` de sobrante del tope de Fijos a Ahorros y posteriormente registra un gasto fijo olvidado de `$10.000` en el mismo mes, la fórmula `max(Límite, Gastado + Trasladado)` absorbe los primeros `$0` excedentes hasta el tope y refleja el excedente real si `Gastado + Trasladado > Límite`, impidiendo que el usuario retire/traslade más de `$30.000` en total (`sobrante <= 0` bloquea nuevos traslados).
2. **Adelanto de cuotas mayor al saldo pendiente:**
   - Si una compra tiene 2 cuotas pendientes y el usuario pide adelantar 3 (en Web o Telegram), el sistema rechaza la operación con mensaje explícito: *"Solo quedan 2 cuotas pendientes para esta compra"*.
3. **Anulación `[❌ Anular]` de `pay_installments` tras modificación posterior:**
   - Si luego de adelantar 2 cuotas por Telegram el usuario anula la compra completa en la Web o deshace manualmente una cuota del lote, `[❌ Anular]` verifica idempotencia y consistencia del lote antes de revertir, informando si ya fue revertido o eliminado en la Web.
4. **Saldo líquido insuficiente en Bóveda para Plazo Fijo (`savings_fund`):**
   - Si la Bóveda tiene `$150.000` acumulados pero `$100.000` están inmovilizados en un Plazo Fijo activo, el saldo líquido real es `$50.000`. Intentar constituir otro plazo fijo de `$80.000` desde `savings_fund` (desde Web o Telegram) es bloqueado atómicamente en PostgreSQL.
5. **Plazo Fijo en Telegram con tasa vs. monto:**
   - Si el usuario no indica ni monto a recibir ni `%` de rendimiento, el bot nunca inventa una tasa y entra en `awaiting_fixed_term_return` pidiéndole cuánto va a recibir o qué porcentaje rinde. Si indica `monto a recibir < monto invertido`, se valida y pide confirmación o corrección (`expected_return_amount >= principal_amount`).
6. **Drag & Drop en dispositivos táctiles y accesibilidad:**
   - En iOS/Android donde HTML5 Drag & Drop no dispara eventos touch nativos, los controles de cambio de cuadrante en cada tarjeta (`Mover a...`) y los filtros por cuadrante garantizan la paridad total de operación con área táctil `>= 44px`.
7. **Asistente IA con historial insuficiente (< 3 meses), sueldo en `$0` y control de cuota:**
   - Si el usuario tiene menos de 3 meses de historial (incluso 0 movimientos), el asistente igual analiza el sueldo fijo, plantillas fijas y cuotas vigentes (advirtiendo si el mes actual está recién iniciado); si el sueldo fijo es `$0`, muestra un estado preventivo claro invitando a configurarlo antes de generar la propuesta.
   - Las invocaciones están protegidas por rate limit por usuario (`budget_assistant_logs`) y tiempo de espera acotado para evitar agotamiento de cuota o cuelgues.
8. **Acreditación anticipada o con pérdida en Plazos Fijos:**
   - Si el usuario intenta acreditar antes de `maturity_date` o ingresa un retorno final inferior al capital invertido (`actual_return_amount < principal_amount`), el modal muestra una advertencia explícita y valida que `accredited_date >= start_date`.
9. **Seguridad y aislamiento:**
   - Todas las tablas nuevas (`fixed_term_deposits`, `priority_items`, `installment_payment_batches`, `budget_assistant_logs`) tienen RLS estricto por `auth.uid() = user_id` y FKs compuestas `(category_id, user_id)` donde corresponda. Las mutaciones contables sensibles (`fixed_term_deposits`, `installment_payment_batches`, `savings_entries` no manuales) solo pueden ejecutarse mediante sus RPCs transaccionales. Ningún dato de Fase 4 (`profiles`, `avatars`, RBAC `role`) es creado o alterado.

---

## 5. Criterios de Aceptación Verificables (Dado / Cuando / Entonces)

### CA-3.1 — Fórmula de Disponible Real y Sobrante de Gastos Fijos
- **Dado** un mes con Sueldo `$1.000.000`, Límite Fijos `$300.000` (gastado `$250.000`), Presupuesto Gustitos `$100.000` (gastado `$80.000`), Ahorro Meta `$150.000`, Variables No-Gustito `$50.000` y Plazo Fijo desde Disponible `$100.000`,
- **Cuando** el Dashboard consolida el resumen del mes,
- **Entonces** `Disponible Real` es `$1.000.000 - $300.000 - $150.000 - $50.000 - $80.000 - $100.000 = $320.000` (incluyendo los `$20.000` restantes del cupo de Gustitos dentro del Disponible Real); al registrar otro gustito de `$10.000`, el disponible de Gustitos baja a `$10.000` y el `Disponible Real` baja a `$310.000`; y si el usuario traslada `$50.000` del sobrante de Fijos a la Bóveda de Ahorros, la Bóveda suma `$50.000` y el `Disponible Real` permanece sin doble descuento.

### CA-3.2 — Cuotas de Gustitos aisladas de Comprometido
- **Dado** una compra de 3 cuotas de `$20.000` en una categoría marcada como Gustito,
- **Cuando** se evalúa el mes de cada cuota,
- **Entonces** `Fijos + Cuotas No-Gustito` no suma los `$20.000`, `Gastado en Gustitos` sí suma `$20.000` (descontando de la Bolsa de Gustitos y del `Disponible Real`) y la cuota aparece en `Pendientes de Pago` con la etiqueta `Gustito`.

### CA-3.3 — Adelanto de `N` Cuotas con Descuento y Reversión
- **Dado** una compra con cuotas `2/6` a `6/6` pendientes de `$30.000` cada una,
- **Cuando** el usuario adelanta `2` cuotas por un total de `$55.000` (desde Web o Telegram),
- **Entonces** las cuotas `2/6` y `3/6` pasan al `month_date` del mes calendario actual con `is_paid = true`, montos `$27.500` y `$27.500` (o ajuste de centavos en `3/6` si no es divisible por 2), `total_amount` del padre se recalcula, las cuotas desaparecen de los meses futuros, y presionar `"Deshacer adelanto"` o `[❌ Anular]` las devuelve a `is_paid = false` con sus `month_date` y montos originales.

### CA-3.4 — Barra Creciente de Gustitos y Dashboard Ejecutivo
- **Dado** un `Presupuesto Gustitos = $100.000` y `Gastado = $100.000`,
- **Cuando** el usuario visualiza la cabecera del Dashboard,
- **Entonces** la barra de Bolsa de Gustitos muestra `100%` de progreso de izquierda a derecha en rojo semántico (`#EF4444`), y el contenido operativo detallado se encuentra organizado en las sub-pestañas `Resumen y Gráficos`, `Pendientes de Pago` y `Movimientos del Mes`.

### CA-3.5 — Matriz de Prioridad Interactiva
- **Dado** un ítem en el cuadrante `Alto Impacto / Alto Costo`,
- **Cuando** el usuario lo arrastra en desktop (o abre la tarjeta y elige el cuadrante en el modal),
- **Entonces** su cuadrante se persiste inmediatamente en `priority_items`; y al hacer click en la tarjeta para elegir **Comprar**, ajustar el **monto real pagado** y confirmar, la creación del registro financiero y la eliminación del ítem de la matriz ocurren de forma atómica.

### CA-3.6 — Simulador Efímero
- **Dado** un usuario en `/simulator` agregando 2 ítems hipotéticos combinados (un gasto al contado Gustito y una compra en 3 cuotas Fijas),
- **Cuando** evalúa el impacto (pasando cualquier tope al `>= 100%`) y luego recarga la página o sale de la ruta,
- **Entonces** el simulador muestra los indicadores superados en rojo desde el `100%` inclusive (consistente con el Dashboard) y ningún movimiento hipotético queda persistido en `transactions`, `installment_purchases` ni `monthly_commitments`.

### CA-3.7 — Plazos Fijos, Aislamiento, Vencimiento y Telegram
- **Dado** un Plazo Fijo de `$100.000` constituido desde `monthly_available` con retorno esperado `$104.000`,
- **Cuando** está activo,
- **Entonces** el `Disponible Real` del mes de inicio se reduce en `$100.000`, el capital nunca se suma al `Disponible Real`, `daily-alerts` notifica por Telegram 3 días antes y el día del vencimiento, y al vencer y acreditarse hacia `savings_fund` suma `$104.000` en `/savings` sin afectar el `Disponible Real`. Si el usuario elige acreditar hacia `monthly_available`, suma `$104.000` al `Disponible Real` del mes de acreditación.

### CA-3.8 — Asistente de Presupuesto con IA (Matriz + Audio 60s)
- **Dado** un usuario con sueldo fijo configurado, historial reciente, Bóveda e ítems en Matriz de Prioridad,
- **Cuando** solicita una propuesta por texto o grabando un audio de hasta 60 segundos (ej. preguntando cómo planificar una compra de su matriz en 3 meses) y presiona `"Aplicar límites sugeridos"`,
- **Entonces** la Edge Function devuelve JSON válido con recomendaciones y plan en el resumen principal, muestra el aviso orientativo y actualiza atómicamente `user_settings` (y `monthly_budgets` / `monthly_category_snapshots` del mes actual si el checkbox está activo).
