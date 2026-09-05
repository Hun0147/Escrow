import { Notification, NotificationType } from '@escrow/shared';
import { insertNotification, listNotifications, markNotificationsRead } from '../../db/repos/misc.repo';
import { realtime } from '../../realtime/bus';

export interface NotifyParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  matchId?: string | null;
}

/**
 * Persists a notification and pushes it live.
 *
 * Persist-then-push, in that order: a player who was offline when their match
 * settled still sees it next time they open the app.
 */
export async function notify(params: NotifyParams): Promise<Notification> {
  const notification = await insertNotification(params);
  realtime.toUser(params.userId, 'notification', notification);
  return notification;
}

export async function listForUser(userId: string, limit = 50): Promise<Notification[]> {
  return listNotifications(userId, limit);
}

export async function markAllRead(userId: string): Promise<void> {
  await markNotificationsRead(userId);
}
