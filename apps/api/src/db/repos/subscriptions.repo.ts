import { Subscription, SubscriptionStatus } from '@escrow/shared';
import { pool } from '../pool';
import { Queryable } from './users.repo';

function mapSubscription(row: any): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    status: row.status,
    priceCents: Number(row.price_cents),
    currentPeriodStart: row.current_period_start.toISOString(),
    currentPeriodEnd: row.current_period_end.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertSubscription(
  params: { userId: string; priceCents: number; periodDays: number },
  db: Queryable = pool,
): Promise<Subscription> {
  const { rows } = await db.query(
    `INSERT INTO subscriptions (user_id, price_cents, current_period_end)
     VALUES ($1, $2, now() + ($3 || ' days')::interval) RETURNING *`,
    [params.userId, params.priceCents, String(params.periodDays)],
  );
  return mapSubscription(rows[0]);
}

/** The subscription that is still running, if any. */
export async function findLiveSubscription(
  userId: string,
  db: Queryable = pool,
): Promise<Subscription | null> {
  const { rows } = await db.query(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND status IN ('active', 'cancelling')
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

export async function lockLiveSubscription(
  userId: string,
  db: Queryable,
): Promise<Subscription | null> {
  const { rows } = await db.query(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND status IN ('active', 'cancelling')
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId],
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

export async function setSubscriptionStatus(
  id: string,
  status: SubscriptionStatus,
  db: Queryable = pool,
): Promise<Subscription> {
  const { rows } = await db.query(
    'UPDATE subscriptions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, status],
  );
  if (!rows[0]) throw new Error('Subscription not found');
  return mapSubscription(rows[0]);
}

export async function extendSubscription(
  id: string,
  periodDays: number,
  db: Queryable = pool,
): Promise<Subscription> {
  const { rows } = await db.query(
    `UPDATE subscriptions
     SET current_period_start = current_period_end,
         current_period_end = current_period_end + ($2 || ' days')::interval,
         updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, String(periodDays)],
  );
  if (!rows[0]) throw new Error('Subscription not found');
  return mapSubscription(rows[0]);
}

/** Subscriptions whose paid period has run out and need renewing or closing. */
export async function findDueSubscriptions(
  limit = 100,
  db: Queryable = pool,
): Promise<Subscription[]> {
  const { rows } = await db.query(
    `SELECT * FROM subscriptions
     WHERE status IN ('active', 'cancelling') AND current_period_end < now()
     ORDER BY current_period_end ASC LIMIT $1`,
    [limit],
  );
  return rows.map(mapSubscription);
}

export async function listSubscriptionHistory(
  userId: string,
  db: Queryable = pool,
): Promise<Subscription[]> {
  const { rows } = await db.query(
    'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 24',
    [userId],
  );
  return rows.map(mapSubscription);
}
