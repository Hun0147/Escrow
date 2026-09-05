'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ALLOWED_HALF_LENGTHS,
  DEFAULT_MATCH_RULES,
  GAME_MODES,
  STAKE_TIERS_CENTS,
  calculateSettlement,
} from '@escrow/shared';
import type { GameMode, Match, MatchRules } from '@escrow/shared';
import { ApiError, api } from '../../../lib/api';
import { formatCents, modeLabel } from '../../../lib/format';
import { useRequireSession } from '../../../components/SessionProvider';
import { AppShell } from '../../../components/AppShell';
import { Banner, Spinner } from '../../../components/ui';

export default function CreateMatchPage() {
  const { user, wallet, loading } = useRequireSession();
  const router = useRouter();
  const [stakeCents, setStakeCents] = useState<number>(STAKE_TIERS_CENTS[1]);
  const [gameMode, setGameMode] = useState<GameMode>('ultimate_team');
  const [rules, setRules] = useState<MatchRules>(DEFAULT_MATCH_RULES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const rakeBps = user.subscriptionTier === 'pro' ? 700 : 1000;
  const preview = calculateSettlement(stakeCents, stakeCents, rakeBps);
  const affordable = (wallet?.availableCents ?? 0) >= stakeCents;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ match: Match }>('/matches', {
        body: { gameMode, stakeCents, rules },
      });
      router.push(`/match/${response.match.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the match');
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-black">Create a match</h1>
      <p className="mb-5 text-sm text-slate-400">
        Your stake is escrowed the moment you post it, so anyone who joins knows the money is real.
      </p>

      <section className="card mb-3">
        <p className="label">Stake</p>
        <div className="grid grid-cols-5 gap-2">
          {STAKE_TIERS_CENTS.map((cents) => (
            <button
              key={cents}
              onClick={() => setStakeCents(cents)}
              className={`rounded-xl border py-3 font-display text-sm font-black tabular-nums ${
                stakeCents === cents
                  ? 'border-volt bg-volt/10 text-volt'
                  : 'border-pitch-500 text-slate-300'
              }`}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
      </section>

      <section className="card mb-3">
        <p className="label">Game mode</p>
        <div className="grid grid-cols-2 gap-2">
          {GAME_MODES.map((option) => (
            <button
              key={option}
              onClick={() => setGameMode(option)}
              className={`rounded-xl border py-3 text-sm font-semibold ${
                gameMode === option ? 'border-volt bg-volt/10 text-volt' : 'border-pitch-500 text-slate-300'
              }`}
            >
              {modeLabel(option)}
            </button>
          ))}
        </div>
      </section>

      <section className="card mb-3 space-y-4">
        <div>
          <p className="label">Half length</p>
          <div className="flex flex-wrap gap-2">
            {ALLOWED_HALF_LENGTHS.map((minutes) => (
              <button
                key={minutes}
                onClick={() => setRules({ ...rules, halfLengthMinutes: minutes })}
                className={`chip ${rules.halfLengthMinutes === minutes ? 'chip-active' : ''}`}
              >
                {minutes} min
              </button>
            ))}
          </div>
        </div>

        <Toggle
          label="Custom tactics"
          hint="Off means default tactics only"
          value={rules.customTactics}
          onChange={(value) => setRules({ ...rules, customTactics: value })}
        />
        <Toggle
          label="Chemistry styles"
          hint="Usually banned in money matches"
          value={rules.chemistryStyles}
          onChange={(value) => setRules({ ...rules, chemistryStyles: value })}
        />
        <Toggle
          label="Extra time and penalties"
          hint="Off means a draw voids the match and both stakes come back"
          value={rules.extraTimeAndPenalties}
          onChange={(value) => setRules({ ...rules, extraTimeAndPenalties: value })}
        />

        <div>
          <label className="label" htmlFor="cap">
            Squad rating cap
          </label>
          <input
            id="cap"
            type="number"
            min={60}
            max={99}
            className="field"
            value={rules.squadRatingCap ?? ''}
            placeholder="No cap"
            onChange={(event) =>
              setRules({
                ...rules,
                squadRatingCap: event.target.value === '' ? null : Number(event.target.value),
              })
            }
          />
        </div>

        <div>
          <label className="label" htmlFor="notes">
            House rules
          </label>
          <textarea
            id="notes"
            className="field"
            rows={2}
            maxLength={280}
            value={rules.notes ?? ''}
            placeholder="e.g. no time wasting after 85', no icons"
            onChange={(event) => setRules({ ...rules, notes: event.target.value || null })}
          />
        </div>
      </section>

      <section className="card mb-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-slate-400">Prize pool</span>
          <span className="font-display text-xl font-black tabular-nums">
            {formatCents(preview.grossPoolCents)}
          </span>
        </div>
        <div className="flex items-baseline justify-between text-sm text-slate-400">
          <span>Platform rake ({(rakeBps / 100).toFixed(0)}%)</span>
          <span className="tabular-nums">−{formatCents(preview.platformFeeCents)}</span>
        </div>
        <div className="mt-2 flex items-baseline justify-between border-t border-pitch-600 pt-2">
          <span className="text-sm font-semibold">Winner takes</span>
          <span className="stake">{formatCents(preview.payoutCents)}</span>
        </div>
        {user.subscriptionTier !== 'pro' ? (
          <p className="mt-2 text-xs text-slate-500">Pro members pay 7% instead of 10%.</p>
        ) : null}
      </section>

      {error ? (
        <div className="mb-3">
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}
      {!affordable ? (
        <div className="mb-3">
          <Banner tone="warn">
            Your available balance is {formatCents(wallet?.availableCents ?? 0)} — top up to stake{' '}
            {formatCents(stakeCents)}.
          </Banner>
        </div>
      ) : null}

      <button className="btn-primary w-full" disabled={busy || !affordable} onClick={create}>
        {busy ? 'Escrowing…' : `Post match and escrow ${formatCents(stakeCents)}`}
      </button>
    </AppShell>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex w-full items-center justify-between gap-3 text-left"
    >
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          value ? 'bg-volt' : 'bg-pitch-500'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-pitch-900 transition-all ${
            value ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  );
}
