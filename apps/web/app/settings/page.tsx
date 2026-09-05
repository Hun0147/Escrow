'use client';

import { useState } from 'react';
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
export default function SettingsPage() {
  const { user, loading, refresh } = useRequireSession();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

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
