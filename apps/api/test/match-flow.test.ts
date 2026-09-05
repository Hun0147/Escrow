import { PLATFORM_REVENUE, matchEscrow, userAvailable } from '@escrow/shared';
import { fund, makeUser, ULTIMATE_TEAM } from './factories';
import { createMatch, forfeitMatch, joinMatch, setReady, cancelOpenMatch } from '../src/modules/matches/matches.service';
import { submitResult } from '../src/modules/results/results.service';
import { accountBalance, getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { findMatchById } from '../src/db/repos/matches.repo';
import { findUserById } from '../src/db/repos/users.repo';
import { findDisputeByMatch } from '../src/db/repos/misc.repo';

const STAKE = 2500; // $25

/** Every money test asserts this: the cached wallets and the ledger agree. */
async function expectBooksBalance() {
  expect(await reconcileWallets()).toEqual([]);
}

describe('1v1 money match, happy path', () => {
  it('escrows both stakes, settles on agreement and pays the winner the pool minus rake', async () => {
    // Trust scores high enough that the pair auto-settles without screenshots.
    const creator = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 10000, trustScore: 88 });

    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: STAKE });
    expect(match.status).toBe('open');

    // The creator's stake left their spendable balance the moment they posted.
    let wallet = await getWallet(creator.id);
    expect(wallet!.availableCents).toBe(7500);
    expect(wallet!.lockedCents).toBe(STAKE);
    await expectBooksBalance();

    await joinMatch(opponent, match.id);
    expect(await accountBalance(matchEscrow(match.id))).toBe(STAKE * 2);
    await expectBooksBalance();

    await setReady(creator, match.id, true);
    const started = await setReady(opponent, match.id, true);
    expect(started.status).toBe('in_progress');

    const first = await submitResult(creator, {
      matchId: match.id,
      selfScore: 3,
      opponentScore: 1,
    });
    expect(first.status).toBe('awaiting_opponent');
    // Nothing has moved yet: one player's word is never enough.
    expect(await accountBalance(matchEscrow(match.id))).toBe(STAKE * 2);

    const second = await submitResult(opponent, {
      matchId: match.id,
      selfScore: 1,
      opponentScore: 3,
    });
    expect(second.status).toBe('settled');

    const settled = await findMatchById(match.id);
    expect(settled!.status).toBe('settled');
    expect(settled!.winnerId).toBe(creator.id);
    expect(settled!.creatorScore).toBe(3);
    expect(settled!.opponentScore).toBe(1);

    // $50 pool, 10% rake = $5 to the house, $45 to the winner.
    expect(await accountBalance(matchEscrow(match.id))).toBe(0);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(500);
    expect(await accountBalance(userAvailable(creator.id))).toBe(7500 + 4500);

    const creatorWallet = await getWallet(creator.id);
    const opponentWallet = await getWallet(opponent.id);
    expect(creatorWallet!.availableCents).toBe(12000);
    expect(creatorWallet!.lockedCents).toBe(0);
    expect(opponentWallet!.availableCents).toBe(7500);
    expect(opponentWallet!.lockedCents).toBe(0);
    await expectBooksBalance();

    expect((await findUserById(creator.id))!.wins).toBe(1);
    expect((await findUserById(opponent.id))!.losses).toBe(1);
  });

  it('returns both stakes in full on a draw, taking no rake', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 90 });

    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    await submitResult(creator, { matchId: match.id, selfScore: 2, opponentScore: 2 });
    const result = await submitResult(opponent, { matchId: match.id, selfScore: 2, opponentScore: 2 });

    expect(result.status).toBe('settled');
    expect((await findMatchById(match.id))!.status).toBe('voided');
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(0);
    expect((await getWallet(creator.id))!.availableCents).toBe(5000);
    expect((await getWallet(opponent.id))!.availableCents).toBe(5000);
    await expectBooksBalance();
  });
});

describe('escrow safety', () => {
  it('refuses a stake the player cannot cover, and leaves the books untouched', async () => {
    const player = await makeUser({ balanceCents: 1000 });
    await expect(
      createMatch(player, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 }),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect((await getWallet(player.id))!.availableCents).toBe(1000);
    await expectBooksBalance();
  });

  it('refunds the creator when an unjoined match is cancelled', async () => {
    const creator = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: STAKE });
    expect((await getWallet(creator.id))!.availableCents).toBe(2500);

    await cancelOpenMatch(creator, match.id);
    const wallet = await getWallet(creator.id);
    expect(wallet!.availableCents).toBe(5000);
    expect(wallet!.lockedCents).toBe(0);
    expect(await accountBalance(matchEscrow(match.id))).toBe(0);
    await expectBooksBalance();
  });

  it('will not let a joined match be cancelled out from under the opponent', async () => {
    const creator = await makeUser({ balanceCents: 5000 });
    const opponent = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: STAKE });
    await joinMatch(opponent, match.id);

    await expect(cancelOpenMatch(creator, match.id)).rejects.toMatchObject({
      code: 'match_not_open',
    });
    expect(await accountBalance(matchEscrow(match.id))).toBe(STAKE * 2);
    await expectBooksBalance();
  });

  it('only lets one opponent join, even under concurrent attempts', async () => {
    const creator = await makeUser({ balanceCents: 5000 });
    const a = await makeUser({ balanceCents: 5000 });
    const b = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: STAKE });

    const outcomes = await Promise.allSettled([joinMatch(a, match.id), joinMatch(b, match.id)]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // The rejected joiner's money never moved.
    const loser = (await getWallet(a.id))!.lockedCents === 0 ? a : b;
    expect((await getWallet(loser.id))!.availableCents).toBe(5000);
    expect(await accountBalance(matchEscrow(match.id))).toBe(STAKE * 2);
    await expectBooksBalance();
  });

  it('pays the opponent when a player forfeits, and dents the quitter’s trust', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 80 });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 80 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    await forfeitMatch(creator, match.id);

    const settled = await findMatchById(match.id);
    expect(settled!.winnerId).toBe(opponent.id);
    expect((await getWallet(opponent.id))!.availableCents).toBe(4000 + 1800);
    expect((await findUserById(creator.id))!.trustScore).toBeLessThan(80);
    await expectBooksBalance();
  });

  it('sends conflicting reports to the moderation queue instead of paying anyone', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: STAKE });
    await joinMatch(opponent, match.id);

    await submitResult(creator, { matchId: match.id, selfScore: 3, opponentScore: 1 });
    const outcome = await submitResult(opponent, { matchId: match.id, selfScore: 4, opponentScore: 0 });

    expect(outcome.status).toBe('disputed');
    expect((await findMatchById(match.id))!.status).toBe('disputed');
    expect(await findDisputeByMatch(match.id)).not.toBeNull();
    // The money is exactly where it was: still in escrow.
    expect(await accountBalance(matchEscrow(match.id))).toBe(STAKE * 2);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(0);
    await expectBooksBalance();
  });

  it('rejects a second report from the same player', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    await submitResult(creator, { matchId: match.id, selfScore: 1, opponentScore: 0 });
    await expect(
      submitResult(creator, { matchId: match.id, selfScore: 5, opponentScore: 0 }),
    ).rejects.toMatchObject({ code: 'already_reported' });
  });

  it('keeps a stranger out of a match they are not in', async () => {
    const creator = await makeUser({ balanceCents: 5000 });
    const opponent = await makeUser({ balanceCents: 5000 });
    const stranger = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    await expect(
      submitResult(stranger, { matchId: match.id, selfScore: 9, opponentScore: 0 }),
    ).rejects.toMatchObject({ code: 'not_a_participant' });
  });
});
