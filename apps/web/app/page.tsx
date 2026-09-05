'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '../lib/api';
import { useSession } from '../components/SessionProvider';
import { Banner } from '../components/ui';

type Mode = 'login' | 'register';

/** Splash + auth. The only screen that works without a session. */
export default function SplashPage() {
  const { user, loading, signIn } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    handle: '',
    email: '',
    password: '',
    dateOfBirth: '',
    countryCode: 'GB',
    regionCode: '',
    psnId: '',
  });

  useEffect(() => {
    if (!loading && user) router.replace('/lobby');
  }, [loading, user, router]);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload =
        mode === 'login'
          ? { email: form.email, password: form.password }
          : {
              handle: form.handle,
              email: form.email,
              password: form.password,
              dateOfBirth: form.dateOfBirth,
              countryCode: form.countryCode.toUpperCase(),
              ...(form.regionCode ? { regionCode: form.regionCode.toUpperCase() } : {}),
              ...(form.psnId ? { psnId: form.psnId } : {}),
            };
      const response = await api<{ token: string }>(`/auth/${mode}`, { body: payload, auth: false });
      await signIn(response.token);
      router.replace(mode === 'register' ? '/onboarding' : '/lobby');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8">
        <p className="text-xs font-bold uppercase tracking-[0.3em] text-volt">PS5 · EA Sports FC</p>
        <h1 className="mt-2 font-display text-5xl font-black leading-none tracking-tight">
          GOAL<span className="text-volt">27</span>
        </h1>
        <p className="mt-3 text-slate-400">
          Stake it, play it on your own console, get paid in minutes. Both stakes sit in escrow until
          you and your opponent agree on the score.
        </p>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-2 text-center text-[11px] text-slate-400">
        <div className="card px-2 py-3">
          <div className="font-display text-lg font-black text-volt">10%</div>
          rake, 7% on Pro
        </div>
        <div className="card px-2 py-3">
          <div className="font-display text-lg font-black text-volt">$5+</div>
          stake tiers
        </div>
        <div className="card px-2 py-3">
          <div className="font-display text-lg font-black text-volt">18+</div>
          verified only
        </div>
      </div>

      <div className="mb-4 flex gap-2">
        {(['login', 'register'] as Mode[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setMode(option);
              setError(null);
            }}
            className={`chip flex-1 py-2 ${mode === option ? 'chip-active' : ''}`}
          >
            {option === 'login' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="card space-y-3">
        {mode === 'register' ? (
          <div>
            <label className="label" htmlFor="handle">
              Handle
            </label>
            <input id="handle" className="field" value={form.handle} onChange={set('handle')} required />
          </div>
        ) : null}

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input id="email" type="email" className="field" value={form.email} onChange={set('email')} required />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="field"
            value={form.password}
            onChange={set('password')}
            minLength={mode === 'register' ? 10 : undefined}
            required
          />
        </div>

        {mode === 'register' ? (
          <>
            <div>
              <label className="label" htmlFor="dob">
                Date of birth
              </label>
              <input id="dob" type="date" className="field" value={form.dateOfBirth} onChange={set('dateOfBirth')} required />
              <p className="mt-1 text-xs text-slate-500">
                You must be 18 or older — 19 or 21 in some places.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="country">
                  Country
                </label>
                <input id="country" className="field uppercase" maxLength={2} value={form.countryCode} onChange={set('countryCode')} required />
              </div>
              <div>
                <label className="label" htmlFor="region">
                  State / region
                </label>
                <input id="region" className="field uppercase" maxLength={3} value={form.regionCode} onChange={set('regionCode')} placeholder="optional" />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="psn">
                PSN online ID
              </label>
              <input id="psn" className="field" value={form.psnId} onChange={set('psnId')} placeholder="link it now or later" />
            </div>
          </>
        ) : null}

        {error ? <Banner tone="danger">{error}</Banner> : null}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-xs leading-relaxed text-slate-500">
        Paid skill competitions are restricted in some places. Goal 27 checks your region and age
        before you can stake, and identity before you can withdraw.
      </p>
    </main>
  );
}
