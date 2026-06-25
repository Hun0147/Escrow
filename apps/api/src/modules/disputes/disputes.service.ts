import { findMatchById, updateMatch } from '../../db/matches.repo';
import { createDispute, findDisputeById, resolveDisputeRow } from '../../db/disputes.repo';

export class DisputeError extends Error {}

export async function openDispute(matchId: string, raisedBy: string, evidence: string[]) {
  const match = await findMatchById(matchId);
  if (!match) throw new DisputeError('Match not found');
  if (raisedBy !== match.creatorId && raisedBy !== match.opponentId) {
    throw new DisputeError('Only match participants can raise a dispute');
  }

  const dispute = await createDispute({ matchId, raisedBy, evidence });
  await updateMatch(matchId, { status: 'disputed' });
  return dispute;
}

/** Phase 1: manual moderator review only. No AI/automated verification yet. */
export async function resolveDispute(disputeId: string, resolution: string, winnerId: string | null) {
  const dispute = await findDisputeById(disputeId);
  if (!dispute) throw new DisputeError('Dispute not found');

  const resolved = await resolveDisputeRow(disputeId, resolution, 'resolved');

  if (winnerId) {
    // Settlement still goes through settleMatch separately to apply the platform fee.
    await updateMatch(dispute.matchId, { status: 'awaiting_confirmation' });
  }
  return resolved;
}
