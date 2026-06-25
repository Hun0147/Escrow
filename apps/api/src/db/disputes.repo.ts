import { Pool, PoolClient } from 'pg';
import { Dispute, DisputeStatus } from '@escrow/shared';
import { pool } from './pool';

type Queryable = Pool | PoolClient;

function mapRow(row: any): Dispute {
  return {
    id: row.id,
    matchId: row.match_id,
    raisedBy: row.raised_by,
    status: row.status,
    evidence: row.evidence,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createDispute(
  params: { matchId: string; raisedBy: string; evidence: string[] },
  db: Queryable = pool,
): Promise<Dispute> {
  const { rows } = await db.query(
    `INSERT INTO disputes (match_id, raised_by, evidence) VALUES ($1, $2, $3) RETURNING *`,
    [params.matchId, params.raisedBy, JSON.stringify(params.evidence)],
  );
  return mapRow(rows[0]);
}

export async function findDisputeById(id: string, db: Queryable = pool): Promise<Dispute | null> {
  const { rows } = await db.query(`SELECT * FROM disputes WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function resolveDisputeRow(
  id: string,
  resolution: string,
  status: DisputeStatus,
  db: Queryable = pool,
): Promise<Dispute> {
  const { rows } = await db.query(
    `UPDATE disputes SET status = $1, resolution = $2 WHERE id = $3 RETURNING *`,
    [status, resolution, id],
  );
  return mapRow(rows[0]);
}
