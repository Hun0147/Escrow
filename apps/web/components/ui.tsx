'use client';

import Link from 'next/link';
import { formatCents, trustTone } from '../lib/format';

export function StakePill({ cents, label }: { cents: number; label?: string }) {
  return (
    <div className="shrink-0 text-right">
      <div className="stake leading-none">{formatCents(cents)}</div>
      {label ? (
        <div className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
          {label}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Trust, drawn as a filled arc.
 *
 * The number alone made 72 and 38 look like the same kind of fact. The ring
 * fills with the score and takes its colour from the band, so how much
 * evidence a match will demand is legible before you read the digits.
 */
export function TrustBadge({ score, size = 'sm' }: { score: number; size?: 'sm' | 'lg' }) {
  const px = size === 'lg' ? 56 : 26;
  const stroke = size === 'lg' ? 5 : 2.5;
  const radius = (px - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;

  return (
    <span
      className={`inline-flex items-center gap-1.5 ${trustTone(score)}`}
      title="Trust score: report accuracy, dispute rate and cancellations"
    >
      <span className="relative inline-flex shrink-0" style={{ width: px, height: px }}>
        <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} className="-rotate-90">
          <circle
            cx={px / 2}
            cy={px / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            className="opacity-20"
          />
          <circle
            cx={px / 2}
            cy={px / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
          />
        </svg>
        <span
          className={`absolute inset-0 flex items-center justify-center font-display font-black tabular-nums ${
            size === 'lg' ? 'text-lg' : 'text-[10px]'
          }`}
        >
          {score}
        </span>
      </span>
      {size === 'lg' ? (
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] opacity-80">Trust</span>
      ) : null}
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
  } as const;
  return (
    <div className={`animate-rise rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 py-12 text-center">
      {/* An empty pitch, rather than an empty box. */}
      <svg viewBox="0 0 48 32" className="h-10 w-16 text-pitch-500" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="1" y="1" width="46" height="30" rx="2" />
        <path d="M24 1v30" />
        <circle cx="24" cy="16" r="5" />
      </svg>
      <p className="font-display text-lg font-black tracking-tight">{title}</p>
      {hint ? <p className="max-w-xs text-sm text-slate-400">{hint}</p> : null}
      {action}
    </div>
  );
}

export function SectionTitle({ children, href }: { children: React.ReactNode; href?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="flex items-center gap-2 font-display text-[13px] font-black uppercase tracking-[0.16em] text-slate-400">
        <span className="h-3 w-0.5 rounded-full bg-volt/70" />
        {children}
      </h2>
      {href ? (
        <Link
          href={href}
          className="-my-2 flex min-h-[44px] items-center px-2 text-xs font-semibold text-volt hover:underline"
        >
          See all
        </Link>
      ) : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-slate-500">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-volt motion-reduce:animate-none" />
      <span className="text-xs font-bold uppercase tracking-[0.14em]">{label}</span>
    </div>
  );
}

/** Placeholder rows that hold the shape of what is loading. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 space-y-2">
              <div className="skeleton h-4 w-28" />
              <div className="skeleton h-3 w-40" />
              <div className="skeleton h-3 w-32" />
            </div>
            <div className="skeleton h-8 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
