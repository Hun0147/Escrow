import {
  BracketSlot,
  GameMode,
  LeaderboardRow,
  MatchRules,
  Tournament,
  TournamentEntry,
  TournamentStatus,
  normaliseRules,
} from '@escrow/shared';
import { pool } from '../pool';
import { Queryable } from './users.repo';

function mapTournament(row: any): Tournament {
  return {
    id: row.id,
    name: row.name,
    gameMode: row.game_mode,
    entryFeeCents: Number(row.entry_fee_cents),
    escrowFeeBps: row.escrow_fee_bps,
    maxEntrants: row.max_entrants,
    status: row.status,
    rules: normaliseRules(row.rules ?? {}),
    sponsorName: row.sponsor_name,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertTournament(
  params: {
    name: string;
    gameMode: GameMode;
    entryFeeCents: number;
    escrowFeeBps: number;
    maxEntrants: number;
    rules: MatchRules;
    sponsorName?: string | null;
    startsAt?: string | null;
  },
  db: Queryable = pool,
): Promise<Tournament> {
  const { rows } = await db.query(
    `INSERT INTO tournaments (name, game_mode, entry_fee_cents, escrow_fee_bps, max_entrants, rules, sponsor_name, starts_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
    [
      params.name,
      params.gameMode,
      params.entryFeeCents,
      params.escrowFeeBps,
      params.maxEntrants,
      JSON.stringify(params.rules),
      params.sponsorName ?? null,
      params.startsAt ?? null,
    ],
  );
  return mapTournament(rows[0]);
}

export async function findTournamentById(id: string, db: Queryable = pool): Promise<Tournament | null> {
  const { rows } = await db.query('SELECT * FROM tournaments WHERE id = $1', [id]);
  return rows[0] ? mapTournament(rows[0]) : null;
}

export async function lockTournament(id: string, db: Queryable): Promise<Tournament | null> {
  const { rows } = await db.query('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ? mapTournament(rows[0]) : null;
}

export async function listTournaments(
  status: TournamentStatus | 'all' = 'all',
  db: Queryable = pool,
): Promise<Tournament[]> {
  const { rows } =
    status === 'all'
      ? await db.query('SELECT * FROM tournaments ORDER BY created_at DESC LIMIT 100')
      : await db.query('SELECT * FROM tournaments WHERE status = $1 ORDER BY created_at DESC LIMIT 100', [
          status,
        ]);
  return rows.map(mapTournament);
}

export async function setTournamentStatus(
  id: string,
  status: TournamentStatus,
  db: Queryable = pool,
): Promise<Tournament> {
  const { rows } = await db.query(
    'UPDATE tournaments SET status = $2 WHERE id = $1 RETURNING *',
    [id, status],
  );
  if (!rows[0]) throw new Error('Tournament not found');
  return mapTournament(rows[0]);
}

function mapEntry(row: any): TournamentEntry {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    userId: row.user_id,
    seed: row.seed,
    eliminatedInRound: row.eliminated_in_round,
    placement: row.placement,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertEntry(
  tournamentId: string,
  userId: string,
  db: Queryable = pool,
): Promise<TournamentEntry> {
  const { rows } = await db.query(
    'INSERT INTO tournament_entries (tournament_id, user_id) VALUES ($1, $2) RETURNING *',
    [tournamentId, userId],
  );
  return mapEntry(rows[0]);
}

export async function listEntries(
  tournamentId: string,
  db: Queryable = pool,
): Promise<TournamentEntry[]> {
  const { rows } = await db.query(
    'SELECT * FROM tournament_entries WHERE tournament_id = $1 ORDER BY created_at ASC',
    [tournamentId],
  );
  return rows.map(mapEntry);
}

export async function countEntries(tournamentId: string, db: Queryable = pool): Promise<number> {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = $1',
    [tournamentId],
  );
  return Number(rows[0].count);
}

export async function setEntrySeed(
  tournamentId: string,
  userId: string,
  seed: number,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    'UPDATE tournament_entries SET seed = $3 WHERE tournament_id = $1 AND user_id = $2',
    [tournamentId, userId, seed],
  );
}

export async function eliminateEntry(
  tournamentId: string,
  userId: string,
  round: number,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE tournament_entries SET eliminated_in_round = $3
     WHERE tournament_id = $1 AND user_id = $2 AND eliminated_in_round IS NULL`,
    [tournamentId, userId, round],
  );
}

export async function setPlacement(
  tournamentId: string,
  userId: string,
  placement: number,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    'UPDATE tournament_entries SET placement = $3 WHERE tournament_id = $1 AND user_id = $2',
    [tournamentId, userId, placement],
  );
}

// -------------------------------------------------------------------- bracket

function mapSlot(row: any): BracketSlot {
  return {
    round: row.round,
    position: row.position,
    matchId: row.match_id,
    playerAId: row.player_a_id,
    playerBId: row.player_b_id,
    winnerId: row.winner_id,
  };
}

export async function insertBracketSlot(
  params: {
    tournamentId: string;
    round: number;
    position: number;
    playerAId: string | null;
    playerBId: string | null;
    matchId?: string | null;
    winnerId?: string | null;
  },
  db: Queryable = pool,
): Promise<BracketSlot> {
  const { rows } = await db.query(
    `INSERT INTO tournament_matches (tournament_id, round, position, player_a_id, player_b_id, match_id, winner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tournament_id, round, position) DO UPDATE
       SET player_a_id = EXCLUDED.player_a_id,
           player_b_id = EXCLUDED.player_b_id,
           match_id = COALESCE(EXCLUDED.match_id, tournament_matches.match_id)
     RETURNING *`,
    [
      params.tournamentId,
      params.round,
      params.position,
      params.playerAId,
      params.playerBId,
      params.matchId ?? null,
      params.winnerId ?? null,
    ],
  );
  return mapSlot(rows[0]);
}

export async function listBracket(tournamentId: string, db: Queryable = pool): Promise<BracketSlot[]> {
  const { rows } = await db.query(
    'SELECT * FROM tournament_matches WHERE tournament_id = $1 ORDER BY round, position',
    [tournamentId],
  );
  return rows.map(mapSlot);
}

export async function findSlotByMatch(matchId: string, db: Queryable = pool): Promise<(BracketSlot & { tournamentId: string }) | null> {
  const { rows } = await db.query('SELECT * FROM tournament_matches WHERE match_id = $1', [matchId]);
  return rows[0] ? { ...mapSlot(rows[0]), tournamentId: rows[0].tournament_id } : null;
}

export async function setSlotWinner(
  tournamentId: string,
  round: number,
  position: number,
  winnerId: string,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE tournament_matches SET winner_id = $4
     WHERE tournament_id = $1 AND round = $2 AND position = $3`,
    [tournamentId, round, position, winnerId],
  );
}

// ---------------------------------------------------------------- leaderboard

/**
 * Per-stake-tier leaderboard.
 *
 * Net is computed from the ledger rather than from a win counter, so it is the
 * player's actual profit after the escrow fee — the number they care about.
 */
export async function leaderboardForStake(
  stakeCents: number,
  limit = 25,
  db: Queryable = pool,
): Promise<LeaderboardRow[]> {
  const { rows } = await db.query(
    `WITH played AS (
       SELECT m.id, m.creator_id, m.opponent_id, m.winner_id, m.stake_cents
       FROM matches m
       WHERE m.status = 'settled' AND m.stake_cents = $1 AND m.winner_id IS NOT NULL
     ),
     participants AS (
       SELECT creator_id AS user_id, id AS match_id, winner_id, stake_cents FROM played
       UNION ALL
       SELECT opponent_id AS user_id, id AS match_id, winner_id, stake_cents FROM played
       WHERE opponent_id IS NOT NULL
     ),
     tallies AS (
       SELECT p.user_id,
              COUNT(*) FILTER (WHERE p.winner_id = p.user_id) AS wins,
              COUNT(*) FILTER (WHERE p.winner_id <> p.user_id) AS losses,
              COALESCE(SUM(
                CASE WHEN p.winner_id = p.user_id
                     THEN (SELECT COALESCE(SUM(e.amount_cents), 0)
                           FROM ledger_entries e
                           JOIN ledger_transactions t ON t.id = e.transaction_id
                           WHERE t.match_id = p.match_id AND t.type = 'escrow_payout'
                             AND e.credit_account = 'user:' || p.user_id || ':available')
                          - p.stake_cents
                     ELSE -p.stake_cents END
              ), 0) AS net_cents
       FROM participants p
       GROUP BY p.user_id
     )
     SELECT t.user_id, u.handle, u.psn_id, u.trust_score, t.wins, t.losses, t.net_cents
     FROM tallies t
     JOIN users u ON u.id = t.user_id
     ORDER BY t.net_cents DESC, t.wins DESC
     LIMIT $2`,
    [stakeCents, limit],
  );

  return rows.map((row) => ({
    userId: row.user_id,
    handle: row.handle,
    psnId: row.psn_id,
    stakeTierCents: stakeCents,
    wins: Number(row.wins),
    losses: Number(row.losses),
    netCents: Number(row.net_cents),
    trustScore: row.trust_score,
  }));
}
