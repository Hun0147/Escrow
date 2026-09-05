import {
  EXTERNAL_SETTLEMENT,
  PLATFORM_REVENUE,
  calculateSettlement,
  matchEscrow,
  tournamentEscrow,
  userAvailable,
} from '@escrow/shared';
import { Queryable } from '../../db/repos/users.repo';
import {
  InsufficientFundsError,
  adjustWallet,
  postTransaction,
} from '../../db/repos/ledger.repo';
import { AppError, badRequest } from '../../common/errors';

/**
 * Every movement of money in Goal 27 goes through one of these functions.
 *
 * Each one writes the double-entry journal AND the wallet cache in the same
 * database transaction, so the two can never disagree — see
 * `reconcileWallets`, which asserts exactly that and is run by the test suite
 * after every money path.
 *
 * All of these REQUIRE an open transaction (`withTransaction`). None of them
 * open one themselves, because a caller almost always has other work — a match
 * status change, a trust event — that has to commit or roll back with the
 * money.
 */

export class WalletError extends AppError {
  constructor(code: string, message: string) {
    super(400, code, message);
  }
}

export async function creditDeposit(
  db: Queryable,
  userId: string,
  amountCents: number,
  memo: string,
): Promise<void> {
  await postTransaction(
    {
      type: 'deposit',
      userId,
      memo,
      entries: [
        { debitAccount: EXTERNAL_SETTLEMENT, creditAccount: userAvailable(userId), amountCents },
      ],
    },
    db,
  );
  await adjustWallet(userId, { availableCents: amountCents }, db);
}

export async function debitWithdrawal(
  db: Queryable,
  userId: string,
  amountCents: number,
  memo: string,
): Promise<void> {
  try {
    await adjustWallet(userId, { availableCents: -amountCents }, db);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw new WalletError('insufficient_funds', 'Insufficient available balance');
    }
    throw err;
  }
  await postTransaction(
    {
      type: 'withdrawal',
      userId,
      memo,
      entries: [
        { debitAccount: userAvailable(userId), creditAccount: EXTERNAL_SETTLEMENT, amountCents },
      ],
    },
    db,
  );
}

/** Moves a player's stake out of their spendable balance and into match escrow. */
export async function lockStake(
  db: Queryable,
  userId: string,
  matchId: string,
  amountCents: number,
): Promise<void> {
  try {
    await adjustWallet(userId, { availableCents: -amountCents, lockedCents: amountCents }, db);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw new WalletError('insufficient_funds', 'Insufficient balance to cover the stake');
    }
    throw err;
  }
  await postTransaction(
    {
      type: 'escrow_lock',
      userId,
      matchId,
      memo: 'Stake locked into match escrow',
      entries: [
        { debitAccount: userAvailable(userId), creditAccount: matchEscrow(matchId), amountCents },
      ],
    },
    db,
  );
}

export interface ReleaseParams {
  matchId: string;
  winnerId: string;
  loserId: string;
  stakeCents: number;
  rakeBps: number;
}

export interface ReleaseResult {
  grossPoolCents: number;
  platformFeeCents: number;
  payoutCents: number;
}

/**
 * Releases a fully funded escrow to the winner and takes the rake.
 *
 * The escrow account is drained to exactly zero: payout + fee == both stakes,
 * by construction of `calculateSettlement`.
 */
export async function releaseEscrowToWinner(
  db: Queryable,
  params: ReleaseParams,
): Promise<ReleaseResult> {
  const { grossPoolCents, platformFeeCents, payoutCents } = calculateSettlement(
    params.stakeCents,
    params.stakeCents,
    params.rakeBps,
  );
  const escrow = matchEscrow(params.matchId);

  const entries = [
    { debitAccount: escrow, creditAccount: userAvailable(params.winnerId), amountCents: payoutCents },
  ];
  if (platformFeeCents > 0) {
    entries.push({ debitAccount: escrow, creditAccount: PLATFORM_REVENUE, amountCents: platformFeeCents });
  }

  await postTransaction(
    {
      type: 'escrow_payout',
      userId: params.winnerId,
      matchId: params.matchId,
      memo: `Payout ${payoutCents} + rake ${platformFeeCents} of pool ${grossPoolCents}`,
      entries,
    },
    db,
  );

  // Both players' stakes leave escrow; the winner's spendable balance grows by
  // the payout. The loser simply loses the lock.
  await adjustWallet(
    params.winnerId,
    { availableCents: payoutCents, lockedCents: -params.stakeCents },
    db,
  );
  await adjustWallet(params.loserId, { lockedCents: -params.stakeCents }, db);

  return { grossPoolCents, platformFeeCents, payoutCents };
}

