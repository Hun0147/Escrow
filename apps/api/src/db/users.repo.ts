import { Pool, PoolClient } from 'pg';
import { User } from '@escrow/shared';
import { pool } from './pool';

type Queryable = Pool | PoolClient;
export type UserRecord = User & { passwordHash: string };

function mapRow(row: any): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    psnId: row.psn_id,
    walletBalanceCents: Number(row.wallet_balance_cents),
    kycStatus: row.kyc_status,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createUser(
  params: { email: string; passwordHash: string; psnId?: string | null },
  db: Queryable = pool,
): Promise<UserRecord> {
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, psn_id) VALUES ($1, $2, $3) RETURNING *`,
    [params.email, params.passwordHash, params.psnId ?? null],
  );
  return mapRow(rows[0]);
}

export async function findUserByEmail(email: string, db: Queryable = pool): Promise<UserRecord | null> {
  const { rows } = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findUserById(id: string, db: Queryable = pool): Promise<UserRecord | null> {
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export class InsufficientBalanceError extends Error {}

/**
 * Atomically adjusts a user's wallet balance by deltaCents (positive or negative).
 * The WHERE clause enforces the non-negative-balance invariant at the database
 * level so concurrent requests can't race past zero.
 */
export async function adjustBalance(
  userId: string,
  deltaCents: number,
  db: Queryable = pool,
): Promise<number> {
  const { rows } = await db.query(
    `UPDATE users SET wallet_balance_cents = wallet_balance_cents + $1
     WHERE id = $2 AND wallet_balance_cents + $1 >= 0
     RETURNING wallet_balance_cents`,
    [deltaCents, userId],
  );
  if (rows[0]) return Number(rows[0].wallet_balance_cents);

  const user = await findUserById(userId, db);
  if (!user) throw new Error('User not found');
  throw new InsufficientBalanceError('Insufficient balance');
}
