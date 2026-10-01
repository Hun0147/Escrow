-- Discord direct messages.
--
-- The match room is unusable during the part that matters: a player is on
-- their PS5 with hands on a controller for twelve minutes, not looking at a
-- web page. The reporting window is ten minutes long, and a player who closed
-- the tab currently has no idea it is running — so a match escalates to a
-- moderator who never needed to be involved. A DM lands on their phone.
--
-- Outbound only. Nothing arriving from Discord may move money or change match
-- state; that rule is the same one that keeps settlement off the websocket.

ALTER TABLE users
  ADD COLUMN discord_id TEXT,
  ADD COLUMN discord_username TEXT,
  -- Linking implies consent to be messaged; this is the switch to stop.
  ADD COLUMN discord_dm_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN discord_linked_at TIMESTAMPTZ;

-- One Discord account per player, and one player per Discord account: it is
-- another uniqueness axis alongside PSN, and shared identity is a fraud signal.
CREATE UNIQUE INDEX users_discord_id_key ON users (discord_id) WHERE discord_id IS NOT NULL;

-- Idempotency and audit in one column: a notification is DM'd at most once,
-- and support can see whether a player was actually told.
ALTER TABLE notifications
  ADD COLUMN discord_delivered_at TIMESTAMPTZ,
  ADD COLUMN discord_error TEXT;

CREATE INDEX notifications_discord_pending_idx ON notifications (created_at)
  WHERE discord_delivered_at IS NULL;

-- Which notifications are worth interrupting someone for. Deposits and
-- withdrawals are deliberately absent: a DM per wallet movement trains people
-- to ignore the channel, and the one message that matters is the reporting
-- clock.
INSERT INTO platform_settings (key, value) VALUES
  ('discord_dm_types', '["match_joined","match_ready","result_submitted","match_settled","dispute_opened","dispute_resolved","kyc_updated","tournament_started"]'::jsonb)
ON CONFLICT (key) DO NOTHING;