/** Returns both stakes in full — a draw, a mutual cancel, or a void ruling.
 *  No rake is taken: the house does not profit from a match that didn't
 *  produce a result. */
export async function refundEscrow(
  db: Queryable,
  matchId: string,
  participants: string[],
  stakeCents: number,
): Promise<void> {
  const escrow = matchEscrow(matchId);
  for (const userId of participants) {
    await postTransaction(
      {
        type: 'refund',
        userId,
        matchId,
        memo: 'Stake returned from escrow',
        entries: [
          { debitAccount: escrow, creditAccount: userAvailable(userId), amountCents: stakeCents },
        ],
      },
      db,
    );
    await adjustWallet(userId, { availableCents: stakeCents, lockedCents: -stakeCents }, db);
  }
}

/** Returns a single player's stake — used when a match is cancelled before an
 *  opponent ever joined. */
export async function refundSingleStake(
  db: Queryable,
  matchId: string,
  userId: string,
  stakeCents: number,
): Promise<void> {
  await refundEscrow(db, matchId, [userId], stakeCents);
}

export async function chargeTournamentEntry(
  db: Queryable,
  userId: string,
  tournamentId: string,
  amountCents: number,
): Promise<void> {
  if (amountCents === 0) return;
  try {
    await adjustWallet(userId, { availableCents: -amountCents, lockedCents: amountCents }, db);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw new WalletError('insufficient_funds', 'Insufficient balance for the entry fee');
    }
    throw err;
  }
  await postTransaction(
    {
      type: 'tournament_entry',
      userId,
      tournamentId,
      memo: 'Tournament entry fee',
      entries: [
        {
          debitAccount: userAvailable(userId),
          creditAccount: tournamentEscrow(tournamentId),
          amountCents,
        },
      ],
    },
    db,
  );
}

/** Pays a placing player out of the tournament escrow, net of rake. */
export async function payTournamentPrize(
  db: Queryable,
  tournamentId: string,
  userId: string,
  amountCents: number,
): Promise<void> {
  if (amountCents <= 0) return;
  await postTransaction(
    {
      type: 'tournament_prize',
      userId,
      tournamentId,
      memo: 'Tournament prize',
      entries: [
        {
          debitAccount: tournamentEscrow(tournamentId),
          creditAccount: userAvailable(userId),
          amountCents,
        },
      ],
    },
    db,
  );
  await adjustWallet(userId, { availableCents: amountCents }, db);
}

/** Moves the tournament's rake out of escrow and into platform revenue. */
export async function takeTournamentRake(
  db: Queryable,
  tournamentId: string,
  amountCents: number,
): Promise<void> {
  if (amountCents <= 0) return;
  await postTransaction(
    {
      type: 'platform_rake',
      tournamentId,
      memo: 'Tournament rake',
      entries: [
        {
          debitAccount: tournamentEscrow(tournamentId),
          creditAccount: PLATFORM_REVENUE,
          amountCents,
        },
      ],
    },
    db,
  );
}

/** Releases an entrant's locked entry fee — used when a prize is paid and when
 *  a tournament is cancelled before it runs. */
export async function releaseTournamentLock(
  db: Queryable,
  userId: string,
  amountCents: number,
): Promise<void> {
  if (amountCents <= 0) return;
  await adjustWallet(userId, { lockedCents: -amountCents }, db);
}

export async function refundTournamentEntry(
  db: Queryable,
  tournamentId: string,
  userId: string,
  amountCents: number,
): Promise<void> {
  if (amountCents <= 0) return;
  await postTransaction(
    {
      type: 'refund',
      userId,
      tournamentId,
      memo: 'Tournament entry refunded',
      entries: [
        {
          debitAccount: tournamentEscrow(tournamentId),
          creditAccount: userAvailable(userId),
          amountCents,
        },
      ],
    },
    db,
  );
  await adjustWallet(userId, { availableCents: amountCents, lockedCents: -amountCents }, db);
}

/** Charges a subscription period out of the player's wallet. */
export async function chargeSubscription(
  db: Queryable,
  userId: string,
  amountCents: number,
  memo: string,
): Promise<void> {
  if (amountCents === 0) return;
  try {
    await adjustWallet(userId, { availableCents: -amountCents }, db);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw new WalletError('insufficient_funds', 'Not enough balance to cover the subscription');
    }
    throw err;
  }
  await postTransaction(
    {
      type: 'subscription_fee',
      userId,
      memo,
      entries: [
        { debitAccount: userAvailable(userId), creditAccount: PLATFORM_REVENUE, amountCents },
      ],
    },
    db,
  );
}

export function assertPositiveAmount(amountCents: number, label: string): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw badRequest('invalid_amount', `${label} must be a positive whole number of cents`);
  }
}
