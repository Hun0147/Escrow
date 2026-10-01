import {
  ChatMessage,
  Dispute,
  DisputeResolution,
  DisputeStatus,
  Match,
  MatchResult,
  PublicUser,
  Screenshot,
} from '@escrow/shared';
import { pool } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { findMatchById, listResults, lockMatch, updateMatch } from '../../db/repos/matches.repo';
import {
  findDisputeById,
  listChatMessages,
  listDisputes,
  listScreenshotsForMatch,
  markDisputeResolved,
} from '../../db/repos/misc.repo';
import { UserRow, findUserById, toPublicUser } from '../../db/repos/users.repo';
import { logAdminAction } from '../../db/repos/fraud.repo';
import { badRequest, conflict, notFound } from '../../common/errors';
import { getSetting } from '../../common/settings';
import { assertParticipant } from '../matches/matches.service';
import { openDisputeForMatch } from '../results/results.service';
import { afterSettlement, finaliseInTransaction, voidMatch } from '../settlement/settlement.service';
import { addStrike, recordTrustEvent, recomputeTrustScore } from '../trust/trust.service';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';

export async function raiseDispute(user: UserRow, matchId: string, reason: string): Promise<Dispute> {
  const match = await findMatchById(matchId);
  if (!match) throw notFound('Match');
  assertParticipant(match, user.id);
  if (['settled', 'voided', 'cancelled'].includes(match.status)) {
    throw conflict('bad_state', 'This match is already closed');
  }
  if (!reason.trim()) throw badRequest('missing_reason', 'Describe what went wrong');

  const dispute = await openDisputeForMatch(match, user.id, reason.trim());
  await recordTrustEvent({ userId: user.id, type: 'dispute_raised', matchId, note: reason.trim() });
  await recomputeTrustScore(user.id);
  return dispute;
}

/** Everything a moderator needs on one screen, so a ruling never depends on
 *  chasing records across tables. */
export interface DisputeCase {
  dispute: Dispute;
  match: Match;
  creator: PublicUser;
  opponent: PublicUser | null;
  results: MatchResult[];
  screenshots: Screenshot[];
  chat: ChatMessage[];
  history: { userId: string; disputes: number; disputesLost: number; strikes: number }[];
}

export async function caseFile(disputeId: string): Promise<DisputeCase> {
  const dispute = await findDisputeById(disputeId);
  if (!dispute) throw notFound('Dispute');
  const match = await findMatchById(dispute.matchId);
  if (!match) throw notFound('Match');
  const creator = await findUserById(match.creatorId);
  if (!creator) throw notFound('Creator');
  const opponent = match.opponentId ? await findUserById(match.opponentId) : null;

  return {
    dispute,
    match,
    creator: toPublicUser(creator),
    opponent: opponent ? toPublicUser(opponent) : null,
    results: await listResults(match.id),
    screenshots: await listScreenshotsForMatch(match.id),
    chat: await listChatMessages(match.id),
    history: await disputeHistory([creator, opponent].filter(Boolean) as UserRow[]),
  };
}

