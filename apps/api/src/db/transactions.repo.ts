import { Pool, PoolClient } from 'pg';
import { Transaction, TransactionType } from '@escrow/shared';
import { pool } from './pool';

type Queryable = Pool | PoolClient;

function mapRow(row: any): Transaction {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    amountCents: Number(row.amount_cents),
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export async function recordTransaction(
  params: { userId: string; matchId?: string | null; type: TransactionType; amountCents: number },
  db: Queryable = pool,
): Promise<Transaction> {
  const { rows } = await db.query(
    `INSERT INTO transactions (user_id, match_id, type, amount_cents, status)
     VALUES ($1, $2, $3, $4, 'completed') RETURNING *`,
    [params.userId, params.matchId ?? null, params.type, params.amountCents],
  );
  return mapRow(rows[0]);
}
