import { MatchOutcome } from './types';

/**
 * Result reconciliation.
 *
 * Both players report the match from their own point of view ("I scored 3,
 * they scored 1"). Reconciliation normalises both reports onto the creator's
 * point of view and checks that they describe the same game.
 */

export interface RawReport {
  reporterId: string;
  selfScore: number;
  opponentScore: number;
}

export interface NormalisedReport {
  reporterId: string;
  creatorScore: number;
  opponentScore: number;
}

export type ReconciliationVerdict = 'agreed' | 'conflict';

export interface Reconciliation {
  verdict: ReconciliationVerdict;
  outcome: MatchOutcome | null;
  creatorScore: number | null;
  opponentScore: number | null;
  /** Winner's user id; null on a draw or a conflict. */
  winnerId: string | null;
}

export function normaliseReport(report: RawReport, creatorId: string): NormalisedReport {
  assertScore(report.selfScore);
  assertScore(report.opponentScore);
  const fromCreator = report.reporterId === creatorId;
  return {
    reporterId: report.reporterId,
    creatorScore: fromCreator ? report.selfScore : report.opponentScore,
    opponentScore: fromCreator ? report.opponentScore : report.selfScore,
  };
}

function assertScore(score: number): void {
  if (!Number.isInteger(score) || score < 0 || score > 99) {
    throw new Error('Score must be an integer between 0 and 99');
  }
}

export function outcomeFor(creatorScore: number, opponentScore: number): MatchOutcome {
  if (creatorScore > opponentScore) return 'creator_win';
  if (creatorScore < opponentScore) return 'opponent_win';
  return 'draw';
}

export function reconcile(
  reports: RawReport[],
  creatorId: string,
  opponentId: string,
): Reconciliation {
  if (reports.length !== 2) {
    throw new Error('Reconciliation needs exactly two reports');
  }
  const [a, b] = reports.map((r) => normaliseReport(r, creatorId));
  if (a.reporterId === b.reporterId) {
    throw new Error('Both reports came from the same player');
  }

  const agree = a.creatorScore === b.creatorScore && a.opponentScore === b.opponentScore;
  if (!agree) {
    return { verdict: 'conflict', outcome: null, creatorScore: null, opponentScore: null, winnerId: null };
  }

  const outcome = outcomeFor(a.creatorScore, a.opponentScore);
  const winnerId =
    outcome === 'creator_win' ? creatorId : outcome === 'opponent_win' ? opponentId : null;

  return {
    verdict: 'agreed',
    outcome,
    creatorScore: a.creatorScore,
    opponentScore: a.opponentScore,
    winnerId,
  };
}

/**
 * A single report, used when the opponent never reported and their deadline
 * lapsed. This does NOT settle on its own — it is the claim a moderator (or a
 * high-trust auto-forfeit rule) acts on.
 */
export function claimFromSingleReport(
  report: RawReport,
  creatorId: string,
  opponentId: string,
): Reconciliation {
  const n = normaliseReport(report, creatorId);
  const outcome = outcomeFor(n.creatorScore, n.opponentScore);
  return {
    verdict: 'agreed',
    outcome,
    creatorScore: n.creatorScore,
    opponentScore: n.opponentScore,
    winnerId: outcome === 'creator_win' ? creatorId : outcome === 'opponent_win' ? opponentId : null,
  };
}
