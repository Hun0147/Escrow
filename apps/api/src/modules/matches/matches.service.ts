import {
  ChatMessage,
  GameMode,
  Match,
  MatchRules,
  PublicUser,
  isStakeTier,
  normaliseRules,
  settlementPolicyFor,
} from '@escrow/shared';
import { withTransaction } from '../../db/transaction';
import {
  LobbyEntry,
  LobbyFilters,
  insertMatch,
  listMatchesForUser,
  listOpenMatches,
  listResults,
  lockMatch,
  findMatchById,
  updateMatch,
} from '../../db/repos/matches.repo';
import { UserRow, findUserById, toPublicUser } from '../../db/repos/users.repo';
import { getWallet } from '../../db/repos/ledger.repo';
import {
  insertChatMessage,
  listChatMessages,
  listScreenshotsForMatch,
  findDisputeByMatch,
} from '../../db/repos/misc.repo';
import { assessAccountLink, raiseFraudFlag } from '../../db/repos/fraud.repo';
import { lockStake, refundSingleStake } from '../wallet/money.service';
import { assertWithinLossLimit } from '../wallet/wallet.service';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { getSetting } from '../../common/settings';
import { escrowFeeBpsFor } from '../../common/fees';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';
import { settleMatch } from '../settlement/settlement.service';
import { isPro } from '../subscriptions/subscriptions.service';
import { recordTrustEvent, recomputeTrustScore } from '../trust/trust.service';

export interface CreateMatchInput {
  gameMode: GameMode;
  stakeCents: number;
  rules?: Partial<MatchRules>;
  game?: string;
}

/**
 * Creating a match escrows the creator's stake immediately.
 *
 * That is the whole point of the lobby being trustworthy: every open match a
 * player sees is already backed by real money, so joining one cannot be met
 * with "sorry, my balance was spent".
 */
export async function createMatch(user: UserRow, input: CreateMatchInput): Promise<Match> {
  assertCanStake(user);
  if (!isStakeTier(input.stakeCents)) {
    throw badRequest('invalid_stake', 'Stake must be one of the offered tiers');
  }
  const rules = normaliseRules(input.rules);
  await assertWithinLossLimit(user.id, input.stakeCents);

  // Read the live subscription rather than the cached tier flag, so a lapsed
  // subscription cannot keep earning the discount until the renewal sweep runs.
  const escrowFeeBps = await escrowFeeBpsFor(await isPro(user.id));

  const match = await withTransaction(async (client) => {
    const created = await insertMatch(
      {
        creatorId: user.id,
        game: input.game ?? 'EA Sports FC 26',
        gameMode: input.gameMode,
        stakeCents: input.stakeCents,
        escrowFeeBps,
        rules,
      },
      client,
    );
    await lockStake(client, user.id, created.id, created.stakeCents);
    return created;
  });

  const wallet = await getWallet(user.id);
  if (wallet) realtime.toUser(user.id, 'wallet:updated', wallet);
  realtime.toLobby('lobby:match_created', await decorate(match));
  return match;
}

/**
 * Joining escrows the opponent's stake. From this point both stakes are held
 * and neither player can unilaterally walk away with the money.
 */
