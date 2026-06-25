-- Phase 1 MVP schema: registration, wallet, escrow, match creation, manual dispute review.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  psn_id TEXT UNIQUE,
  wallet_balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (wallet_balance_cents >= 0),
  kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id),
  opponent_id UUID REFERENCES users(id),
  game TEXT NOT NULL,
  stake_cents BIGINT NOT NULL CHECK (stake_cents > 0),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'funded', 'in_progress', 'awaiting_confirmation', 'disputed', 'settled', 'cancelled')),
  winner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL UNIQUE REFERENCES matches(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'funded', 'released', 'refunded')),
  released_at TIMESTAMPTZ
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  match_id UUID REFERENCES matches(id),
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'escrow_lock', 'escrow_release', 'platform_fee', 'refund')),
  amount_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  raised_by UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'community_review', 'moderator_review', 'arbitration', 'resolved')),
  evidence JSONB NOT NULL DEFAULT '[]',
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_disputes_match_id ON disputes(match_id);
