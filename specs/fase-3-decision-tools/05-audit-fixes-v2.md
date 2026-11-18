# Auditoría Integral SDD v2 y Plan de Correcciones — Fases 1–3 (SB-Finance)

> **Versión:** 2.0.0  
> **Fecha de auditoría:** 2026-11-16  
> **Documentos contrastados:** `specs/constitution.md`, `specs/product_roadmap.md`, `specs/fase-1-core/*`, `specs/fase-2-automation/*`, `specs/fase-3-decision-tools/01-functional-spec.md`, `specs/fase-3-decision-tools/02-tech-spec.md`.  
> **Áreas auditadas:** QA Funcional, Seguridad BaaS/RLS y Auditoría UX/UI.  
> **Regla de aislamiento:** Las tareas dentro de una misma oleada paralela tienen **intersección cero de archivos**.

---

## 1. Resumen Ejecutivo

- **Dictamen General:** **REQUIERE CORRECCIONES CRÍTICAS** antes de operar en producción con Telegram y cuentas reales.
- **Compilación y Seguridad Estática (Baseline actual):**
  - `npx tsc --noEmit`: **PASS** (`0` errores).
  - `deno check` en las 6 Edge Functions y 6 `supabase/deploy-bundles/*.ts`: **PASS** (`0` errores, bundles `IN_SYNC`).
  - Secretos en `src/` y `dist/`: **PASS** (`0` claves privadas expuestas).
  - Auditoría estática UI/UX (`src/`): **PASS** (`0` hallazgos bloqueantes).
- **Qué está sólido:** La fórmula de `Disponible Real` (con Gustitos integrado y descontado al gastarse) coincide término a término entre `useDashboardData.ts`, `getSixMonthsEvolution` y `useExpenseSimulator.ts`; la aritmética en centavos (`toCents`/`roundCurrency`) es consistente entre frontend y Edge; y `fixedTermsService`, `priorityMatrixService` y `budgetAssistantService` validan con Zod y ejecutan RPCs atómicas.

---

## 2. Diagnóstico Exacto de Incidentes Reportados

### 2.1 Incidente 1 — Audio por Telegram para pagar 2 cuotas restantes de *"Zapatillas"*
- **Síntoma:** Existía una compra en 3 cuotas (`1/3` pagada en noviembre; `2/3` y `3/3` pendientes). Al enviar un audio por Telegram pidiendo pagar las 2 cuotas restantes, llegó `"⏳ Mensaje recibido, estamos procesando la transacción..."`, el log mostró `POST | 200` y `shutdown` 91s después, pero nunca llegó confirmación ni se pagaron las 2 cuotas.
- **Causas raíz encadenadas:**
  1. **Bloqueo por `sb_secret_` en todas las RPCs duales (`AUD-01`):** Las 4 RPCs (`advance_installments`, `revert_installment_payment_batch`, `create_fixed_term_deposit`, `cancel_fixed_term_deposit`) son `SECURITY DEFINER` y validan únicamente `current_setting('request.jwt.claim.role', true) = 'service_role'`. Con claves `sb_secret_...` ese claim queda vacío, provocando `'No autenticado'` en toda llamada desde `supabaseAdmin`.
  2. **Silencio en `sendTelegramMessage` (`_shared/telegramApi.ts:92-96`):** Ante `!res.ok`, retorna `null` sin lanzar ni reintentar en texto plano, y ningún caller valida `null`.
  3. **Sin `AbortSignal.timeout` ni fallback de modelo en Telegram (`_shared/telegramIntentProcessor.ts:37-38, 914-921`):** Hardcodea `gemini-3.8-flash` sin `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` (`gemini-2.5-flash`) ni timeout en `fetch`.
  4. **Webhook síncrono + deduplicación temprana (`telegram-webhook/index.ts:141-150, 891-1091`):** Inserta `update_id` antes de procesar y bloquea esperando Gemini/DB antes de responder `200`.
  5. **Contexto insuficiente para frases sin dígito (`_shared/telegramIntentProcessor.ts:809-869, 1046`):** No envía las `installment_purchases` pendientes al prompt y `findMatchingPurchases` coincide stop-words de `>= 2` letras (`"de"`, `"la"`).

