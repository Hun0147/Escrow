'use client';

import { useEffect, useState } from 'react';
import { STAKE_TIERS_CENTS } from '@escrow/shared';
import type { LeaderboardRow } from '@escrow/shared';
import { api } from '../../lib/api';
import { formatCents } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Empty, Spinner, TrustBadge } from '../../components/ui';

/** Leaderboards are per stake tier — a $5 grinder and a $100 player are not
 *  playing the same game, and ranking them together would say nothing. */
export default function LeaderboardsPage() {
  const { user, loading } = useRequireSession();
  const [stake, setStake] = useState<number>(STAKE_TIERS_CENTS[2]);
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    if (!user) return;
    setRows(null);
    void api<{ rows: LeaderboardRow[] }>(`/matches/leaderboard?stakeCents=${stake}`).then((data) =>
      setRows(data.rows),
    );
  }, [user, stake]);

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-black">Leaderboards</h1>
      <p className="mb-4 text-sm text-slate-400">
        Ranked by net profit after rake, not by wins — this is what you actually took home.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {STAKE_TIERS_CENTS.map((cents) => (
          <button
            key={cents}
            onClick={() => setStake(cents)}
            className={`chip ${stake === cents ? 'chip-active' : ''}`}
          >
            {formatCents(cents)}
          </button>
        ))}
      </div>

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No settled matches at this stake yet" hint="Be the first name on the board." />
      ) : (
        <ol className="space-y-2">
          {rows.map((row, index) => (
            <li
              key={row.userId}
              className={`card flex items-center gap-3 py-3 ${row.userId === user.id ? 'border-volt/50' : ''}`}
            >
              <span className="w-6 shrink-0 text-center font-display text-lg font-black text-slate-500">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display font-bold">
                  {row.handle}
                  {row.userId === user.id ? <span className="text-slate-500"> (you)</span> : null}
                </p>
                <p className="text-xs text-slate-500">
                  {row.wins}W–{row.losses}L · {row.psnId ?? 'no PSN'}
                </p>
              </div>
              <TrustBadge score={row.trustScore} />
              <span
                className={`w-24 text-right font-display text-lg font-black tabular-nums ${
                  row.netCents >= 0 ? 'text-volt' : 'text-danger'
                }`}
              >
                {row.netCents >= 0 ? '+' : '−'}
                {formatCents(Math.abs(row.netCents))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}
