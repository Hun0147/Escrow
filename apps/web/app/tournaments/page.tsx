'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Tournament } from '@escrow/shared';
import { ApiError, api } from '../../lib/api';
import { formatCents, modeLabel } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Banner, Empty, Spinner } from '../../components/ui';

interface TournamentCard {
  tournament: Tournament;
  entrants: number;
  poolCents: number;
  rakeCents: number;
  prizeCents: number;
}

export default function TournamentsPage() {
  const { user, loading, refresh } = useRequireSession();
  const [cards, setCards] = useState<TournamentCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ tournaments: TournamentCard[] }>('/tournaments');
    setCards(data.tournaments);
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-black">Tournaments</h1>
      <p className="mb-4 text-sm text-slate-400">
        Single elimination. Your entry fee is escrowed on registration and the whole pool pays out
        when the bracket finishes.
      </p>

      {error ? <div className="mb-3"><Banner tone="danger">{error}</Banner></div> : null}
      {notice ? <div className="mb-3"><Banner tone="good">{notice}</Banner></div> : null}

      {cards === null ? (
        <Spinner />
      ) : cards.length === 0 ? (
        <Empty title="No tournaments scheduled" hint="Sponsored cups and weekend brackets appear here." />
      ) : (
        <div className="space-y-3">
          {cards.map((card) => (
            <article key={card.tournament.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/tournaments/${card.tournament.id}`} className="font-display text-lg font-bold hover:text-volt">
                    {card.tournament.name}
                  </Link>
                  {card.tournament.sponsorName ? (
                    <p className="text-xs font-semibold uppercase tracking-wider text-cyanline">
                      Sponsored by {card.tournament.sponsorName}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-slate-500">
                    {modeLabel(card.tournament.gameMode)} · {card.entrants}/{card.tournament.maxEntrants} entered ·{' '}
                    {card.tournament.status}
                  </p>
                </div>
                <div className="text-right">
                  <div className="stake">{formatCents(card.prizeCents)}</div>
                  <div className="text-[11px] uppercase tracking-wider text-slate-500">prize pool</div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-sm text-slate-400">
                  Entry {formatCents(card.tournament.entryFeeCents)}
                </span>
                {card.tournament.status === 'registering' ? (
                  <button
                    className="btn-primary"
                    onClick={async () => {
                      setError(null);
                      setNotice(null);
                      try {
                        await api(`/tournaments/${card.tournament.id}/enter`, { body: {} });
                        setNotice(`You are in ${card.tournament.name}.`);
                        await Promise.all([refresh(), load()]);
                      } catch (err) {
                        setError(err instanceof ApiError ? err.message : 'Could not enter');
                      }
                    }}
                  >
                    Enter
                  </button>
                ) : (
                  <Link href={`/tournaments/${card.tournament.id}`} className="btn-ghost">
                    View bracket
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
