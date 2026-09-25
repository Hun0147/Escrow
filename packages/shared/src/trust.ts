/**
 * Trust score (0-100).
 *
 * A player's score is derived from their record, not from a running mutable
 * counter, so it can always be recomputed from the trust_events table and can
 * never drift. New accounts start near the neutral prior rather than at 0 or
 * 100 — a fresh account should be neither punished nor trusted.
 */

export interface TrustInputs {
  /** Matches that reached a terminal settled/voided state. */
  matchesSettled: number;
  /** Reports that agreed with the opponent, or were upheld in a dispute. */
  accurateReports: number;
  /** Reports contradicted by the opponent and overturned by a moderator. */
  inaccurateReports: number;
  disputesRaised: number;
  /** Disputes resolved against this player. */
  disputesLost: number;
  /** Matches this player abandoned after escrow. */
  cancellations: number;
  /** Moderator-issued strikes. */
  strikes: number;
}

export const NEUTRAL_TRUST_SCORE = 65;

/** Weight of the prior, in pseudo-reports. Higher = slower to move. */
const PRIOR_WEIGHT = 8;
const PRIOR_ACCURACY = 0.65;

const DISPUTE_RATE_PENALTY = 25;
const DISPUTE_LOSS_PENALTY = 12;
const CANCELLATION_RATE_PENALTY = 20;
const STRIKE_PENALTY = 15;

export const HIGH_TRUST_THRESHOLD = 75;
export const LOW_TRUST_THRESHOLD = 40;

export function computeTrustScore(input: TrustInputs): number {
  const reports = input.accurateReports + input.inaccurateReports;
  const accuracy =
    (input.accurateReports + PRIOR_WEIGHT * PRIOR_ACCURACY) / (reports + PRIOR_WEIGHT);

  const denominator = Math.max(input.matchesSettled, 1);
  const disputeRate = Math.min(input.disputesRaised / denominator, 1);
  const cancellationRate = Math.min(input.cancellations / denominator, 1);

  const score =
    accuracy * 100 -
    disputeRate * DISPUTE_RATE_PENALTY -
    input.disputesLost * DISPUTE_LOSS_PENALTY -
    cancellationRate * CANCELLATION_RATE_PENALTY -
    input.strikes * STRIKE_PENALTY;

  return clamp(Math.round(score));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export type TrustBand = 'low' | 'standard' | 'high';

export function trustBand(score: number): TrustBand {
  if (score >= HIGH_TRUST_THRESHOLD) return 'high';
  if (score < LOW_TRUST_THRESHOLD) return 'low';
  return 'standard';
}

export interface SettlementPolicy {
  /** Escrow will not release until both players have uploaded a screenshot. */
  requireBothScreenshots: boolean;
  /** Hold period between agreement and payout, for a fraud review window. */
  holdSeconds: number;
  /** Route to a moderator even when both players agree. */
  forceManualReview: boolean;
}

/**
 * How hard we make a pair of players work before escrow opens.
 *
 * Driven by the *lower* of the two trust scores: one careless or dishonest
 * player is enough to make a settlement risky, no matter how good the other is.
 */
export function settlementPolicyFor(trustA: number, trustB: number): SettlementPolicy {
  const band = trustBand(Math.min(trustA, trustB));
  if (band === 'high') {
    return { requireBothScreenshots: false, holdSeconds: 0, forceManualReview: false };
  }
  if (band === 'standard') {
    return { requireBothScreenshots: true, holdSeconds: 60, forceManualReview: false };
  }
  return { requireBothScreenshots: true, holdSeconds: 300, forceManualReview: true };
}

/** Score deltas are advisory — they annotate the audit trail, not the score. */
export const TRUST_EVENT_DELTAS: Record<string, number> = {
  match_settled_clean: 1,
  report_accurate: 2,
  report_inaccurate: -8,
  dispute_raised: -1,
  dispute_lost: -12,
  dispute_won: 3,
  report_timeout: -5,
  match_cancelled: -3,
  strike: -15,
  manual_adjustment: 0,
};
