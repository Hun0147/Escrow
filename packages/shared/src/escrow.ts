export const PLATFORM_FEE_BPS = 1200; // 12.00%, expressed in basis points (1/100 of a percent)

/**
 * All money amounts are integer cents to avoid floating point rounding errors.
 */
export interface SettlementResult {
  grossPoolCents: number;
  platformFeeCents: number;
  payoutCents: number;
}

export function calculateSettlement(stakeACents: number, stakeBCents: number): SettlementResult {
  if (stakeACents <= 0 || stakeBCents <= 0) {
    throw new Error('Stakes must be positive');
  }
  if (stakeACents !== stakeBCents) {
    throw new Error('Stakes must match for a 1v1 wager');
  }

  const grossPoolCents = stakeACents + stakeBCents;
  const platformFeeCents = Math.round((grossPoolCents * PLATFORM_FEE_BPS) / 10000);
  const payoutCents = grossPoolCents - platformFeeCents;

  return { grossPoolCents, platformFeeCents, payoutCents };
}
