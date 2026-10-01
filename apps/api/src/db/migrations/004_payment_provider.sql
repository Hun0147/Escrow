-- Deposits become two steps: an intent, then a confirmation from the provider.
-- Until now the ledger was credited inline, which no real processor allows —
-- the money is not ours to credit until the processor says it captured.

-- A provider reference identifies one payment at one provider, so a repeated
-- webhook resolves to the same intent instead of creating a second credit.
CREATE UNIQUE INDEX payment_intents_provider_ref_key
  ON payment_intents (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

CREATE INDEX payment_intents_pending_idx ON payment_intents (created_at)
  WHERE status = 'pending';

-- Records every webhook we accept, so a replayed delivery is visible as a
-- replay rather than silently ignored.
CREATE TABLE payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  -- The provider's own event id. Unique, so a redelivery cannot be processed
  -- twice even if it arrives while the first is still in flight.
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payment_intent_id UUID REFERENCES payment_intents(id),
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE INDEX payment_events_intent_idx ON payment_events (payment_intent_id);
