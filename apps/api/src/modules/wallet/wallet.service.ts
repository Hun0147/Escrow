import { Wallet, calculateWithdrawal, userAvailable } from '@escrow/shared';
import { pool } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { UserRow } from '../../db/repos/users.repo';
import { accountHistory, getWallet } from '../../db/repos/ledger.repo';
import {
  attachProviderRef,
  claimPaymentIntent,
  completePaymentIntent,
  countRecentPayments,
  findPaymentIntent,
  findPaymentIntentByRef,
  insertPaymentIntent,
  raiseFraudFlag,
  recordPaymentEvent,
  recordPaymentMethod,
  sumRecentPayments,
} from '../../db/repos/fraud.repo';
import { paymentProvider } from '../../payments';
import { getSetting } from '../../common/settings';
import { escrowFeeBpsFor } from '../../common/fees';
import { badRequest, forbidden, notFound, tooManyRequests } from '../../common/errors';
import {
  assertPositiveAmount,
  creditDeposit,
  debitWithdrawal,
  reverseWithdrawal,
} from './money.service';
import { isPro } from '../subscriptions/subscriptions.service';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';

/** Deposits allowed in this window before the account is throttled. */
const DEPOSIT_BURST_LIMIT = 5;
const DEPOSIT_BURST_WINDOW_MINUTES = 10;
const WITHDRAWAL_BURST_LIMIT = 3;
const WITHDRAWAL_BURST_WINDOW_MINUTES = 60;

export type PaymentProvider = 'mock' | 'stripe' | 'paypal' | 'bank';

export interface DepositParams {
  user: UserRow;
  amountCents: number;
  /** Processor-side instrument fingerprint — never a card number. */
  instrumentFingerprint?: string | null;
  instrumentKind?: 'card' | 'paypal' | 'bank';
}

export interface DepositResult {
  intentId: string;
  provider: string;
  /** 'captured' means the wallet is already credited; 'pending' means the
   *  client must complete the payment and the webhook will credit it. */
  status: 'captured' | 'pending';
  clientSecret?: string;
  wallet: Wallet | null;
}

/**
 * Starts a deposit.
 *
 * Limits and throttles are checked before the provider is called, and the
 * ledger is credited only once the provider says the money is captured. With
 * a real processor that confirmation arrives by webhook, so this returns
 * `pending` and the balance does not move yet — crediting on the client's
 * say-so is how a platform gets drained.
 */
export async function deposit(params: DepositParams): Promise<DepositResult> {
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

  // The cap counts money already taken plus anything still in flight, so a
  // burst of pending intents cannot be used to step over the limit.
  const dailyTotal = await sumRecentPayments(user.id, 'deposit', 24, { includePending: true });
  const platformCap = await getSetting('daily_deposit_cap_cents');
  const personalCap = await personalDepositLimit(user.id);
  const cap = personalCap === null ? platformCap : Math.min(platformCap, personalCap);
  if (dailyTotal + amountCents > cap) {
    throw forbidden(
      'deposit_limit_reached',
      `This deposit would exceed your 24-hour deposit limit of ${cap} cents`,
    );
  }

  const provider = paymentProvider();
  const intent = await insertPaymentIntent({
    userId: user.id,
    direction: 'deposit',
    provider: provider.name,
    amountCents,
  });

  if (params.instrumentFingerprint) {
    await recordPaymentMethod({
      userId: user.id,
      kind: params.instrumentKind ?? 'card',
      instrumentFingerprint: params.instrumentFingerprint,
    });
  }

  let ticket;
  try {
    ticket = await provider.createDeposit({
      intentId: intent.id,
      userId: user.id,
      amountCents,
      instrumentFingerprint: params.instrumentFingerprint ?? null,
    });
  } catch (err) {
    await completePaymentIntent(intent.id, 'failed', (err as Error).message);
    throw err;
  }
  await attachProviderRef(intent.id, ticket.providerRef);

  if (!ticket.captured) {
    return {
      intentId: intent.id,
      provider: provider.name,
      status: 'pending',
      clientSecret: ticket.clientSecret,
      wallet: await getWallet(user.id),
    };
  }

  const wallet = await captureDeposit(intent.id);
  return { intentId: intent.id, provider: provider.name, status: 'captured', wallet };
}

