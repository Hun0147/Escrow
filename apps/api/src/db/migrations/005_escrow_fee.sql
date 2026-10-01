-- One escrow fee replaces the platform rake.
--
-- Goal 27 charges a single rate wherever money leaves escrow to a player: a
-- winning payout, a tournament prize, and a withdrawal. Refunds — draws,
-- voids, moderator rulings, cancellations — and deposits are never charged.
-- The columns and ledger type are renamed so the schema says what the product
-- does, rather than carrying a word ("rake") that no longer appears anywhere.

ALTER TABLE matches RENAME COLUMN rake_bps TO escrow_fee_bps;
ALTER TABLE matches RENAME CONSTRAINT matches_rake_bps_check TO matches_escrow_fee_bps_check;

ALTER TABLE tournaments RENAME COLUMN rake_bps TO escrow_fee_bps;
ALTER TABLE tournaments RENAME CONSTRAINT tournaments_rake_bps_check TO tournaments_escrow_fee_bps_check;

-- Historic rows keep their amounts; only the label changes.
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
UPDATE ledger_transactions SET type = 'escrow_fee' WHERE type = 'platform_rake';
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check
  CHECK (type IN (
    'deposit', 'withdrawal', 'escrow_lock', 'escrow_payout',
    'escrow_fee', 'refund', 'tournament_entry', 'tournament_prize',
    'subscription_fee', 'adjustment'));

UPDATE platform_settings SET key = 'escrow_fee_bps' WHERE key = 'rake_bps';
UPDATE platform_settings SET key = 'pro_escrow_fee_bps' WHERE key = 'pro_rake_bps';

-- The smallest withdrawal that still leaves the player something after the
-- fee. Enforced in code; stored here so operations can raise it without a
-- deploy.
INSERT INTO platform_settings (key, value) VALUES ('min_withdrawal_net_cents', '100'::jsonb)
ON CONFLICT (key) DO NOTHING;