### 2.2 Incidente 2 — Pago de la 1.ª cuota no visible en **Movimientos**
- **Causa:** `toggleCommitmentPaidStatus` (`commitmentsService.ts:452-475`) y `advanceInstallments` (`commitmentsService.ts:528-564`) solo actualizan `monthly_commitments` y nunca insertan en `transactions` (hacerlo causaría **doble descuento** en `Disponible Real`, `Gustitos`, `categoryLimits` y `Evolución 6 meses`).
- **Decisión aprobada (Opción A):** Mostrar los compromisos abonados (`monthly_commitments` con `is_paid = true`) en `/transactions` y en la pestaña `Movimientos del Mes` del Dashboard en modo **solo lectura**, con badge `Cuota pagada` / `Fijo pagado` y enlace a `/commitments`, manteniendo intactos los totales de `Gastos Variables` y `Disponible Real`.

### 2.3 Incidente 3 — Solicitud en cola de Telegram (`telegram_pending_requests`) sin procesarse ni expirar tras >13 horas
- **Síntoma:** Tras recibir el aviso `"⚠️ Problema temporal en el servicio de IA... Tus datos quedaron guardados"`, pasaron 13 horas sin registrarse el gasto **ni** enviarse el mensaje automático de expiración a las 2 horas (`process-telegram-queue/index.ts:132-137`).
- **Causas raíz:**
  1. **Gateway JWT bloqueando `pg_cron` (`20261116000002_phase2_audit_fixes.sql:282-289` vs `process-telegram-queue/index.ts:85-88`):** El cron SQL `sb-finance-process-telegram-queue` llama por `net.http_post` enviando **únicamente `X-Cron-Secret`** (sin header `Authorization`). Si `process-telegram-queue` (o `daily-alerts`) está desplegada en Cloud con `Verify JWT = ON` (valor por defecto en Supabase), el gateway rechaza cada ejecución con `HTTP 401` antes de llegar al código.
  2. **Dependencia de `Supabase Vault` sin validación visible (`20261116000002:283-286`):** Si en `vault.decrypted_secrets` faltan o difieren `supabase_project_url` o `cron_internal_secret` (vs `CRON_INTERNAL_SECRET`), `pg_cron` falla silenciosamente.
  3. **Filas atascadas en `'processing'` (`AUD-06`) y falta de fallback Gemini:** Si una ejecución reclamó la fila (`status = 'processing'`) y cayó por timeout sin `AbortSignal.timeout`, Paso A y Paso B (`:105, :145`) solo leen `status = 'pending'`, dejando la fila trabada para siempre. Además `callGeminiFlash` carece de fallback a `gemini-2.5-flash`.

---

## 3. Catálogo Consolidado de Hallazgos

