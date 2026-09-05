import { PLATFORM_REVENUE, PRO_RAKE_BPS, DEFAULT_RAKE_BPS } from '@escrow/shared';
import { makeUser, ULTIMATE_TEAM } from './factories';
import { cancel, isPro, status, subscribe, sweepRenewals } from '../src/modules/subscriptions/subscriptions.service';
import { createMatch, joinMatch } from '../src/modules/matches/matches.service';
import { submitResult } from '../src/modules/results/results.service';
import { accountBalance, getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { findUserById } from '../src/db/repos/users.repo';
import { findLiveSubscription } from '../src/db/repos/subscriptions.repo';
import { pool } from '../src/db/pool';
import { bestCandidateIndex, matchmakingQueue, QueueTicket } from '../src/queue/matchmaking';
import { quickMatch } from '../src/modules/lobby/matchmaking.service';

const PRICE = 999;

describe('Goal 27 Pro', () => {
  it('charges the wallet and posts to the ledger like any other movement', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    const subscription = await subscribe(user);

    expect(subscription.status).toBe('active');
    expect((await getWallet(user.id))!.availableCents).toBe(5000 - PRICE);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(PRICE);
    expect((await findUserById(user.id))!.subscriptionTier).toBe('pro');
    expect(await reconcileWallets()).toEqual([]);
  });

  it('refuses to subscribe twice', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    await subscribe(user);
    await expect(subscribe((await findUserById(user.id))!)).rejects.toMatchObject({
      code: 'already_subscribed',
    });
    // Charged exactly once.
    expect((await getWallet(user.id))!.availableCents).toBe(5000 - PRICE);
  });

  it('will not sell a subscription the wallet cannot cover', async () => {
    const user = await makeUser({ balanceCents: 100 });
    await expect(subscribe(user)).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect((await findUserById(user.id))!.subscriptionTier).toBe('free');
    expect(await reconcileWallets()).toEqual([]);
  });

  it('cancels at the end of the paid period, not immediately', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    await subscribe(user);
    const cancelled = await cancel((await findUserById(user.id))!);

    expect(cancelled.status).toBe('cancelling');
    // The player paid for this period and keeps the benefits through it.
    expect(await isPro(user.id)).toBe(true);
    expect((await findUserById(user.id))!.subscriptionTier).toBe('pro');
  });

  it('resuming before the period ends calls off the cancellation without recharging', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    await subscribe(user);
    await cancel((await findUserById(user.id))!);
    const resumed = await subscribe((await findUserById(user.id))!);

    expect(resumed.status).toBe('active');
    expect((await getWallet(user.id))!.availableCents).toBe(5000 - PRICE);
  });

  it('renews a live subscription when the period runs out', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    const subscription = await subscribe(user);
    await expirePeriod(subscription.id);

    const { renewed } = await sweepRenewals();
    expect(renewed).toContain(subscription.id);
    expect((await getWallet(user.id))!.availableCents).toBe(5000 - PRICE * 2);
    expect(new Date((await findLiveSubscription(user.id))!.currentPeriodEnd).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(await reconcileWallets()).toEqual([]);
  });

  it('lapses rather than overdrawing a wallet that cannot cover the renewal', async () => {
    const user = await makeUser({ balanceCents: PRICE });
    const subscription = await subscribe(user);
    expect((await getWallet(user.id))!.availableCents).toBe(0);
    await expirePeriod(subscription.id);

    const { closed } = await sweepRenewals();
    expect(closed).toContain(subscription.id);
    expect((await getWallet(user.id))!.availableCents).toBe(0);
    expect((await findUserById(user.id))!.subscriptionTier).toBe('free');
    expect(await isPro(user.id)).toBe(false);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('closes a cancelling subscription when its period ends', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    const subscription = await subscribe(user);
    await cancel((await findUserById(user.id))!);
    await expirePeriod(subscription.id);

    await sweepRenewals();
    expect((await findUserById(user.id))!.subscriptionTier).toBe('free');
    // Not charged for the period they cancelled out of.
    expect((await getWallet(user.id))!.availableCents).toBe(5000 - PRICE);
  });

  it('reports price and history for the settings screen', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    await subscribe(user);
    const result = await status(user.id);
    expect(result.priceCents).toBe(PRICE);
    expect(result.subscription).not.toBeNull();
    expect(result.history).toHaveLength(1);
  });
});

