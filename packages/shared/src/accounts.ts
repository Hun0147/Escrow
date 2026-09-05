/**
 * Ledger account naming.
 *
 * Every movement of money is a transfer between two named accounts, so the
 * books balance by construction: there is no way to write a single-sided
 * entry. Account names are stable strings, not foreign keys, so historical
 * entries stay readable even if a user row is later anonymised.
 */

/** Funds a player can stake or withdraw right now. */
export const userAvailable = (userId: string) => `user:${userId}:available`;

/** A player's stake, held for one specific match. */
export const matchEscrow = (matchId: string) => `escrow:match:${matchId}`;

/** A player's entry fee, held for one tournament. */
export const tournamentEscrow = (tournamentId: string) => `escrow:tournament:${tournamentId}`;

/** Where rake accrues. */
export const PLATFORM_REVENUE = 'platform:revenue';

/**
 * The boundary with the outside world (card processor, bank, PayPal).
 * Deposits are credited from here and withdrawals are debited back to it, so
 * its balance is the net cash the platform owes or is owed externally.
 */
export const EXTERNAL_SETTLEMENT = 'external:settlement';

export function isUserAvailableAccount(account: string): boolean {
  return /^user:[0-9a-f-]{36}:available$/i.test(account);
}

export function userIdFromAccount(account: string): string | null {
  const match = /^user:([0-9a-f-]{36}):available$/i.exec(account);
  return match ? match[1] : null;
}
