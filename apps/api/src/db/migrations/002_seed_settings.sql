-- Configurable platform defaults and the initial blocked-region list.
-- Values here are operational settings, not code constants, so compliance can
-- change them without a deploy.

INSERT INTO platform_settings (key, value) VALUES
  ('rake_bps', '1000'::jsonb),
  ('pro_rake_bps', '700'::jsonb),
  ('min_deposit_cents', '500'::jsonb),
  ('max_deposit_cents', '100000'::jsonb),
  ('min_withdrawal_cents', '1000'::jsonb),
  ('daily_withdrawal_cap_cents', '200000'::jsonb),
  ('daily_deposit_cap_cents', '100000'::jsonb),
  ('result_deadline_minutes', '10'::jsonb),
  ('match_start_countdown_seconds', '120'::jsonb),
  ('min_age', '18'::jsonb),
  ('kyc_required_before_withdrawal', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Placeholder list. These are the US states most commonly cited as restricting
-- paid entry-fee skill contests, plus a few national bans. It is a starting
-- point for a compliance review, NOT legal advice, and must be verified per
-- jurisdiction before real money moves.
INSERT INTO blocked_regions (code, reason, min_age) VALUES
  ('US-AZ', 'Paid entry-fee skill contests restricted', NULL),
  ('US-AR', 'Paid entry-fee skill contests restricted', NULL),
  ('US-CT', 'Paid entry-fee skill contests restricted', NULL),
  ('US-DE', 'Paid entry-fee skill contests restricted', NULL),
  ('US-LA', 'Paid entry-fee skill contests restricted', NULL),
  ('US-MT', 'Paid entry-fee skill contests restricted', NULL),
  ('US-SC', 'Paid entry-fee skill contests restricted', NULL),
  ('US-SD', 'Paid entry-fee skill contests restricted', NULL),
  ('US-TN', 'Paid entry-fee skill contests restricted', NULL),
  ('US-AL', 'Minimum age 19 in this state', 19),
  ('US-NE', 'Minimum age 19 in this state', 19),
  ('US-MA', 'Minimum age 21 in this state', 21),
  ('KP', 'Sanctioned jurisdiction', NULL),
  ('IR', 'Sanctioned jurisdiction', NULL),
  ('SY', 'Sanctioned jurisdiction', NULL),
  ('CU', 'Sanctioned jurisdiction', NULL)
ON CONFLICT (code) DO NOTHING;
