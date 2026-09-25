import { PLATFORM_REVENUE, tournamentEscrow } from '@escrow/shared';
import { makeUser, ULTIMATE_TEAM } from './factories';
import { cancelTournament, createTournament, enterTournament } from '../src/modules/tournaments/tournaments.service';
import { bracketFor, startTournament } from '../src/modules/tournaments/bracket.service';
import { settleMatch } from '../src/modules/settlement/settlement.service';
import { accountBalance, getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { findTournamentById, listEntries } from '../src/db/repos/tournaments.repo';

const ENTRY_FEE = 1000;

async function tournamentWith(playerCount: number) {
  const tournament = await createTournament({
    name: 'Friday Night Cup',
    gameMode: ULTIMATE_TEAM,
    entryFeeCents: ENTRY_FEE,
    maxEntrants: 8,
  });
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const player = await makeUser({ balanceCents: 5000, trustScore: 90 });
    await enterTournament(player, tournament.id);
    players.push(player);
  }
  return { tournament, players };
}

describe('tournaments', () => {
  it('escrows entry fees on registration', async () => {
    const { tournament, players } = await tournamentWith(4);
    expect(await accountBalance(tournamentEscrow(tournament.id))).toBe(ENTRY_FEE * 4);

    const wallet = await getWallet(players[0].id);
    expect(wallet!.availableCents).toBe(4000);
    expect(wallet!.lockedCents).toBe(ENTRY_FEE);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('refuses a second entry from the same player and a full bracket', async () => {
    const { tournament, players } = await tournamentWith(2);
    await expect(enterTournament(players[0], tournament.id)).rejects.toMatchObject({
      code: 'already_entered',
    });
  });

  it('builds a single-elimination bracket and plays it out to a champion', async () => {
    const { tournament, players } = await tournamentWith(4);
    const bracket = await startTournament(tournament.id);

    expect(bracket).toHaveLength(2);
    expect(bracket.every((slot) => slot.matchId !== null)).toBe(true);

    // Round 1: the first-listed player wins both fixtures.
    for (const slot of bracket) {
      await settleMatch({
        matchId: slot.matchId!,
        outcome: 'creator_win',
        creatorScore: 2,
        opponentScore: 0,
        source: 'auto_agreement',
      });
    }

    const afterRound1 = await bracketFor(tournament.id);
    const final = afterRound1.find((slot) => slot.round === 2)!;
    expect(final).toBeDefined();
    expect(final.matchId).not.toBeNull();

    await settleMatch({
      matchId: final.matchId!,
      outcome: 'creator_win',
      creatorScore: 1,
      opponentScore: 0,
      source: 'auto_agreement',
    });

    const finished = await findTournamentById(tournament.id);
    expect(finished!.status).toBe('completed');

    // $40 pool, 10% rake: $36 to the champion, $4 to the house.
    const championId = (await bracketFor(tournament.id)).find((slot) => slot.round === 2)!.winnerId!;
    const championWallet = await getWallet(championId);
    expect(championWallet!.availableCents).toBe(4000 + 3600);
    for (const player of players.filter((p) => p.id !== championId)) {
      expect((await getWallet(player.id))!.availableCents).toBe(4000);
    }
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(400);
    expect(await accountBalance(tournamentEscrow(tournament.id))).toBe(0);

    const entries = await listEntries(tournament.id);
    expect(entries.filter((e) => e.placement === 1)).toHaveLength(1);

    // Nobody is left with a phantom lock.
    for (const player of players) {
      expect((await getWallet(player.id))!.lockedCents).toBe(0);
    }
    expect(await reconcileWallets()).toEqual([]);
  });

  it('gives byes to the top seeds when the field is not a power of two', async () => {
    const { tournament } = await tournamentWith(3);
    const bracket = await startTournament(tournament.id);

    const byes = bracket.filter((slot) => slot.playerBId === null);
    expect(byes).toHaveLength(1);
    expect(byes[0].winnerId).not.toBeNull(); // advanced without playing
  });

  it('refunds every entrant in full when a tournament is cancelled', async () => {
    const { tournament, players } = await tournamentWith(3);
    await cancelTournament(tournament.id);

    for (const player of players) {
      const wallet = await getWallet(player.id);
      expect(wallet!.availableCents).toBe(5000);
      expect(wallet!.lockedCents).toBe(0);
    }
    expect(await accountBalance(tournamentEscrow(tournament.id))).toBe(0);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('will not start a bracket with fewer than two entrants', async () => {
    const { tournament } = await tournamentWith(1);
    await expect(startTournament(tournament.id)).rejects.toMatchObject({
      code: 'not_enough_entrants',
    });
  });
});
