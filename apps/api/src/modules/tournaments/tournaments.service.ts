import { GameMode, MatchRules, Tournament, TournamentEntry, normaliseRules } from '@escrow/shared';
import { withTransaction } from '../../db/transaction';
import {
  countEntries,
  findTournamentById,
  insertEntry,
  insertTournament,
  listEntries,
  listTournaments,
  lockTournament,
  setTournamentStatus,
} from '../../db/repos/tournaments.repo';
import { UserRow } from '../../db/repos/users.repo';
import { getWallet } from '../../db/repos/ledger.repo';
import { chargeTournamentEntry, refundTournamentEntry } from '../wallet/money.service';
import { assertWithinLossLimit } from '../wallet/wallet.service';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { realtime } from '../../realtime/bus';
import { prizePreview } from './bracket.service';

export interface CreateTournamentInput {
  name: string;
  gameMode: GameMode;
  entryFeeCents: number;
  rakeBps?: number;
  maxEntrants: number;
  rules?: Partial<MatchRules>;
  sponsorName?: string | null;
  startsAt?: string | null;
}

export async function createTournament(input: CreateTournamentInput): Promise<Tournament> {
  if (input.maxEntrants < 2 || input.maxEntrants > 256) {
    throw badRequest('invalid_size', 'A bracket holds between 2 and 256 entrants');
  }
  if (input.entryFeeCents < 0) throw badRequest('invalid_fee', 'Entry fee cannot be negative');
  return insertTournament({
    name: input.name,
    gameMode: input.gameMode,
    entryFeeCents: input.entryFeeCents,
    rakeBps: input.rakeBps ?? 1000,
    maxEntrants: input.maxEntrants,
    rules: normaliseRules(input.rules),
    sponsorName: input.sponsorName ?? null,
    startsAt: input.startsAt ?? null,
  });
}

/** Entering escrows the fee straight away, exactly like joining a money match. */
export async function enterTournament(user: UserRow, tournamentId: string): Promise<TournamentEntry> {
  if (!user.emailVerified) throw forbidden('email_unverified', 'Verify your email before entering');
  if (!user.psnId) throw forbidden('psn_required', 'Link your PSN ID before entering');

  const entry = await withTransaction(async (client) => {
    const tournament = await lockTournament(tournamentId, client);
    if (!tournament) throw notFound('Tournament');
    if (tournament.status !== 'registering') {
      throw conflict('registration_closed', 'Registration for this tournament is closed');
    }
    const entrants = await countEntries(tournamentId, client);
    if (entrants >= tournament.maxEntrants) {
      throw conflict('tournament_full', 'This tournament is full');
    }
    const existing = await listEntries(tournamentId, client);
    if (existing.some((e) => e.userId === user.id)) {
      throw conflict('already_entered', 'You are already entered');
    }

    await assertWithinLossLimit(user.id, tournament.entryFeeCents);
    const created = await insertEntry(tournamentId, user.id, client);
    await chargeTournamentEntry(client, user.id, tournamentId, tournament.entryFeeCents);
    return created;
  });

  const wallet = await getWallet(user.id);
  if (wallet) realtime.toUser(user.id, 'wallet:updated', wallet);
  realtime.toLobby('tournament:entry', { tournamentId, userId: user.id });
  return entry;
}

export async function cancelTournament(tournamentId: string): Promise<void> {
  await withTransaction(async (client) => {
    const tournament = await lockTournament(tournamentId, client);
    if (!tournament) throw notFound('Tournament');
    if (tournament.status === 'completed' || tournament.status === 'cancelled') {
      throw conflict('bad_state', 'This tournament is already closed');
    }
    for (const entry of await listEntries(tournamentId, client)) {
      await refundTournamentEntry(client, tournamentId, entry.userId, tournament.entryFeeCents);
    }
    await setTournamentStatus(tournamentId, 'cancelled', client);
  });
  realtime.toLobby('tournament:cancelled', { tournamentId });
}

export async function list(status: Tournament['status'] | 'all' = 'all') {
  const tournaments = await listTournaments(status);
  return Promise.all(
    tournaments.map(async (tournament) => ({
      tournament,
      ...(await prizePreview(tournament.id)),
    })),
  );
}

export async function detail(tournamentId: string) {
  const tournament = await findTournamentById(tournamentId);
  if (!tournament) throw notFound('Tournament');
  return {
    tournament,
    entries: await listEntries(tournamentId),
    ...(await prizePreview(tournamentId)),
  };
}