| ID | Severidad | Ubicación | Descripción del Hallazgo | Tarea |
| :--- | :---: | :--- | :--- | :---: |
| **AUD-01** | **Alta** | `20261117000002_phase3_audit_fixes.sql:224,284,440,528,994` | `sb_secret_` falla en `advance_installments`, `revert_installment_payment_batch`, `create_fixed_term_deposit`, `cancel_fixed_term_deposit` (`SECURITY DEFINER` + solo `request.jwt.claim.role`) y `get_liquid_savings_balance` (`current_user` omite `'service_role'`). | `T3B-01` |
| **AUD-02** | **Alta** | `20261117000002_phase3_audit_fixes.sql:782-958` | `reconcile_cap_surplus` aún acepta `p_bucket = 'gustitos'` y `p_action = 'to_available'`, pudiendo generar ingresos fantasma duplicados. | `T3B-01` |
| **AUD-03** | **Alta** | `src/hooks/useDashboardData.ts:428-429` | `isOverFixedLimit` usa `>` estricto en lugar de `>= 100%` (divergencia con Simulador, `financeHelpers.ts` y `daily-alerts`). | `T3B-05` |
| **AUD-04** | **Alta** | `supabase/functions/_shared/financeHelpers.ts:408` | `computeGustitosStatus` omite `\|\| spent > 0` en `isConfigured`, silenciando alertas de Telegram cuando hay gastos `is_gustito = true` sin categorías Gustito. | `T3B-02` |
| **AUD-05** | **Alta** | `src/features/settings/BudgetSettingsForm.tsx:86-88` | Error silencioso al cargar categorías deja `selectedGustitoIds = []` y puede borrar `is_gustito` en todas las categorías al guardar. | `T3B-07` |
| **AUD-06** | **Alta** | `supabase/functions/process-telegram-queue/index.ts:157-167` | Filas en `status = 'processing'` quedan atascadas para siempre si el worker cae por timeout. | `T3B-01`, `T3B-03` |
| **AUD-07** | **Media** | `commitmentsService.ts:528-564`, `notify-gustitos-alert/index.ts:175` | `advanceInstallments` web no dispara alerta Gustitos; `notify-gustitos-alert` pisa `monthDate` con `first_installment_date`. | `T3B-04`, `T3B-06` |
| **AUD-08** | **Media** | `supabase/functions/budget-assistant/index.ts:486-491` | No carga categorías archivadas ni `monthly_category_snapshots` al agrupar los últimos 3 meses. | `T3B-04` |
| **AUD-09** | **Media** | `_shared/telegramIntentProcessor.ts:984`, `telegram-webhook/index.ts:341-355`, `financeHelpers.ts`, `daily-alerts/index.ts` | `JSON.parse` sin `try/catch` en `callGeminiFlash`; múltiples queries DB ignoran `.error` (incluyendo `paidCount` antes de `.delete()`). | `T3B-02`, `T3B-03` |
| **AUD-10** | **Media** | `transactionsService.ts:129-154`, `savingsService.ts:205-252`, `categoriesService.ts:265-306`, `admin-create-user/index.ts`, `notify-gustitos-alert/index.ts` | Mutaciones multi-paso sin transacción SQL en cliente; CORS `*` y fuga de `err.message` en `admin-create-user` y `notify-gustitos-alert`. | `T3B-01`, `T3B-04`, `T3B-06` |
| **AUD-11** | **Media** | `20261117000002_phase3_audit_fixes.sql:765-805` | `reconcile_cap_surplus` no bloquea períodos futuros (`v_month > v_current_local_month`). | `T3B-01` |
| **AUD-12** | **Media** | `TransactionsPage.tsx:33`, `CategoriesPage.tsx:50-62`, `CommitmentsPage.tsx:405-408` | `TransactionsPage` oculta `error`; `CategoriesPage` sin banner de error ni `useRovingTabs`; `CommitmentsPage` no usa snapshot mensual para `isGustito`; más **Opción A** de Movimientos. | `T3B-07`, `T3B-08` |
| **AUD-14** | **Media** | `src/features/priority-matrix/PriorityMatrixPage.tsx` (`wasDraggedRef` / `onDrop`) | Al arrastrar una tarjeta a otro cuadrante, el `<button>` se desmonta del cuadrante origen antes de disparar `onDragEnd`, dejando `wasDraggedRef.current = true` y bloqueando futuros clicks para abrir el modal de acciones (`Comprar`/`Editar`/`Eliminar`). | `T3B-08` |
| **AUD-15** | **Alta** | `20261116000002_phase2_audit_fixes.sql:278-290`, `process-telegram-queue/index.ts`, `daily-alerts/index.ts` | `pg_cron` invoca `process-telegram-queue` y `daily-alerts` sin header `Authorization` (solo `X-Cron-Secret`); si `Verify JWT` está activo en Supabase Cloud o falta `cron_internal_secret` en Vault, la cola de 2 h nunca corre ni notifica expiración (`Incidente 3`). | `T3B-01`, `T3B-03`, `T3B-09` |
| **AUD-13** | **Baja** | `SurplusCloseModal.tsx:206,244`, `BudgetSettingsForm.tsx:282-289`, `supabaseClient.ts:23`, `TransactionFormModal.tsx:233`, `SavingsEntryFormModal.tsx:151`, `SavingsPage.tsx:320,472`, `supabase_logs.json` | Copy residual `"tus topes"`, tipado `<Database>`, `aria-hidden` en `*`, `break-all` en `SavingsPage`, `title` en truncamientos, `min-h-[44px]` en checkboxes y archivo `supabase_logs.json` suelto. | `T3B-08`, `T3B-09` |

---

## 4. Plan de Tareas de Corrección (Intersección Cero por Oleada)

### Oleada 1 — SQL y Edge Functions Core (Paralela)
- **`T3B-01` — Migración SQL `supabase/migrations/20261118000002_audit_consistency_fixes.sql`:**
  - Pasar las 4 RPCs duales a `SECURITY INVOKER` + verificación `current_user = 'service_role'` / `request.jwt.claim.role = 'service_role'` + flag local `sb_finance.allow_system_dml` en RLS, y agregar `'service_role'` a `get_liquid_savings_balance` (`AUD-01`).
  - Restringir `reconcile_cap_surplus` a `p_bucket = 'fixed_limit'` y `v_month <= v_current_local_month` (`AUD-02`, `AUD-11`).
  - Agregar `processing_started_at` en `telegram_pending_requests` (`AUD-06`), `REVOKE`/`GRANT` en RPCs de Fase 1/2 y RPCs atómicas para `save_to_savings` / `credit_to_available` (`AUD-10`).
