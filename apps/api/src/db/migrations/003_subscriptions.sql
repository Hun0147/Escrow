-- Goal 27 Pro: a paid tier that lowers the rake and jumps the matchmaking queue.

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tier TEXT NOT NULL DEFAULT 'pro' CHECK (tier IN ('pro')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelling', 'cancelled', 'lapsed')),
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live subscription per account. A lapsed or cancelled one stays on file as
-- billing history, so this only constrains the ones that are still running.
CREATE UNIQUE INDEX subscriptions_one_live_per_user
  ON subscriptions (user_id)
  WHERE status IN ('active', 'cancelling');

CREATE INDEX subscriptions_renewal_idx ON subscriptions (current_period_end)
  WHERE status IN ('active', 'cancelling');

-- Subscription fees are ordinary ledger movements, so they show up in a
-- player's statement alongside everything else.
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check
  CHECK (type IN (
    'deposit', 'withdrawal', 'escrow_lock', 'escrow_payout',
    'platform_rake', 'refund', 'tournament_entry', 'tournament_prize',
    'subscription_fee', 'adjustment'));

INSERT INTO platform_settings (key, value) VALUES
  ('pro_subscription_cents', '999'::jsonb),
  ('pro_subscription_days', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