describe('the Pro rake discount', () => {
  it('applies when either player subscribes, and pays the winner more', async () => {
    const creator = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 10000, trustScore: 90 });
    await subscribe(opponent);

    const match = await createMatch((await findUserById(creator.id))!, {
      gameMode: ULTIMATE_TEAM,
      stakeCents: 2500,
    });
    // The creator is free, so the match starts at the standard rake…
    expect(match.rakeBps).toBe(DEFAULT_RAKE_BPS);

    await joinMatch((await findUserById(opponent.id))!, match.id);
    await submitResult(creator, { matchId: match.id, selfScore: 2, opponentScore: 0 });
    await submitResult(opponent, { matchId: match.id, selfScore: 0, opponentScore: 2 });

    // …and drops to the Pro rate once the subscriber joins: $50 pool, 7% = $3.50.
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(PRICE + 350);
    expect((await getWallet(creator.id))!.availableCents).toBe(7500 + 4650);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('stops applying once the subscription has lapsed', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    const subscription = await subscribe(user);
    await expirePeriod(subscription.id);

    // The cached tier flag still says pro until the sweep runs, but the rake
    // is read from the live period, so the discount is already gone.
    expect((await findUserById(user.id))!.subscriptionTier).toBe('pro');
    const match = await createMatch((await findUserById(user.id))!, {
      gameMode: ULTIMATE_TEAM,
      stakeCents: 1000,
    });
    expect(match.rakeBps).toBe(DEFAULT_RAKE_BPS);
  });
});

describe('priority matchmaking', () => {
  const ticket = (userId: string, priority: boolean, enqueuedAt: number): QueueTicket => ({
    userId,
    stakeCents: 1000,
    gameMode: 'ultimate_team',
    skillTier: 'rookie',
    priority,
    enqueuedAt,
  });

  it('matches the longest-waiting player when nobody has priority', () => {
    const bucket = [ticket('a', false, 300), ticket('b', false, 100), ticket('c', false, 200)];
    expect(bestCandidateIndex(bucket, 'z')).toBe(1);
  });

  it('puts subscribers ahead of free accounts', () => {
    const bucket = [ticket('a', false, 100), ticket('b', true, 500)];
    expect(bestCandidateIndex(bucket, 'z')).toBe(1);
  });

  it('is still first-in-first-out within the Pro tier', () => {
    const bucket = [ticket('a', true, 400), ticket('b', true, 200), ticket('c', false, 1)];
    expect(bestCandidateIndex(bucket, 'z')).toBe(1);
  });

  it('never matches a player against themselves', () => {
    expect(bestCandidateIndex([ticket('a', true, 1)], 'a')).toBe(-1);
  });

  it('pairs a waiting subscriber ahead of a free account who queued first', async () => {
    const free = await makeUser({ balanceCents: 5000 });
    const pro = await makeUser({ balanceCents: 5000 });
    await subscribe(pro);
    const arriving = await makeUser({ balanceCents: 5000 });

    // Two players only sit in the queue together under load — a lone arrival
    // is paired immediately — so the waiting state is set up directly rather
    // than by racing two quickMatch calls.
    const queue = await matchmakingQueue();
    await queue.enqueue(ticket(free.id, false, Date.now() - 60_000));
    await queue.enqueue(ticket(pro.id, true, Date.now() - 1_000));

    const result = await quickMatch(arriving, { gameMode: 'ultimate_team', stakeCents: 1000 });
    expect(result.status).toBe('matched');
    // The subscriber is taken despite queueing 59 seconds later.
    if (result.status === 'matched') expect(result.match.creatorId).toBe(pro.id);
    expect(await queue.size()).toBe(1); // the free account is still waiting
    expect(await reconcileWallets()).toEqual([]);
  });
});

/** Winds a subscription's paid period back into the past. */
async function expirePeriod(id: string): Promise<void> {
  await pool.query(
    `UPDATE subscriptions
     SET current_period_start = now() - interval '31 days',
         current_period_end = now() - interval '1 minute'
     WHERE id = $1`,
    [id],
  );
}
