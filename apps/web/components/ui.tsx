'use client';

import Link from 'next/link';
import { formatCents, trustTone } from '../lib/format';

export function StakePill({ cents, label }: { cents: number; label?: string }) {
  return (
    <div className="text-right">
      <div className="stake">{formatCents(cents)}</div>
      {label ? <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div> : null}
    </div>
  );
}

export function TrustBadge({ score, size = 'sm' }: { score: number; size?: 'sm' | 'lg' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 font-semibold tabular-nums ${trustTone(score)} ${
        size === 'lg' ? 'text-2xl' : 'text-xs'
      }`}
      title="Trust score: report accuracy, dispute rate and cancellations"
    >
      <span aria-hidden>◈</span>
      {score}
    </span>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'good';
  children: React.ReactNode;
}) {
  const tones = {
    info: 'border-cyanline/40 bg-cyanline/10 text-cyan-100',
    warn: 'border-warn/40 bg-warn/10 text-amber-100',
    danger: 'border-danger/40 bg-danger/10 text-rose-100',
    good: 'border-volt/40 bg-volt/10 text-emerald-100',
  };
  return <div className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</div>;
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 py-10 text-center">
      <p className="font-display text-lg font-bold">{title}</p>
      {hint ? <p className="max-w-xs text-sm text-slate-400">{hint}</p> : null}
      {action}
    </div>
  );
}

export function SectionTitle({ children, href }: { children: React.ReactNode; href?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="font-display text-sm font-bold uppercase tracking-widest text-slate-400">
        {children}
      </h2>
      {href ? (
        <Link href={href} className="text-xs font-semibold text-volt hover:underline">
          See all
        </Link>
      ) : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
      <span className="h-3 w-3 animate-ping rounded-full bg-volt" />
      {label}
    </div>
  );
}