export async function joinMatch(user: UserRow, matchId: string): Promise<Match> {
  assertCanStake(user);

  const target = await findMatchById(matchId);
  if (!target) throw notFound('Match');
  if (target.creatorId === user.id) {
    throw badRequest('self_match', 'You cannot join your own match');
  }

  // Self-matching between linked accounts turns the platform into a money
  // mover: lose on purpose, and the only cost is the fee. The check runs
  // before the money transaction so the flag survives the rejection — rolling
  // it back with the failed join would erase the evidence.
  const link = await assessAccountLink(user.id, target.creatorId);
  if (link.blocking.length > 0) {
    await raiseFraudFlag({
      userId: user.id,
      relatedUserId: target.creatorId,
      kind: 'self_match_attempt',
      detail: `Blocked join on match ${target.id}: ${link.blocking.join(', ')}`,
    });
    throw forbidden(
      'linked_accounts',
      'You cannot play an account that shares a device or payment method with yours',
    );
  }
  if (link.reasons.length > 0) {
    // A weaker signal — shared network only. Let the match happen, but put it
    // in front of a human, because two accounts on one address playing each
    // other repeatedly is exactly what collusion looks like.
    await raiseFraudFlag({
      userId: user.id,
      relatedUserId: target.creatorId,
      kind: 'weak_account_link',
      detail: `Joined match ${target.id} despite: ${link.reasons.join(', ')}`,
    });
  }

  const match = await withTransaction(async (client) => {
    const locked = await lockMatch(matchId, client);
    if (!locked) throw notFound('Match');
    if (locked.status !== 'open') throw conflict('match_not_open', 'This match is no longer open');
    if (locked.creatorId === user.id) {
      throw badRequest('self_match', 'You cannot join your own match');
    }
    if (locked.opponentId) throw conflict('match_full', 'This match already has an opponent');

    await assertWithinLossLimit(user.id, locked.stakeCents);
    await lockStake(client, user.id, locked.id, locked.stakeCents);

    // The Pro discount applies if either player subscribes, so the rate can
    // only be settled once both are known.
    const escrowFeeBps = await escrowFeeBpsFor(
      (await isPro(locked.creatorId)) || (await isPro(user.id)),
    );
    await client.query('UPDATE matches SET escrow_fee_bps = $2 WHERE id = $1', [
      locked.id,
      escrowFeeBps,
    ]);

    return updateMatch(
      locked.id,
      { opponentId: user.id, status: 'escrowed', escrowStatus: 'funded' },
      client,
    );
  });

  const wallet = await getWallet(user.id);
  if (wallet) realtime.toUser(user.id, 'wallet:updated', wallet);

  await notify({
    userId: match.creatorId,
    matchId: match.id,
    type: 'match_joined',
    title: 'Opponent found',
    body: `${user.handle} joined your ${match.stakeCents} cent match.`,
  });
  realtime.toMatch(match.id, 'match:updated', await detail(match.id));
  realtime.toLobby('lobby:match_removed', { matchId: match.id });
  return match;
}

/** Ready toggles. When both players are ready the clock starts. */
export async function setReady(user: UserRow, matchId: string, ready: boolean): Promise<Match> {
  const match = await withTransaction(async (client) => {
    const locked = await lockMatch(matchId, client);
    if (!locked) throw notFound('Match');
    assertParticipant(locked, user.id);
    if (locked.status !== 'escrowed' && locked.status !== 'in_progress') {
      throw conflict('bad_state', 'Ready state can only change before kick-off');
    }

    const isCreator = locked.creatorId === user.id;
    const creatorReady = isCreator ? ready : locked.creatorReady;
    const opponentReady = isCreator ? locked.opponentReady : ready;
    const bothReady = creatorReady && opponentReady;

    return updateMatch(
      locked.id,
      {
        creatorReady,
        opponentReady,
        status: bothReady ? 'in_progress' : 'escrowed',
        startedAt: bothReady ? (locked.startedAt ?? new Date().toISOString()) : null,
      },
      client,
    );
  });

  realtime.toMatch(match.id, 'match:ready_state', {
    matchId: match.id,
    creatorReady: match.creatorReady,
    opponentReady: match.opponentReady,
    status: match.status,
    startedAt: match.startedAt,
  });

  if (match.status === 'in_progress') {
    const countdown = await getSetting('match_start_countdown_seconds');
    realtime.toMatch(match.id, 'match:countdown', { matchId: match.id, seconds: countdown });
    for (const userId of participantsOf(match)) {
      await notify({
        userId,
        matchId: match.id,
        type: 'match_ready',
        title: 'Both players ready',
        body: 'Kick off on PS5 now. Report the result when you finish.',
      });
    }
  }
  return match;
}

/** Only an unjoined match can be withdrawn; the creator gets their stake back. */
export async function cancelOpenMatch(user: UserRow, matchId: string): Promise<Match> {
  const match = await withTransaction(async (client) => {
    const locked = await lockMatch(matchId, client);
    if (!locked) throw notFound('Match');
    if (locked.creatorId !== user.id) throw forbidden('not_creator', 'Only the creator can cancel');
    if (locked.status !== 'open') {
      throw conflict('match_not_open', 'Once an opponent has staked, the match can only be played, forfeited or disputed');
    }
    await refundSingleStake(client, locked.id, locked.creatorId, locked.stakeCents);
    return updateMatch(
      locked.id,
      { status: 'cancelled', escrowStatus: 'refunded', settledAt: new Date().toISOString() },
      client,
    );
  });

  const wallet = await getWallet(user.id);
  if (wallet) realtime.toUser(user.id, 'wallet:updated', wallet);
  realtime.toLobby('lobby:match_removed', { matchId: match.id });
  return match;
}

