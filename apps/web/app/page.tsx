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
        <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.28em] text-volt">
          <span className="dot-live" />
          PS5 · EA Sports FC
        </p>
        <h1 className="mt-3 font-display text-[4.25rem] font-black leading-[0.85] tracking-[-0.045em]">
          GOAL
          <span className="bg-gradient-to-br from-volt to-cyanline bg-clip-text text-transparent">27</span>
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-slate-400">
          Stake it, play it on your own console, get paid in minutes. Both stakes sit in escrow until
          you and your opponent agree on the score.
        </p>
      </div>

      {/* The three facts that decide whether someone signs up. */}
      <div className="mb-5 grid grid-cols-3 gap-2">
        {[
          { value: '10%', note: 'escrow fee\n7% on Pro' },
          { value: '$5+', note: 'stake tiers\nup to $100' },
          { value: '18+', note: 'verified only\nregion checked' },
        ].map((item) => (
          <div key={item.value} className="card px-2 py-3.5 text-center">
            <div className="money text-xl font-black text-volt">{item.value}</div>
            <div className="mt-1.5 whitespace-pre-line text-[10px] font-semibold uppercase leading-[1.5] tracking-[0.08em] text-slate-500">
              {item.note}
            </div>
          </div>
        ))}
      </div>

      {/* One control, two states — a segmented switch rather than two
          buttons that look equally pressed. */}
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] p-1">
        {(['login', 'register'] as Mode[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setMode(option);
              setError(null);
            }}
            className={`min-h-[40px] rounded-full text-xs font-bold uppercase tracking-[0.1em] transition
              ${mode === option
                ? 'bg-volt text-pitch-900 shadow-volt-glow'
                : 'text-slate-400 hover:text-slate-200'}`}
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
