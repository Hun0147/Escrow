import { pool } from '../pool';
import { Queryable } from './users.repo';

export interface DeviceFingerprintInput {
  userId: string;
  fingerprint: string;
  ip: string | null;
  userAgent: string | null;
}

export async function recordDevice(input: DeviceFingerprintInput, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO device_fingerprints (user_id, fingerprint, ip, user_agent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, fingerprint)
     DO UPDATE SET last_seen_at = now(), ip = COALESCE(EXCLUDED.ip, device_fingerprints.ip)`,
    [input.userId, input.fingerprint, input.ip, input.userAgent],
  );
}

/**
 * Accounts that share a device, an IP, or a payment instrument with this one.
 *
 * This is the self-matching check: two accounts run by the same person can
 * otherwise "play" each other, lose on purpose, and use the platform to move
 * money around at the cost of only the rake.
 */
export interface LinkedAccount {
  userId: string;
  reasons: string[];
}

export async function findLinkedAccounts(
  userId: string,
  db: Queryable = pool,
): Promise<LinkedAccount[]> {
  const { rows } = await db.query(
    `WITH mine AS (
       SELECT fingerprint, ip FROM device_fingerprints WHERE user_id = $1
     ),
     my_instruments AS (
       SELECT instrument_fingerprint FROM payment_methods WHERE user_id = $1
     ),
     device_matches AS (
       SELECT d.user_id, 'shared_device' AS reason
       FROM device_fingerprints d
       WHERE d.user_id <> $1 AND d.fingerprint IN (SELECT fingerprint FROM mine)
     ),
     ip_matches AS (
       SELECT d.user_id, 'shared_ip' AS reason
       FROM device_fingerprints d
       WHERE d.user_id <> $1 AND d.ip IS NOT NULL
         AND d.ip IN (SELECT ip FROM mine WHERE ip IS NOT NULL)
     ),
     payment_matches AS (
       SELECT p.user_id, 'shared_payment_method' AS reason
       FROM payment_methods p
       WHERE p.user_id <> $1
         AND p.instrument_fingerprint IN (SELECT instrument_fingerprint FROM my_instruments)
     )
     SELECT user_id, array_agg(DISTINCT reason) AS reasons
     FROM (
       SELECT * FROM device_matches
       UNION ALL SELECT * FROM ip_matches
       UNION ALL SELECT * FROM payment_matches
     ) all_matches
     GROUP BY user_id`,
    [userId],
  );
  return rows.map((row) => ({ userId: row.user_id, reasons: row.reasons }));
}

/**
 * Signals strong enough to refuse a match outright.
 *
 * A shared IP is deliberately NOT one of them: flatmates, a family console and
 * anyone behind carrier-grade NAT share an address, and blocking them would
 * break a real use case to stop a fraud they may not be committing. It is
 * still recorded, so a moderator sees the pattern if it recurs.
 */
export const BLOCKING_LINK_REASONS = ['shared_device', 'shared_payment_method'] as const;

export interface LinkAssessment {
  reasons: string[];
  blocking: string[];
}

export async function assessAccountLink(
  userA: string,
  userB: string,
  db: Queryable = pool,
): Promise<LinkAssessment> {
  const linked = await findLinkedAccounts(userA, db);
  const reasons = linked.find((entry) => entry.userId === userB)?.reasons ?? [];
  return {
    reasons,
    blocking: reasons.filter((reason) =>
      (BLOCKING_LINK_REASONS as readonly string[]).includes(reason),
    ),
  };
}

export async function raiseFraudFlag(
  params: { userId: string; relatedUserId?: string | null; kind: string; detail: string },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO fraud_flags (user_id, related_user_id, kind, detail) VALUES ($1, $2, $3, $4)`,
    [params.userId, params.relatedUserId ?? null, params.kind, params.detail],
  );
}

export interface FraudFlagRow {
  id: string;
  userId: string;
  relatedUserId: string | null;
  kind: string;
  detail: string;
  createdAt: string;
}

export async function listOpenFraudFlags(limit = 100, db: Queryable = pool): Promise<FraudFlagRow[]> {
  const { rows } = await db.query(
    `SELECT * FROM fraud_flags WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    relatedUserId: row.related_user_id,
    kind: row.kind,
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  }));
}

// -------------------------------------------------------------- geofencing

export interface BlockedRegion {
  code: string;
  reason: string;
  minAge: number | null;
}

export async function findBlockedRegion(
  countryCode: string,
  regionCode: string | null,
  db: Queryable = pool,
): Promise<BlockedRegion | null> {
  const codes = [countryCode.toUpperCase()];
  if (regionCode) codes.push(`${countryCode.toUpperCase()}-${regionCode.toUpperCase()}`);
  const { rows } = await db.query(
    `SELECT * FROM blocked_regions WHERE code = ANY($1::text[])
     ORDER BY length(code) DESC LIMIT 1`,
    [codes],
  );
  if (!rows[0]) return null;
  return { code: rows[0].code, reason: rows[0].reason, minAge: rows[0].min_age };
}

export async function listBlockedRegions(db: Queryable = pool): Promise<BlockedRegion[]> {
  const { rows } = await db.query('SELECT * FROM blocked_regions ORDER BY code');
  return rows.map((row) => ({ code: row.code, reason: row.reason, minAge: row.min_age }));
}

export async function upsertBlockedRegion(
  params: { code: string; reason: string; minAge: number | null },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO blocked_regions (code, reason, min_age) VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET reason = EXCLUDED.reason, min_age = EXCLUDED.min_age`,
    [params.code.toUpperCase(), params.reason, params.minAge],
  );
}

