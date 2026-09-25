import { TRUST_EVENT_DELTAS, TrustEvent, TrustEventType, computeTrustScore } from '@escrow/shared';
import { insertTrustEvent, listTrustEvents, tallyTrustEvents } from '../../db/repos/misc.repo';
import { findUserById, updateUser } from '../../db/repos/users.repo';
import { notFound } from '../../common/errors';
import { realtime } from '../../realtime/bus';

export interface TrustEventInput {
  userId: string;
  type: TrustEventType;
  matchId?: string | null;
  note?: string | null;
  delta?: number;
}

export async function recordTrustEvent(input: TrustEventInput): Promise<TrustEvent> {
  const delta = input.delta ?? TRUST_EVENT_DELTAS[input.type] ?? 0;
  return insertTrustEvent({
    userId: input.userId,
    type: input.type,
    matchId: input.matchId ?? null,
    delta,
    note: input.note ?? null,
  });
}

/**
 * Recomputes the score from the event log rather than nudging a counter, so a
 * missed or double-written event can be corrected by replaying, and the number
 * on a player's profile is always explainable from the events beneath it.
 */
export async function recomputeTrustScore(userId: string): Promise<number> {
  const user = await findUserById(userId);
  if (!user) throw notFound('User');

  const tally = await tallyTrustEvents(userId);
  const score = computeTrustScore({ ...tally, strikes: user.strikes });

  if (score !== user.trustScore) {
    await updateUser(userId, { trustScore: score });
    realtime.toUser(userId, 'trust:updated', { trustScore: score });
  }
  return score;
}

export async function history(userId: string, limit = 50): Promise<TrustEvent[]> {
  return listTrustEvents(userId, limit);
}

/** A strike is a moderator judgement, so it moves the score immediately. */
export async function addStrike(userId: string, note: string): Promise<number> {
  const user = await findUserById(userId);
  if (!user) throw notFound('User');
  await updateUser(userId, { strikes: user.strikes + 1 });
  await recordTrustEvent({ userId, type: 'strike', note });
  return recomputeTrustScore(userId);
}
