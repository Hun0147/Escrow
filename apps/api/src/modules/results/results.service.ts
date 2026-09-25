import {
  Match,
  MatchResult,
  RawReport,
  reconcile,
  settlementPolicyFor,
} from '@escrow/shared';
import { withTransaction } from '../../db/transaction';
import {
  findMatchById,
  insertResult,
  listResults,
  lockMatch,
  updateMatch,
  findLapsedMatches,
} from '../../db/repos/matches.repo';
import { UserRow, findUserById } from '../../db/repos/users.repo';
import { findScreenshotById, listScreenshotsForMatch, upsertDispute } from '../../db/repos/misc.repo';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { getSetting } from '../../common/settings';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';
import { settleMatch } from '../settlement/settlement.service';
import { recordTrustEvent, recomputeTrustScore } from '../trust/trust.service';
import { assertParticipant } from '../matches/matches.service';

export interface SubmitResultInput {
  matchId: string;
  selfScore: number;
  opponentScore: number;
  screenshotId?: string | null;
  clipUrl?: string | null;
}

export interface SubmitResultOutcome {
  result: MatchResult;
  match: Match;
  /** What happened once this report was in. */
  status: 'awaiting_opponent' | 'settled' | 'held_for_review' | 'disputed';
  detail: string;
}

/**
 * A player reports their own result.
 *
 * When both reports are in and agree, escrow settles automatically — unless
 * the pair's trust policy says otherwise. When they disagree, the match goes
 * straight to the moderation queue. Escrow never releases on one player's word
 * alone.
 */
export async function submitResult(user: UserRow, input: SubmitResultInput): Promise<SubmitResultOutcome> {
  assertScore(input.selfScore);
  assertScore(input.opponentScore);

  const prepared = await withTransaction(async (client) => {
    const match = await lockMatch(input.matchId, client);
    if (!match) throw notFound('Match');
    assertParticipant(match, user.id);
    if (!match.opponentId) throw badRequest('no_opponent', 'This match was never joined');
    if (!['escrowed', 'in_progress', 'awaiting_results'].includes(match.status)) {
      throw conflict('bad_state', `A result cannot be reported while the match is ${match.status}`);
    }

    const existing = await listResults(match.id, client);
    if (existing.some((r) => r.reporterId === user.id)) {
      throw conflict('already_reported', 'You have already reported this match');
    }

    if (input.screenshotId) {
      const screenshot = await findScreenshotById(input.screenshotId, client);
      if (!screenshot) throw notFound('Screenshot');
      if (screenshot.matchId !== match.id || screenshot.uploaderId !== user.id) {
        throw forbidden('screenshot_mismatch', 'That screenshot belongs to another match or player');
      }
    }

    const result = await insertResult(
      {
        matchId: match.id,
        reporterId: user.id,
        selfScore: input.selfScore,
        opponentScore: input.opponentScore,
        screenshotId: input.screenshotId ?? null,
        clipUrl: input.clipUrl ?? null,
      },
      client,
    );

    // The first report starts the opponent's clock. Miss it and the match is
    // escalated rather than silently forfeited — a player whose console died
    // deserves a human look, not an automatic loss.
    const deadlineMinutes = await getSetting('result_deadline_minutes');
    const isFirst = existing.length === 0;
    const updated = await updateMatch(
      match.id,
      isFirst
        ? {
            status: 'awaiting_results',
            reportDeadlineAt: new Date(Date.now() + deadlineMinutes * 60_000).toISOString(),
          }
        : { status: 'awaiting_results' },
      client,
    );

    return { result, match: updated, reports: [...existing, result] };
  });

  realtime.toMatch(prepared.match.id, 'result:submitted', {
    matchId: prepared.match.id,
    reporterId: user.id,
    reportsIn: prepared.reports.length,
  });

  const opponentId =
    prepared.match.creatorId === user.id ? prepared.match.opponentId! : prepared.match.creatorId;
  await notify({
    userId: opponentId,
    matchId: prepared.match.id,
    type: 'result_submitted',
    title: 'Opponent reported the result',
    body: 'Submit your score and screenshot to settle the match.',
  });

  if (prepared.reports.length < 2) {
    return {
      result: prepared.result,
      match: prepared.match,
      status: 'awaiting_opponent',
      detail: 'Waiting on your opponent to report.',
    };
  }

  const outcome = await finaliseIfPossible(prepared.match.id);
  return { ...outcome, result: prepared.result };
}

/**
 * Tries to bring a fully-reported match to a conclusion.
 *
 * Deliberately re-runnable, because "both players agreed but the evidence
 * isn't in yet" is a waiting state, not an outcome: the screenshot that
 * unblocks it arrives later, and something has to look again when it does.
 * Called on every result submission and again after each screenshot is
 * analysed.
 */
export async function finaliseIfPossible(
  matchId: string,
): Promise<Omit<SubmitResultOutcome, 'result'>> {
  const match = await findMatchById(matchId);
  if (!match) throw notFound('Match');

  if (match.status === 'settled' || match.status === 'voided') {
    return { match, status: 'settled', detail: 'This match is already settled.' };
  }
  if (match.status === 'disputed') {
    return { match, status: 'disputed', detail: 'This match is with a moderator.' };
  }

  const reports = await listResults(matchId);
  if (reports.length < 2) {
    return { match, status: 'awaiting_opponent', detail: 'Waiting on the second report.' };
  }
  return resolveBothReports(match, reports);
}