/**
 * Conceding. The opponent is paid as if they had won, and the forfeiting
 * player takes the trust hit — this is the honest exit from a match you can't
 * or won't play, and it is much cheaper for everyone than a dispute.
 */
export async function forfeitMatch(user: UserRow, matchId: string): Promise<Match> {
  const match = await findMatchById(matchId);
  if (!match) throw notFound('Match');
  assertParticipant(match, user.id);
  if (!['escrowed', 'in_progress', 'awaiting_results'].includes(match.status)) {
    throw conflict('bad_state', 'This match cannot be forfeited');
  }

  const outcome = match.creatorId === user.id ? 'opponent_win' : 'creator_win';
  const result = await settleMatch({
    matchId,
    outcome,
    creatorScore: null,
    opponentScore: null,
    source: 'forfeit',
  });
  await recordTrustEvent({
    userId: user.id,
    type: 'match_cancelled',
    matchId,
    note: 'Forfeited after escrow',
  });
  await recomputeTrustScore(user.id);
  return result.match;
}

// -------------------------------------------------------------------- views

export interface MatchDetail {
  match: Match;
  creator: PublicUser;
  opponent: PublicUser | null;
  results: Awaited<ReturnType<typeof listResults>>;
  screenshots: Awaited<ReturnType<typeof listScreenshotsForMatch>>;
  disputeId: string | null;
  policy: ReturnType<typeof settlementPolicyFor>;
}

export async function detail(matchId: string): Promise<MatchDetail> {
  const match = await findMatchById(matchId);
  if (!match) throw notFound('Match');
  const creator = await findUserById(match.creatorId);
  if (!creator) throw notFound('Creator');
  const opponent = match.opponentId ? await findUserById(match.opponentId) : null;
  const dispute = await findDisputeByMatch(matchId);

  return {
    match,
    creator: toPublicUser(creator),
    opponent: opponent ? toPublicUser(opponent) : null,
    results: await listResults(matchId),
    screenshots: await listScreenshotsForMatch(matchId),
    disputeId: dispute?.id ?? null,
    policy: settlementPolicyFor(creator.trustScore, opponent?.trustScore ?? creator.trustScore),
  };
}

export async function lobby(filters: LobbyFilters): Promise<LobbyEntry[]> {
  return listOpenMatches(filters);
}

export async function myMatches(userId: string): Promise<Match[]> {
  return listMatchesForUser(userId);
}

async function decorate(match: Match): Promise<LobbyEntry> {
  const creator = await findUserById(match.creatorId);
  return {
    match,
    creatorHandle: creator?.handle ?? '',
    creatorPsnId: creator?.psnId ?? null,
    creatorTrustScore: creator?.trustScore ?? 0,
    creatorSkillTier: creator?.skillTier ?? 'rookie',
    creatorWins: creator?.wins ?? 0,
    creatorLosses: creator?.losses ?? 0,
  };
}

// --------------------------------------------------------------------- chat

export async function postChatMessage(
  user: UserRow,
  matchId: string,
  body: string,
): Promise<ChatMessage> {
  const match = await findMatchById(matchId);
  if (!match) throw notFound('Match');
  assertParticipant(match, user.id);
  const trimmed = body.trim();
  if (!trimmed) throw badRequest('empty_message', 'Message cannot be empty');
  if (trimmed.length > 500) throw badRequest('message_too_long', 'Messages are capped at 500 characters');

  const message = await insertChatMessage({ matchId, userId: user.id, body: trimmed });
  realtime.toMatch(matchId, 'chat:message', message);
  return message;
}

export async function chatHistory(user: UserRow, matchId: string): Promise<ChatMessage[]> {
  const match = await findMatchById(matchId);
  if (!match) throw notFound('Match');
  // Moderators need the chat log to rule on a dispute.
  if (user.role === 'player') assertParticipant(match, user.id);
  return listChatMessages(matchId);
}

// --------------------------------------------------------------------- guards

export function participantsOf(match: Match): string[] {
  return [match.creatorId, match.opponentId].filter(Boolean) as string[];
}

export function assertParticipant(match: Match, userId: string): void {
  if (match.creatorId !== userId && match.opponentId !== userId) {
    throw forbidden('not_a_participant', 'You are not in this match');
  }
}

function assertCanStake(user: UserRow): void {
  if (!user.emailVerified) {
    throw forbidden('email_unverified', 'Verify your email before staking money');
  }
  if (!user.psnId) {
    throw forbidden('psn_required', 'Link your PSN ID before staking money');
  }
}
