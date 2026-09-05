'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { BracketSlot, Tournament, TournamentEntry } from '@escrow/shared';
import { api } from '../../../lib/api';
import { formatCents, modeLabel } from '../../../lib/format';
import { useRequireSession } from '../../../components/SessionProvider';
import { AppShell } from '../../../components/AppShell';
import { Empty, SectionTitle, Spinner } from '../../../components/ui';

interface TournamentDetail {
  tournament: Tournament;
  entries: TournamentEntry[];
  bracket: BracketSlot[];
  entrants: number;
  poolCents: number;
  rakeCents: number;
  prizeCents: number;
}

export default function TournamentPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { user, loading } = useRequireSession();
  const [detail, setDetail] = useState<TournamentDetail | null>(null);

  useEffect(() => {
    if (!user) return;
    void api<TournamentDetail>(`/tournaments/${tournamentId}`).then(setDetail);
  }, [user, tournamentId]);

  if (loading || !user || !detail) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const rounds = [...new Set(detail.bracket.map((slot) => slot.round))].sort((a, b) => a - b);
  const myEntry = detail.entries.find((entry) => entry.userId === user.id);

  return (
    <AppShell>
      <h1 className="font-display text-2xl font-black">{detail.tournament.name}</h1>
      <p className="mb-4 text-sm text-slate-400">
        {modeLabel(detail.tournament.gameMode)} · {detail.entrants} entered · {detail.tournament.status}
      </p>

      <section className="card mb-4 border-volt/30">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-slate-400">Prize pool</span>
          <span className="stake">{formatCents(detail.prizeCents)}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between text-xs text-slate-500">
          <span>
            {detail.entrants} × {formatCents(detail.tournament.entryFeeCents)} entry
          </span>
          <span>rake {formatCents(detail.rakeCents)}</span>
        </div>
        {myEntry ? (
          <p className="mt-3 text-sm font-semibold text-volt">
            {myEntry.placement === 1
              ? 'You won this one.'
              : myEntry.eliminatedInRound
                ? `Knocked out in round ${myEntry.eliminatedInRound}.`
                : 'You are still in.'}
          </p>
        ) : null}
      </section>

      <SectionTitle>Bracket</SectionTitle>
      {rounds.length === 0 ? (
        <Empty title="Bracket not drawn yet" hint="It is generated when registration closes." />
      ) : (
        <div className="space-y-4">
          {rounds.map((round) => (
            <div key={round}>
              <p className="label">
                {round === Math.max(...rounds) ? 'Final' : `Round ${round}`}
              </p>
              <div className="space-y-2">
                {detail.bracket
                  .filter((slot) => slot.round === round)
                  .map((slot) => (
                    <div key={`${slot.round}-${slot.position}`} className="card py-3">
                      <SlotSide
                        userId={slot.playerAId}
                        entries={detail.entries}
                        winner={slot.winnerId === slot.playerAId}
                        me={user.id}
                      />
                      <div className="my-1 h-px bg-pitch-600" />
                      <SlotSide
                        userId={slot.playerBId}
                        entries={detail.entries}
                        winner={slot.winnerId === slot.playerBId}
                        me={user.id}
                      />
                      {slot.matchId ? (
                        <Link
                          href={`/match/${slot.matchId}`}
                          className="mt-2 block text-xs font-semibold text-volt hover:underline"
                        >
                          Open fixture →
                        </Link>
                      ) : null}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}

function SlotSide({
  userId,
  entries,
  winner,
  me,
}: {
  userId: string | null;
  entries: TournamentEntry[];
  winner: boolean;
  me: string;
}) {
  if (!userId) {
    return <p className="text-sm text-slate-600">Bye</p>;
  }
  const seed = entries.find((entry) => entry.userId === userId)?.seed;
  return (
    <p className={`flex items-center justify-between text-sm ${winner ? 'font-bold text-volt' : 'text-slate-300'}`}>
      <span>
        {seed ? <span className="mr-2 text-xs text-slate-500">#{seed}</span> : null}
        {userId === me ? 'You' : `${userId.slice(0, 8)}…`}
      </span>
      {winner ? <span className="text-xs uppercase tracking-wider">won</span> : null}
    </p>
  );
}
