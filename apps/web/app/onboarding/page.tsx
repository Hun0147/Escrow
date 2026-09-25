'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SKILL_TIERS } from '@escrow/shared';
import type { SkillTier } from '@escrow/shared';
import { ApiError, api } from '../../lib/api';
import { useRequireSession } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';
import { Banner, Spinner } from '../../components/ui';

const TIER_HINT: Record<SkillTier, string> = {
  rookie: 'New to online FC, or back after a long break',
  amateur: 'Division 8-10, comfortable in Squad Battles',
  semi_pro: 'Division 5-7, competitive in Rivals',
  pro: 'Division 2-4, Weekend League regular',
  elite: 'Division 1, 15+ wins in Champs',
};

/**
 * Onboarding.
 *
 * Ordered by what unblocks what: verify email and link PSN before you can
 * stake, KYC before you can withdraw. Each step says which gate it opens so
 * the friction reads as a reason rather than a form.
 */
export default function OnboardingPage() {
  const { user, loading, refresh } = useRequireSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [psnId, setPsnId] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function run(name: string, work: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const canStake = user.emailVerified && Boolean(user.psnId);

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-black">Get match ready</h1>
      <p className="mb-5 text-sm text-slate-400">Three steps between you and your first money match.</p>

      {error ? (
        <div className="mb-4">
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      <div className="space-y-3">
        <Step
          index={1}
          title="Verify your email"
          done={user.emailVerified}
          unlocks="Required before you can stake"
        >
          <button
            className="btn-primary w-full"
            disabled={user.emailVerified || busy === 'email'}
            onClick={() => run('email', () => api('/me/verify-email', { body: {} }))}
          >
            {user.emailVerified ? 'Verified' : 'Send and confirm'}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Development build: confirming here stands in for the emailed code.
          </p>
        </Step>

        <Step
          index={2}
          title="Link your PSN online ID"
          done={Boolean(user.psnId)}
          unlocks="Required before you can stake — it is what your opponent looks for in game"
        >
          {user.psnId ? (
            <p className="font-display text-lg font-bold text-volt">{user.psnId}</p>
          ) : (
            <div className="flex gap-2">
              <input
                className="field"
                value={psnId}
                onChange={(event) => setPsnId(event.target.value)}
                placeholder="Your PSN ID"
              />
              <button
                className="btn-primary"
                disabled={psnId.length < 3 || busy === 'psn'}
                onClick={() => run('psn', () => api('/me/psn', { body: { psnId } }))}
              >
                Link
              </button>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Set once. Changing it later needs support, so a bad reputation cannot be walked away from.
          </p>
        </Step>

        <Step
          index={3}
          title="Verify your identity"
          done={user.kycStatus === 'approved'}
          unlocks="Required before your first withdrawal, not before you play"
        >
          <p className="mb-2 text-sm text-slate-400">
            Status: <span className="font-semibold text-slate-200">{user.kycStatus}</span>
          </p>
          <button
            className="btn-ghost w-full"
            disabled={user.kycStatus === 'approved' || busy === 'kyc'}
            onClick={() =>
              run('kyc', () =>
                api('/me/kyc', {
                  body: {
                    documentType: 'passport',
                    documentRef: `dev-doc-${user.id.slice(0, 8)}`,
                    selfieRef: `dev-selfie-${user.id.slice(0, 8)}`,
                    addressCountry: user.countryCode ?? 'GB',
                    addressRegion: null,
                  },
                }),
              )
            }
          >
            {user.kycStatus === 'pending' ? 'Submitted — in review' : 'Submit ID and selfie'}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Development build: this queues a stub record for a moderator instead of uploading documents.
          </p>
        </Step>

        <div className="card">
          <p className="label">Optional</p>
          <p className="mb-2 text-sm text-slate-400">Add a phone number for match alerts.</p>
          <div className="flex gap-2">
            <input
              className="field"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+44…"
            />
            <button
              className="btn-ghost"
              disabled={phone.length < 7 || busy === 'phone'}
              onClick={() => run('phone', () => api('/me/verify-phone', { body: { phone } }))}
            >
              Verify
            </button>
          </div>
        </div>

        <div className="card">
          <p className="label">Skill tier</p>
          <p className="mb-3 text-sm text-slate-400">
            Used for matchmaking hints. Be honest — the leaderboards are per stake tier anyway.
          </p>
          <div className="space-y-2">
            {SKILL_TIERS.map((tier) => (
              <button
                key={tier}
                className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
                  user.skillTier === tier
                    ? 'border-volt/70 bg-volt/10 text-volt'
                    : 'border-pitch-500 text-slate-300'
                }`}
                onClick={() => run('tier', () => api('/me/skill-tier', { body: { skillTier: tier } }))}
              >
                <span className="font-semibold capitalize">{tier.replace('_', '-')}</span>
                <span className="block text-xs text-slate-500">{TIER_HINT[tier]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        className="btn-primary mt-6 w-full"
        disabled={!canStake}
        onClick={() => router.push('/lobby')}
      >
        {canStake ? 'Go to the lobby' : 'Finish steps 1 and 2 to continue'}
      </button>
    </AppShell>
  );
}

function Step({
  index,
  title,
  done,
  unlocks,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  unlocks: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`card ${done ? 'border-volt/40' : ''}`}>
      <div className="mb-2 flex items-start gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-black ${
            done ? 'bg-volt text-pitch-900' : 'bg-pitch-600 text-slate-300'
          }`}
        >
          {done ? '✓' : index}
        </span>
        <div>
          <h2 className="font-display font-bold">{title}</h2>
          <p className="text-xs text-slate-500">{unlocks}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
