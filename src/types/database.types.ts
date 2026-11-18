/**
 * Definición estricta de tipos e interfaces del dominio SB-Finance.
 *
 * Arquitectura y decisiones técnicas:
 * - Separamos las entidades de base de datos de los DTOs de entrada/salida y de los
 *   modelos agregados del Dashboard (`MonthlyFinancialSummary`, `GustitosSummary`,
 *   `CategoryLimitProgress`, `MonthlyEvolutionPoint`, `AccumulatedSavingsSummary`).
 * - Incorporamos contratos discriminados para `source_type` en Ahorros, Plazos Fijos,
 *   Matriz de Prioridad, lotes de adelanto de cuotas y propuestas del Asistente IA,
 *   manteniendo `strict: true` sin ningún `any`.
 * - Definimos el esquema `Database` completo (`Tables`, `Views`, `Functions`,
 *   `Relationships`) usando `type` aliases compatibles con `Record<string, unknown>`
 *   para que `createClient<Database>` valide nombres de tablas, columnas, joins y
 *   argumentos/retornos RPC en tiempo de compilación.
 */

export type TransactionType = 'expense' | 'income';
export type CommitmentType = 'fixed_expense' | 'installment';
export type TransactionSource = 'web' | 'telegram';
export type SavingsEntryType = 'deposit' | 'withdrawal';
export type PeriodClassification = 'past' | 'current' | 'future';

export type SavingsSourceType =
  | 'manual'
  | 'direct_income'
  | 'cap_surplus_fixed'
  | 'cap_surplus_gustitos'
  | 'fixed_term_constitution'
  | 'fixed_term_return';

export type FixedTermOrigin = 'monthly_available' | 'savings_fund';
export type FixedTermStatus =
  | 'active'
  | 'accredited_savings'
  | 'accredited_available'
  | 'cancelled';

export type PriorityQuadrant =
  | 'high_impact_low_cost'
  | 'high_impact_high_cost'
  | 'low_impact_low_cost'
  | 'low_impact_high_cost';

export type SurplusBucket = 'fixed_limit' | 'gustitos';
export type SurplusAction = 'to_savings' | 'to_available' | 'mark_reviewed';

export interface UserSettings {
  user_id: string;
  fixed_salary: number;
  monthly_savings_target: number;
  fixed_expenses_limit: number;
  gustitos_budget: number;
  salary_payday: number;
  timezone: string;
  currency: string;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  user_id: string;
  name: string;
  type: TransactionType;
  icon: string;
  is_system: boolean;
  is_active: boolean;
  is_gustito: boolean;
  monthly_limit: number | null;
  created_at: string;
  updated_at: string;
}