async function resolveBothReports(
  match: Match,
  reports: MatchResult[],
): Promise<Omit<SubmitResultOutcome, 'result'>> {
  const raw: RawReport[] = reports.map((r) => ({
    reporterId: r.reporterId,
    selfScore: r.selfScore,
    opponentScore: r.opponentScore,
  }));
  const verdict = reconcile(raw, match.creatorId, match.opponentId!);

  if (verdict.verdict === 'conflict') {
    const dispute = await openDisputeForMatch(
      match,
      null,
      'Players reported different scorelines',
    );
    for (const report of reports) {
      await recordTrustEvent({
        userId: report.reporterId,
        type: 'dispute_raised',
        matchId: match.id,
        note: 'Conflicting result reports',
      });
      await recomputeTrustScore(report.reporterId);
    }
    return {
      match: await findMatchById(match.id).then((m) => m!),
      status: 'disputed',
      detail: `Reports conflict — dispute ${dispute.id} is in the moderation queue.`,
    };
  }

  const policy = await policyFor(match);
  const screenshots = await listScreenshotsForMatch(match.id);

  if (policy.requireBothScreenshots) {
    const uploaders = new Set(screenshots.map((s) => s.uploaderId));
    const missing = [match.creatorId, match.opponentId!].filter((id) => !uploaders.has(id));
    if (missing.length > 0) {
      return {
        match,
        status: 'held_for_review',
        detail: 'Both players must upload a post-match screenshot before escrow releases.',
      };
    }
  }

  // A screenshot the OCR pass has already rejected blocks auto-settlement
  // outright, however well the two typed reports agree.
  const rejected = screenshots.filter((s) => s.verdict === 'duplicate' || s.verdict === 'mismatch');
  if (rejected.length > 0) {
    const dispute = await openDisputeForMatch(
      match,
      null,
      `Screenshot verification failed: ${rejected.map((s) => s.verdict).join(', ')}`,
    );
    return {
      match: await findMatchById(match.id).then((m) => m!),
      status: 'disputed',
      detail: `Screenshot verification failed — dispute ${dispute.id} opened.`,
    };
  }

  if (policy.forceManualReview) {
    const dispute = await openDisputeForMatch(
      match,
      null,
      'Low-trust matchup routed to manual review',
    );
    return {
      match: await findMatchById(match.id).then((m) => m!),
      status: 'held_for_review',
      detail: `Held for review — case ${dispute.id}.`,
    };
  }

  let settled;
  try {
    settled = await settleMatch({
      matchId: match.id,
      outcome: verdict.outcome!,
      creatorScore: verdict.creatorScore,
      opponentScore: verdict.opponentScore,
      source: 'auto_agreement',
    });
  } catch (err) {
    // Two screenshots finishing analysis at once both reach here; the row lock
    // lets exactly one settle and the other must not treat that as a failure.
    if (err instanceof AppError && err.code === 'already_settled') {
      const already = (await findMatchById(match.id))!;
      return { match: already, status: 'settled', detail: 'Settled.' };
    }
    throw err;
  }

  return {
    match: settled.match,
    status: 'settled',
    detail:
      verdict.outcome === 'draw'
        ? 'Draw — both stakes returned in full.'
        : `Settled: ${settled.payoutCents} cents paid out after a ${settled.platformFeeCents} cent escrow fee.`,
  };
}

async function policyFor(match: Match) {
  const creator = await findUserById(match.creatorId);
  const opponent = match.opponentId ? await findUserById(match.opponentId) : null;
  return settlementPolicyFor(creator?.trustScore ?? 0, opponent?.trustScore ?? 0);
}

export async function openDisputeForMatch(match: Match, raisedBy: string | null, reason: string) {
  const dispute = await upsertDispute({ matchId: match.id, raisedBy, reason });
  await updateMatch(match.id, { status: 'disputed' });
  for (const userId of [match.creatorId, match.opponentId].filter(Boolean) as string[]) {
    await notify({
      userId,
      matchId: match.id,
      type: 'dispute_opened',
      title: 'Match under review',
      body: `${reason}. Your stake stays in escrow until a moderator rules.`,
    });
  }
  realtime.toMatch(match.id, 'match:disputed', { matchId: match.id, disputeId: dispute.id, reason });
  return dispute;
}

/**
 * Sweeps matches whose reporting window expired.
 *
 * Run by the worker on a timer. A silent opponent does not hand the reporter
 * an automatic win — the match goes to the moderation queue with the one
 * report, the screenshots and the chat log attached, and the no-show takes a
 * trust hit.
 */
export async function sweepLapsedMatches(): Promise<string[]> {
  const lapsed = await findLapsedMatches();
  const handled: string[] = [];

  for (const match of lapsed) {
    const reports = await listResults(match.id);

    if (reports.length >= 2) {
      // Both players reported but the match never settled — it is waiting on
      // evidence that has not arrived. Give it one more chance to conclude,
      // and escalate rather than leaving the escrow stuck forever.
      const outcome = await finaliseIfPossible(match.id);
      if (outcome.status === 'held_for_review') {
        await openDisputeForMatch(
          match,
          null,
          'Reports agree but the required screenshots were never uploaded',
        );
        handled.push(match.id);
      }
      continue;
    }

    const reporterId = reports[0]?.reporterId ?? null;
    const silentId =
      reporterId === null
        ? null
        : reporterId === match.creatorId
          ? match.opponentId
          : match.creatorId;

    await openDisputeForMatch(
      match,
      null,
      reporterId
        ? 'Opponent did not report within the reporting window'
        : 'Neither player reported within the reporting window',
    );

    if (silentId) {
      await recordTrustEvent({
        userId: silentId,
        type: 'report_timeout',
        matchId: match.id,
        note: 'Missed the reporting deadline',
      });
      await recomputeTrustScore(silentId);
    }
    handled.push(match.id);
  }
  return handled;
}

function assertScore(score: number): void {
  if (!Number.isInteger(score) || score < 0 || score > 99) {
    throw badRequest('invalid_score', 'Scores must be whole numbers between 0 and 99');
  }
}
