'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Wallet } from '@escrow/shared';
import { ApiError, api } from '../../lib/api';
import { formatCents, relativeTime } from '../../lib/format';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Banner, Empty, SectionTitle, Spinner } from '../../components/ui';

interface LedgerRow {
  transactionId: string;
  type: string;
  matchId: string | null;
  memo: string | null;
  deltaCents: number;
  createdAt: string;
}

const TYPE_LABEL: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  escrow_lock: 'Stake escrowed',
  escrow_payout: 'Match payout',
  refund: 'Refund',
  tournament_entry: 'Tournament entry',
  tournament_prize: 'Tournament prize',
  platform_rake: 'Platform rake',
  adjustment: 'Adjustment',
};

const QUICK_AMOUNTS = [1000, 2500, 5000, 10000];

export default function WalletPage() {
  const { user, wallet, loading, refresh } = useRequireSession();
  const [entries, setEntries] = useState<LedgerRow[]>([]);
  const [exposure, setExposure] = useState(0);
  const [amount, setAmount] = useState(2500);
  const [method, setMethod] = useState<'stripe' | 'paypal' | 'bank'>('stripe');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [history, balance] = await Promise.all([
      api<{ entries: LedgerRow[] }>('/wallet/history'),
      api<{ wallet: Wallet; dailyLossExposureCents: number }>('/wallet'),
    ]);
    setEntries(history.entries);
    setExposure(balance.dailyLossExposureCents);
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  async function move(direction: 'deposit' | 'withdraw') {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/wallet/${direction}`, {
        body:
          direction === 'deposit'
            ? { amountCents: amount, provider: 'mock', instrumentFingerprint: `dev-card-${user!.id.slice(0, 8)}` }
            : { amountCents: amount, method },
      });
      setNotice(
        direction === 'deposit'
          ? `${formatCents(amount)} added.`
          : `${formatCents(amount)} sent via ${method}.`,
      );
      await Promise.all([refresh(), load()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not complete that');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user || !wallet) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <section className="card mb-4 border-volt/30">
        <p className="label">Available</p>
        <p className="font-display text-5xl font-black tabular-nums text-volt">
          {formatCents(wallet.availableCents)}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wider text-slate-500">In escrow</p>
            <p className="font-display text-lg font-bold tabular-nums">{formatCents(wallet.lockedCents)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-slate-500">At risk today</p>
            <p className="font-display text-lg font-bold tabular-nums">{formatCents(exposure)}</p>
          </div>
        </div>
      </section>

      {error ? <div className="mb-3"><Banner tone="danger">{error}</Banner></div> : null}
      {notice ? <div className="mb-3"><Banner tone="good">{notice}</Banner></div> : null}

      <section className="card mb-4">
        <p className="label">Amount</p>
        <div className="mb-3 grid grid-cols-4 gap-2">
          {QUICK_AMOUNTS.map((cents) => (
            <button
              key={cents}
              onClick={() => setAmount(cents)}
              className={`rounded-xl border py-2 font-display text-sm font-black tabular-nums ${
                amount === cents ? 'border-volt bg-volt/10 text-volt' : 'border-pitch-500 text-slate-300'
              }`}
            >
              {formatCents(cents)}
            </button>
          ))}
        </div>
        <input
          type="number"
          min={1}
          step="0.01"
          className="field"
          value={(amount / 100).toFixed(2)}
          onChange={(event) => setAmount(Math.round(Number(event.target.value) * 100))}
        />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => move('deposit')}>
            Deposit
          </button>
          <button
            className="btn-ghost"
            disabled={busy || wallet.availableCents < amount}
            onClick={() => move('withdraw')}
          >
            Withdraw
          </button>
        </div>

        <div className="mt-3 flex gap-2">
          {(['stripe', 'paypal', 'bank'] as const).map((option) => (
            <button
              key={option}
              onClick={() => setMethod(option)}
              className={`chip flex-1 py-2 capitalize ${method === option ? 'chip-active' : ''}`}
            >
              {option}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Payments are mocked in this build — no card is charged and no money leaves the platform.
        </p>
        {user.kycStatus !== 'approved' ? (
          <div className="mt-3">
            <Banner tone="warn">
              Identity verification is required before your first withdrawal.{' '}
              <Link href="/onboarding" className="font-semibold underline">
                Verify now
              </Link>
            </Banner>
          </div>
        ) : null}
      </section>

      <SectionTitle href="/settings">Statement</SectionTitle>
      {entries.length === 0 ? (
        <Empty title="No movements yet" hint="Deposit to get started, then stake in the lobby." />
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={`${entry.transactionId}-${entry.createdAt}`} className="card flex items-center justify-between py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{TYPE_LABEL[entry.type] ?? entry.type}</p>
                <p className="text-xs text-slate-500">{relativeTime(entry.createdAt)}</p>
              </div>
              <span
                className={`font-display text-lg font-black tabular-nums ${
                  entry.deltaCents >= 0 ? 'text-volt' : 'text-slate-300'
                }`}
              >
                {entry.deltaCents >= 0 ? '+' : '−'}
                {formatCents(Math.abs(entry.deltaCents))}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-slate-500">
        Every line is a double-entry ledger posting. Nothing here can be edited or deleted, by anyone.
      </p>
    </AppShell>
  );
}