export async function deleteBlockedRegion(code: string, db: Queryable = pool): Promise<void> {
  await db.query('DELETE FROM blocked_regions WHERE code = $1', [code.toUpperCase()]);
}

// ---------------------------------------------------------------- payments

export async function insertPaymentIntent(
  params: {
    userId: string;
    direction: 'deposit' | 'withdrawal';
    provider: 'mock' | 'stripe' | 'paypal' | 'bank';
    amountCents: number;
    providerRef?: string | null;
  },
  db: Queryable = pool,
): Promise<{ id: string }> {
  const { rows } = await db.query(
    `INSERT INTO payment_intents (user_id, direction, provider, amount_cents, provider_ref)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [params.userId, params.direction, params.provider, params.amountCents, params.providerRef ?? null],
  );
  return { id: rows[0].id };
}

export async function completePaymentIntent(
  id: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  failureReason: string | null,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE payment_intents SET status = $2, failure_reason = $3, completed_at = now() WHERE id = $1`,
    [id, status, failureReason],
  );
}

export async function attachProviderRef(
  id: string,
  providerRef: string,
  db: Queryable = pool,
): Promise<void> {
  await db.query('UPDATE payment_intents SET provider_ref = $2 WHERE id = $1', [id, providerRef]);
}

export interface PaymentIntentRow {
  id: string;
  userId: string;
  direction: 'deposit' | 'withdrawal';
  provider: string;
  providerRef: string | null;
  amountCents: number;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
}

function mapIntent(row: any): PaymentIntentRow {
  return {
    id: row.id,
    userId: row.user_id,
    direction: row.direction,
    provider: row.provider,
    providerRef: row.provider_ref,
    amountCents: Number(row.amount_cents),
    status: row.status,
  };
}

export async function findPaymentIntent(
  id: string,
  db: Queryable = pool,
): Promise<PaymentIntentRow | null> {
  const { rows } = await db.query('SELECT * FROM payment_intents WHERE id = $1', [id]);
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function findPaymentIntentByRef(
  provider: string,
  providerRef: string,
  db: Queryable = pool,
): Promise<PaymentIntentRow | null> {
  const { rows } = await db.query(
    'SELECT * FROM payment_intents WHERE provider = $1 AND provider_ref = $2',
    [provider, providerRef],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

/**
 * Marks a pending intent succeeded, and reports whether THIS call is the one
 * that did it.
 *
 * The whole idempotency of the deposit path rests here: a webhook can be
 * delivered any number of times, and only the caller that flips the row out of
 * 'pending' is allowed to credit the ledger.
 */
export async function claimPaymentIntent(
  id: string,
  db: Queryable,
): Promise<PaymentIntentRow | null> {
  const { rows } = await db.query(
    `UPDATE payment_intents SET status = 'succeeded', completed_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

/** Records an accepted webhook. Returns false if we have seen it before. */
export async function recordPaymentEvent(
  params: {
    provider: string;
    eventId: string;
    eventType: string;
    paymentIntentId: string | null;
    payload: unknown;
  },
  db: Queryable = pool,
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO payment_events (provider, event_id, event_type, payment_intent_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [
      params.provider,
      params.eventId,
      params.eventType,
      params.paymentIntentId,
      JSON.stringify(params.payload ?? {}),
    ],
  );
  return rows.length > 0;
}

/**
 * Total moved in one direction over a rolling window.
 *
 * `includePending` counts money still in flight as well as money taken — a
 * limit that ignored pending intents could be stepped over by firing several
 * deposits before any of them confirm.
 */
export async function sumRecentPayments(
  userId: string,
  direction: 'deposit' | 'withdrawal',
  windowHours: number,
  options: { includePending?: boolean; db?: Queryable } = {},
): Promise<number> {
  const db = options.db ?? pool;
  const statuses = options.includePending ? ['succeeded', 'pending'] : ['succeeded'];
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payment_intents
     WHERE user_id = $1 AND direction = $2 AND status = ANY($3::text[])
       AND created_at > now() - ($4 || ' hours')::interval`,
    [userId, direction, statuses, String(windowHours)],
  );
  return Number(rows[0].total);
}

export async function countRecentPayments(
  userId: string,
  direction: 'deposit' | 'withdrawal',
  windowMinutes: number,
  db: Queryable = pool,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS count FROM payment_intents
     WHERE user_id = $1 AND direction = $2
       AND created_at > now() - ($3 || ' minutes')::interval`,
    [userId, direction, String(windowMinutes)],
  );
  return Number(rows[0].count);
}

export async function recordPaymentMethod(
  params: { userId: string; kind: 'card' | 'paypal' | 'bank'; instrumentFingerprint: string; label?: string | null },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO payment_methods (user_id, kind, instrument_fingerprint, label)
     VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, instrument_fingerprint) DO NOTHING`,
    [params.userId, params.kind, params.instrumentFingerprint, params.label ?? null],
  );
}

export async function logAdminAction(
  params: { adminId: string; action: string; targetType: string; targetId: string; notes?: string | null },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO admin_actions (admin_id, action, target_type, target_id, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.adminId, params.action, params.targetType, params.targetId, params.notes ?? null],
  );
}
