-- ---------------------------------------------------------------------------
-- Goal 27 — core schema.
--
-- This replaces the Phase 1 scaffold tables (users/matches/escrows/
-- transactions/disputes). Phase 1 was never deployed and held no real money,
-- so the migration drops them rather than carrying a compatibility shim: the
-- money representation changed from a single mutable balance column to a
-- double-entry ledger, and there is no meaningful way to back-fill one from
-- the other.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS disputes CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS escrows CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- --------------------------------------------------------------------- users

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'moderator', 'admin')),

  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone TEXT,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,

  psn_id TEXT,
  skill_tier TEXT NOT NULL DEFAULT 'rookie'
    CHECK (skill_tier IN ('rookie', 'amateur', 'semi_pro', 'pro', 'elite')),

  date_of_birth DATE,
  country_code TEXT,
  region_code TEXT,

  subscription_tier TEXT NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro')),
  kyc_status TEXT NOT NULL DEFAULT 'unstarted'
    CHECK (kyc_status IN ('unstarted', 'pending', 'approved', 'rejected')),

  trust_score INTEGER NOT NULL DEFAULT 65 CHECK (trust_score BETWEEN 0 AND 100),
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER NOT NULL DEFAULT 0,
  banned_at TIMESTAMPTZ,

  -- Responsible play. NULL means "no limit set".
  deposit_limit_daily_cents BIGINT CHECK (deposit_limit_daily_cents IS NULL OR deposit_limit_daily_cents >= 0),
  loss_limit_daily_cents BIGINT CHECK (loss_limit_daily_cents IS NULL OR loss_limit_daily_cents >= 0),
  session_reminder_minutes INTEGER CHECK (session_reminder_minutes IS NULL OR session_reminder_minutes > 0),
  self_excluded_until TIMESTAMPTZ,
  cool_off_until TIMESTAMPTZ,

  signup_ip INET,
  last_ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Striker" and "striker" must not be two accounts.
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_handle_key ON users (lower(handle));
CREATE UNIQUE INDEX users_psn_id_key ON users (lower(psn_id)) WHERE psn_id IS NOT NULL;

-- ------------------------------------------------------------------- wallets

CREATE TABLE wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_cents BIGINT NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
  locked_cents BIGINT NOT NULL DEFAULT 0 CHECK (locked_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------- ledger
-- Append-only, double-entry. Each entry is a transfer between two named
-- accounts, so the books cannot be written out of balance: there is no way to
-- express a one-sided entry. `wallets` is a materialised cache of the
-- per-user account balance and is reconciled against `v_ledger_balances`.

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN (
    'deposit', 'withdrawal', 'escrow_lock', 'escrow_payout',
    'platform_rake', 'refund', 'tournament_entry', 'tournament_prize', 'adjustment')),
  user_id UUID REFERENCES users(id),
  match_id UUID,
  tournament_id UUID,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (debit_account <> credit_account)
);

CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_debit_idx ON ledger_entries (debit_account);
CREATE INDEX ledger_entries_credit_idx ON ledger_entries (credit_account);
CREATE INDEX ledger_transactions_user_idx ON ledger_transactions (user_id, created_at DESC);
CREATE INDEX ledger_transactions_match_idx ON ledger_transactions (match_id);

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Signed balance per account: credits in, debits out.
CREATE VIEW v_ledger_balances AS
  SELECT account, SUM(delta)::BIGINT AS balance_cents
  FROM (
    SELECT credit_account AS account, amount_cents AS delta FROM ledger_entries
    UNION ALL
    SELECT debit_account AS account, -amount_cents AS delta FROM ledger_entries
  ) movements
  GROUP BY account;

-- ------------------------------------------------------------------- matches

