-- The fraud review window the trust policy has always promised.
--
-- `settlementPolicyFor()` returns a hold — 60 seconds at standard trust, 300
-- at low — described as a window in which a late signal can still stop a
-- payout. Nothing read it, so agreement paid out instantly and the window did
-- not exist. It is a column rather than a timer because a hold that a process
-- restart forgets is not a hold, and because two workers must not each start
-- their own clock on the same match.
ALTER TABLE matches ADD COLUMN settlement_hold_until TIMESTAMPTZ;

-- The sweep asks one question: which held matches are due?
CREATE INDEX matches_settlement_hold_idx ON matches (settlement_hold_until)
  WHERE settlement_hold_until IS NOT NULL;