export interface MonthlyBudget {
  id: string;
  user_id: string;
  month_date: string; // 'YYYY-MM-01'
  fixed_salary: number;
  monthly_savings_target: number;
  fixed_expenses_limit: number;
  gustitos_budget: number;
  surplus_review_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonthlyCategorySnapshot {
  id: string;
  user_id: string;
  month_date: string; // 'YYYY-MM-01'
  category_id: string;
  is_gustito: boolean;
  monthly_limit: number | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramLink {
  user_id: string;
  telegram_chat_id: number;
  telegram_username: string | null;
  linked_at: string;
  updated_at: string;
}

export interface TelegramLinkCode {
  id: string;
  user_id: string;
  code: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface FixedExpenseTemplate {
  id: string;
  user_id: string;
  category_id: string;
  name: string;
  default_amount: number;
  due_day: number | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  category?: Category;
}

export interface InstallmentPurchase {
  id: string;
  user_id: string;
  category_id: string;
  description: string;
  installment_amount: number;
  installments_count: number;
  total_amount: number;
  purchase_date: string; // 'YYYY-MM-DD'
  first_installment_date: string; // 'YYYY-MM-DD'
  notes: string | null;
  is_gustito: boolean;
  source: TransactionSource;
  created_at: string;
  updated_at: string;
  category?: Category;
}

export interface InstallmentPaymentBatch {
  id: string;
  user_id: string;
  installment_purchase_id: string;
  target_month_date: string; // 'YYYY-MM-01'
  installments_count: number;
  total_paid_amount: number;
  source: TransactionSource;
  reverted_at: string | null;
  created_at: string;
}

export interface MonthlyCommitment {
  id: string;
  user_id: string;
  month_date: string; // 'YYYY-MM-01'
  category_id: string;
  commitment_type: CommitmentType;
  fixed_expense_template_id: string | null;
  installment_purchase_id: string | null;
  name: string;
  amount: number;
  due_date: string | null;
  installment_number: number | null;
  total_installments: number | null;
  is_paid: boolean;
  paid_at: string | null;
  notes: string | null;
  original_month_date?: string | null;
  original_due_date?: string | null;
  original_amount?: number | null;
  payment_batch_id?: string | null;
  created_at: string;
  updated_at: string;
  category?: Category;
  installment_purchase?: {
    id: string;
    is_gustito: boolean;
    source: TransactionSource;
  } | null;
}

export interface Transaction {
  id: string;
  user_id: string;
  category_id: string;
  type: TransactionType;
  amount: number;
  transaction_date: string; // 'YYYY-MM-DD'
  description: string;
  notes: string | null;
  source: TransactionSource;
  is_gustito: boolean;
  save_to_savings?: boolean;
  created_at: string;
  updated_at: string;
  category?: Category;
}

export interface SavingsEntry {
  id: string;
  user_id: string;
  month_date: string; // 'YYYY-MM-01'
  entry_type: SavingsEntryType;
  amount: number;
  entry_date: string; // 'YYYY-MM-DD'
  description: string;
  notes: string | null;
  source_transaction_id?: string | null;
  source_type: SavingsSourceType;
  fixed_term_id?: string | null;
  source_month_date?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FixedTermDeposit {
  id: string;
  user_id: string;
  institution: string;
  principal_amount: number;
  expected_return_amount: number;
  actual_return_amount: number | null;
  start_date: string; // 'YYYY-MM-DD'
  maturity_date: string; // 'YYYY-MM-DD'
  origin: FixedTermOrigin;
  status: FixedTermStatus;
  accredited_at: string | null;
  accredited_month_date: string | null;
  source: TransactionSource;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PriorityItem {
  id: string;
  user_id: string;
  title: string;
  estimated_cost: number;
  category_id: string | null;
  quadrant: PriorityQuadrant;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  category?: Category | null;
}

export interface CategoryLimitProgress {
  categoryId: string;
  categoryName: string;
  icon: string;
  isGustito: boolean;
  monthlyLimit: number;
  spent: number;
  usagePercent: number;
  remaining: number;
}

export interface GustitosSummary {
  isConfigured: boolean;
  budget: number;
  spent: number;
  remaining: number;
  usagePercent: number | null;
  gustitoCategoriesCount: number;
  isExceeded: boolean;
}

export interface MonthlyFinancialSummary {
  monthDate: string; // 'YYYY-MM-01'
  isInitialized: boolean;
  fixedSalary: number;
  extraIncomeTotal: number;
  totalIncome: number; // fixedSalary + extraIncomeTotal + fixedTermsReturnedToAvailable
  fixedExpensesLimit: number;
  fixedExpensesTotal: number;
  installmentsTotal: number; // Cuotas No-Gustito
  fixedAndNonGustitoInstallmentsTotal: number;
  gustitosInstallmentsTotal: number;
  totalCommitted: number; // fixedExpensesTotal + installmentsTotal (excluye cuotas Gustitos)
  fixedReservedAmount: number; // max(fixedExpensesLimit, totalCommitted + fixedCapTransferredToSavings)
  gustitosReservedAmount: number; // max(gustitosBudget, gustitosSpent + gustitosTransferredToSavings)
  fixedCapTransferredToSavings: number;
  gustitosTransferredToSavings: number;
  fixedCapSurplus: number;
  gustitosSurplus: number;
  fixedTermsInvestedFromAvailable: number;
  fixedTermsReturnedToAvailable: number;
  committedLimitUsagePercent: number | null; // null si fixedExpensesLimit === 0
  isOverFixedLimit: boolean;
  paidCommitmentsTotal: number;
  pendingCommitmentsTotal: number; // Lo que falta abonar en el mes (incluye todas las cuotas)
  pendingCommitmentsCount: number;
  totalCommitmentsCount: number;
  monthlySavingsTarget: number; // Ahorro fijo apartado del mes
  extraSavingsDeposits: number; // Aportes operativos manual / direct_income
  totalMonthlySavings: number; // monthlySavingsTarget + extraSavingsDeposits
  variableExpensesTotal: number; // Todas las transacciones expense (para referencia visual)
  variableNonGustitoExpensesTotal: number; // Variables excluyendo Gustitos
  realAvailable: number;
  surplusReviewCompletedAt: string | null;
  shouldPromptSurplusReview: boolean;
  gustitos: GustitosSummary;
  categoryLimits: CategoryLimitProgress[];
}

export interface TransactionFilters {
  search: string;
  type: 'all' | TransactionType;
  categoryId: string;
  dateFrom: string;
  dateTo: string;
}

export interface CategoryBreakdownItem {
  categoryId: string;
  categoryName: string;
  amount: number;
  percentage: number;
  color: string;
}

export interface MonthlyEvolutionPoint {
  monthDate: string;
  label: string;
  totalIncome: number;
  totalExpenses: number;
  committedTotal: number;
  variableExpenses: number;
  realAvailable: number;
}

// ----------------------------------------------------------------------------
// DTOs de entrada para servicios, formularios y herramientas de decisión
// ----------------------------------------------------------------------------

export interface UpdateUserSettingsInput {
  fixed_salary: number;
  monthly_savings_target: number;
  fixed_expenses_limit: number;
  gustitos_budget: number;
  salary_payday: number;
  timezone: string;
  update_current_month: boolean;
}

export interface CategoryInput {
  name: string;
  type: TransactionType;
  icon?: string;
  is_gustito?: boolean;
  monthly_limit?: number | null;
}

export interface FixedExpenseTemplateInput {
  name: string;
  category_id: string;
  default_amount: number;
  due_day: number | null;
  notes?: string | null;
}

export interface InstallmentPurchaseInput {
  description: string;
  category_id: string;
  installment_amount: number;
  installments_count: number;
  purchase_date: string;
  first_installment_date: string;
  notes?: string | null;
  is_gustito?: boolean;
}

export interface AdvanceInstallmentsInput {
  purchase_id: string;
  count: number;
  target_month_date: string;
  total_amount?: number | null;
}

export interface AdvanceInstallmentsResult {
  batch_id: string;
  purchase_id: string;
  purchase_description: string;
  category_id: string;
  is_gustito: boolean;
  target_month_date: string;
  installments_count: number;
  total_paid_amount: number;
  installments: Array<{
    id: string;
    installment_number: number;
    total_installments: number;
    amount: number;
    original_month_date: string;
    month_date: string;
  }>;
}

export interface RevertInstallmentBatchResult {
  reverted: boolean;
  batch_id?: string;
  restored_count?: number;
  reason?: string;
}

export interface ReconcileCapSurplusInput {
  month_date: string;
  bucket: SurplusBucket;
  action: SurplusAction;
  amount: number;
  target_income_month?: string | null;
}

export interface ReconcileCapSurplusResult {
  ok: boolean;
  bucket?: SurplusBucket;
  action: SurplusAction;
  amount?: number;
  remaining_surplus?: number;
}

export interface TransactionInput {
  type: TransactionType;
  category_id: string;
  amount: number;
  transaction_date: string;
  description: string;
  notes?: string | null;
  is_gustito?: boolean;
  save_to_savings?: boolean;
}

export interface SavingsEntryInput {
  entry_type: SavingsEntryType;
  amount: number;
  entry_date: string;
  description: string;
  notes?: string | null;
  credit_to_available?: boolean;
}

export interface AccumulatedSavingsSummary {
  totalAccumulated: number; // Alias retrocompatible de liquidBalance
  liquidBalance: number;
  immobilizedInFixedTerms: number;
  totalPatrimony: number;
  totalMonthlyTargetsFrozen: number;
  totalExtraDeposits: number;
  totalWithdrawals: number;
}

export interface FixedTermDepositInput {
  institution: string;
  principal_amount: number;
  expected_return_amount: number;
  start_date: string;
  maturity_date: string;
  origin: FixedTermOrigin;
  notes?: string | null;
}

export interface AccreditFixedTermInput {
  destination: FixedTermOrigin;
  actual_return_amount: number;
  accredited_date: string;
}

export interface PriorityItemInput {
  title: string;
  estimated_cost: number;
  category_id: string | null;
  quadrant: PriorityQuadrant;
  notes?: string | null;
}

export interface BudgetAssistantCategorySuggestion {
  category_id: string;
  category_name: string;
  current_limit: number | null;
  suggested_limit: number | null;
  reason: string;
}

export interface BudgetAssistantProposal {
  summary_reasoning: string;
  recommended_fixed_expenses_limit: number;
  recommended_gustitos_budget: number;
  recommended_monthly_savings_target: number;
  category_limits: BudgetAssistantCategorySuggestion[];
  warnings: string[];
  disclaimer: string;
}

export interface BudgetAssistantResponse {
  status: 'ok' | 'insufficient_data';
  reason?: string;
  message?: string;
  monthsAnalyzedCount?: number;
  analyzedMonths?: string[];
  proposal?: BudgetAssistantProposal;
}

export interface SimulatedExpenseItem {
  id: string;
  description: string;
  mode: 'cash' | 'installments';
  unitAmount: number;
  installmentsCount: number;
  categoryId: string | null;
  isGustito: boolean;
  startMonth: 'current' | 'next';
}

export interface InstallmentProgressSummary {
  purchaseId: string;
  paidCount: number;
  totalCount: number;
}

export interface AdminCreateUserResponse {
  user: {
    id: string;
    email: string;
  };
  message: string;
}

export interface BudgetAssistantLog {
  id: string;
  user_id: string;
  goal_length: number;
  created_at: string;
}

// ----------------------------------------------------------------------------
// Contratos RPC atómicos transaccionales
// ----------------------------------------------------------------------------

export interface CancelFixedTermDepositArgs {
  p_fixed_term_id: string;
  p_actor_user_id?: string | null;
}

export type CancelFixedTermDepositResult =
  | {
      cancelled: true;
      fixed_term_id: string;
      origin: FixedTermOrigin;
      principal_amount: number;
    }
  | {
      cancelled: false;
      reason: 'not_found';
      fixed_term_id: string;
    }
  | {
      cancelled: false;
      reason: 'not_active';
      fixed_term_id: string;
      status: FixedTermStatus;
    };

export interface ApplyBudgetAssistantCategoryLimitParam {
  category_id: string;
  suggested_limit: number | null;
}

export interface ApplyBudgetAssistantLimitsArgs {
  p_fixed_expenses_limit: number;
  p_gustitos_budget: number;
  p_monthly_savings_target: number;
  p_category_limits?: ApplyBudgetAssistantCategoryLimitParam[];
  p_apply_to_current_month?: boolean;
  p_target_month_date?: string | null;
}

export interface ApplyBudgetAssistantLimitsResult {
  ok: boolean;
  applied_to_current_month: boolean;
  target_month_date: string | null;
  updated_categories_count: number;
}

export type PriorityPurchaseMode = 'cash' | 'installments';

export interface ConvertPriorityItemToPurchaseArgs {
  p_priority_item_id: string;
  p_purchase_mode: PriorityPurchaseMode;
  p_category_id: string;
  p_description: string;
  p_amount: number;
  p_purchase_date: string;
  p_installments_count?: number;
  p_first_installment_date?: string | null;
  p_notes?: string | null;
  p_is_gustito?: boolean;
}

export interface ConvertPriorityItemToPurchaseResult {
  ok: boolean;
  mode: PriorityPurchaseMode;
  priority_item_id: string;
  created_id: string;
  month_date: string;
}

export interface DatabaseRpcFunctions {
  cancel_fixed_term_deposit: {
    Args: CancelFixedTermDepositArgs;
    Returns: CancelFixedTermDepositResult;
  };
  apply_budget_assistant_limits: {
    Args: ApplyBudgetAssistantLimitsArgs;
    Returns: ApplyBudgetAssistantLimitsResult;
  };
  convert_priority_item_to_purchase: {
    Args: ConvertPriorityItemToPurchaseArgs;
    Returns: ConvertPriorityItemToPurchaseResult;
  };
}

// ----------------------------------------------------------------------------
// Esquema tipado completo de PostgreSQL para createClient<Database>()
// ----------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type UserSettingsRow = {
  user_id: string;
  fixed_salary: number;
  monthly_savings_target: number;
  fixed_expenses_limit: number;
  gustitos_budget: number;
  salary_payday: number;
  timezone: string;
  currency: string;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
};

type CategoryRow = {
  id: string;
  user_id: string;
  name: string;
  type: TransactionType;
  icon: string;
  is_system: boolean;
  is_active: boolean;
  is_gustito: boolean;
  monthly_limit: number | null;
  created_at: string;
  updated_at: string;
};

type MonthlyBudgetRow = {
  id: string;
  user_id: string;
  month_date: string;
  fixed_salary: number;
  monthly_savings_target: number;
  fixed_expenses_limit: number;
  gustitos_budget: number;
  surplus_review_completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type MonthlyCategorySnapshotRow = {
  id: string;
  user_id: string;
  month_date: string;
  category_id: string;
  is_gustito: boolean;
  monthly_limit: number | null;
  created_at: string;
  updated_at: string;
};

type FixedExpenseTemplateRow = {
  id: string;
  user_id: string;
  category_id: string;
  name: string;
  default_amount: number;
  due_day: number | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type InstallmentPurchaseRow = {
  id: string;
  user_id: string;
  category_id: string;
  description: string;
  installment_amount: number;
  installments_count: number;
  total_amount: number;
  purchase_date: string;
  first_installment_date: string;
  notes: string | null;
  is_gustito: boolean;
  source: TransactionSource;
  created_at: string;
  updated_at: string;
};

type InstallmentPaymentBatchRow = {
  id: string;
  user_id: string;
  installment_purchase_id: string;
  target_month_date: string;
  installments_count: number;
  total_paid_amount: number;
  source: TransactionSource;
  reverted_at: string | null;
  created_at: string;
};

type MonthlyCommitmentRow = {
  id: string;
  user_id: string;
  month_date: string;
  category_id: string;
  commitment_type: CommitmentType;
  fixed_expense_template_id: string | null;
  installment_purchase_id: string | null;
  name: string;
  amount: number;
  due_date: string | null;
  installment_number: number | null;
  total_installments: number | null;
  is_paid: boolean;
  paid_at: string | null;
  notes: string | null;
  original_month_date: string | null;
  original_due_date: string | null;
  original_amount: number | null;
  payment_batch_id: string | null;
  created_at: string;
  updated_at: string;
};

type TransactionRow = {
  id: string;
  user_id: string;
  category_id: string;
  type: TransactionType;
  amount: number;
  transaction_date: string;
  description: string;
  notes: string | null;
  source: TransactionSource;
  is_gustito: boolean;
  save_to_savings: boolean;
  created_at: string;
  updated_at: string;
};

type SavingsEntryRow = {
  id: string;
  user_id: string;
  month_date: string;
  entry_type: SavingsEntryType;
  amount: number;
  entry_date: string;
  description: string;
  notes: string | null;
  source_transaction_id: string | null;
  source_type: SavingsSourceType;
  fixed_term_id: string | null;
  source_month_date: string | null;
  created_at: string;
  updated_at: string;
};

type FixedTermDepositRow = {
  id: string;
  user_id: string;
  institution: string;
  principal_amount: number;
  expected_return_amount: number;
  actual_return_amount: number | null;
  start_date: string;
  maturity_date: string;
  origin: FixedTermOrigin;
  status: FixedTermStatus;
  accredited_at: string | null;
  accredited_month_date: string | null;
  source: TransactionSource;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type PriorityItemRow = {
  id: string;
  user_id: string;
  title: string;
  estimated_cost: number;
  category_id: string | null;
  quadrant: PriorityQuadrant;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type TelegramLinkRow = {
  user_id: string;
  telegram_chat_id: number;
  telegram_username: string | null;
  linked_at: string;
  updated_at: string;
};

type TelegramLinkCodeRow = {
  id: string;
  user_id: string;
  code: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
};

export type TelegramSessionIntent =
  | 'expense'
  | 'income'
  | 'installment_purchase'
  | 'pay_installments'
  | 'fixed_term_deposit';

export type TelegramSessionPendingStep =
  | 'awaiting_category'
  | 'awaiting_amount'
  | 'awaiting_description'
  | 'awaiting_installment_details'
  | 'awaiting_first_installment_date'
  | 'awaiting_purchase_selection'
  | 'awaiting_installment_count'
  | 'awaiting_fixed_term_origin'
  | 'awaiting_fixed_term_return';

type TelegramConversationSessionRow = {
  id: string;
  user_id: string;
  chat_id: number;
  intent: TelegramSessionIntent;
  pending_step: TelegramSessionPendingStep;
  draft_json: Json;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type TelegramActionLogRow = {
  id: string;
  user_id: string;
  chat_id: number;
  action_type: TelegramSessionIntent;
  target_table:
    | 'transactions'
    | 'installment_purchases'
    | 'installment_payment_batches'
    | 'fixed_term_deposits';
  target_id: string;
  telegram_message_id: number | null;
  voided_at: string | null;
  rollback_payload: Json | null;
  created_at: string;
};

type TelegramProcessedUpdateRow = {
  update_id: number;
  processed_at: string;
};

export type TelegramPendingRequestStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed_permanent';

type TelegramPendingRequestRow = {
  id: string;
  user_id: string;
  chat_id: number;
  message_text: string | null;
  audio_base64: string | null;
  audio_mime_type: string | null;
  local_date: string;
  timezone: string;
  currency: string;
  session_draft_json: Json | null;
  session_pending_step: string | null;
  session_intent: string | null;
  status: TelegramPendingRequestStatus;
  attempts: number;
  next_retry_at: string;
  expires_at: string;
  last_error: string | null;
  processed_at: string | null;
  processing_started_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NotificationAlertType =
  | 'category_warning_80'
  | 'category_exceeded_100'
  | 'fixed_limit_warning_80'
  | 'fixed_limit_exceeded_100'
  | 'mid_month_pending_reminder'
  | 'end_of_month_pending_reminder'
  | 'fixed_term_due_3d'
  | 'fixed_term_due_today'
  | 'fixed_cap_surplus_closing';

type NotificationLogRow = {
  id: string;
  user_id: string;
  month_date: string;
  alert_type: NotificationAlertType;
  reference_id: string | null;
  sent_at: string;
};

type BudgetAssistantLogRow = {
  id: string;
  user_id: string;
  goal_length: number;
  created_at: string;
};

export type SyncGustitoCategoriesSelectionResult = {
  ok: boolean;
  updated_categories: number;
  synced_snapshots: number;
  month_date: string | null;
};

export type CronVaultDiagnosticsResult = {
  vault_available: boolean;
  cron_available: boolean;
  has_supabase_project_url: boolean;
  has_cron_internal_secret: boolean;
  has_supabase_anon_key: boolean;
  jobs: Array<{
    jobname: string;
    schedule: string;
    active: boolean;
  }>;
};

type AsRecord<T> = { [K in keyof T]: T[K] };

export type Database = {
  public: {
    Tables: {
      user_settings: {
        Row: UserSettingsRow;
        Insert: {
          user_id: string;
          fixed_salary?: number;
          monthly_savings_target?: number;
          fixed_expenses_limit?: number;
          gustitos_budget?: number;
          salary_payday?: number;
          timezone?: string;
          currency?: string;
          is_admin?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<UserSettingsRow>;
        Relationships: [];
      };
      categories: {
        Row: CategoryRow;
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          type: TransactionType;
          icon?: string;
          is_system?: boolean;
          is_active?: boolean;
          is_gustito?: boolean;
          monthly_limit?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<CategoryRow>;
        Relationships: [];
      };
      monthly_budgets: {
        Row: MonthlyBudgetRow;
        Insert: {
          id?: string;
          user_id: string;
          month_date: string;
          fixed_salary?: number;
          monthly_savings_target?: number;
          fixed_expenses_limit?: number;
          gustitos_budget?: number;
          surplus_review_completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<MonthlyBudgetRow>;
        Relationships: [];
      };
      monthly_category_snapshots: {
        Row: MonthlyCategorySnapshotRow;
        Insert: {
          id?: string;
          user_id: string;
          month_date: string;
          category_id: string;
          is_gustito?: boolean;
          monthly_limit?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<MonthlyCategorySnapshotRow>;
        Relationships: [
          {
            foreignKeyName: 'fk_monthly_cat_snapshots_category_user';
            columns: ['category_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      fixed_expense_templates: {
        Row: FixedExpenseTemplateRow;
        Insert: {
          id?: string;
          user_id: string;
          category_id: string;
          name: string;
          default_amount: number;
          due_day?: number | null;
          is_active?: boolean;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<FixedExpenseTemplateRow>;
        Relationships: [
          {
            foreignKeyName: 'fixed_expense_templates_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
        ];
      };
      installment_purchases: {
        Row: InstallmentPurchaseRow;
        Insert: {
          id?: string;
          user_id: string;
          category_id: string;
          description: string;
          installment_amount: number;
          installments_count: number;
          total_amount: number;
          purchase_date: string;
          first_installment_date: string;
          notes?: string | null;
          is_gustito?: boolean;
          source?: TransactionSource;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<InstallmentPurchaseRow>;
        Relationships: [
          {
            foreignKeyName: 'installment_purchases_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
        ];
      };
      installment_payment_batches: {
        Row: InstallmentPaymentBatchRow;
        Insert: {
          id?: string;
          user_id: string;
          installment_purchase_id: string;
          target_month_date: string;
          installments_count: number;
          total_paid_amount: number;
          source?: TransactionSource;
          reverted_at?: string | null;
          created_at?: string;
        };
        Update: Partial<InstallmentPaymentBatchRow>;
        Relationships: [
          {
            foreignKeyName: 'installment_payment_batches_installment_purchase_id_fkey';
            columns: ['installment_purchase_id'];
            isOneToOne: false;
            referencedRelation: 'installment_purchases';
            referencedColumns: ['id'];
          },
        ];
      };
      monthly_commitments: {
        Row: MonthlyCommitmentRow;
        Insert: {
          id?: string;
          user_id: string;
          month_date: string;
          category_id: string;
          commitment_type: CommitmentType;
          fixed_expense_template_id?: string | null;
          installment_purchase_id?: string | null;
          name: string;
          amount: number;
          due_date?: string | null;
          installment_number?: number | null;
          total_installments?: number | null;
          is_paid?: boolean;
          paid_at?: string | null;
          notes?: string | null;
          original_month_date?: string | null;
          original_due_date?: string | null;
          original_amount?: number | null;
          payment_batch_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<MonthlyCommitmentRow>;
        Relationships: [
          {
            foreignKeyName: 'monthly_commitments_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'monthly_commitments_fixed_expense_template_id_fkey';
            columns: ['fixed_expense_template_id'];
            isOneToOne: false;
            referencedRelation: 'fixed_expense_templates';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'monthly_commitments_installment_purchase_id_fkey';
            columns: ['installment_purchase_id'];
            isOneToOne: false;
            referencedRelation: 'installment_purchases';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'monthly_commitments_payment_batch_id_fkey';
            columns: ['payment_batch_id'];
            isOneToOne: false;
            referencedRelation: 'installment_payment_batches';
            referencedColumns: ['id'];
          },
        ];
      };
      transactions: {
        Row: TransactionRow;
        Insert: {
          id?: string;
          user_id: string;
          category_id: string;
          type: TransactionType;
          amount: number;
          transaction_date: string;
          description: string;
          notes?: string | null;
          source?: TransactionSource;
          is_gustito?: boolean;
          save_to_savings?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<TransactionRow>;
        Relationships: [
          {
            foreignKeyName: 'transactions_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id'];
          },
        ];
      };
      savings_entries: {
        Row: SavingsEntryRow;
        Insert: {
          id?: string;
          user_id: string;
          month_date: string;
          entry_type: SavingsEntryType;
          amount: number;
          entry_date: string;
          description: string;
          notes?: string | null;
          source_transaction_id?: string | null;
          source_type?: SavingsSourceType;
          fixed_term_id?: string | null;
          source_month_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<SavingsEntryRow>;
        Relationships: [
          {
            foreignKeyName: 'savings_entries_source_transaction_id_fkey';
            columns: ['source_transaction_id'];
            isOneToOne: true;
            referencedRelation: 'transactions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'savings_entries_fixed_term_id_fkey';
            columns: ['fixed_term_id'];
            isOneToOne: false;
            referencedRelation: 'fixed_term_deposits';
            referencedColumns: ['id'];
          },
        ];
      };
      fixed_term_deposits: {
        Row: FixedTermDepositRow;
        Insert: {
          id?: string;
          user_id: string;
          institution?: string;
          principal_amount: number;
          expected_return_amount: number;
          actual_return_amount?: number | null;
          start_date: string;
          maturity_date: string;
          origin: FixedTermOrigin;
          status?: FixedTermStatus;
          accredited_at?: string | null;
          accredited_month_date?: string | null;
          source?: TransactionSource;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<FixedTermDepositRow>;
        Relationships: [];
      };
      priority_items: {
        Row: PriorityItemRow;
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          estimated_cost: number;
          category_id?: string | null;
          quadrant: PriorityQuadrant;
          sort_order?: number;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<PriorityItemRow>;
        Relationships: [
          {
            foreignKeyName: 'fk_priority_items_category_user';
            columns: ['category_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      telegram_links: {
        Row: TelegramLinkRow;
        Insert: {
          user_id: string;
          telegram_chat_id: number;
          telegram_username?: string | null;
          linked_at?: string;
          updated_at?: string;
        };
        Update: Partial<TelegramLinkRow>;
        Relationships: [];
      };
      telegram_link_codes: {
        Row: TelegramLinkCodeRow;
        Insert: {
          id?: string;
          user_id: string;
          code: string;
          expires_at: string;
          used_at?: string | null;
          created_at?: string;
        };
        Update: Partial<TelegramLinkCodeRow>;
        Relationships: [];
      };
      telegram_conversation_sessions: {
        Row: TelegramConversationSessionRow;
        Insert: {
          id?: string;
          user_id: string;
          chat_id: number;
          intent: TelegramSessionIntent;
          pending_step: TelegramSessionPendingStep;
          draft_json?: Json;
          expires_at: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<TelegramConversationSessionRow>;
        Relationships: [];
      };
      telegram_action_logs: {
        Row: TelegramActionLogRow;
        Insert: {
          id?: string;
          user_id: string;
          chat_id: number;
          action_type: TelegramSessionIntent;
          target_table:
            | 'transactions'
            | 'installment_purchases'
            | 'installment_payment_batches'
            | 'fixed_term_deposits';
          target_id: string;
          telegram_message_id?: number | null;
          voided_at?: string | null;
          rollback_payload?: Json | null;
          created_at?: string;
        };
        Update: Partial<TelegramActionLogRow>;
        Relationships: [];
      };
      telegram_processed_updates: {
        Row: TelegramProcessedUpdateRow;
        Insert: {
          update_id: number;
          processed_at?: string;
        };
        Update: Partial<TelegramProcessedUpdateRow>;
        Relationships: [];
      };
      telegram_pending_requests: {
        Row: TelegramPendingRequestRow;
        Insert: {
          id?: string;
          user_id: string;
          chat_id: number;
          message_text?: string | null;
          audio_base64?: string | null;
          audio_mime_type?: string | null;
          local_date: string;
          timezone?: string;
          currency?: string;
          session_draft_json?: Json | null;
          session_pending_step?: string | null;
          session_intent?: string | null;
          status?: TelegramPendingRequestStatus;
          attempts?: number;
          next_retry_at?: string;
          expires_at?: string;
          last_error?: string | null;
          processed_at?: string | null;
          processing_started_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<TelegramPendingRequestRow>;
        Relationships: [];
      };
      notification_logs: {
        Row: NotificationLogRow;
        Insert: {
          id?: string;
          user_id: string;
          month_date: string;
          alert_type: NotificationAlertType;
          reference_id?: string | null;
          sent_at?: string;
        };
        Update: Partial<NotificationLogRow>;
        Relationships: [];
      };
      budget_assistant_logs: {
        Row: BudgetAssistantLogRow;
        Insert: {
          id?: string;
          user_id: string;
          goal_length?: number;
          created_at?: string;
        };
        Update: Partial<BudgetAssistantLogRow>;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      ensure_monthly_period: {
        Args: {
          p_month_date: string;
        };
        Returns: MonthlyBudgetRow;
      };
      create_installment_purchase: {
        Args: {
          p_category_id: string;
          p_description: string;
          p_installment_amount: number;
          p_installments_count: number;
          p_purchase_date: string;
          p_first_installment_date: string;
          p_notes?: string | null;
          p_is_gustito?: boolean;
          p_source?: TransactionSource;
        };
        Returns: InstallmentPurchaseRow;
      };
      update_installment_purchase: {
        Args: {
          p_purchase_id: string;
          p_category_id: string;
          p_description: string;
          p_installment_amount: number;
          p_installments_count: number;
          p_purchase_date: string;
          p_first_installment_date: string;
          p_notes?: string | null;
          p_is_gustito?: boolean;
        };
        Returns: InstallmentPurchaseRow;
      };
      advance_installments: {
        Args: {
          p_purchase_id: string;
          p_count: number;
          p_target_month_date: string;
          p_total_amount?: number | null;
          p_source?: TransactionSource;
          p_actor_user_id?: string | null;
        };
        Returns: AsRecord<AdvanceInstallmentsResult>;
      };
      revert_installment_payment_batch: {
        Args: {
          p_batch_id: string;
          p_actor_user_id?: string | null;
        };
        Returns: AsRecord<RevertInstallmentBatchResult>;
      };
      get_liquid_savings_balance: {
        Args: {
          p_user_id: string;
        };
        Returns: number;
      };
      create_fixed_term_deposit: {
        Args: {
          p_institution: string;
          p_principal_amount: number;
          p_expected_return_amount: number;
          p_start_date: string;
          p_maturity_date: string;
          p_origin: FixedTermOrigin;
          p_source?: TransactionSource;
          p_notes?: string | null;
          p_actor_user_id?: string | null;
        };
        Returns: FixedTermDepositRow;
      };
      accredit_fixed_term_deposit: {
        Args: {
          p_fixed_term_id: string;
          p_destination?: FixedTermOrigin;
          p_actual_return_amount?: number | null;
          p_accredited_date?: string | null;
        };
        Returns: FixedTermDepositRow;
      };
      cancel_fixed_term_deposit: {
        Args: {
          p_fixed_term_id: string;
          p_actor_user_id?: string | null;
        };
        Returns: CancelFixedTermDepositResult;
      };
      reconcile_cap_surplus: {
        Args: {
          p_month_date: string;
          p_bucket: SurplusBucket;
          p_action: SurplusAction;
          p_amount?: number;
          p_target_income_month?: string | null;
        };
        Returns: AsRecord<ReconcileCapSurplusResult>;
      };
      apply_budget_assistant_limits: {
        Args: {
          p_fixed_expenses_limit: number;
          p_gustitos_budget: number;
          p_monthly_savings_target: number;
          p_category_limits?: AsRecord<ApplyBudgetAssistantCategoryLimitParam>[];
          p_apply_to_current_month?: boolean;
          p_target_month_date?: string | null;
        };
        Returns: AsRecord<ApplyBudgetAssistantLimitsResult>;
      };
      convert_priority_item_to_purchase: {
        Args: {
          p_priority_item_id: string;
          p_purchase_mode: PriorityPurchaseMode;
          p_category_id: string;
          p_description: string;
          p_amount: number;
          p_purchase_date: string;
          p_installments_count?: number;
          p_first_installment_date?: string | null;
          p_notes?: string | null;
          p_is_gustito?: boolean;
        };
        Returns: AsRecord<ConvertPriorityItemToPurchaseResult>;
      };
      create_transaction_with_savings: {
        Args: {
          p_type: TransactionType;
          p_category_id: string;
          p_amount: number;
          p_transaction_date: string;
          p_description: string;
          p_notes?: string | null;
          p_is_gustito?: boolean;
          p_save_to_savings?: boolean;
          p_source?: TransactionSource;
        };
        Returns: TransactionRow;
      };
      update_transaction_with_savings: {
        Args: {
          p_transaction_id: string;
          p_type: TransactionType;
          p_category_id: string;
          p_amount: number;
          p_transaction_date: string;
          p_description: string;
          p_notes?: string | null;
          p_is_gustito?: boolean;
          p_save_to_savings?: boolean;
        };
        Returns: TransactionRow;
      };
      create_savings_entry_with_credit: {
        Args: {
          p_entry_type: SavingsEntryType;
          p_amount: number;
          p_entry_date: string;
          p_description: string;
          p_notes?: string | null;
          p_credit_to_available?: boolean;
          p_compensatory_category_id?: string | null;
        };
        Returns: SavingsEntryRow;
      };
      sync_gustito_categories_selection: {
        Args: {
          p_selected_category_ids: string[];
          p_update_current_month?: boolean;
        };
        Returns: SyncGustitoCategoriesSelectionResult;
      };
      get_cron_vault_diagnostics: {
        Args: Record<string, never>;
        Returns: CronVaultDiagnosticsResult;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
