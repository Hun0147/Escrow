import { Notification, NotificationType } from '@escrow/shared';

/**
 * What a Discord DM actually says.
 *
 * Pure formatting, so it is testable without a bot token and without the
 * network. Two rules shape every message:
 *
 * 1. Say what to do, not just what happened. A player reading this is away
 *    from the app — usually mid-game on a PS5 — so the message has to carry
 *    enough to act on.
 * 2. Never include anything that is not already the recipient's to see.
 *    These land in a third-party inbox we do not control.
 */
export interface DmContext {
  notification: Notification;
  /** Base URL of the web client, for the deep link. */
  webOrigin: string;
  /** Minutes left to report, when the notification is about a clock. */
  deadlineMinutes?: number | null;
}

const URGENT: NotificationType[] = ['result_submitted', 'dispute_opened'];

export function isUrgent(type: NotificationType): boolean {
  return URGENT.includes(type);
}

/** A stable prefix so the message reads as Goal 27 at a glance in a DM list. */
const LEAD: Partial<Record<NotificationType, string>> = {
  match_joined: '⚽ **Opponent found**',
  match_ready: '🟢 **Both players ready**',
  result_submitted: '⏱️ **Your opponent reported the result**',
  match_settled: '💸 **Match settled**',
  dispute_opened: '⚠️ **Match under review**',
  dispute_resolved: '✅ **Dispute resolved**',
  kyc_updated: '🪪 **Verification update**',
  tournament_started: '🏆 **Tournament**',
};

export function formatDm(context: DmContext): string {
  const { notification: n, webOrigin } = context;
  const lines: string[] = [];

  lines.push(`${LEAD[n.type] ?? `**${n.title}**`}`);
  if (n.title && !LEAD[n.type]) lines.push('');
  lines.push(n.body);

  // The reporting clock is the whole reason this feature exists — make the
  // deadline impossible to miss.
  if (n.type === 'result_submitted' && context.deadlineMinutes != null) {
    lines.push('');
    lines.push(
      context.deadlineMinutes > 0
        ? `You have **${context.deadlineMinutes} minute${context.deadlineMinutes === 1 ? '' : 's'}** to submit yours, or the match goes to a moderator.`
        : 'Your reporting window has closed — the match is going to a moderator.',
    );
  }

  const link = n.matchId ? `${webOrigin}/match/${n.matchId}` : `${webOrigin}/lobby`;
  lines.push('');
  lines.push(link);

  return lines.join('\n');
}

/** Discord rejects anything over 2000 characters; ours are far shorter, but a
 *  long moderator note could push a dispute message over. */
export const DISCORD_MAX_MESSAGE = 2000;

export function truncateForDiscord(content: string): string {
  if (content.length <= DISCORD_MAX_MESSAGE) return content;
  return `${content.slice(0, DISCORD_MAX_MESSAGE - 1)}…`;
}