CREATE TABLE matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id),
  opponent_id UUID REFERENCES users(id),
  game TEXT NOT NULL DEFAULT 'EA Sports FC 26',
  game_mode TEXT NOT NULL DEFAULT 'ultimate_team'
    CHECK (game_mode IN ('ultimate_team', 'seasons', 'clubs', 'pro_clubs')),
  -- Zero is legal only for a tournament fixture: the money for those sits in
  -- the tournament's escrow, not the individual match's.
  stake_cents BIGINT NOT NULL CHECK (stake_cents >= 0),
  rake_bps INTEGER NOT NULL DEFAULT 1000 CHECK (rake_bps BETWEEN 0 AND 2000),
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'escrowed', 'in_progress', 'awaiting_results',
    'disputed', 'settled', 'voided', 'cancelled')),
  escrow_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (escrow_status IN ('pending', 'funded', 'released', 'refunded')),

  winner_id UUID REFERENCES users(id),
  outcome TEXT CHECK (outcome IN ('creator_win', 'opponent_win', 'draw')),
  creator_score INTEGER,
  opponent_score INTEGER,

  creator_ready BOOLEAN NOT NULL DEFAULT FALSE,
  opponent_ready BOOLEAN NOT NULL DEFAULT FALSE,

  tournament_id UUID,
  tournament_round INTEGER,

  started_at TIMESTAMPTZ,
  report_deadline_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (opponent_id IS NULL OR opponent_id <> creator_id),
  CHECK (stake_cents > 0 OR tournament_id IS NOT NULL)
);

CREATE INDEX matches_status_idx ON matches (status, created_at DESC);
CREATE INDEX matches_lobby_idx ON matches (status, stake_cents, game_mode) WHERE status = 'open';
CREATE INDEX matches_creator_idx ON matches (creator_id);
CREATE INDEX matches_opponent_idx ON matches (opponent_id);
CREATE INDEX matches_report_deadline_idx ON matches (report_deadline_at)
  WHERE status = 'awaiting_results';

-- --------------------------------------------------------------- screenshots

CREATE TABLE screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  uploader_id UUID NOT NULL REFERENCES users(id),
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  perceptual_hash TEXT,
  ocr_text TEXT,
  ocr_home_tag TEXT,
  ocr_away_tag TEXT,
  ocr_home_score INTEGER,
  ocr_away_score INTEGER,
  verdict TEXT NOT NULL DEFAULT 'pending'
    CHECK (verdict IN ('pending', 'match', 'mismatch', 'unreadable', 'duplicate')),
  duplicate_of_id UUID REFERENCES screenshots(id),
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX screenshots_match_idx ON screenshots (match_id);
CREATE INDEX screenshots_sha256_idx ON screenshots (sha256);
CREATE INDEX screenshots_phash_idx ON screenshots (perceptual_hash) WHERE perceptual_hash IS NOT NULL;

-- The bytes are immutable once stored; only the OCR/verdict columns may change.
CREATE OR REPLACE FUNCTION reject_screenshot_tamper() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sha256 <> OLD.sha256
     OR NEW.storage_key <> OLD.storage_key
     OR NEW.byte_size <> OLD.byte_size
     OR NEW.match_id <> OLD.match_id
     OR NEW.uploader_id <> OLD.uploader_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'screenshot evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER screenshots_immutable
  BEFORE UPDATE ON screenshots
  FOR EACH ROW EXECUTE FUNCTION reject_screenshot_tamper();

CREATE TABLE ocr_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screenshot_id UUID NOT NULL UNIQUE REFERENCES screenshots(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ocr_jobs_pending_idx ON ocr_jobs (created_at) WHERE status = 'pending';

-- ------------------------------------------------------------- match results

CREATE TABLE match_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  reporter_id UUID NOT NULL REFERENCES users(id),
  self_score INTEGER NOT NULL CHECK (self_score BETWEEN 0 AND 99),
  opponent_score INTEGER NOT NULL CHECK (opponent_score BETWEEN 0 AND 99),
  screenshot_id UUID REFERENCES screenshots(id),
  clip_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, reporter_id)
);

-- ------------------------------------------------------------------ disputes

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL UNIQUE REFERENCES matches(id),
  raised_by UUID REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'under_review', 'resolved', 'auto_resolved')),
  resolution TEXT CHECK (resolution IN
    ('creator_wins', 'opponent_wins', 'void_refund', 'replay', 'dismissed')),
  resolved_by UUID REFERENCES users(id),
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX disputes_queue_idx ON disputes (status, created_at);

