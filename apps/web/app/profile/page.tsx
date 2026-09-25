'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Match, TrustEvent } from '@escrow/shared';
import { api } from '../../lib/api';
import { formatCents, MATCH_STATUS_LABELS, MATCH_STATUS_TONE, modeLabel, relativeTime } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Empty, SectionTitle, Spinner, TrustBadge } from '../../components/ui';

const TRUST_LABEL: Record<string, string> = {
  match_settled_clean: 'Match settled cleanly',
  report_accurate: 'Report agreed with your opponent',
  report_inaccurate: 'Report contradicted by a ruling',
  dispute_raised: 'Dispute opened',
  dispute_lost: 'Dispute ruled against you',
  dispute_won: 'Dispute ruled in your favour',
  report_timeout: 'Missed the reporting deadline',
  match_cancelled: 'Left a match after escrow',
  strike: 'Moderator strike',
  manual_adjustment: 'Manual adjustment',
};

export default function ProfilePage() {
  const { user, loading, notifications, signOut, refresh } = useRequireSession();
  const [events, setEvents] = useState<TrustEvent[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);

  useEffect(() => {
    if (!user) return;
    void api<{ events: TrustEvent[] }>('/me/trust').then((data) => setEvents(data.events));
    void api<{ matches: Match[] }>('/matches/mine').then((data) => setMatches(data.matches));
    // Opening this screen is what clears the bell.
    void api('/me/notifications/read', { body: {} })
      .then(() => refresh())
      .catch(() => undefined);
  }, [user?.id]);

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const played = user.wins + user.losses + user.draws;
  const winRate = played === 0 ? 0 : Math.round((user.wins / played) * 100);

  return (
    <AppShell>
      <section className="card mb-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-black">{user.handle}</h1>
            <p className="text-sm text-slate-400">{user.psnId ?? 'No PSN linked'}</p>
            <p className="text-xs capitalize text-slate-500">
              {user.skillTier.replace('_', '-')} · {user.subscriptionTier} · {user.countryCode}
            </p>
          </div>
          <div className="text-right">
            <TrustBadge score={user.trustScore} size="lg" />
            <p className="text-[11px] uppercase tracking-wider text-slate-500">trust</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          <Stat label="Won" value={user.wins} tone="text-volt" />
          <Stat label="Lost" value={user.losses} />
          <Stat label="Drawn" value={user.draws} />
          <Stat label="Win %" value={winRate} />
        </div>

        {user.strikes > 0 ? (
          <p className="mt-3 text-sm font-semibold text-danger">
            {user.strikes} strike{user.strikes === 1 ? '' : 's'} on this account.
          </p>
        ) : null}
      </section>

      <div className="mb-4 grid grid-cols-2 gap-2">
        <Link href="/settings" className="btn-ghost">
          Settings
        </Link>
        <button className="btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </div>

      {notifications.length > 0 ? (
        <section className="mb-4">
          <SectionTitle>Recent activity</SectionTitle>
          <ul className="space-y-2">
            {notifications.slice(0, 6).map((notification) => (
              <li key={notification.id} className="card py-3">
                <p className="text-sm font-semibold">{notification.title}</p>
                <p className="text-xs text-slate-400">{notification.body}</p>
                <p className="mt-1 text-[11px] text-slate-500">{relativeTime(notification.createdAt)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <SectionTitle>Match history</SectionTitle>
      {matches.length === 0 ? (
        <Empty title="No matches yet" hint="Your record starts with your first stake." />
      ) : (
        <ul className="mb-4 space-y-2">
          {matches.slice(0, 15).map((match) => (
            <li key={match.id}>
              <Link href={`/match/${match.id}`} className="card flex items-center justify-between py-3 hover:border-volt/50">
                <div className="min-w-0">
                  <p className={`text-xs font-bold uppercase tracking-wider ${MATCH_STATUS_TONE[match.status]}`}>
                    {MATCH_STATUS_LABELS[match.status]}
                  </p>
                  <p className="truncate text-sm text-slate-300">{modeLabel(match.gameMode)}</p>
                  <p className="text-xs text-slate-500">{relativeTime(match.createdAt)}</p>
                </div>
                <div className="text-right">
                  {match.creatorScore !== null ? (
                    <p className="font-display text-lg font-black tabular-nums">
                      {match.creatorScore}–{match.opponentScore}
                    </p>
                  ) : null}
                  <p
                    className={`text-sm font-bold tabular-nums ${
                      match.winnerId === user.id ? 'text-volt' : 'text-slate-400'
                    }`}
                  >
                    {formatCents(match.stakeCents)}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Why your trust score is what it is</SectionTitle>
      {events.length === 0 ? (
        <Empty title="No trust events yet" hint="Reporting honestly and settling cleanly builds it up." />
      ) : (
        <ul className="space-y-2">
          {events.slice(0, 12).map((event) => (
            <li key={event.id} className="card flex items-center justify-between py-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{TRUST_LABEL[event.type] ?? event.type}</p>
                <p className="text-xs text-slate-500">{relativeTime(event.createdAt)}</p>
              </div>
              <span
                className={`font-display text-sm font-black tabular-nums ${
                  event.delta >= 0 ? 'text-volt' : 'text-danger'
                }`}
              >
                {event.delta >= 0 ? '+' : ''}
                {event.delta}
              </span>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

function Stat({ label, value, tone = 'text-slate-100' }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl bg-pitch-900/60 py-2">
      <p className={`font-display text-xl font-black tabular-nums ${tone}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
    </div>
  );
}