async function disputeHistory(users: UserRow[]) {
  const out = [];
  for (const user of users) {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'dispute_raised') AS raised,
         COUNT(*) FILTER (WHERE type = 'dispute_lost') AS lost
       FROM trust_events WHERE user_id = $1`,
      [user.id],
    );
    out.push({
      userId: user.id,
      disputes: Number(rows[0].raised),
      disputesLost: Number(rows[0].lost),
      strikes: user.strikes,
    });
  }
  return out;
}

export async function queue(status: DisputeStatus | 'all' = 'open'): Promise<Dispute[]> {
  return listDisputes(status);
}

export interface ResolveInput {
  disputeId: string;
  resolution: DisputeResolution;
  notes: string;
  /** Issue a strike to the player found to have reported dishonestly. */
  strikeUserId?: string | null;
}

/**
 * A moderator ruling. This is the only way a contested escrow ever releases.
 *
 * The dispute row and the settlement commit together: a ruling that paid out
 * but left the case open — or vice versa — would be worse than either failing.
 */
export async function resolveDispute(moderator: UserRow, input: ResolveInput): Promise<Dispute> {
  const dispute = await findDisputeById(input.disputeId);
  if (!dispute) throw notFound('Dispute');
  if (dispute.status === 'resolved' || dispute.status === 'auto_resolved') {
    throw conflict('already_resolved', 'This dispute has already been ruled on');
  }
  if (!input.notes.trim()) throw badRequest('missing_notes', 'Record the reasoning for this ruling');

  if (input.resolution === 'dismissed') {
    const minutes = await getSetting('result_deadline_minutes');
    await updateMatch(dispute.matchId, {
      status: 'awaiting_results',
      reportDeadlineAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    });
    const resolved = await markDisputeResolved({
      id: dispute.id,
      resolution: 'dismissed',
      resolvedBy: moderator.id,
      notes: input.notes.trim(),
    });
    await announce(dispute.matchId, 'Dispute dismissed — report the result again.', resolved);
    await logAdminAction({
      adminId: moderator.id,
      action: 'dispute_dismissed',
      targetType: 'dispute',
      targetId: dispute.id,
      notes: input.notes.trim(),
    });
    return resolved;
  }

  if (input.resolution === 'void_refund' || input.resolution === 'replay') {
    await voidMatch(
      dispute.matchId,
      input.resolution === 'replay' ? 'Moderator ordered a replay.' : 'Moderator voided the match.',
    );
    const resolved = await markDisputeResolved({
      id: dispute.id,
      resolution: input.resolution,
      resolvedBy: moderator.id,
      notes: input.notes.trim(),
    });
    await announce(dispute.matchId, 'Match voided by a moderator — stakes returned.', resolved);
    await logAdminAction({
      adminId: moderator.id,
      action: `dispute_${input.resolution}`,
      targetType: 'dispute',
      targetId: dispute.id,
      notes: input.notes.trim(),
    });
    if (input.strikeUserId) await addStrike(input.strikeUserId, `Dispute ${dispute.id}: ${input.notes.trim()}`);
    return resolved;
  }

  const outcome = input.resolution === 'creator_wins' ? 'creator_win' : 'opponent_win';

  const { settlement, resolved } = await withTransaction(async (client) => {
    const match = await lockMatch(dispute.matchId, client);
    if (!match) throw notFound('Match');
    if (match.status === 'settled' || match.status === 'voided') {
      throw conflict('already_settled', 'This match has already been settled');
    }
    if (match.escrowStatus !== 'funded') {
      throw badRequest('escrow_not_funded', 'Escrow is not fully funded');
    }
    const settlement = await finaliseInTransaction(client, match, {
      matchId: match.id,
      outcome,
      creatorScore: match.creatorScore ?? null,
      opponentScore: match.opponentScore ?? null,
      source: 'moderator',
      resolvedBy: moderator.id,
    });
    const resolved = await markDisputeResolved(
      {
        id: dispute.id,
        resolution: input.resolution,
        resolvedBy: moderator.id,
        notes: input.notes.trim(),
      },
      client,
    );
    return { settlement, resolved };
  });

  await afterSettlement(settlement, {
    matchId: dispute.matchId,
    outcome,
    creatorScore: settlement.match.creatorScore ?? null,
    opponentScore: settlement.match.opponentScore ?? null,
    source: 'moderator',
    resolvedBy: moderator.id,
  });

  // The player the ruling went against wears the dispute loss; the other side
  // is credited for having reported honestly.
  const winnerId = settlement.match.winnerId!;
  const loserId =
    winnerId === settlement.match.creatorId ? settlement.match.opponentId! : settlement.match.creatorId;
  await recordTrustEvent({ userId: winnerId, type: 'dispute_won', matchId: dispute.matchId });
  await recordTrustEvent({ userId: loserId, type: 'dispute_lost', matchId: dispute.matchId });
  await recordTrustEvent({ userId: loserId, type: 'report_inaccurate', matchId: dispute.matchId });
  await recomputeTrustScore(winnerId);
  await recomputeTrustScore(loserId);

  if (input.strikeUserId) {
    await addStrike(input.strikeUserId, `Dispute ${dispute.id}: ${input.notes.trim()}`);
  }

  await announce(dispute.matchId, 'A moderator has ruled on this match.', resolved);
  await logAdminAction({
    adminId: moderator.id,
    action: `dispute_${input.resolution}`,
    targetType: 'dispute',
    targetId: dispute.id,
    notes: input.notes.trim(),
  });
  return resolved;
}

async function announce(matchId: string, body: string, dispute: Dispute): Promise<void> {
  const match = await findMatchById(matchId);
  if (!match) return;
  for (const userId of [match.creatorId, match.opponentId].filter(Boolean) as string[]) {
    await notify({
      userId,
      matchId,
      type: 'dispute_resolved',
      title: 'Dispute resolved',
      body,
    });
  }
  realtime.toMatch(matchId, 'dispute:resolved', { matchId, dispute });
}