/**
 * Credits a captured deposit. Safe to call repeatedly — only the call that
 * moves the intent out of 'pending' writes to the ledger, so a webhook
 * redelivered five times still credits once.
 */
export async function captureDeposit(intentId: string): Promise<Wallet | null> {
  const credited = await withTransaction(async (client) => {
    const claimed = await claimPaymentIntent(intentId, client);
    if (!claimed) return null; // already handled, or never pending
    await creditDeposit(client, claimed.userId, claimed.amountCents, `Deposit ${claimed.id}`);
    return claimed;
  });

  if (!credited) {
    const existing = await findPaymentIntent(intentId);
    return existing ? getWallet(existing.userId) : null;
  }

  const wallet = await getWallet(credited.userId);
  if (wallet) realtime.toUser(credited.userId, 'wallet:updated', wallet);
  await notify({
    userId: credited.userId,
    type: 'wallet_credited',
    title: 'Deposit complete',
    body: `${credited.amountCents} cents added to your wallet.`,
  });
  return wallet;
}

/**
 * Handles a provider webhook: verify, de-duplicate, then act.
 *
 * Verification happens in the provider (it owns the signature scheme); this
 * decides what the event means for the ledger.
 */
export async function handlePaymentWebhook(
  rawBody: Buffer,
  signature: string | undefined,
): Promise<{ handled: boolean; reason: string }> {
  const provider = paymentProvider();
  const event = provider.parseWebhook(rawBody, signature);

  const intent = event.providerRef
    ? await findPaymentIntentByRef(provider.name, event.providerRef)
    : null;

  const fresh = await recordPaymentEvent({
    provider: provider.name,
    eventId: event.id,
    eventType: event.type,
    paymentIntentId: intent?.id ?? null,
    payload: JSON.parse(rawBody.toString('utf8')),
  });
  if (!fresh) return { handled: false, reason: 'duplicate_event' };
  if (!intent) return { handled: false, reason: 'unknown_payment' };

  // A provider reporting a different amount than we recorded is not a payment
  // to credit — it is an incident.
  if (event.amountCents !== null && event.amountCents !== intent.amountCents) {
    await raiseFraudFlag({
      userId: intent.userId,
      kind: 'payment_amount_mismatch',
      detail: `Webhook ${event.id} reports ${event.amountCents} cents against an intent for ${intent.amountCents}`,
    });
    return { handled: false, reason: 'amount_mismatch' };
  }

  if (event.type.endsWith('.succeeded') || event.type.endsWith('.paid')) {
    await captureDeposit(intent.id);
    return { handled: true, reason: 'captured' };
  }
  if (event.type.endsWith('.payment_failed') || event.type.endsWith('.failed')) {
    await completePaymentIntent(intent.id, 'failed', event.type);
    return { handled: true, reason: 'failed' };
  }
  if (event.type.endsWith('.canceled') || event.type.endsWith('.cancelled')) {
    await completePaymentIntent(intent.id, 'cancelled', event.type);
    return { handled: true, reason: 'cancelled' };
  }
  return { handled: false, reason: 'ignored_event_type' };
}

export interface WithdrawParams {
  user: UserRow;
  amountCents: number;
  method: 'stripe' | 'paypal' | 'bank';
}

export interface WithdrawalResult {
  wallet: Wallet;
  /** What left the wallet. */
  grossCents: number;
  feeBps: number;
  feeCents: number;
  /** What the player actually receives. */
  netCents: number;
}

