import { findUserById } from '../../db/users.repo';
import { createMatchRow, findMatchByIdForUpdate, updateMatch } from '../../db/matches.repo';
import { addToEscrow, createEscrow, findEscrowByMatchId, updateEscrowStatus } from '../../db/escrows.repo';
import { withTransaction } from '../../db/transaction';
import { lockForEscrow, refund, WalletError } from '../wallet/wallet.service';

export class MatchError extends Error {}

export async function createMatch(creatorId: string, game: string, stakeCents: number) {
  if (!(await findUserById(creatorId))) throw new MatchError('Creator not found');
  if (stakeCents <= 0) throw new MatchError('Stake must be positive');
  return createMatchRow({ creatorId, game, stakeCents });
}

export async function fundEscrow(matchId: string, userId: string) {
  return withTransaction(async (client) => {
    const match = await findMatchByIdForUpdate(matchId, client);
    if (!match) throw new MatchError('Match not found');
    if (match.status !== 'created' && match.status !== 'funded') {
      throw new MatchError('Match is not open for funding');
    }
    if (userId !== match.creatorId && match.opponentId !== null && userId !== match.opponentId) {
      throw new MatchError('User is not a participant in this match');
    }

    if (userId === match.creatorId) {
      await lockForEscrow(userId, match.stakeCents, matchId, client);
    } else {
      if (match.opponentId && match.opponentId !== userId) {
        throw new MatchError('Match already has an opponent');
      }
      await updateMatch(matchId, { opponentId: userId }, client);
      await lockForEscrow(userId, match.stakeCents, matchId, client);
    }

    let escrow = await findEscrowByMatchId(matchId, client);
    if (!escrow) {
      escrow = await createEscrow({ matchId, amountCents: match.stakeCents }, client);
    } else {
      escrow = await addToEscrow(matchId, match.stakeCents, client);
    }

    const finalOpponentId = userId === match.creatorId ? match.opponentId : userId;
    let finalMatch = match;
    if (match.creatorId && finalOpponentId) {
      finalMatch = await updateMatch(matchId, { status: 'funded' }, client);
      escrow = await updateEscrowStatus(matchId, 'funded', client);
    } else {
      finalMatch = (await findMatchByIdForUpdate(matchId, client))!;
    }

    return { match: finalMatch, escrow };
  });
}

export async function cancelMatch(matchId: string) {
  return withTransaction(async (client) => {
    const match = await findMatchByIdForUpdate(matchId, client);
    if (!match) throw new MatchError('Match not found');
    if (match.status === 'settled') throw new MatchError('Cannot cancel a settled match');

    const escrow = await findEscrowByMatchId(matchId, client);
    if (escrow && (escrow.status === 'pending' || escrow.status === 'funded')) {
      await refund(match.creatorId, match.stakeCents, matchId, client);
      if (escrow.status === 'funded' && match.opponentId) {
        await refund(match.opponentId, match.stakeCents, matchId, client);
      }
      await updateEscrowStatus(matchId, 'refunded', client);
    }
    return updateMatch(matchId, { status: 'cancelled' }, client);
  });
}

export { WalletError };
