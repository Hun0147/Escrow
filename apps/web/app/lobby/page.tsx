'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { GAME_MODES, STAKE_TIERS_CENTS, describeRules } from '@escrow/shared';
import type { GameMode, Match } from '@escrow/shared';
import { ApiError, api } from '../../lib/api';
import { formatCents, modeLabel, MATCH_STATUS_LABELS, MATCH_STATUS_TONE, relativeTime } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { InstallApp } from '../../components/InstallApp';
import { Banner, Empty, SectionTitle, SkeletonRows, Spinner, StakePill, TrustBadge } from '../../components/ui';

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

/** Which pill a live match wears, by what its state means for the money. */
const LIVE_PILL: Record<string, string> = {
  open: 'pill-wait',
  escrowed: 'pill-live',
  awaiting_results: 'pill-live',
  disputed: 'pill-alert',
  settled: 'pill-done',
  voided: 'pill-done',
  cancelled: 'pill-done',
};

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

      <InstallApp />

      {mine.length > 0 ? (
        <section className="mb-6">
          <SectionTitle>Your live matches</SectionTitle>
          <div className="space-y-2">
            {mine.map((match) => (
              <Link key={match.id} href={`/match/${match.id}`} className="card-interactive block">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <span className={`${LIVE_PILL[match.status] ?? 'pill-done'}`}>
                      {match.status === 'escrowed' || match.status === 'awaiting_results' ? (
                        <span className="dot-live" />
                      ) : null}
                      {MATCH_STATUS_LABELS[match.status]}
                    </span>
                    <p className="mt-2 font-display text-base font-black tracking-tight">
                      {modeLabel(match.gameMode)}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">
                      {describeRules(match.rules)}
                    </p>
                  </div>
                  <StakePill cents={match.stakeCents} label="stake" />
                </div>
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

      {/* Filters scroll sideways rather than wrapping onto three rows and
          pushing the actual matches off the screen. */}
      <div className="mb-3 space-y-2">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button className={`chip shrink-0 ${stake === null ? 'chip-active' : ''}`} onClick={() => setStake(null)}>
            Any stake
          </button>
          {STAKE_TIERS_CENTS.map((cents) => (
            <button
              key={cents}
              className={`chip shrink-0 ${stake === cents ? 'chip-active' : ''}`}
              onClick={() => setStake(cents)}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button className={`chip shrink-0 ${mode === null ? 'chip-active' : ''}`} onClick={() => setMode(null)}>
            All modes
          </button>
          {GAME_MODES.map((option) => (
            <button
              key={option}
              className={`chip shrink-0 ${mode === option ? 'chip-active' : ''}`}
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
        <SkeletonRows rows={3} />
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
            <article key={entry.match.id} className="card-interactive">
              {/* Who, how trusted, and at what stake — in that order, because
                  that is the order a player decides in. */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <TrustBadge score={entry.creatorTrustScore} />
                  <div className="min-w-0">
                    <p className="truncate font-display text-base font-black tracking-tight">
                      {entry.creatorHandle}
                    </p>
                    <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                      {entry.creatorWins}W–{entry.creatorLosses}L · {entry.creatorSkillTier.replace('_', '-')} ·{' '}
                      {relativeTime(entry.match.createdAt)}
                    </p>
                  </div>
                </div>
                <StakePill cents={entry.match.stakeCents} label="each" />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="pill-done border-cyanline/25 bg-cyanline/[0.07] text-cyanline">
                  {modeLabel(entry.match.gameMode)}
                </span>
                <span className="pill-done normal-case tracking-normal text-slate-400">
                  {describeRules(entry.match.rules)}
                </span>
              </div>

              <div className="my-3 rule" />

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                    Winner takes
                  </p>
                  <p className="money text-lg font-black text-slate-100">
                    {formatCents(entry.match.stakeCents * 2 - Math.round((entry.match.stakeCents * 2 * entry.match.escrowFeeBps) / 10000))}
                  </p>
                </div>
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
