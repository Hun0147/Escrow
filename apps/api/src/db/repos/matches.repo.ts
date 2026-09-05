import {
  GameMode,
  Match,
  MatchOutcome,
  MatchResult,
  MatchRules,
  MatchStatus,
  EscrowStatus,
  normaliseRules,
} from '@escrow/shared';
import { pool } from '../pool';
import { Queryable } from './users.repo';

export function mapMatch(row: any): Match {
  return {
    id: row.id,
    creatorId: row.creator_id,
    opponentId: row.opponent_id,
    game: row.game,
    gameMode: row.game_mode,
    stakeCents: Number(row.stake_cents),
    rakeBps: row.rake_bps,
    rules: normaliseRules(row.rules ?? {}),
    status: row.status,
    escrowStatus: row.escrow_status,
    winnerId: row.winner_id,
    outcome: row.outcome,
    creatorScore: row.creator_score,
    opponentScore: row.opponent_score,
    creatorReady: row.creator_ready,
    opponentReady: row.opponent_ready,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    reportDeadlineAt: row.report_deadline_at ? row.report_deadline_at.toISOString() : null,
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CreateMatchParams {
  creatorId: string;
  game: string;
  gameMode: GameMode;
  stakeCents: number;
  rakeBps: number;
  rules: MatchRules;
  tournamentId?: string | null;
  tournamentRound?: number | null;
}

export async function insertMatch(params: CreateMatchParams, db: Queryable = pool): Promise<Match> {
  const { rows } = await db.query(
    `INSERT INTO matches (creator_id, game, game_mode, stake_cents, rake_bps, rules,
                          tournament_id, tournament_round)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
    [
      params.creatorId,
      params.game,
      params.gameMode,
      params.stakeCents,
      params.rakeBps,
      JSON.stringify(params.rules),
      params.tournamentId ?? null,
      params.tournamentRound ?? null,
    ],
  );
  return mapMatch(rows[0]);
}

export async function findMatchById(id: string, db: Queryable = pool): Promise<Match | null> {
  const { rows } = await db.query('SELECT * FROM matches WHERE id = $1', [id]);
  return rows[0] ? mapMatch(rows[0]) : null;
}

/** Row-locks the match; every money path takes this lock first so that
 *  concurrent joins, settlements and cancels serialise on the match. */
export async function lockMatch(id: string, db: Queryable): Promise<Match | null> {
  const { rows } = await db.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ? mapMatch(rows[0]) : null;
}

const UPDATABLE: Record<string, string> = {
  opponentId: 'opponent_id',
  status: 'status',
  escrowStatus: 'escrow_status',
  winnerId: 'winner_id',
  outcome: 'outcome',
  creatorScore: 'creator_score',
  opponentScore: 'opponent_score',
  creatorReady: 'creator_ready',
  opponentReady: 'opponent_ready',
  startedAt: 'started_at',
  reportDeadlineAt: 'report_deadline_at',
  settledAt: 'settled_at',
};

export interface MatchPatch {
  opponentId?: string | null;
  status?: MatchStatus;
  escrowStatus?: EscrowStatus;
  winnerId?: string | null;
  outcome?: MatchOutcome | null;
  creatorScore?: number | null;
  opponentScore?: number | null;
  creatorReady?: boolean;
  opponentReady?: boolean;
  startedAt?: string | null;
  reportDeadlineAt?: string | null;
  settledAt?: string | null;
}

export async function updateMatch(id: string, patch: MatchPatch, db: Queryable = pool): Promise<Match> {
  const keys = Object.keys(patch).filter((key) => key in UPDATABLE);
  if (keys.length === 0) {
    const existing = await findMatchById(id, db);
    if (!existing) throw new Error('Match not found');
    return existing;
  }
  const assignments = keys.map((key, index) => `${UPDATABLE[key]} = $${index + 2}`);
  const values = keys.map((key) => (patch as Record<string, unknown>)[key]);
  const { rows } = await db.query(
    `UPDATE matches SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error('Match not found');
  return mapMatch(rows[0]);
}

export interface LobbyFilters {
  stakeCents?: number;
  gameMode?: GameMode;
  halfLengthMinutes?: number;
  excludeUserId?: string;
  limit?: number;
}

export interface LobbyEntry {
  match: Match;
  creatorHandle: string;
  creatorPsnId: string | null;
  creatorTrustScore: number;
  creatorSkillTier: string;
  creatorWins: number;
  creatorLosses: number;
}

export async function listOpenMatches(
  filters: LobbyFilters,
  db: Queryable = pool,
): Promise<LobbyEntry[]> {
  const conditions = ["m.status = 'open'"];
  const values: unknown[] = [];

  if (filters.stakeCents !== undefined) {
    values.push(filters.stakeCents);
    conditions.push(`m.stake_cents = $${values.length}`);
  }
  if (filters.gameMode !== undefined) {
    values.push(filters.gameMode);
    conditions.push(`m.game_mode = $${values.length}`);
  }
  if (filters.halfLengthMinutes !== undefined) {
    values.push(filters.halfLengthMinutes);
    conditions.push(`(m.rules->>'halfLengthMinutes')::int = $${values.length}`);
  }
  if (filters.excludeUserId !== undefined) {
    values.push(filters.excludeUserId);
    conditions.push(`m.creator_id <> $${values.length}`);
  }
  values.push(Math.min(filters.limit ?? 50, 200));

  const { rows } = await db.query(
    `SELECT m.*, u.handle, u.psn_id, u.trust_score, u.skill_tier, u.wins, u.losses
     FROM matches m
     JOIN users u ON u.id = m.creator_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.created_at DESC
     LIMIT $${values.length}`,
    values,
  );

  return rows.map((row) => ({
    match: mapMatch(row),
    creatorHandle: row.handle,
    creatorPsnId: row.psn_id,
    creatorTrustScore: row.trust_score,
    creatorSkillTier: row.skill_tier,
    creatorWins: row.wins,
    creatorLosses: row.losses,
  }));
}

export async function listMatchesForUser(
  userId: string,
  limit = 50,
  db: Queryable = pool,
): Promise<Match[]> {
  const { rows } = await db.query(
    `SELECT * FROM matches
     WHERE creator_id = $1 OR opponent_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(mapMatch);
}

/** Matches whose reporting window has closed with at most one report in. */
export async function findLapsedMatches(db: Queryable = pool): Promise<Match[]> {
  const { rows } = await db.query(
    `SELECT * FROM matches
     WHERE status = 'awaiting_results'
       AND report_deadline_at IS NOT NULL
       AND report_deadline_at < now()
     ORDER BY report_deadline_at ASC
     LIMIT 100`,
  );
  return rows.map(mapMatch);
}

// ------------------------------------------------------------ match results

function mapResult(row: any): MatchResult {
  return {
    id: row.id,
    matchId: row.match_id,
    reporterId: row.reporter_id,
    selfScore: row.self_score,
    opponentScore: row.opponent_score,
    screenshotId: row.screenshot_id,
    clipUrl: row.clip_url,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertResult(
  params: {
    matchId: string;
    reporterId: string;
    selfScore: number;
    opponentScore: number;
    screenshotId?: string | null;
    clipUrl?: string | null;
  },
  db: Queryable = pool,
): Promise<MatchResult> {
  const { rows } = await db.query(
    `INSERT INTO match_results (match_id, reporter_id, self_score, opponent_score, screenshot_id, clip_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      params.matchId,
      params.reporterId,
      params.selfScore,
      params.opponentScore,
      params.screenshotId ?? null,
      params.clipUrl ?? null,
    ],
  );
  return mapResult(rows[0]);
}

export async function listResults(matchId: string, db: Queryable = pool): Promise<MatchResult[]> {
  const { rows } = await db.query(
    'SELECT * FROM match_results WHERE match_id = $1 ORDER BY created_at ASC',
    [matchId],
  );
  return rows.map(mapResult);
}
