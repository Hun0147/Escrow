/** Money helpers. Every amount in the system is an integer number of cents. */

export const CURRENCY = 'USD' as const;

/** The fixed stake ladder offered in the lobby, in cents. */
export const STAKE_TIERS_CENTS = [500, 1000, 2500, 5000, 10000] as const;
export type StakeTierCents = (typeof STAKE_TIERS_CENTS)[number];

export function isStakeTier(cents: number): cents is StakeTierCents {
  return (STAKE_TIERS_CENTS as readonly number[]).includes(cents);
}

export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const body = `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function assertPositiveCents(cents: number, label = 'amount'): void {
  if (!Number.isInteger(cents)) throw new Error(`${label} must be an integer number of cents`);
  if (cents <= 0) throw new Error(`${label} must be positive`);
}
