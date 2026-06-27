// ─── User & Auth ────────────────────────────────────────────────────────────

export type UserRole = 'provider' | 'client' | 'admin';

export interface User {
  id: string;
  email: string;
  phone: string;
  name: string;
  role: UserRole;
  email_verified: boolean;
  onboarding_complete: boolean;
  is_suspended: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderProfile {
  id: string;
  user_id: string;
  display_name: string;
  categories: string[];
  bio: string;
  portfolio_url: string | null;
  portfolio_file_url: string | null;
  profile_photo_url: string | null;
  city: string;
  state: string;
  id_type: string | null;
  id_number: string | null;
  id_front_url: string | null;
  id_back_url: string | null;
  selfie_url: string | null;
  is_id_verified: boolean;
  bank_code: string | null;
  bank_name: string | null;
  account_number: string | null;
  account_name: string | null;
  trust_score: number;
  completed_projects: number;
  terms_accepted: boolean;
  terms_accepted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ClientProfile {
  id: string;
  user_id: string;
  full_name: string;
  phone: string;
  company_name: string | null;
  city: string;
  state: string;
  terms_accepted: boolean;
  terms_accepted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ─── Project ─────────────────────────────────────────────────────────────────

export type ProjectState =
  | 'DRAFT'
  | 'PENDING_ACCEPTANCE'
  | 'PENDING_PAYMENT'
  | 'PARTIALLY_PAID'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface Project {
  id: string;
  title: string;
  description: string;
  provider_id: string;
  client_id: string | null;
  client_email: string | null;
  total_amount: number;
  currency: string;
  state: ProjectState;
  share_url: string;
  virtual_account_id: string | null;
  virtual_account_number: string | null;
  virtual_account_bank: string | null;
  virtual_account_name: string | null;
  amount_paid: number;
  overpayment_amount: number;
  nomba_account_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

// ─── Milestone ────────────────────────────────────────────────────────────────

export type MilestoneState =
  | 'LOCKED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'REVISION_REQUESTED'
  | 'APPROVED'
  | 'APPROVED_PENDING_TRANSFER'
  | 'PAID'
  | 'DISPUTED'
  | 'REFUNDED';

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string;
  deliverable: string;
  amount: number;
  order_index: number;
  state: MilestoneState;
  delivery_note: string | null;
  delivery_files: string[];
  revision_notes: string | null;
  nomba_transfer_ref: string | null;
  transfer_attempts: number;
  auto_approve_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ─── Payment ──────────────────────────────────────────────────────────────────

export type PaymentStatus = 'MATCHED' | 'UNMATCHED' | 'PARTIALLY_MATCHED' | 'REFUNDED';

export interface Payment {
  id: string;
  project_id: string | null;
  nomba_transaction_id: string;
  nomba_event_id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  raw_payload: Record<string, unknown>;
  created_at: Date;
}

// ─── Dispute ──────────────────────────────────────────────────────────────────

export type DisputeOutcome = 'PENDING' | 'RELEASED_TO_PROVIDER' | 'REFUNDED_TO_CLIENT';

export interface Dispute {
  id: string;
  project_id: string;
  milestone_id: string;
  raised_by: string;
  reason: string;
  description: string;
  evidence_files: string[];
  counter_description: string | null;
  counter_evidence_files: string[];
  outcome: DisputeOutcome;
  admin_notes: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  project_id: string;
  milestone_id: string | null;
  event_type: string;
  actor_id: string | null;
  actor_role: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

// ─── Notification ─────────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
}

// ─── Nomba API Types ──────────────────────────────────────────────────────────

export interface NombaTokenResponse {
  code: string;
  description: string;
  data: {
    access_token: string;
    refresh_token: string;
    expiresAt: string;
  };
}

export interface NombaVirtualAccountResponse {
  code: string;
  description: string;
  data: {
    accountNumber: string;
    accountName: string;
    bankName: string;
    bankCode: string;
    accountRef: string;
  };
}

export interface NombaTransferResponse {
  code: string;
  description: string;
  data: {
    transactionRef: string;
    status: string;
    amount: number;
  };
}

export interface NombaWebhookPayload {
  event_type: 'payment_success' | 'payment_failed' | 'payout_success' | 'payout_failed';
  requestId: string;
  data: {
    merchant: { userId: string };
    transaction: {
      fee: number;
      type: string;
      transactionId: string;
      merchantTxRef: string;
      transactionAmount: number;
      time: string;
    };
    order?: {
      amount: number;
      orderId: string;
      accountId: string;
      customerEmail: string;
      orderReference: string;
      paymentMethod: string;
      currency: string;
    };
    virtualAccount?: {
      accountNumber: string;
      accountRef: string;
      amount: number;
    };
  };
}

export interface NombaBankResolveResponse {
  code: string;
  description: string;
  data: {
    accountName: string;
    accountNumber: string;
    bankCode: string;
  };
}

// ─── Request/Response DTOs ────────────────────────────────────────────────────

export interface RegisterDTO {
  name: string;
  email: string;
  phone: string;
  password: string;
  role: UserRole;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
    onboarding_complete: boolean;
    email_verified: boolean;
  };
}

export interface ProviderProfileDTO {
  displayName: string;
  categories: string[];
  bio: string;
  portfolioUrl?: string;
  city: string;
  state: string;
}

export interface ProviderBankDTO {
  bankCode: string;
  accountNumber: string;
}

export interface ProviderConfirmDTO {
  bankCode: string;
  accountNumber: string;
  accountName: string;
  agreedToTerms: true;
}

export interface ClientProfileDTO {
  fullName: string;
  phone: string;
  companyName?: string;
  city: string;
  state: string;
}

export interface MilestoneDTO {
  title: string;
  description: string;
  deliverable: string;
  amount: number;
}

export interface CreateProjectDTO {
  title: string;
  description: string;
  clientEmail?: string;
  totalAmount: number;
  currency: string;
  milestones: MilestoneDTO[];
}

export interface MilestoneSubmitDTO {
  deliveryNote: string;
}

export interface RevisionRequestDTO {
  notes: string;
}

export interface DisputeDTO {
  reason: string;
  description: string;
}

export interface CounterEvidenceDTO {
  description: string;
}

export interface AdminResolveDisputeDTO {
  outcome: 'release' | 'refund';
  notes: string;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
}

export interface ProjectListQuery extends PaginationQuery {
  role?: 'provider' | 'client';
  state?: ProjectState;
}

// ─── API Response Wrapper ─────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    field?: string;
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ─── JWT Payload ──────────────────────────────────────────────────────────────

export interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

// ─── Express Request Extension ────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}
