import { Wallet, userAvailable } from '@escrow/shared';
import { pool } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { UserRow } from '../../db/repos/users.repo';
import { accountHistory, getWallet } from '../../db/repos/ledger.repo';
import {
  completePaymentIntent,
  countRecentPayments,
  insertPaymentIntent,
  raiseFraudFlag,
  recordPaymentMethod,
  sumRecentPayments,
} from '../../db/repos/fraud.repo';
import { getSetting } from '../../common/settings';
import { badRequest, forbidden, notFound, tooManyRequests } from '../../common/errors';
import { assertPositiveAmount, creditDeposit, debitWithdrawal } from './money.service';
import { notify } from '../notifications/notifications.service';

/** Deposits allowed in this window before the account is throttled. */
const DEPOSIT_BURST_LIMIT = 5;
const DEPOSIT_BURST_WINDOW_MINUTES = 10;
const WITHDRAWAL_BURST_LIMIT = 3;
const WITHDRAWAL_BURST_WINDOW_MINUTES = 60;

export type PaymentProvider = 'mock' | 'stripe' | 'paypal' | 'bank';

export interface DepositParams {
  user: UserRow;
  amountCents: number;
  provider?: PaymentProvider;
  /** Processor-side instrument fingerprint — never a card number. */
  instrumentFingerprint?: string | null;
  instrumentKind?: 'card' | 'paypal' | 'bank';
}

/**
 * Mock deposit.
 *
 * The provider call is stubbed, but everything around it is real: limits,
 * throttles, the payment_intents record and the ledger posting. Dropping in
 * Stripe Connect means replacing `settleWithProvider` with a webhook-confirmed
 * capture, not rewriting this flow.
 */
export async function deposit(params: DepositParams): Promise<Wallet> {
  const { user, amountCents } = params;
  assertPositiveAmount(amountCents, 'Deposit');

  const min = await getSetting('min_deposit_cents');
  const max = await getSetting('max_deposit_cents');
  if (amountCents < min) throw badRequest('below_minimum', `Minimum deposit is ${min} cents`);
  if (amountCents > max) throw badRequest('above_maximum', `Maximum single deposit is ${max} cents`);

  const recentCount = await countRecentPayments(user.id, 'deposit', DEPOSIT_BURST_WINDOW_MINUTES);
  if (recentCount >= DEPOSIT_BURST_LIMIT) {
    throw tooManyRequests('deposit_rate_limited', 'Too many deposits in a short window — try again later');
  }

  const dailyTotal = await sumRecentPayments(user.id, 'deposit', 24);
  const platformCap = await getSetting('daily_deposit_cap_cents');
  const personalCap = await personalDepositLimit(user.id);
  const cap = personalCap === null ? platformCap : Math.min(platformCap, personalCap);
  if (dailyTotal + amountCents > cap) {
    throw forbidden(
      'deposit_limit_reached',
      `This deposit would exceed your 24-hour deposit limit of ${cap} cents`,
    );
  }

  const intent = await insertPaymentIntent({
    userId: user.id,
    direction: 'deposit',
    provider: params.provider ?? 'mock',
    amountCents,
  });

  if (params.instrumentFingerprint) {
    await recordPaymentMethod({
      userId: user.id,
      kind: params.instrumentKind ?? 'card',
      instrumentFingerprint: params.instrumentFingerprint,
    });
  }

  const wallet = await withTransaction(async (client) => {
    await creditDeposit(client, user.id, amountCents, `Deposit ${intent.id}`);
    return (await getWallet(user.id, client))!;
  });

  await completePaymentIntent(intent.id, 'succeeded', null);
  await notify({
    userId: user.id,
    type: 'wallet_credited',
    title: 'Deposit complete',
    body: `${amountCents} cents added to your wallet.`,
  });
  return wallet;
}

export interface WithdrawParams {
  user: UserRow;
  amountCents: number;
  method: 'stripe' | 'paypal' | 'bank';
}

