import { Pool, PoolClient } from 'pg';
import { Escrow, EscrowStatus } from '@escrow/shared';
import { pool } from './pool';

type Queryable = Pool | PoolClient;

function mapRow(row: any): Escrow {
  return {
    id: row.id,
    matchId: row.match_id,
    amountCents: Number(row.amount_cents),
    status: row.status,
    releasedAt: row.released_at ? row.released_at.toISOString() : null,
  };
}

export async function findEscrowByMatchId(matchId: string, db: Queryable = pool): Promise<Escrow | null> {
  const { rows } = await db.query(`SELECT * FROM escrows WHERE match_id = $1`, [matchId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createEscrow(
  params: { matchId: string; amountCents: number; status?: EscrowStatus },
  db: Queryable = pool,
): Promise<Escrow> {
  const { rows } = await db.query(
    `INSERT INTO escrows (match_id, amount_cents, status) VALUES ($1, $2, $3) RETURNING *`,
    [params.matchId, params.amountCents, params.status ?? 'pending'],
  );
  return mapRow(rows[0]);
}

export async function addToEscrow(matchId: string, amountCents: number, db: Queryable = pool): Promise<Escrow> {
  const { rows } = await db.query(
    `UPDATE escrows SET amount_cents = amount_cents + $1 WHERE match_id = $2 RETURNING *`,
    [amountCents, matchId],
  );
  return mapRow(rows[0]);
}

export async function updateEscrowStatus(
  matchId: string,
  status: EscrowStatus,
  db: Queryable = pool,
): Promise<Escrow> {
  const { rows } = await db.query(
    `UPDATE escrows SET status = $1, released_at = CASE WHEN $1 IN ('released', 'refunded') THEN now() ELSE released_at END
     WHERE match_id = $2 RETURNING *`,
    [status, matchId],
  );
  return mapRow(rows[0]);
}
