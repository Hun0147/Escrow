'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { formatCents } from '../lib/format';
import { useSession } from './SessionProvider';
import { BellIcon, PitchIcon, PlayerIcon, RanksIcon, TrophyIcon, WalletIcon } from './icons';

interface SessionReminder {
  elapsedMinutes: number;
  intervalMinutes: number;
}

const NAV = [
  { href: '/lobby', label: 'Lobby', Icon: PitchIcon },
  { href: '/tournaments', label: 'Cups', Icon: TrophyIcon },
  { href: '/wallet', label: 'Wallet', Icon: WalletIcon },
  { href: '/leaderboards', label: 'Ranks', Icon: RanksIcon },
  { href: '/profile', label: 'You', Icon: PlayerIcon },
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
      <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-pitch-900/80 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <Link href="/lobby" className="flex min-h-[44px] items-center gap-2">
            <span className="font-display text-lg font-black tracking-[-0.02em]">
              GOAL<span className="text-volt">27</span>
            </span>
          </Link>

          <div className="flex items-center gap-1">
            <Link href="/profile" className="tap relative text-slate-400 hover:text-slate-100" aria-label="Notifications">
              <BellIcon />
              {unread > 0 ? (
                <span
                  className="absolute right-1.5 top-1.5 flex h-4 min-w-[16px] items-center justify-center
                             rounded-full bg-volt px-1 text-[10px] font-black text-pitch-900"
                >
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </Link>

            {/* The money, never more than a glance away. */}
            <Link
              href="/wallet"
              className="group flex min-h-[44px] items-center gap-2.5 rounded-xl border border-white/[0.07]
                         bg-white/[0.04] py-1.5 pl-3 pr-3 transition hover:border-volt/30"
            >
              <div className="text-right leading-none">
                <div className="money text-xl font-black text-volt">
                  {formatCents(wallet?.availableCents ?? 0)}
                </div>
                <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  Available
                </div>
              </div>
              {wallet && wallet.lockedCents > 0 ? (
                <div className="border-l border-white/10 pl-2.5 text-left leading-none">
                  <div className="money text-sm font-bold text-cyanline">
                    {formatCents(wallet.lockedCents)}
                  </div>
                  <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
                    Escrow
                  </div>
                </div>
              ) : null}
            </Link>
          </div>
        </div>

        {user?.role !== 'player' ? (
          <Link
            href="/admin"
            className="flex items-center justify-center gap-2 border-t border-white/[0.06]
                       bg-cyanline/[0.07] px-4 py-1.5 text-center text-[11px] font-bold
                       uppercase tracking-[0.12em] text-cyanline"
          >
            Staff view — moderation queue
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

      {/* The bottom padding clears the fixed nav AND the home indicator, since
          the viewport is set to cover the full screen. */}
      <main
        className="flex-1 px-4 pt-4"
        style={{ paddingBottom: 'calc(7rem + env(safe-area-inset-bottom))' }}
      >
        {children}
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-2xl border-t border-white/[0.07]
                   bg-pitch-900/85 backdrop-blur-xl"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="grid grid-cols-5">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-[56px] flex-col items-center justify-center gap-1 py-2
                  text-[10px] font-bold uppercase tracking-[0.08em] transition
                  ${active ? 'text-volt' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {/* The active tab is lit from the top edge, like a tunnel. */}
                {active ? (
                  <span className="absolute inset-x-5 top-0 h-px bg-volt shadow-[0_0_12px_2px_rgba(61,255,154,0.6)]" />
                ) : null}
                <item.Icon />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