- **`T3B-02` — `_shared/telegramApi.ts`, `_shared/telegramIntentProcessor.ts`, `_shared/financeHelpers.ts`:**
  - `AbortSignal.timeout` + retry texto plano en `sendTelegramMessage` (`Incidente 1`).
  - `GEMINI_MODEL` + fallback `gemini-2.5-flash` + `AbortSignal.timeout` + `try/catch` en `JSON.parse` + contexto de compras pendientes + filtro de stop-words en `findMatchingPurchases` (`Incidente 1`, `AUD-09`).
  - `computeGustitosStatus` con `|| spent > 0` y verificación `.error` en helpers (`AUD-04`, `AUD-09`).
- **`T3B-03` — `telegram-webhook/index.ts`, `process-telegram-queue/index.ts`, `daily-alerts/index.ts`:**
  - Notificación garantizada al usuario ante error en `telegram-webhook`, verificación `.error` en `paidCount`/queries, recuperación de filas `'processing'` > 2 min en `process-telegram-queue` (`AUD-06`, `AUD-09`).
- **`T3B-04` — `budget-assistant/index.ts`, `notify-gustitos-alert/index.ts`, `admin-create-user/index.ts`:**
  - Cargar categorías archivadas + `monthly_category_snapshots` en `budget-assistant` (`AUD-08`); respetar `monthDate` real en `notify-gustitos-alert` (`AUD-07`); CORS `ALLOWED_ORIGINS` y eliminar leaks de `err.message` (`AUD-10`).

### Oleada 2 — Hooks y Servicios Frontend (Paralela)
- **`T3B-05` — `src/hooks/useDashboardData.ts` y `src/lib/supabaseClient.ts`:**
  - Alinear `isOverFixedLimit` a `>= 100%` (`AUD-03`) y tipar `createClient<Database>` (`AUD-13`).
- **`T3B-06` — `src/services/commitmentsService.ts`, `src/services/transactionsService.ts`, `src/services/savingsService.ts`:**
  - Disparar `triggerPurchaseGustitosAlertNonBlocking` en `advanceInstallments` (`AUD-07`) y migrar mutaciones multi-paso a RPCs atómicas si aplica (`AUD-10`).

### Oleada 3 — UI, Opción A de Movimientos y Accesibilidad (Paralela)
- **`T3B-07` — `TransactionsPage.tsx`, `DashboardPage.tsx`, `BudgetSettingsForm.tsx`, `CategoriesPage.tsx`:**
  - Implementar **Opción A** (mostrar `monthly_commitments` con `is_paid = true` en solo lectura dentro de Movimientos con badge `Cuota pagada`/`Fijo pagado` y enlace a `/commitments`, sin doble descuento).
  - Mostrar error/reintento en `TransactionsPage` y `CategoriesPage` + `useRovingTabs` (`AUD-12`), y bloquear guardado de Gustitos si falla `getCategories` en `BudgetSettingsForm` (`AUD-05`).
- **`T3B-08` — `PriorityMatrixPage.tsx`, `SurplusCloseModal.tsx`, `CommitmentsPage.tsx`, `SavingsPage.tsx`, `TransactionFormModal.tsx`, `SavingsEntryFormModal.tsx`:**
  - Resetear `wasDraggedRef.current = false` en `onDrop` (además de `onDragEnd`) en `PriorityMatrixPage.tsx` para que las tarjetas sigan abriendo el modal de acciones tras moverse de cuadrante (`AUD-14`).
  - Copy singular en `SurplusCloseModal`, snapshot mensual en `CommitmentsPage`, `break-all` y `320px` en `SavingsPage`, `aria-hidden` en `*` (`AUD-12`, `AUD-13`).

### Oleada 4 — Bundles y Verificación Integral
- **`T3B-09` — Regeneración, Configuración de Cron/Vault y Checks:**
  - `npm run bundle:functions`, `deno check` en las 6 funciones y 6 bundles, `npx tsc --noEmit`, `npm run build`, revisión UX/UI y limpieza de `supabase_logs.json`.
  - Documentar/verificar despliegue con `Verify JWT = OFF` (`--no-verify-jwt`) en `telegram-webhook`, `process-telegram-queue` y `daily-alerts`, y validar `vault.decrypted_secrets` (`supabase_project_url`, `cron_internal_secret`) + `net._http_response` (`AUD-15`).
