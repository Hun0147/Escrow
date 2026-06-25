import { calculateSettlement } from '@escrow/shared';
import { findMatchByIdForUpdate, updateMatch } from '../../db/matches.repo';
import { findEscrowByMatchId, updateEscrowStatus } from '../../db/escrows.repo';
import { recordTransaction } from '../../db/transactions.repo';
import { withTransaction } from '../../db/transaction';
import { creditPayout } from '../wallet/wallet.service';

export class SettlementError extends Error {}

export async function settleMatch(matchId: string, winnerId: string) {
  return withTransaction(async (client) => {
    const match = await findMatchByIdForUpdate(matchId, client);
    if (!match) throw new SettlementError('Match not found');
    if (match.status !== 'funded' && match.status !== 'awaiting_confirmation') {
      throw new SettlementError('Match is not ready for settlement');
    }
    if (winnerId !== match.creatorId && winnerId !== match.opponentId) {
      throw new SettlementError('Winner must be a match participant');
    }
    const escrow = await findEscrowByMatchId(matchId, client);
    if (!escrow || escrow.status !== 'funded') {
      throw new SettlementError('Escrow is not fully funded');
    }

    const { grossPoolCents, platformFeeCents, payoutCents } = calculateSettlement(
      match.stakeCents,
      match.stakeCents,
    );

    await creditPayout(winnerId, payoutCents, matchId, client);
    await recordTransaction({ userId: winnerId, matchId, type: 'platform_fee', amountCents: platformFeeCents }, client);

    await updateMatch(matchId, { status: 'settled', winnerId }, client);
    await updateEscrowStatus(matchId, 'released', client);

    return { matchId, winnerId, grossPoolCents, platformFeeCents, payoutCents };
  });
}
