import { Subscription } from '@escrow/shared';
import { withTransaction } from '../../db/transaction';
import { UserRow, findUserById, updateUser } from '../../db/repos/users.repo';
import {
  extendSubscription,
  findDueSubscriptions,
  findLiveSubscription,
  insertSubscription,
  listSubscriptionHistory,
  lockLiveSubscription,
  setSubscriptionStatus,
} from '../../db/repos/subscriptions.repo';
import { getWallet } from '../../db/repos/ledger.repo';
import { WalletError, chargeSubscription } from '../wallet/money.service';
import { conflict, notFound } from '../../common/errors';
import { getSetting } from '../../common/settings';
import { notify } from '../notifications/notifications.service';
import { realtime } from '../../realtime/bus';

/**
 * Goal 27 Pro.
 *
 * Paid from the wallet like everything else, so it posts to the same ledger and
 * shows up in the same statement — a subscription is not a side channel for
 * money. The tier flag on `users` is a cache of "has a live subscription", kept
 * in step here and by the renewal sweep.
 */
export async function subscribe(user: UserRow): Promise<Subscription> {
  const priceCents = await getSetting('pro_subscription_cents');
  const periodDays = await getSetting('pro_subscription_days');

  const subscription = await withTransaction(async (client) => {
    const existing = await lockLiveSubscription(user.id, client);
    if (existing) {
      if (existing.status === 'cancelling') {
        // Resubscribing before the period ends just calls off the cancellation
        // — charging again for time already paid for would be theft.
        const resumed = await setSubscriptionStatus(existing.id, 'active', client);
        await updateUser(user.id, { subscriptionTier: 'pro' }, client);
        return resumed;
      }
      throw conflict('already_subscribed', 'You are already on Goal 27 Pro');
    }

    await chargeSubscription(client, user.id, priceCents, 'Goal 27 Pro subscription');
    const created = await insertSubscription({ userId: user.id, priceCents, periodDays }, client);
    await updateUser(user.id, { subscriptionTier: 'pro' }, client);
    return created;
  });

  const wallet = await getWallet(user.id);
  if (wallet) realtime.toUser(user.id, 'wallet:updated', wallet);
  await notify({
    userId: user.id,
    type: 'wallet_debited',
    title: 'Goal 27 Pro is live',
    body: `Your escrow fee drops to 7% and you take priority in the matchmaking queue until ${new Date(
      subscription.currentPeriodEnd,
    ).toLocaleDateString()}.`,
  });
  return subscription;
}

/**
 * Cancels at the end of the paid period rather than immediately: the player
 * bought that time and keeps the lower fee until it runs out.
 */
export async function cancel(user: UserRow): Promise<Subscription> {
  const live = await findLiveSubscription(user.id);
  if (!live) throw notFound('Subscription');
  if (live.status === 'cancelling') return live;
  return setSubscriptionStatus(live.id, 'cancelling');
}

export async function status(userId: string): Promise<{
  subscription: Subscription | null;
  history: Subscription[];
  priceCents: number;
  periodDays: number;
}> {
  return {
    subscription: await findLiveSubscription(userId),
    history: await listSubscriptionHistory(userId),
    priceCents: await getSetting('pro_subscription_cents'),
    periodDays: await getSetting('pro_subscription_days'),
  };
}

/**
 * Renewal sweep, run by the worker.
 *
 * A subscription that reaches the end of its period either renews (charged
 * again) or closes. A player who cannot cover the renewal is dropped to free
 * rather than pushed into a negative balance — this product must never invent
 * a debt.
 */
export async function sweepRenewals(): Promise<{ renewed: string[]; closed: string[] }> {
  const due = await findDueSubscriptions();
  const renewed: string[] = [];
  const closed: string[] = [];
  const periodDays = await getSetting('pro_subscription_days');

  for (const subscription of due) {
    if (subscription.status === 'cancelling') {
      await close(subscription, 'cancelled', 'Your Goal 27 Pro subscription has ended.');
      closed.push(subscription.id);
      continue;
    }
    try {
      await withTransaction(async (client) => {
        await chargeSubscription(
          client,
          subscription.userId,
          subscription.priceCents,
          'Goal 27 Pro renewal',
        );
        await extendSubscription(subscription.id, periodDays, client);
      });
      renewed.push(subscription.id);
      const wallet = await getWallet(subscription.userId);
      if (wallet) realtime.toUser(subscription.userId, 'wallet:updated', wallet);
    } catch (err) {
      if (!(err instanceof WalletError)) throw err;
      await close(
        subscription,
        'lapsed',
        'Goal 27 Pro lapsed: there was not enough balance to renew. Your escrow fee is back to 10%.',
      );
      closed.push(subscription.id);
    }
  }
  return { renewed, closed };
}

async function close(
  subscription: Subscription,
  status: 'cancelled' | 'lapsed',
  message: string,
): Promise<void> {
  await setSubscriptionStatus(subscription.id, status);
  const user = await findUserById(subscription.userId);
  if (user) await updateUser(user.id, { subscriptionTier: 'free' });
  await notify({
    userId: subscription.userId,
    type: 'wallet_debited',
    title: 'Goal 27 Pro ended',
    body: message,
  });
}

/** Whether a player's Pro benefits are in force right now. */
export async function isPro(userId: string): Promise<boolean> {
  const live = await findLiveSubscription(userId);
  return live !== null && new Date(live.currentPeriodEnd).getTime() > Date.now();
}
