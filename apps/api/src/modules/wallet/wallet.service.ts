import { v4 as uuid } from 'uuid';
import { store } from '../../db/store';

export class WalletError extends Error {}

function getUserOrThrow(userId: string) {
  const user = store.users.get(userId);
  if (!user) throw new WalletError('User not found');
  return user;
}

export function deposit(userId: string, amountCents: number) {
  if (amountCents <= 0) throw new WalletError('Deposit must be positive');
  const user = getUserOrThrow(userId);
  user.walletBalanceCents += amountCents;
  recordTransaction(userId, 'deposit', amountCents);
  return user.walletBalanceCents;
}

export function withdraw(userId: string, amountCents: number) {
  if (amountCents <= 0) throw new WalletError('Withdrawal must be positive');
  const user = getUserOrThrow(userId);
  if (user.walletBalanceCents < amountCents) throw new WalletError('Insufficient balance');
  user.walletBalanceCents -= amountCents;
  recordTransaction(userId, 'withdrawal', amountCents);
  return user.walletBalanceCents;
}

export function lockForEscrow(userId: string, amountCents: number) {
  const user = getUserOrThrow(userId);
  if (user.walletBalanceCents < amountCents) throw new WalletError('Insufficient balance to fund escrow');
  user.walletBalanceCents -= amountCents;
  recordTransaction(userId, 'escrow_lock', amountCents);
}

export function creditPayout(userId: string, amountCents: number) {
  const user = getUserOrThrow(userId);
  user.walletBalanceCents += amountCents;
  recordTransaction(userId, 'escrow_release', amountCents);
}

export function refund(userId: string, amountCents: number) {
  const user = getUserOrThrow(userId);
  user.walletBalanceCents += amountCents;
  recordTransaction(userId, 'refund', amountCents);
}

function recordTransaction(userId: string, type: 'deposit' | 'withdrawal' | 'escrow_lock' | 'escrow_release' | 'refund', amountCents: number) {
  const id = uuid();
  store.transactions.set(id, {
    id,
    userId,
    type,
    amountCents,
    status: 'completed',
    createdAt: new Date().toISOString(),
  });
}
