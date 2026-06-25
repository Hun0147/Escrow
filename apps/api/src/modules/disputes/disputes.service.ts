import { v4 as uuid } from 'uuid';
import { store } from '../../db/store';

export class DisputeError extends Error {}

export function openDispute(matchId: string, raisedBy: string, evidence: string[]) {
  const match = store.matches.get(matchId);
  if (!match) throw new DisputeError('Match not found');
  if (raisedBy !== match.creatorId && raisedBy !== match.opponentId) {
    throw new DisputeError('Only match participants can raise a dispute');
  }

  const id = uuid();
  store.disputes.set(id, {
    id,
    matchId,
    raisedBy,
    status: 'open',
    evidence,
    createdAt: new Date().toISOString(),
  });
  match.status = 'disputed';
  return store.disputes.get(id)!;
}

/** Phase 1: manual moderator review only. No AI/automated verification yet. */
export function resolveDispute(disputeId: string, resolution: string, winnerId: string | null) {
  const dispute = store.disputes.get(disputeId);
  if (!dispute) throw new DisputeError('Dispute not found');
  dispute.status = 'resolved';
  (dispute as any).resolution = resolution;

  const match = store.matches.get(dispute.matchId);
  if (match && winnerId) {
    match.status = 'awaiting_confirmation';
    match.winnerId = null; // settlement still goes through settleMatch to apply the fee
  }
  return dispute;
}
