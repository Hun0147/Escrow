import { v4 as uuid } from 'uuid';
import { store } from '../../db/store';
import { lockForEscrow, refund, WalletError } from '../wallet/wallet.service';

export class MatchError extends Error {}

export function createMatch(creatorId: string, game: string, stakeCents: number) {
  if (!store.users.has(creatorId)) throw new MatchError('Creator not found');
  if (stakeCents <= 0) throw new MatchError('Stake must be positive');

  const id = uuid();
  store.matches.set(id, {
    id,
    creatorId,
    opponentId: null,
    game,
    stakeCents,
    status: 'created',
    winnerId: null,
    createdAt: new Date().toISOString(),
  });
  return store.matches.get(id)!;
}

export function fundEscrow(matchId: string, userId: string) {
  const match = store.matches.get(matchId);
  if (!match) throw new MatchError('Match not found');
  if (match.status !== 'created' && match.status !== 'funded') {
    throw new MatchError('Match is not open for funding');
  }
  if (userId !== match.creatorId && userId !== match.opponentId && match.opponentId !== null) {
    throw new MatchError('User is not a participant in this match');
  }

  if (userId === match.creatorId) {
    lockForEscrow(userId, match.stakeCents);
  } else {
    if (match.opponentId && match.opponentId !== userId) {
      throw new MatchError('Match already has an opponent');
    }
    match.opponentId = userId;
    lockForEscrow(userId, match.stakeCents);
  }

  let escrow = store.escrowByMatchId(matchId);
  if (!escrow) {
    const id = uuid();
    escrow = { id, matchId, amountCents: 0, status: 'pending', releasedAt: null };
    store.escrows.set(id, escrow);
  }
  escrow.amountCents += match.stakeCents;

  if (match.creatorId && match.opponentId) {
    match.status = 'funded';
    escrow.status = 'funded';
  }

  return { match, escrow };
}

export function cancelMatch(matchId: string) {
  const match = store.matches.get(matchId);
  if (!match) throw new MatchError('Match not found');
  if (match.status === 'settled') throw new MatchError('Cannot cancel a settled match');

  const escrow = store.escrowByMatchId(matchId);
  if (escrow && (escrow.status === 'pending' || escrow.status === 'funded')) {
    refund(match.creatorId, match.stakeCents);
    if (escrow.status === 'funded' && match.opponentId) {
      refund(match.opponentId, match.stakeCents);
    }
    escrow.status = 'refunded';
    escrow.releasedAt = new Date().toISOString();
  }
  match.status = 'cancelled';
  return match;
}

export { WalletError };
