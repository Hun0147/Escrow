import { Match, MatchOutcome } from '@escrow/shared';
import { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction';
import { lockMatch, updateMatch } from '../../db/repos/matches.repo';
import { bumpRecord, lockUsers } from '../../db/repos/users.repo';
import { getWallet } from '../../db/repos/ledger.repo';
import { refundEscrow, releaseEscrowToWinner } from '../wallet/money.service';
import { badRequest, conflict, notFound } from '../../common/errors';
import { recordTrustEvent, recomputeTrustScore } from '../trust/trust.service';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';
import { advanceBracketAfterMatch } from '../tournaments/bracket.service';

export interface SettleInput {
  matchId: string;
  outcome: MatchOutcome;
  creatorScore: number | null;
  opponentScore: number | null;
  /** Where the ruling came from — recorded on the ledger memo and the audit log. */
  source: 'auto_agreement' | 'moderator' | 'forfeit' | 'timeout_forfeit';
  resolvedBy?: string | null;
}

export interface SettleOutput {
  match: Match;
  payoutCents: number;
  platformFeeCents: number;
  grossPoolCents: number;
}

/**
 * The only path that releases escrow.
 *
 * Everything else — auto-settlement on agreement, a moderator ruling, a
 * forfeit — funnels through here, so there is exactly one place where money
 * leaves a match, and exactly one set of invariants to audit.
 */
export async function settleMatch(input: SettleInput): Promise<SettleOutput> {
  const result = await withTransaction(async (client) => {
    const match = await lockMatch(input.matchId, client);
    if (!match) throw notFound('Match');
    if (match.status === 'settled' || match.status === 'voided') {
      throw conflict('already_settled', 'This match has already been settled');
    }
    if (!match.opponentId) {
      throw badRequest('no_opponent', 'A match without an opponent cannot be settled');
    }
    if (match.stakeCents > 0 && match.escrowStatus !== 'funded') {
      throw badRequest('escrow_not_funded', 'Escrow is not fully funded');
    }
    return finaliseInTransaction(client, match, input);
  });

  await afterSettlement(result, input);
  return result;
}

/**
 * Settlement body, callable from inside an existing transaction (a moderator
 * resolving a dispute updates the dispute row and settles atomically).
 */
export async function finaliseInTransaction(
  client: PoolClient,
  match: Match,
  input: SettleInput,
): Promise<SettleOutput> {
  if (!match.opponentId) throw badRequest('no_opponent', 'A match without an opponent cannot be settled');
  await lockUsers([match.creatorId, match.opponentId], client);

  // A tournament fixture carries no stake of its own — the entry fees are held
  // by the tournament, and prizes are paid when the bracket completes.
  if (match.stakeCents === 0) {
    const winnerId =
      input.outcome === 'creator_win'
        ? match.creatorId
        : input.outcome === 'opponent_win'
          ? match.opponentId
          : null;
    const updated = await updateMatch(
      match.id,
      {
        status: input.outcome === 'draw' ? 'voided' : 'settled',
        outcome: input.outcome,
        winnerId,
        creatorScore: input.creatorScore,
        opponentScore: input.opponentScore,
        settledAt: new Date().toISOString(),
      },
      client,
    );
    return { match: updated, payoutCents: 0, platformFeeCents: 0, grossPoolCents: 0 };
  }

  if (input.outcome === 'draw') {
    await refundEscrow(client, match.id, [match.creatorId, match.opponentId], match.stakeCents);
    const updated = await updateMatch(
      match.id,
      {
        status: 'voided',
        escrowStatus: 'refunded',
        outcome: 'draw',
        winnerId: null,
        creatorScore: input.creatorScore,
        opponentScore: input.opponentScore,
        settledAt: new Date().toISOString(),
      },
      client,
    );
    await bumpRecord(match.creatorId, 'draws', client);
    await bumpRecord(match.opponentId, 'draws', client);
    return { match: updated, payoutCents: 0, platformFeeCents: 0, grossPoolCents: match.stakeCents * 2 };
  }

  const winnerId = input.outcome === 'creator_win' ? match.creatorId : match.opponentId;
  const loserId = input.outcome === 'creator_win' ? match.opponentId : match.creatorId;

  const release = await releaseEscrowToWinner(client, {
    matchId: match.id,
    winnerId,
    loserId,
    stakeCents: match.stakeCents,
    escrowFeeBps: match.escrowFeeBps,
  });

  const updated = await updateMatch(
    match.id,
    {
      status: 'settled',
      escrowStatus: 'released',
      outcome: input.outcome,
      winnerId,
      creatorScore: input.creatorScore,
      opponentScore: input.opponentScore,
      settledAt: new Date().toISOString(),
    },
    client,
  );
  await bumpRecord(winnerId, 'wins', client);
  await bumpRecord(loserId, 'losses', client);

  return { match: updated, ...release };
}

/** Notifications, trust bookkeeping and bracket advancement — everything that
 *  must NOT hold the money transaction open. */
export async function afterSettlement(result: SettleOutput, input: SettleInput): Promise<void> {
  const match = result.match;
  const participants = [match.creatorId, match.opponentId!].filter(Boolean) as string[];

  if (input.source === 'auto_agreement') {
    for (const userId of participants) {
      await recordTrustEvent({ userId, type: 'report_accurate', matchId: match.id, note: 'Reports agreed' });
      await recordTrustEvent({ userId, type: 'match_settled_clean', matchId: match.id });
    }
  } else {
    for (const userId of participants) {
      await recordTrustEvent({ userId, type: 'match_settled_clean', matchId: match.id });
    }
  }
  for (const userId of participants) await recomputeTrustScore(userId);

  for (const userId of participants) {
    const wallet = await getWallet(userId);
    const won = match.winnerId === userId;
    await notify({
      userId,
      matchId: match.id,
      type: 'match_settled',
      title: match.winnerId === null ? 'Match voided' : won ? 'You won' : 'Match settled',
      body:
        match.winnerId === null
          ? 'The match was a draw — both stakes were returned in full.'
          : won
            ? `${result.payoutCents} cents paid into your wallet.`
            : 'Your opponent took the pool.',
    });
    if (wallet) realtime.toUser(userId, 'wallet:updated', wallet);
  }

  realtime.toMatch(match.id, 'match:settled', { match, payoutCents: result.payoutCents });
  realtime.toLobby('lobby:match_removed', { matchId: match.id });

  if (match.winnerId) await advanceBracketAfterMatch(match.id, match.winnerId);
}

/** Returns both stakes and closes the match without a winner. */
export async function voidMatch(matchId: string, reason: string): Promise<Match> {
  const match = await withTransaction(async (client) => {
    const locked = await lockMatch(matchId, client);
    if (!locked) throw notFound('Match');
    if (locked.status === 'settled' || locked.status === 'voided') {
      throw conflict('already_settled', 'This match has already been settled');
    }
    // With escrow still 'pending' only the creator has staked; refunding both
    // would credit the opponent money they never put in.
    const staked =
      locked.escrowStatus === 'funded'
        ? ([locked.creatorId, locked.opponentId].filter(Boolean) as string[])
        : locked.escrowStatus === 'pending'
          ? [locked.creatorId]
          : [];
    if (staked.length > 0) {
      await refundEscrow(client, locked.id, staked, locked.stakeCents);
    }
    return updateMatch(
      locked.id,
      {
        status: 'voided',
        escrowStatus: 'refunded',
        settledAt: new Date().toISOString(),
      },
      client,
    );
  });

  const participants = [match.creatorId, match.opponentId].filter(Boolean) as string[];
  for (const userId of participants) {
    const wallet = await getWallet(userId);
    await notify({
      userId,
      matchId: match.id,
      type: 'match_settled',
      title: 'Match voided',
      body: `${reason} Your stake was returned in full.`,
    });
    if (wallet) realtime.toUser(userId, 'wallet:updated', wallet);
  }
  realtime.toMatch(match.id, 'match:voided', { match, reason });
  realtime.toLobby('lobby:match_removed', { matchId: match.id });
  return match;
}