-- -------------------------------------------------------------- trust events

CREATE TABLE trust_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'match_settled_clean', 'report_accurate', 'report_inaccurate', 'dispute_raised',
    'dispute_lost', 'dispute_won', 'report_timeout', 'match_cancelled', 'strike',
    'manual_adjustment')),
  match_id UUID REFERENCES matches(id),
  delta INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trust_events_user_idx ON trust_events (user_id, created_at DESC);

-- ----------------------------------------------------------------------- kyc

CREATE TABLE kyc_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('unstarted', 'pending', 'approved', 'rejected')),
  document_type TEXT NOT NULL,
  document_ref TEXT NOT NULL,
  selfie_ref TEXT NOT NULL,
  address_country TEXT NOT NULL,
  address_region TEXT,
  reviewed_by UUID REFERENCES users(id),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX kyc_records_user_idx ON kyc_records (user_id, created_at DESC);
CREATE INDEX kyc_records_queue_idx ON kyc_records (status, created_at) WHERE status = 'pending';

-- --------------------------------------------------------------- engagement

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  match_id UUID REFERENCES matches(id),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  user_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_match_idx ON chat_messages (match_id, created_at);

-- --------------------------------------------------------------- tournaments

CREATE TABLE tournaments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  game_mode TEXT NOT NULL DEFAULT 'ultimate_team'
    CHECK (game_mode IN ('ultimate_team', 'seasons', 'clubs', 'pro_clubs')),
  entry_fee_cents BIGINT NOT NULL CHECK (entry_fee_cents >= 0),
  rake_bps INTEGER NOT NULL DEFAULT 1000 CHECK (rake_bps BETWEEN 0 AND 2000),
  max_entrants INTEGER NOT NULL CHECK (max_entrants >= 2),
  status TEXT NOT NULL DEFAULT 'registering'
    CHECK (status IN ('registering', 'running', 'completed', 'cancelled')),
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  sponsor_name TEXT,
  starts_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tournament_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id),
  user_id UUID NOT NULL REFERENCES users(id),
  seed INTEGER,
  eliminated_in_round INTEGER,
  placement INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE tournament_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id),
  round INTEGER NOT NULL CHECK (round >= 1),
  position INTEGER NOT NULL CHECK (position >= 0),
  match_id UUID REFERENCES matches(id),
  player_a_id UUID REFERENCES users(id),
  player_b_id UUID REFERENCES users(id),
  winner_id UUID REFERENCES users(id),
  UNIQUE (tournament_id, round, position)
);

ALTER TABLE matches
  ADD CONSTRAINT matches_tournament_fk FOREIGN KEY (tournament_id) REFERENCES tournaments(id);

-- ---------------------------------------------------------------- anti-fraud

CREATE TABLE device_fingerprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  fingerprint TEXT NOT NULL,
  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

CREATE INDEX device_fingerprints_fp_idx ON device_fingerprints (fingerprint);
CREATE INDEX device_fingerprints_ip_idx ON device_fingerprints (ip);

CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('card', 'paypal', 'bank')),
  -- A processor-side fingerprint, never a PAN. Two accounts sharing one is a
  -- strong signal of the same human behind both.
  instrument_fingerprint TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, instrument_fingerprint)
);

CREATE INDEX payment_methods_fp_idx ON payment_methods (instrument_fingerprint);

CREATE TABLE payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
  provider TEXT NOT NULL CHECK (provider IN ('mock', 'stripe', 'paypal', 'bank')),
  provider_ref TEXT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX payment_intents_user_idx ON payment_intents (user_id, created_at DESC);

CREATE TABLE blocked_regions (
  code TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  -- Some jurisdictions permit paid skill contests only at 21+.
  min_age INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fraud_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  related_user_id UUID REFERENCES users(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fraud_flags_user_idx ON fraud_flags (user_id, created_at DESC);
CREATE INDEX fraud_flags_open_idx ON fraud_flags (created_at) WHERE resolved_at IS NULL;

CREATE TABLE admin_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
