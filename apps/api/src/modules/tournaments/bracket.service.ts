import { BracketSlot, Match } from '@escrow/shared';
import { withTransaction } from '../../db/transaction';
import { insertMatch, updateMatch } from '../../db/repos/matches.repo';
import {
  countEntries,
  eliminateEntry,
  findSlotByMatch,
  findTournamentById,
  insertBracketSlot,
  listBracket,
  listEntries,
  setEntrySeed,
  setPlacement,
  setSlotWinner,
  setTournamentStatus,
} from '../../db/repos/tournaments.repo';
import { getWallet } from '../../db/repos/ledger.repo';
import {
  payTournamentPrize,
  releaseTournamentLock,
  takeTournamentRake,
} from '../wallet/money.service';
import { badRequest, conflict, notFound } from '../../common/errors';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';

/**
 * Single elimination.
 *
 * Fixtures are ordinary matches with a zero stake: the entry fees sit in the
 * tournament's escrow account and are paid out once, when the bracket
 * completes. That keeps one settlement path for reporting and disputes while
 * keeping the prize pool in one place.
 */
export async function startTournament(tournamentId: string): Promise<BracketSlot[]> {
  const tournament = await findTournamentById(tournamentId);
  if (!tournament) throw notFound('Tournament');
  if (tournament.status !== 'registering') {
    throw conflict('bad_state', 'This tournament is not accepting a start');
  }
  const entrants = await listEntries(tournamentId);
  if (entrants.length < 2) throw badRequest('not_enough_entrants', 'At least two entrants are required');

  // Registration order is the seed. It is arbitrary but visible and
  // unmanipulable after the fact, which matters more here than strength-based
  // seeding.
  for (const [index, entry] of entrants.entries()) {
    await setEntrySeed(tournamentId, entry.userId, index + 1);
  }

  const bracketSize = nextPowerOfTwo(entrants.length);
  const byes = bracketSize - entrants.length;
  const slots: BracketSlot[] = [];

  // Byes go to the top seeds, standard single-elimination practice.
  const firstRound: (string | null)[] = [];
  const seeded = entrants.map((entry) => entry.userId);
  for (let i = 0; i < byes; i++) firstRound.push(seeded[i], null);
  for (let i = byes; i < seeded.length; i += 2) {
    firstRound.push(seeded[i], seeded[i + 1] ?? null);
  }

  for (let position = 0; position * 2 < firstRound.length; position++) {
    const playerA = firstRound[position * 2] ?? null;
    const playerB = firstRound[position * 2 + 1] ?? null;
    const slot = await insertBracketSlot({
      tournamentId,
      round: 1,
      position,
      playerAId: playerA,
      playerBId: playerB,
    });
    slots.push(slot);
  }

  await setTournamentStatus(tournamentId, 'running');

  // Create fixtures for real pairings; a bye advances immediately.
  for (const slot of slots) {
    if (slot.playerAId && slot.playerBId) {
      await createFixture(tournamentId, slot);
    } else if (slot.playerAId) {
      await setSlotWinner(tournamentId, slot.round, slot.position, slot.playerAId);
    }
  }

  await maybeAdvanceRound(tournamentId, 1);

  for (const entry of entrants) {
    await notify({
      userId: entry.userId,
      type: 'tournament_started',
      title: `${tournament.name} has started`,
      body: 'Check your bracket for your first fixture.',
    });
  }
  realtime.toLobby('tournament:started', { tournamentId });
  return listBracket(tournamentId);
}

async function createFixture(tournamentId: string, slot: BracketSlot): Promise<Match> {
  const tournament = await findTournamentById(tournamentId);
  if (!tournament) throw notFound('Tournament');
  const match = await insertMatch({
    creatorId: slot.playerAId!,
    game: 'EA Sports FC 26',
    gameMode: tournament.gameMode,
    stakeCents: 0,
    rakeBps: 0,
    rules: tournament.rules,
    tournamentId,
    tournamentRound: slot.round,
  });
  await updateMatch(match.id, { opponentId: slot.playerBId, status: 'escrowed' });
  await insertBracketSlot({
    tournamentId,
    round: slot.round,
    position: slot.position,
    playerAId: slot.playerAId,
    playerBId: slot.playerBId,
    matchId: match.id,
  });
  realtime.toMatch(match.id, 'match:updated', { matchId: match.id });
  return match;
}

