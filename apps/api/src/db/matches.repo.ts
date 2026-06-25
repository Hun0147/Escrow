import { Pool, PoolClient } from 'pg';
import { Match, MatchStatus } from '@escrow/shared';
import { pool } from './pool';

type Queryable = Pool | PoolClient;

function mapRow(row: any): Match {
  return {
    id: row.id,
    creatorId: row.creator_id,
    opponentId: row.opponent_id,
    game: row.game,
    stakeCents: Number(row.stake_cents),
    status: row.status,
    winnerId: row.winner_id,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createMatchRow(
  params: { creatorId: string; game: string; stakeCents: number },
  db: Queryable = pool,
): Promise<Match> {
  const { rows } = await db.query(
    `INSERT INTO matches (creator_id, game, stake_cents) VALUES ($1, $2, $3) RETURNING *`,
    [params.creatorId, params.game, params.stakeCents],
  );
  return mapRow(rows[0]);
}

export async function findMatchById(id: string, db: Queryable = pool): Promise<Match | null> {
  const { rows } = await db.query(`SELECT * FROM matches WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Locks the match row for update; use inside a transaction to serialize concurrent funding/settlement. */
export async function findMatchByIdForUpdate(id: string, db: Queryable = pool): Promise<Match | null> {
  const { rows } = await db.query(`SELECT * FROM matches WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateMatch(
  id: string,
  patch: Partial<{ opponentId: string | null; status: MatchStatus; winnerId: string | null }>,
  db: Queryable = pool,
): Promise<Match> {
  const { rows } = await db.query(
    `UPDATE matches SET
       opponent_id = COALESCE($2, opponent_id),
       status = COALESCE($3, status),
       winner_id = CASE WHEN $4 THEN $5 ELSE winner_id END
     WHERE id = $1 RETURNING *`,
    [id, patch.opponentId ?? null, patch.status ?? null, 'winnerId' in patch, patch.winnerId ?? null],
  );
  return mapRow(rows[0]);
}
