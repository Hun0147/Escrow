'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { formatCents } from '../lib/format';
import { useSession } from './SessionProvider';

interface SessionReminder {
  elapsedMinutes: number;
  intervalMinutes: number;
}

const NAV = [
  { href: '/lobby', label: 'Lobby', glyph: '⚽' },
  { href: '/tournaments', label: 'Cups', glyph: '🏆' },
  { href: '/wallet', label: 'Wallet', glyph: '💳' },
  { href: '/leaderboards', label: 'Ranks', glyph: '📊' },
  { href: '/profile', label: 'You', glyph: '👤' },
];

/**
 * The frame every signed-in screen sits in.
 *
 * The money bar is sticky and always on top: the brief's hard requirement is
 * that a player never has to scroll to see their balance or the state of the
 * match they have money in.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, wallet, notifications, socket } = useSession();
  const pathname = usePathname();
  const unread = notifications.filter((n) => !n.readAt).length;
  const [reminder, setReminder] = useState<SessionReminder | null>(null);

  // A responsible-play nudge the player asked for. It is dismissible but not
  // silenceable from here — turning it off is a deliberate trip to settings.
  useEffect(() => {
    if (!socket) return;
    const onReminder = (payload: SessionReminder) => setReminder(payload);
    socket.on('session:reminder', onReminder);
    return () => {
      socket.off('session:reminder', onReminder);
    };
  }, [socket]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
      <header className="sticky top-0 z-20 border-b border-pitch-600 bg-pitch-900/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/lobby" className="font-display text-lg font-black tracking-tight">
            GOAL<span className="text-volt">27</span>
          </Link>

          <div className="flex items-center gap-3">
            <Link href="/profile" className="relative text-xl" aria-label="Notifications">
              🔔
              {unread > 0 ? (
                <span className="absolute -right-1 -top-1 rounded-full bg-volt px-1.5 text-[10px] font-black text-pitch-900">
                  {unread}
                </span>
              ) : null}
            </Link>
            <Link href="/wallet" className="text-right leading-tight">
              <div className="font-display text-xl font-black tabular-nums text-volt">
                {formatCents(wallet?.availableCents ?? 0)}
              </div>
              {wallet && wallet.lockedCents > 0 ? (
                <div className="text-[11px] tabular-nums text-slate-400">
                  {formatCents(wallet.lockedCents)} in escrow
                </div>
              ) : (
                <div className="text-[11px] uppercase tracking-wider text-slate-500">Available</div>
              )}
            </Link>
          </div>
        </div>
        {user?.role !== 'player' ? (
          <Link
            href="/admin"
            className="block bg-pitch-700 px-4 py-1.5 text-center text-xs font-semibold text-cyanline"
          >
            Staff view — open the moderation queue
          </Link>
        ) : null}
      </header>

      {reminder ? (
        <div className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-amber-100">
          <div className="flex items-start justify-between gap-3">
            <p>
              You have been playing for{' '}
              <span className="font-semibold">{reminder.elapsedMinutes} minutes</span>. Take a break
              if you want one —{' '}
              <Link href="/settings" className="underline">
                limits and cool-off
              </Link>{' '}
              are in settings.
            </p>
            <button
              className="shrink-0 text-xs font-bold uppercase tracking-wider"
              onClick={() => setReminder(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <main className="flex-1 px-4 pb-28 pt-4">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-2xl border-t border-pitch-600 bg-pitch-900/95 backdrop-blur">
        <div className="grid grid-cols-5">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-col items-center gap-0.5 py-3 text-[11px] font-semibold ${
                  active ? 'text-volt' : 'text-slate-500'
                }`}
              >
                <span className="text-lg" aria-hidden>
                  {item.glyph}
                </span>
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
