import { Pool, PoolClient } from 'pg';
import { adjustBalance, findUserById, InsufficientBalanceError } from '../../db/users.repo';
import { recordTransaction } from '../../db/transactions.repo';

type Queryable = Pool | PoolClient;

export class WalletError extends Error {}

export async function deposit(userId: string, amountCents: number): Promise<number> {
  if (amountCents <= 0) throw new WalletError('Deposit must be positive');
  if (!(await findUserById(userId))) throw new WalletError('User not found');
  const balance = await adjustBalance(userId, amountCents);
  await recordTransaction({ userId, type: 'deposit', amountCents });
  return balance;
}

export async function withdraw(userId: string, amountCents: number): Promise<number> {
  if (amountCents <= 0) throw new WalletError('Withdrawal must be positive');
  try {
    const balance = await adjustBalance(userId, -amountCents);
    await recordTransaction({ userId, type: 'withdrawal', amountCents });
    return balance;
  } catch (err) {
    if (err instanceof InsufficientBalanceError) throw new WalletError('Insufficient balance');
    throw err;
  }
}

export async function lockForEscrow(userId: string, amountCents: number, matchId: string, db: Queryable): Promise<void> {
  try {
    await adjustBalance(userId, -amountCents, db);
  } catch (err) {
    if (err instanceof InsufficientBalanceError) throw new WalletError('Insufficient balance to fund escrow');
    throw err;
  }
  await recordTransaction({ userId, matchId, type: 'escrow_lock', amountCents }, db);
}

export async function creditPayout(userId: string, amountCents: number, matchId: string, db: Queryable): Promise<void> {
  await adjustBalance(userId, amountCents, db);
  await recordTransaction({ userId, matchId, type: 'escrow_release', amountCents }, db);
}

export async function refund(userId: string, amountCents: number, matchId: string, db: Queryable): Promise<void> {
  await adjustBalance(userId, amountCents, db);
  await recordTransaction({ userId, matchId, type: 'refund', amountCents }, db);
}