export async function withdraw(params: WithdrawParams): Promise<Wallet> {
  const { user, amountCents } = params;
  assertPositiveAmount(amountCents, 'Withdrawal');

  const kycRequired = await getSetting('kyc_required_before_withdrawal');
  if (kycRequired && user.kycStatus !== 'approved') {
    throw forbidden('kyc_required', 'Identity verification is required before your first withdrawal');
  }

  const min = await getSetting('min_withdrawal_cents');
  if (amountCents < min) throw badRequest('below_minimum', `Minimum withdrawal is ${min} cents`);

  const recentCount = await countRecentPayments(
    user.id,
    'withdrawal',
    WITHDRAWAL_BURST_WINDOW_MINUTES,
  );
  if (recentCount >= WITHDRAWAL_BURST_LIMIT) {
    throw tooManyRequests(
      'withdrawal_rate_limited',
      'Too many withdrawal requests in a short window — try again later',
    );
  }

  const dailyTotal = await sumRecentPayments(user.id, 'withdrawal', 24);
  const cap = await getSetting('daily_withdrawal_cap_cents');
  if (dailyTotal + amountCents > cap) {
    throw forbidden('withdrawal_cap_reached', `Daily withdrawal cap of ${cap} cents reached`);
  }

  // Deposit, don't play, withdraw is the classic money-laundering shape. It is
  // flagged for review rather than blocked outright, because it is also what a
  // player who changed their mind looks like.
  await flagRapidCycling(user.id, amountCents);

  const intent = await insertPaymentIntent({
    userId: user.id,
    direction: 'withdrawal',
    provider: params.method,
    amountCents,
  });

  try {
    const wallet = await withTransaction(async (client) => {
      await debitWithdrawal(client, user.id, amountCents, `Withdrawal ${intent.id} via ${params.method}`);
      return (await getWallet(user.id, client))!;
    });
    await completePaymentIntent(intent.id, 'succeeded', null);
    await notify({
      userId: user.id,
      type: 'wallet_debited',
      title: 'Withdrawal sent',
      body: `${amountCents} cents is on its way via ${params.method}.`,
    });
    return wallet;
  } catch (err) {
    await completePaymentIntent(intent.id, 'failed', (err as Error).message);
    throw err;
  }
}

async function flagRapidCycling(userId: string, amountCents: number): Promise<void> {
  const depositedRecently = await sumRecentPayments(userId, 'deposit', 24);
  if (depositedRecently === 0) return;

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS played FROM matches
     WHERE (creator_id = $1 OR opponent_id = $1)
       AND created_at > now() - interval '24 hours'
       AND status IN ('settled', 'voided', 'disputed')`,
    [userId],
  );
  const played = Number(rows[0].played);
  if (played === 0 && amountCents >= depositedRecently * 0.8) {
    await raiseFraudFlag({
      userId,
      kind: 'rapid_deposit_withdraw',
      detail: `Withdrew ${amountCents} cents after depositing ${depositedRecently} cents with no matches played`,
    });
  }
}

async function personalDepositLimit(userId: string): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT deposit_limit_daily_cents FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw notFound('User');
  return rows[0].deposit_limit_daily_cents === null ? null : Number(rows[0].deposit_limit_daily_cents);
}

export async function balance(userId: string): Promise<Wallet> {
  const wallet = await getWallet(userId);
  if (!wallet) throw notFound('Wallet');
  return wallet;
}

export async function history(userId: string, limit = 50) {
  return accountHistory(userAvailable(userId), limit);
}

/**
 * How much this player has already put at risk in the last 24 hours: stakes
 * they lost, plus stakes currently locked in live matches. Used to enforce a
 * self-set daily loss limit before another stake is accepted.
 */
export async function dailyLossExposureCents(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(stake_cents), 0) AS total FROM matches
     WHERE created_at > now() - interval '24 hours'
       AND (
         -- Already lost today.
         (status = 'settled' AND winner_id IS NOT NULL AND winner_id <> $1
            AND (creator_id = $1 OR opponent_id = $1))
         -- Or still at risk: escrow holding this player's stake right now.
         OR (escrow_status = 'funded' AND (creator_id = $1 OR opponent_id = $1))
         OR (escrow_status = 'pending' AND creator_id = $1)
       )`,
    [userId],
  );
  return Number(rows[0].total);
}

export async function assertWithinLossLimit(userId: string, stakeCents: number): Promise<void> {
  const { rows } = await pool.query('SELECT loss_limit_daily_cents FROM users WHERE id = $1', [userId]);
  const limit = rows[0]?.loss_limit_daily_cents;
  if (limit === null || limit === undefined) return;
  const exposure = await dailyLossExposureCents(userId);
  if (exposure + stakeCents > Number(limit)) {
    throw forbidden(
      'loss_limit_reached',
      `This stake would exceed the daily loss limit you set (${limit} cents)`,
    );
  }
}
