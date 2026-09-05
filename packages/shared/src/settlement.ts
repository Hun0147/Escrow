import { assertPositiveCents } from './money';

/** Default platform rake: 10% of the prize pool, in basis points. */
export const DEFAULT_RAKE_BPS = 1000;

/** Subscribers ("Goal 27 Pro") pay a reduced rake. */
export const PRO_RAKE_BPS = 700;

export const MAX_RAKE_BPS = 2000;

export interface SettlementResult {
  grossPoolCents: number;
  rakeBps: number;
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
  rakeBps: number = DEFAULT_RAKE_BPS,
): SettlementResult {
  assertPositiveCents(stakeACents, 'stake');
  assertPositiveCents(stakeBCents, 'stake');
  if (stakeACents !== stakeBCents) {
    throw new Error('Stakes must match for a 1v1 wager');
  }
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > MAX_RAKE_BPS) {
    throw new Error(`Rake must be an integer between 0 and ${MAX_RAKE_BPS} basis points`);
  }

  const grossPoolCents = stakeACents + stakeBCents;
  const platformFeeCents = Math.round((grossPoolCents * rakeBps) / 10000);
  const payoutCents = grossPoolCents - platformFeeCents;

  return { grossPoolCents, rakeBps, platformFeeCents, payoutCents };
}

/**
 * The rake a match should carry, given the two players' subscription tiers.
 * The discount applies if *either* player subscribes, so Pro is worth buying
 * even when you're matched against a free account.
 */
export function rakeForMatch(creatorIsPro: boolean, opponentIsPro: boolean): number {
  return creatorIsPro || opponentIsPro ? PRO_RAKE_BPS : DEFAULT_RAKE_BPS;
}
