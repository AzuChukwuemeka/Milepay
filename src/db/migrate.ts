import pool from '../config/database';

const migrations = `

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('provider', 'client', 'admin')),
  email_verified BOOLEAN DEFAULT FALSE,
  email_verify_token VARCHAR(255),
  email_verify_expires TIMESTAMPTZ,
  password_reset_token VARCHAR(255),
  password_reset_expires TIMESTAMPTZ,
  onboarding_complete BOOLEAN DEFAULT FALSE,
  is_suspended BOOLEAN DEFAULT FALSE,
  suspension_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ─── Provider Profiles ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(255),
  categories TEXT[] DEFAULT '{}',
  bio TEXT,
  portfolio_url VARCHAR(500),
  portfolio_file_url VARCHAR(500),
  profile_photo_url VARCHAR(500),
  city VARCHAR(100),
  state VARCHAR(100),
  id_type VARCHAR(50),
  id_number VARCHAR(100),
  id_front_url VARCHAR(500),
  id_back_url VARCHAR(500),
  selfie_url VARCHAR(500),
  is_id_verified BOOLEAN DEFAULT FALSE,
  bank_code VARCHAR(10),
  bank_name VARCHAR(100),
  account_number VARCHAR(10),
  account_name VARCHAR(255),
  trust_score INTEGER DEFAULT 0,
  completed_projects INTEGER DEFAULT 0,
  terms_accepted BOOLEAN DEFAULT FALSE,
  terms_accepted_at TIMESTAMPTZ,
  onboarding_step INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_profiles_user_id ON provider_profiles(user_id);

-- ─── Client Profiles ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name VARCHAR(255),
  phone VARCHAR(20),
  company_name VARCHAR(255),
  city VARCHAR(100),
  state VARCHAR(100),
  terms_accepted BOOLEAN DEFAULT FALSE,
  terms_accepted_at TIMESTAMPTZ,
  onboarding_step INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_profiles_user_id ON client_profiles(user_id);

-- ─── Projects ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES users(id),
  client_id UUID REFERENCES users(id),
  client_email VARCHAR(255),
  total_amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  state VARCHAR(30) DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT','PENDING_ACCEPTANCE','PENDING_PAYMENT',
    'PARTIALLY_PAID','ACTIVE','COMPLETED',
    'DISPUTED','CANCELLED','REFUNDED'
  )),
  share_url VARCHAR(500),
  virtual_account_id VARCHAR(255),
  virtual_account_number VARCHAR(20),
  virtual_account_bank VARCHAR(100),
  virtual_account_name VARCHAR(255),
  nomba_account_ref VARCHAR(255),
  amount_paid NUMERIC(12, 2) DEFAULT 0,
  overpayment_amount NUMERIC(12, 2) DEFAULT 0,
  payment_timeout_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_provider_id ON projects(provider_id);
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_state ON projects(state);
CREATE INDEX IF NOT EXISTS idx_projects_virtual_account_number ON projects(virtual_account_number);

-- ─── Milestones ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  deliverable TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  order_index INTEGER NOT NULL,
  state VARCHAR(30) DEFAULT 'LOCKED' CHECK (state IN (
    'LOCKED','IN_PROGRESS','SUBMITTED','REVISION_REQUESTED',
    'APPROVED','APPROVED_PENDING_TRANSFER','PAID','DISPUTED','REFUNDED'
  )),
  delivery_note TEXT,
  delivery_files TEXT[] DEFAULT '{}',
  revision_notes TEXT,
  nomba_transfer_ref VARCHAR(255),
  transfer_attempts INTEGER DEFAULT 0,
  auto_approve_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_milestones_project_id ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_state ON milestones(state);
CREATE INDEX IF NOT EXISTS idx_milestones_auto_approve ON milestones(auto_approve_at) WHERE state = 'SUBMITTED';

-- ─── Payments (inbound Nomba webhooks) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id),
  nomba_transaction_id VARCHAR(255) UNIQUE NOT NULL,
  nomba_event_id VARCHAR(255) UNIQUE NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  status VARCHAR(20) DEFAULT 'UNMATCHED' CHECK (status IN (
    'MATCHED','UNMATCHED','PARTIALLY_MATCHED','REFUNDED'
  )),
  raw_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_project_id ON payments(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_nomba_event_id ON payments(nomba_event_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ─── Disputes ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id),
  milestone_id UUID NOT NULL REFERENCES milestones(id),
  raised_by UUID NOT NULL REFERENCES users(id),
  reason VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  evidence_files TEXT[] DEFAULT '{}',
  counter_description TEXT,
  counter_evidence_files TEXT[] DEFAULT '{}',
  outcome VARCHAR(30) DEFAULT 'PENDING' CHECK (outcome IN (
    'PENDING','RELEASED_TO_PROVIDER','REFUNDED_TO_CLIENT'
  )),
  admin_notes TEXT,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_project_id ON disputes(project_id);
CREATE INDEX IF NOT EXISTS idx_disputes_milestone_id ON disputes(milestone_id);
CREATE INDEX IF NOT EXISTS idx_disputes_outcome ON disputes(outcome);

-- ─── Audit Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id UUID REFERENCES milestones(id),
  event_type VARCHAR(100) NOT NULL,
  actor_id UUID REFERENCES users(id),
  actor_role VARCHAR(20),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_project_id ON audit_events(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);

-- ─── Nomba Token Cache ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nomba_token_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Webhook Events (idempotency) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id VARCHAR(255) PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Updated_at triggers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DO $$ BEGIN
  CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER update_provider_profiles_updated_at BEFORE UPDATE ON provider_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER update_client_profiles_updated_at BEFORE UPDATE ON client_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER update_milestones_updated_at BEFORE UPDATE ON milestones FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER update_disputes_updated_at BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

export const runMigrations = async (): Promise<void> => {
  const client = await pool.connect();
  try {
    console.log('🔄 Running database migrations...');
    await client.query(migrations);
    console.log('✅ Database migrations complete');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Run directly: ts-node src/db/migrate.ts
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
