import { calculateSettlement } from '@escrow/shared';
import { v4 as uuid } from 'uuid';
import { store } from '../../db/store';
import { creditPayout } from '../wallet/wallet.service';

export class SettlementError extends Error {}

export function settleMatch(matchId: string, winnerId: string) {
  const match = store.matches.get(matchId);
  if (!match) throw new SettlementError('Match not found');
  if (match.status !== 'funded' && match.status !== 'awaiting_confirmation') {
    throw new SettlementError('Match is not ready for settlement');
  }
  if (winnerId !== match.creatorId && winnerId !== match.opponentId) {
    throw new SettlementError('Winner must be a match participant');
  }
  const escrow = store.escrowByMatchId(matchId);
  if (!escrow || escrow.status !== 'funded') {
    throw new SettlementError('Escrow is not fully funded');
  }

  const { grossPoolCents, platformFeeCents, payoutCents } = calculateSettlement(
    match.stakeCents,
    match.stakeCents,
  );

  creditPayout(winnerId, payoutCents);

  const feeTxId = uuid();
  store.transactions.set(feeTxId, {
    id: feeTxId,
    userId: winnerId,
    type: 'platform_fee',
    amountCents: platformFeeCents,
    status: 'completed',
    createdAt: new Date().toISOString(),
  });

  match.status = 'settled';
  match.winnerId = winnerId;
  escrow.status = 'released';
  escrow.releasedAt = new Date().toISOString();

  return { matchId, winnerId, grossPoolCents, platformFeeCents, payoutCents };
}
