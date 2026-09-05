'use client';

import { useEffect, useState } from 'react';
import type { Subscription } from '@escrow/shared';
import { ApiError, api } from '../../lib/api';
import { formatCents } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Banner, Spinner } from '../../components/ui';

const LIMIT_CHOICES = [2500, 5000, 10000, 25000, 50000];
const EXCLUSION_CHOICES = [1, 7, 30, 90, 365];

/**
 * Responsible play.
 *
 * Limits tighten immediately and never loosen on the spot; self-exclusion is
 * irreversible for its term. The copy says so plainly, because a limit a
 * player believes they can undo in the moment is not a limit.
 */
interface SubscriptionState {
  subscription: Subscription | null;
  priceCents: number;
  periodDays: number;
}

export default function SettingsPage() {
  const { user, loading, refresh } = useRequireSession();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [pro, setPro] = useState<SubscriptionState | null>(null);

  useEffect(() => {
    if (!user) return;
    void api<SubscriptionState>('/subscription').then(setPro);
  }, [user?.id]);

  async function changeSubscription(method: 'POST' | 'DELETE', message: string) {
    setError(null);
    setNotice(null);
    try {
      await api('/subscription', { method, body: method === 'POST' ? {} : undefined });
      setNotice(message);
      setPro(await api<SubscriptionState>('/subscription'));
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update your subscription');
    }
  }

  async function save(body: unknown, message: string) {
    setError(null);
    setNotice(null);
    try {
      await api('/me/responsible-play', { body });
      setNotice(message);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  }

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-black">Settings</h1>
      <p className="mb-4 text-sm text-slate-400">Controls that stay in your hands, not ours.</p>

      {error ? <div className="mb-3"><Banner tone="danger">{error}</Banner></div> : null}
      {notice ? <div className="mb-3"><Banner tone="good">{notice}</Banner></div> : null}

      <section className="card mb-3 border-volt/30">
        <div className="flex items-baseline justify-between">
          <p className="label mb-0">Goal 27 Pro</p>
          {pro ? (
            <span className="font-display text-lg font-black tabular-nums text-volt">
              {formatCents(pro.priceCents)}
              <span className="text-xs font-semibold text-slate-500">/{pro.periodDays}d</span>
            </span>
          ) : null}
        </div>
        <ul className="mt-2 space-y-1 text-sm text-slate-400">
          <li>· Escrow fee drops from 10% to 7% — on payouts and withdrawals alike</li>
          <li>· Priority in the matchmaking queue at every stake</li>
        </ul>

        {pro?.subscription ? (
          <>
            <p className="mt-3 text-sm font-semibold text-volt">
              {pro.subscription.status === 'cancelling'
                ? `Ends ${new Date(pro.subscription.currentPeriodEnd).toLocaleDateString()} — you keep Pro until then.`
                : `Renews ${new Date(pro.subscription.currentPeriodEnd).toLocaleDateString()}.`}
            </p>
            <button
              className={pro.subscription.status === 'cancelling' ? 'btn-primary mt-3 w-full' : 'btn-ghost mt-3 w-full'}
              onClick={() =>
                pro.subscription!.status === 'cancelling'
                  ? changeSubscription('POST', 'Cancellation called off — Pro continues.')
                  : changeSubscription('DELETE', 'Pro will end when the current period does.')
              }
            >
              {pro.subscription.status === 'cancelling' ? 'Resume Pro' : 'Cancel Pro'}
            </button>
          </>
        ) : (
          <button
            className="btn-primary mt-3 w-full"
            disabled={!pro}
            onClick={() => changeSubscription('POST', 'Goal 27 Pro is live.')}
          >
            {pro ? `Subscribe for ${formatCents(pro.priceCents)}` : 'Loading…'}
          </button>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Charged from your wallet balance. It renews automatically, and lapses rather than
          overdrawing you if the balance is short.
        </p>
      </section>

      <section className="card mb-3">
        <p className="label">Daily deposit limit</p>
        <p className="mb-3 text-sm text-slate-400">
          Caps what you can add in any 24 hours. Lowering it takes effect now; raising it needs a
          cool-off, so it cannot be undone in the heat of a session.
        </p>
        <div className="flex flex-wrap gap-2">
          {LIMIT_CHOICES.map((cents) => (
            <button
              key={cents}
              className="chip"
              onClick={() => save({ depositLimitDailyCents: cents }, `Deposit limit set to ${formatCents(cents)} a day.`)}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
      </section>

      <section className="card mb-3">
        <p className="label">Daily loss limit</p>
        <p className="mb-3 text-sm text-slate-400">
          Once your stakes lost plus stakes at risk today reach this, new matches are refused.
        </p>
        <div className="flex flex-wrap gap-2">
          {LIMIT_CHOICES.map((cents) => (
            <button
              key={cents}
              className="chip"
              onClick={() => save({ lossLimitDailyCents: cents }, `Loss limit set to ${formatCents(cents)} a day.`)}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
      </section>

      <section className="card mb-3">
        <p className="label">Session reminders</p>
        <p className="mb-3 text-sm text-slate-400">Nudge me after this long in one sitting.</p>
        <div className="flex flex-wrap gap-2">
          {[30, 60, 120].map((minutes) => (
            <button
              key={minutes}
              className="chip"
              onClick={() => save({ sessionReminderMinutes: minutes }, `Reminder set for every ${minutes} minutes.`)}
            >
              {minutes} min
            </button>
          ))}
        </div>
      </section>

      <section className="card mb-3">
        <p className="label">Cool-off</p>
        <p className="mb-3 text-sm text-slate-400">
          A short break. No deposits and no new matches until it ends.
        </p>
        <div className="flex flex-wrap gap-2">
          {[1, 24, 72].map((hours) => (
            <button
              key={hours}
              className="chip"
              onClick={async () => {
                await api('/me/cool-off', { body: { hours } });
                setNotice(`Cool-off started for ${hours} hour${hours === 1 ? '' : 's'}.`);
                await refresh();
              }}
            >
              {hours}h
            </button>
          ))}
        </div>
        {user.selfExcludedUntil ? (
          <p className="mt-3 text-sm font-semibold text-warn">
            Self-excluded until {new Date(user.selfExcludedUntil).toLocaleDateString()}.
          </p>
        ) : null}
      </section>

      <section className="card border-danger/40">
        <p className="label">Self-exclusion</p>
        <p className="mb-3 text-sm text-slate-400">
          Locks your account out of deposits and matches for the whole period. This cannot be lifted
          early — not by you, not by support.
        </p>
        <div className="flex flex-wrap gap-2">
          {EXCLUSION_CHOICES.map((days) => (
            <button
              key={days}
              className={`chip ${confirming === days ? 'border-danger text-danger' : ''}`}
              onClick={async () => {
                if (confirming !== days) {
                  setConfirming(days);
                  return;
                }
                await api('/me/self-exclude', { body: { days } });
                setConfirming(null);
                setNotice(`Self-excluded for ${days} day${days === 1 ? '' : 's'}.`);
                await refresh();
              }}
            >
              {confirming === days ? `Confirm ${days}d` : `${days} day${days === 1 ? '' : 's'}`}
            </button>
          ))}
        </div>
      </section>

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Paid skill competitions are regulated differently in different places. Goal 27 checks your
        region at signup and again against your verified address, and blocks play where entry-fee
        contests are restricted.
      </p>
    </AppShell>
  );
}
