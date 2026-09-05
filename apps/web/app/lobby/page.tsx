'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { GAME_MODES, STAKE_TIERS_CENTS, describeRules } from '@escrow/shared';
import type { GameMode, Match } from '@escrow/shared';
import { ApiError, api } from '../../lib/api';
import { formatCents, modeLabel, MATCH_STATUS_LABELS, MATCH_STATUS_TONE, relativeTime } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Banner, Empty, SectionTitle, Spinner, StakePill, TrustBadge } from '../../components/ui';

interface LobbyEntry {
  match: Match;
  creatorHandle: string;
  creatorPsnId: string | null;
  creatorTrustScore: number;
  creatorSkillTier: string;
  creatorWins: number;
  creatorLosses: number;
}

const LIVE_STATUSES = new Set(['open', 'escrowed', 'in_progress', 'awaiting_results', 'disputed']);

export default function LobbyPage() {
  const { user, loading, socket } = useRequireSession();
  const [entries, setEntries] = useState<LobbyEntry[]>([]);
  const [mine, setMine] = useState<Match[]>([]);
  const [stake, setStake] = useState<number | null>(null);
  const [mode, setMode] = useState<GameMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(true);

  const load = useCallback(async () => {
    const query = new URLSearchParams();
    if (stake) query.set('stakeCents', String(stake));
    if (mode) query.set('gameMode', mode);
    const [lobby, own] = await Promise.all([
      api<{ matches: LobbyEntry[] }>(`/matches?${query.toString()}`),
      api<{ matches: Match[] }>('/matches/mine'),
    ]);
    setEntries(lobby.matches);
    setMine(own.matches.filter((match) => LIVE_STATUSES.has(match.status)));
    setFetching(false);
  }, [stake, mode]);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  // The lobby is live: a match someone else creates or fills appears or
  // disappears without a refresh.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => void load();
    socket.on('lobby:match_created', refresh);
    socket.on('lobby:match_removed', refresh);
    return () => {
      socket.off('lobby:match_created', refresh);
      socket.off('lobby:match_removed', refresh);
    };
  }, [socket, load]);

  async function join(matchId: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/matches/${matchId}/join`, { body: {} });
      window.location.href = `/match/${matchId}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const blocked = !user.emailVerified || !user.psnId;

  return (
    <AppShell>
      {blocked ? (
        <div className="mb-4">
          <Banner tone="warn">
            Verify your email and link your PSN ID before you can stake.{' '}
            <Link href="/onboarding" className="font-semibold underline">
              Finish setup
            </Link>
          </Banner>
        </div>
      ) : null}

      {mine.length > 0 ? (
        <section className="mb-6">
          <SectionTitle>Your live matches</SectionTitle>
          <div className="space-y-2">
            {mine.map((match) => (
              <Link key={match.id} href={`/match/${match.id}`} className="card flex items-center justify-between hover:border-volt/50">
                <div>
                  <p className={`text-xs font-bold uppercase tracking-wider ${MATCH_STATUS_TONE[match.status]}`}>
                    {MATCH_STATUS_LABELS[match.status]}
                  </p>
                  <p className="text-sm text-slate-300">{modeLabel(match.gameMode)}</p>
                  <p className="text-xs text-slate-500">{describeRules(match.rules)}</p>
                </div>
                <StakePill cents={match.stakeCents} label="stake" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mb-4 flex gap-2">
        <Link href="/lobby/new" className="btn-primary flex-1">
          Create match
        </Link>
        <button
          className="btn-ghost flex-1"
          disabled={blocked || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await api<{ status: string; match?: Match }>('/matches/quick', {
                body: { gameMode: mode ?? 'ultimate_team', stakeCents: stake ?? 1000 },
              });
              if (result.status === 'matched' && result.match) {
                window.location.href = `/match/${result.match.id}`;
              } else {
                setError('You are in the queue — you will be paired as soon as someone matches your filters.');
              }
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Could not queue');
            } finally {
              setBusy(false);
            }
          }}
        >
          Quick match
        </button>
      </div>

      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap gap-2">
          <button className={`chip ${stake === null ? 'chip-active' : ''}`} onClick={() => setStake(null)}>
            Any stake
          </button>
          {STAKE_TIERS_CENTS.map((cents) => (
            <button
              key={cents}
              className={`chip ${stake === cents ? 'chip-active' : ''}`}
              onClick={() => setStake(cents)}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={`chip ${mode === null ? 'chip-active' : ''}`} onClick={() => setMode(null)}>
            All modes
          </button>
          {GAME_MODES.map((option) => (
            <button
              key={option}
              className={`chip ${mode === option ? 'chip-active' : ''}`}
              onClick={() => setMode(option)}
            >
              {modeLabel(option)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="mb-3">
          <Banner tone="info">{error}</Banner>
        </div>
      ) : null}

      <SectionTitle>Open matches</SectionTitle>

      {fetching ? (
        <Spinner label="Loading the lobby" />
      ) : entries.length === 0 ? (
        <Empty
          title="Nothing at these filters"
          hint="Create a match at your stake and someone will pick it up, or widen the filters."
          action={
            <Link href="/lobby/new" className="btn-primary">
              Create match
            </Link>
          }
        />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <article key={entry.match.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-display font-bold">{entry.creatorHandle}</p>
                    <TrustBadge score={entry.creatorTrustScore} />
                  </div>
                  <p className="text-xs text-slate-500">
                    {entry.creatorWins}W–{entry.creatorLosses}L · {entry.creatorSkillTier.replace('_', '-')} ·{' '}
                    {relativeTime(entry.match.createdAt)}
                  </p>
                  <p className="mt-2 text-sm text-slate-300">{modeLabel(entry.match.gameMode)}</p>
                  <p className="text-xs text-slate-500">{describeRules(entry.match.rules)}</p>
                </div>
                <StakePill cents={entry.match.stakeCents} label="each" />
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">
                  Winner takes {formatCents(entry.match.stakeCents * 2 - Math.round((entry.match.stakeCents * 2 * entry.match.escrowFeeBps) / 10000))}
                </p>
                <button className="btn-primary" disabled={blocked || busy} onClick={() => join(entry.match.id)}>
                  Join for {formatCents(entry.match.stakeCents)}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