/**
 * Cashing out.
 *
 * The requested amount is what leaves the wallet; the escrow fee comes out of
 * it and the player receives the remainder. Quoting it the other way round —
 * fee added on top — would let a withdrawal exceed the balance that authorised
 * it, and would surprise a player who asked to withdraw everything they had.
 */
export async function withdraw(params: WithdrawParams): Promise<WithdrawalResult> {
  const { user, amountCents } = params;
  assertPositiveAmount(amountCents, 'Withdrawal');

  const kycRequired = await getSetting('kyc_required_before_withdrawal');
  if (kycRequired && user.kycStatus !== 'approved') {
    throw forbidden('kyc_required', 'Identity verification is required before your first withdrawal');
  }

  const min = await getSetting('min_withdrawal_cents');
  if (amountCents < min) throw badRequest('below_minimum', `Minimum withdrawal is ${min} cents`);

  // Subscribers pay the reduced rate here too — it is one fee on one rate,
  // wherever money leaves escrow.
  const feeBps = await escrowFeeBpsFor(await isPro(user.id));
  const breakdown = calculateWithdrawal(amountCents, feeBps);

  const minNet = await getSetting('min_withdrawal_net_cents');
  if (breakdown.netCents < minNet) {
    throw badRequest(
      'below_minimum_net',
      `After the escrow fee this would pay out ${breakdown.netCents} cents; the minimum is ${minNet}`,
    );
  }

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
  const memo = `Withdrawal ${intent.id} via ${params.method}`;

  try {
    // Debit first: the funds are reserved before we ask the provider to move
    // them, so a slow payout cannot be spent twice in the meantime. A provider
    // failure reverses below.
    const wallet = await withTransaction(async (client) => {
      await debitWithdrawal(client, user.id, breakdown, memo);
      return (await getWallet(user.id, client))!;
    });

    // The provider only ever moves the net — the fee never leaves the platform.
    const ticket = await paymentProvider().createPayout({
      intentId: intent.id,
      userId: user.id,
      amountCents: breakdown.netCents,
      method: params.method,
    });
    await attachProviderRef(intent.id, ticket.providerRef);
    // A payout that has not settled stays pending until the provider says so.
    if (ticket.settled) await completePaymentIntent(intent.id, 'succeeded', null);

    await notify({
      userId: user.id,
      type: 'wallet_debited',
      title: 'Withdrawal sent',
      body: `${breakdown.netCents} cents is on its way via ${params.method}, after a ${breakdown.feeCents} cent escrow fee.`,
    });
    return { wallet, ...breakdown };
  } catch (err) {
    await completePaymentIntent(intent.id, 'failed', (err as Error).message);
    // If the debit went through but the provider did not, the money is ours to
    // give back immediately — a failed payout must never eat a balance, and
    // must never leave us holding a fee for a transfer that did not happen.
    if (await debitAlreadyPosted(intent.id)) {
      await withTransaction((client) =>
        reverseWithdrawal(client, user.id, breakdown, `Reversal of failed withdrawal ${intent.id}`),
      );
      const restored = await getWallet(user.id);
      if (restored) realtime.toUser(user.id, 'wallet:updated', restored);
    }
    throw err;
  }
}

/**
 * What a withdrawal would cost, without committing to it. The wallet screen
 * calls this so the fee is visible before the player taps the button.
 */
export async function quoteWithdrawal(
  user: UserRow,
  amountCents: number,
): Promise<{ feeBps: number; feeCents: number; netCents: number }> {
  const feeBps = await escrowFeeBpsFor(await isPro(user.id));
  const { feeCents, netCents } = calculateWithdrawal(amountCents, feeBps);
  return { feeBps, feeCents, netCents };
}

/** Did the withdrawal's ledger debit actually post before the failure? */
async function debitAlreadyPosted(intentId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM ledger_transactions
     WHERE type = 'withdrawal' AND memo LIKE $1 LIMIT 1`,
    [`Withdrawal ${intentId}%`],
  );
  return rows.length > 0;
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