/** Called by settlement whenever any match finishes; a no-op for ordinary
 *  money matches. */
export async function advanceBracketAfterMatch(matchId: string, winnerId: string): Promise<void> {
  const slot = await findSlotByMatch(matchId);
  if (!slot) return;
  await setSlotWinner(slot.tournamentId, slot.round, slot.position, winnerId);
  const loser = slot.playerAId === winnerId ? slot.playerBId : slot.playerAId;
  if (loser) await eliminateEntry(slot.tournamentId, loser, slot.round);
  await maybeAdvanceRound(slot.tournamentId, slot.round);
}

async function maybeAdvanceRound(tournamentId: string, round: number): Promise<void> {
  const bracket = await listBracket(tournamentId);
  const thisRound = bracket.filter((slot) => slot.round === round);
  if (thisRound.length === 0) return;
  if (thisRound.some((slot) => slot.winnerId === null)) return; // still playing

  if (thisRound.length === 1) {
    await completeTournament(tournamentId, thisRound[0].winnerId!);
    return;
  }

  const winners = thisRound.sort((a, b) => a.position - b.position).map((slot) => slot.winnerId!);
  const nextRound = round + 1;
  const created: BracketSlot[] = [];
  for (let position = 0; position * 2 < winners.length; position++) {
    created.push(
      await insertBracketSlot({
        tournamentId,
        round: nextRound,
        position,
        playerAId: winners[position * 2] ?? null,
        playerBId: winners[position * 2 + 1] ?? null,
      }),
    );
  }
  for (const slot of created) {
    if (slot.playerAId && slot.playerBId) {
      await createFixture(tournamentId, slot);
    } else if (slot.playerAId) {
      await setSlotWinner(tournamentId, slot.round, slot.position, slot.playerAId);
    }
  }
  realtime.toLobby('tournament:round_advanced', { tournamentId, round: nextRound });
  await maybeAdvanceRound(tournamentId, nextRound);
}

/**
 * Pays the prize pool out.
 *
 * MVP payout structure is winner-take-all after rake. A places table (70/20/10
 * and so on) is a change to `prizeSplit` alone — the escrow mechanics do not
 * care how many people are paid.
 */
export async function completeTournament(tournamentId: string, championId: string): Promise<void> {
  const tournament = await findTournamentById(tournamentId);
  if (!tournament) throw notFound('Tournament');
  const entrants = await listEntries(tournamentId);
  const poolCents = tournament.entryFeeCents * entrants.length;
  const rakeCents = Math.round((poolCents * tournament.rakeBps) / 10000);
  const prizeCents = poolCents - rakeCents;

  await withTransaction(async (client) => {
    // Every entrant's fee stops being "locked" the moment the pool is paid.
    for (const entry of entrants) {
      await releaseTournamentLock(client, entry.userId, tournament.entryFeeCents);
    }
    await takeTournamentRake(client, tournamentId, rakeCents);
    await payTournamentPrize(client, tournamentId, championId, prizeCents);
    await client.query('UPDATE tournaments SET status = $2 WHERE id = $1', [tournamentId, 'completed']);
  });

  await setPlacement(tournamentId, championId, 1);
  for (const entry of entrants) {
    const wallet = await getWallet(entry.userId);
    if (wallet) realtime.toUser(entry.userId, 'wallet:updated', wallet);
    await notify({
      userId: entry.userId,
      type: 'tournament_started',
      title: `${tournament.name} is over`,
      body:
        entry.userId === championId
          ? `You won. ${prizeCents} cents has been paid into your wallet.`
          : 'The bracket has finished — check the final standings.',
    });
  }
  realtime.toLobby('tournament:completed', { tournamentId, championId, prizeCents });
}

/** Prize pool preview shown on the tournament card. */
export async function prizePreview(tournamentId: string) {
  const tournament = await findTournamentById(tournamentId);
  if (!tournament) throw notFound('Tournament');
  const entrants = await countEntries(tournamentId);
  const poolCents = tournament.entryFeeCents * entrants;
  const rakeCents = Math.round((poolCents * tournament.rakeBps) / 10000);
  return { entrants, poolCents, rakeCents, prizeCents: poolCents - rakeCents };
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

export async function bracketFor(tournamentId: string): Promise<BracketSlot[]> {
  return listBracket(tournamentId);
}
