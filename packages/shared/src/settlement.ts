import { assertPositiveCents } from './money';

/**
 * The escrow fee.
 *
 * Goal 27 charges one fee, at one rate, wherever money leaves escrow to a
 * player: on a winning payout, on a tournament prize, and on a withdrawal.
 * There is no separate rake — this is the whole revenue model, which means a
 * player only ever has to understand a single number.
 *
 * Money coming back to the player it belongs to is never charged: a draw, a
 * void, a moderator refund and a cancelled match all return stakes whole, and
 * deposits are free. The platform earns when it settles a contest or moves
 * money out, not when a match fails to happen.
 */
export const DEFAULT_ESCROW_FEE_BPS = 1000; // 10.00%

/** Subscribers ("Goal 27 Pro") pay a reduced rate on the same events. */
export const PRO_ESCROW_FEE_BPS = 700; // 7.00%

export const MAX_ESCROW_FEE_BPS = 2000;

export function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_ESCROW_FEE_BPS) {
    throw new Error(
      `Escrow fee must be an integer between 0 and ${MAX_ESCROW_FEE_BPS} basis points`,
    );
  }
}

/** Rounds to the nearest cent. Callers take the remainder, so no cent is lost. */
export function feeOn(amountCents: number, feeBps: number): number {
  assertFeeBps(feeBps);
  return Math.round((amountCents * feeBps) / 10000);
}

export interface SettlementResult {
  grossPoolCents: number;
  feeBps: number;
  platformFeeCents: number;
  payoutCents: number;
}

/**
 * Splits a 1v1 pool between the winner and the house.
 *
 * Both stakes must be equal — a money match is symmetric by construction, and
 * asymmetric stakes would let a player buy a better price on the same game.
 * The fee is rounded to the nearest cent and the winner takes the remainder,
 * so pool = fee + payout holds exactly and no cent is ever created or lost.
 */
export function calculateSettlement(
  stakeACents: number,
  stakeBCents: number,
  feeBps: number = DEFAULT_ESCROW_FEE_BPS,
): SettlementResult {
  assertPositiveCents(stakeACents, 'stake');
  assertPositiveCents(stakeBCents, 'stake');
  if (stakeACents !== stakeBCents) {
    throw new Error('Stakes must match for a 1v1 wager');
  }
  assertFeeBps(feeBps);

  const grossPoolCents = stakeACents + stakeBCents;
  const platformFeeCents = feeOn(grossPoolCents, feeBps);
  const payoutCents = grossPoolCents - platformFeeCents;

  return { grossPoolCents, feeBps, platformFeeCents, payoutCents };
}

export interface WithdrawalBreakdown {
  /** What leaves the player's wallet. */
  grossCents: number;
  feeBps: number;
  feeCents: number;
  /** What actually reaches their bank, card or PayPal. */
  netCents: number;
}

/**
 * Splits a withdrawal between the payee and the house.
 *
 * The requested amount is what leaves the wallet; the fee comes out of it and
 * the player receives the remainder. Quoting it the other way round — fee on
 * top — would let a withdrawal exceed the balance that authorised it.
 */
export function calculateWithdrawal(
  grossCents: number,
  feeBps: number = DEFAULT_ESCROW_FEE_BPS,
): WithdrawalBreakdown {
  assertPositiveCents(grossCents, 'withdrawal');
  assertFeeBps(feeBps);

  const feeCents = feeOn(grossCents, feeBps);
  const netCents = grossCents - feeCents;
  if (netCents <= 0) {
    throw new Error('Withdrawal is too small to cover the escrow fee');
  }
  return { grossCents, feeBps, feeCents, netCents };
}

/**
 * Whether a matchup earns the Pro rate. The discount applies if *either*
 * player subscribes, so Pro is worth buying even against a free account.
 *
 * The rates themselves are a platform setting, not a constant — the server
 * resolves them; the constants here are only the shipped defaults.
 */
export function qualifiesForProRate(creatorIsPro: boolean, opponentIsPro: boolean): boolean {
  return creatorIsPro || opponentIsPro;
}
