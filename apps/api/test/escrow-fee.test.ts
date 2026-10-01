import { EXTERNAL_SETTLEMENT, PLATFORM_REVENUE, matchEscrow, userAvailable } from '@escrow/shared';
import { pool } from '../src/db/pool';
import { fund, makeUser, ULTIMATE_TEAM } from './factories';
import { accountBalance, accountHistory, getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { deposit, withdraw, quoteWithdrawal } from '../src/modules/wallet/wallet.service';
import { subscribe } from '../src/modules/subscriptions/subscriptions.service';
import {
  cancelOpenMatch,
  createMatch,
  joinMatch,
} from '../src/modules/matches/matches.service';
import { submitResult } from '../src/modules/results/results.service';
import { voidMatch } from '../src/modules/settlement/settlement.service';
import { findUserById } from '../src/db/repos/users.repo';
import { setSetting } from '../src/common/settings';

/**
 * Goal 27 charges one escrow fee, at one rate, wherever money leaves escrow to
 * a player. These tests pin down BOTH halves of that: where it is charged, and
 * — more importantly — where it must never be.
 */

const revenue = () => accountBalance(PLATFORM_REVENUE);

describe('the escrow fee is charged when a contest settles', () => {
  it('comes out of the pool on a winning payout', async () => {
    const winner = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const loser = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const match = await createMatch(winner, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await joinMatch(loser, match.id);
    await submitResult(winner, { matchId: match.id, selfScore: 2, opponentScore: 0 });
    await submitResult(loser, { matchId: match.id, selfScore: 0, opponentScore: 2 });

    // $50 pool, 10% = $5 to the house, $45 to the winner.
    expect(await revenue()).toBe(500);
    expect((await getWallet(winner.id))!.availableCents).toBe(7500 + 4500);
    expect(await accountBalance(matchEscrow(match.id))).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('is charged once per match, not once per player', async () => {
    const winner = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const loser = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const match = await createMatch(winner, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(loser, match.id);
    await submitResult(winner, { matchId: match.id, selfScore: 1, opponentScore: 0 });
    await submitResult(loser, { matchId: match.id, selfScore: 0, opponentScore: 1 });

    const { rows } = await pool.query(
      "SELECT COUNT(*) AS c FROM ledger_transactions WHERE type = 'escrow_fee' AND match_id = $1",
      [match.id],
    );
    // The fee rides inside the payout transaction as a second entry.
    expect(Number(rows[0].c)).toBe(0);
    expect(await revenue()).toBe(200);
  });
});

describe('the escrow fee is charged when money leaves the platform', () => {
  it('comes out of a withdrawal, and only the net is paid out', async () => {
    const user = await makeUser({ balanceCents: 10000, kycApproved: true });
    const result = await withdraw({ user, amountCents: 5000, method: 'bank' });

    expect(result.grossCents).toBe(5000);
    expect(result.feeCents).toBe(500);
    expect(result.netCents).toBe(4500);
    expect((await getWallet(user.id))!.availableCents).toBe(5000);

    // Only the net crossed the platform boundary; the fee stayed behind.
    expect(await accountBalance(EXTERNAL_SETTLEMENT)).toBe(-10000 + 4500);
    expect(await revenue()).toBe(500);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('shows up on the statement as its own line, not buried in the payout', async () => {
    const user = await makeUser({ balanceCents: 10000, kycApproved: true });
    await withdraw({ user, amountCents: 5000, method: 'bank' });

    const history = await accountHistory(userAvailable(user.id));
    const withdrawal = history.find((e) => e.type === 'withdrawal');
    const fee = history.find((e) => e.type === 'escrow_fee');
    expect(withdrawal!.deltaCents).toBe(-4500);
    expect(fee!.deltaCents).toBe(-500);
  });

  it('quotes the fee before the player commits to it', async () => {
    const user = await makeUser({ balanceCents: 10000, kycApproved: true });
    const quote = await quoteWithdrawal(user, 5000);
    expect(quote).toEqual({ feeBps: 1000, feeCents: 500, netCents: 4500 });

    // The quote is what actually gets charged.
    const result = await withdraw({ user, amountCents: 5000, method: 'bank' });
    expect(result.feeCents).toBe(quote.feeCents);
    expect(result.netCents).toBe(quote.netCents);
  });

  it('charges subscribers the reduced rate on withdrawals too', async () => {
    const user = await makeUser({ balanceCents: 10000, kycApproved: true });
    await subscribe(user);
    const subscribed = (await findUserById(user.id))!;

    const result = await withdraw({ user: subscribed, amountCents: 5000, method: 'bank' });
    expect(result.feeBps).toBe(700);
    expect(result.feeCents).toBe(350);
    expect(result.netCents).toBe(4650);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('refuses a withdrawal the fee would leave nothing of', async () => {
    const user = await makeUser({ balanceCents: 10000, kycApproved: true });
    await setSetting('min_withdrawal_cents', 1);
    await setSetting('min_withdrawal_net_cents', 500);

    await expect(withdraw({ user, amountCents: 200, method: 'bank' })).rejects.toMatchObject({
      code: 'below_minimum_net',
    });
    expect((await getWallet(user.id))!.availableCents).toBe(10000);
  });
});

describe('the escrow fee is never charged on money coming back', () => {
  it('takes nothing on a deposit', async () => {
    const user = await makeUser();
    await deposit({ user, amountCents: 5000 });

    expect((await getWallet(user.id))!.availableCents).toBe(5000);
    expect(await revenue()).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('takes nothing on a draw — both stakes come back whole', async () => {
    const a = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const b = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const match = await createMatch(a, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await joinMatch(b, match.id);
    await submitResult(a, { matchId: match.id, selfScore: 1, opponentScore: 1 });
    await submitResult(b, { matchId: match.id, selfScore: 1, opponentScore: 1 });

    expect((await getWallet(a.id))!.availableCents).toBe(5000);
    expect((await getWallet(b.id))!.availableCents).toBe(5000);
    expect(await revenue()).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('takes nothing when a moderator voids a match', async () => {
    const a = await makeUser({ balanceCents: 5000 });
    const b = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(a, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(b, match.id);

    await voidMatch(match.id, 'Neither screenshot is legible.');

    expect((await getWallet(a.id))!.availableCents).toBe(5000);
    expect((await getWallet(b.id))!.availableCents).toBe(5000);
    expect(await revenue()).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('takes nothing when an unjoined match is withdrawn', async () => {
    const creator = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await cancelOpenMatch(creator, match.id);

    expect((await getWallet(creator.id))!.availableCents).toBe(5000);
    expect(await revenue()).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('gives the fee back when a payout the platform charged for never happens', async () => {
    // Covered end to end in payments.test.ts; asserted here as a property of
    // the fee model: revenue must not survive a reversed withdrawal.
    const user = await makeUser({ balanceCents: 5000, kycApproved: true });
    await withdraw({ user, amountCents: 2000, method: 'bank' });
    expect(await revenue()).toBe(200);

    const { reverseWithdrawal } = await import('../src/modules/wallet/money.service');
    const { withTransaction } = await import('../src/db/transaction');
    await withTransaction((client) =>
      reverseWithdrawal(client, user.id, { grossCents: 2000, feeCents: 200, netCents: 1800 }, 'test reversal'),
    );

    expect((await getWallet(user.id))!.availableCents).toBe(5000);
    expect(await revenue()).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });
});

describe('the fee rate is one setting', () => {
  it('applies a changed rate to both settlement and withdrawal', async () => {
    await setSetting('escrow_fee_bps', 250); // 2.5%

    const winner = await makeUser({ balanceCents: 10000, trustScore: 90, kycApproved: true });
    const loser = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const match = await createMatch(winner, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await joinMatch(loser, match.id);
    await submitResult(winner, { matchId: match.id, selfScore: 3, opponentScore: 0 });
    await submitResult(loser, { matchId: match.id, selfScore: 0, opponentScore: 3 });

    // $50 pool at 2.5% = $1.25.
    expect(await revenue()).toBe(125);

    const result = await withdraw({
      user: (await findUserById(winner.id))!,
      amountCents: 4000,
      method: 'bank',
    });
    expect(result.feeBps).toBe(250);
    expect(result.feeCents).toBe(100);
    expect(await revenue()).toBe(225);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('charges nothing anywhere when the rate is zero', async () => {
    await setSetting('escrow_fee_bps', 0);

    const winner = await makeUser({ balanceCents: 10000, trustScore: 90, kycApproved: true });
    const loser = await makeUser({ balanceCents: 10000, trustScore: 90 });
    const match = await createMatch(winner, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(loser, match.id);
    await submitResult(winner, { matchId: match.id, selfScore: 1, opponentScore: 0 });
    await submitResult(loser, { matchId: match.id, selfScore: 0, opponentScore: 1 });
    await withdraw({ user: (await findUserById(winner.id))!, amountCents: 1000, method: 'bank' });

    expect(await revenue()).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });
});

describe('the books survive the fee', () => {
  it('still sums to zero across a full deposit-play-withdraw cycle', async () => {
    const a = await makeUser({ trustScore: 90, kycApproved: true });
    const b = await makeUser({ trustScore: 90, kycApproved: true });
    await fund(a.id, 10000);
    await fund(b.id, 10000);

    const match = await createMatch(a, { gameMode: ULTIMATE_TEAM, stakeCents: 5000 });
    await joinMatch(b, match.id);
    await submitResult(a, { matchId: match.id, selfScore: 2, opponentScore: 1 });
    await submitResult(b, { matchId: match.id, selfScore: 1, opponentScore: 2 });
    await withdraw({ user: (await findUserById(a.id))!, amountCents: 10000, method: 'bank' });

    const { rows } = await pool.query('SELECT COALESCE(SUM(balance_cents), 0) AS total FROM v_ledger_balances');
    expect(Number(rows[0].total)).toBe(0);

    // $100 pool → $10 settlement fee; $100 withdrawn → $10 more. The platform
    // takes 10% twice on the same money, which is the shape of this fee model.
    expect(await revenue()).toBe(2000);
    expect(await reconcileWallets()).toEqual([]);
  });
});
