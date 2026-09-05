import { GameMode, Match, isStakeTier } from '@escrow/shared';
import { UserRow, findUserById } from '../../db/repos/users.repo';
import { matchmakingQueue } from '../../queue/matchmaking';
import { badRequest, notFound } from '../../common/errors';
import { createMatch, joinMatch } from '../matches/matches.service';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';

export interface QuickMatchInput {
  stakeCents: number;
  gameMode: GameMode;
}

export type QuickMatchResult =
  | { status: 'queued'; position: number }
  | { status: 'matched'; match: Match };

/**
 * Quick match: pair with whoever has been waiting longest at the same stake
 * and mode, or take a place in the queue.
 *
 * The pairing is turned into a normal match — created by the waiting player,
 * joined by the arriving one — so it inherits every escrow, anti-fraud and
 * settlement rule of the manual lobby flow rather than being a second path
 * to the same money.
 */
export async function quickMatch(user: UserRow, input: QuickMatchInput): Promise<QuickMatchResult> {
  if (!isStakeTier(input.stakeCents)) {
    throw badRequest('invalid_stake', 'Stake must be one of the offered tiers');
  }
  const queue = await matchmakingQueue();
  const ticket = {
    userId: user.id,
    stakeCents: input.stakeCents,
    gameMode: input.gameMode,
    skillTier: user.skillTier,
    enqueuedAt: Date.now(),
  };

  const opponentTicket = await queue.takeOpponent(ticket);
  if (!opponentTicket) {
    await queue.enqueue(ticket);
    return { status: 'queued', position: await queue.size() };
  }

  const waiting = await findUserById(opponentTicket.userId);
  if (!waiting) throw notFound('Queued opponent');

  let match: Match;
  try {
    match = await createMatch(waiting, {
      gameMode: input.gameMode,
      stakeCents: input.stakeCents,
    });
  } catch (err) {
    // The waiting player can no longer cover the stake (or has since become
    // ineligible). Drop their ticket and put the arriving player in the queue
    // rather than failing their request.
    await queue.remove(opponentTicket.userId);
    await queue.enqueue(ticket);
    return { status: 'queued', position: await queue.size() };
  }

  const joined = await joinMatch(user, match.id);
  await queue.remove(user.id);

  await notify({
    userId: waiting.id,
    matchId: joined.id,
    type: 'match_joined',
    title: 'Quick match found',
    body: `You are up against ${user.handle}.`,
  });
  realtime.toUser(waiting.id, 'matchmaking:matched', { matchId: joined.id });
  return { status: 'matched', match: joined };
}

export async function leaveQueue(userId: string): Promise<void> {
  const queue = await matchmakingQueue();
  await queue.remove(userId);
}
