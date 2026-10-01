import { Notification, NotificationType } from '@escrow/shared';
import { findUserById } from '../db/repos/users.repo';
import { claimForDiscordDelivery, releaseDiscordDelivery } from '../db/repos/misc.repo';
import { findMatchById } from '../db/repos/matches.repo';
import { getSetting, loadSettings } from '../common/settings';
import { realtime } from '../realtime/bus';
import { discordClient } from './client';
import { formatDm, truncateForDiscord } from './messages';

/**
 * Sends notifications on to Discord as direct messages.
 *
 * A second subscriber to the realtime bus, alongside the Socket.io gateway.
 * Nothing in the domain services knows it exists, which is the point: if this
 * relay throws, misbehaves or is switched off entirely, settlement is
 * unaffected and the in-app notification is already persisted.
 */
export type DeliveryOutcome =
  | 'sent'
  | 'not_linked'
  | 'dms_disabled'
  | 'type_not_dm_worthy'
  | 'already_delivered'
  | 'discord_unconfigured'
  | 'failed';

async function dmWorthyTypes(): Promise<NotificationType[]> {
  const settings = await loadSettings();
  const configured = settings.discord_dm_types;
  if (!Array.isArray(configured)) return [];
  return configured as NotificationType[];
}

/**
 * Delivers one notification. Safe to call more than once for the same
 * notification — only the caller that claims it sends.
 */
export async function deliverToDiscord(notification: Notification): Promise<DeliveryOutcome> {
  const client = discordClient();
  if (client.name === 'disabled') return 'discord_unconfigured';

  const types = await dmWorthyTypes();
  if (!types.includes(notification.type)) return 'type_not_dm_worthy';

  const user = await findUserById(notification.userId);
  if (!user?.discord) return 'not_linked';
  if (!user.discord.dmEnabled) return 'dms_disabled';

  // Claim before sending. If two relays race — two API instances both
  // subscribed to the bus — exactly one wins and the player gets one message.
  const claimed = await claimForDiscordDelivery(notification.id);
  if (!claimed) return 'already_delivered';

  try {
    const content = truncateForDiscord(
      formatDm({
        notification,
        webOrigin: process.env.WEB_ORIGIN?.replace(/\/$/, '') ?? 'http://localhost:3000',
        deadlineMinutes: await minutesLeftToReport(notification),
      }),
    );
    await client.sendDirectMessage(user.discord.discordId, content);
    return 'sent';
  } catch (err) {
    // Release the claim so a later pass can retry. A failed DM must never
    // mark itself delivered — silence is worse than a duplicate here.
    await releaseDiscordDelivery(notification.id, (err as Error).message);
    console.error(`Discord DM failed for notification ${notification.id}:`, (err as Error).message);
    return 'failed';
  }
}

/** How long the recipient has left to report, for the one message where it
 *  is the entire point. */
async function minutesLeftToReport(notification: Notification): Promise<number | null> {
  if (notification.type !== 'result_submitted' || !notification.matchId) return null;
  const match = await findMatchById(notification.matchId);
  if (!match?.reportDeadlineAt) return await getSetting('result_deadline_minutes');
  const remaining = new Date(match.reportDeadlineAt).getTime() - Date.now();
  return Math.max(0, Math.round(remaining / 60_000));
}

let subscribed: ((message: { scope: any; event: string; payload: unknown }) => void) | null = null;

/**
 * Subscribes the relay to the bus. Called once at startup; a no-op if Discord
 * is not configured, so an unconfigured deployment does no work per event.
 */
export function startDiscordRelay(): () => void {
  if (subscribed) return stopDiscordRelay;

  const handler = (message: { scope: any; event: string; payload: unknown }) => {
    if (message.event !== 'notification' || message.scope?.kind !== 'user') return;
    // Fire and forget: a slow or failing Discord must not hold up the request
    // that produced the notification.
    void deliverToDiscord(message.payload as Notification).catch((err) =>
      console.error('Discord relay error:', err),
    );
  };

  realtime.on('message', handler);
  subscribed = handler;
  return stopDiscordRelay;
}

export function stopDiscordRelay(): void {
  if (!subscribed) return;
  realtime.off('message', subscribed);
  subscribed = null;
}
