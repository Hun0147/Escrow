'use client';

import { useEffect, useState } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'goal27.install-dismissed';

/**
 * Registers the service worker, and offers the install when the browser says
 * one is available.
 *
 * Installed, Goal 27 opens full-screen from the home screen — which matters
 * more here than on most sites, because browser chrome eats exactly the strip
 * the money bar needs, and a player should never scroll to see their balance
 * or the state of a match they have money in.
 *
 * iOS has no install event, so Safari gets the one instruction that works
 * there instead of a button that cannot do anything.
 */
export function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      // Registration failing is not worth interrupting anyone for — the app
      // works without it, it just loses the offline page.
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    const alreadyInstalled =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    const dismissed = (() => {
      try {
        return window.localStorage.getItem(DISMISSED_KEY) === '1';
      } catch {
        return false;
      }
    })();
    if (alreadyInstalled || dismissed) return;

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);

    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    const isSafari = /safari/i.test(window.navigator.userAgent) && !/crios|fxios/i.test(window.navigator.userAgent);
    if (isIos && isSafari) setIosHint(true);

    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // A private window that refuses storage just gets asked again later.
    }
    setPrompt(null);
    setIosHint(false);
  }

  if (!prompt && !iosHint) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-2xl border-t border-volt/30 bg-pitch-800/98 px-4 pt-3 backdrop-blur"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      role="dialog"
      aria-label="Install Goal 27"
    >
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon-192.png" alt="" width={44} height={44} className="rounded-xl" />
        <div className="flex-1">
          <p className="text-sm font-semibold">Install Goal 27</p>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
            {iosHint
              ? 'Tap Share, then “Add to Home Screen” — full screen, with your balance always in view.'
              : 'Full screen from your home screen, with your balance and match state always in view.'}
          </p>
        </div>
        <button className="tap text-xs font-bold uppercase tracking-wider text-slate-500" onClick={dismiss}>
          Not now
        </button>
      </div>

      {prompt ? (
        <button
          className="btn-primary mt-3 w-full"
          onClick={async () => {
            await prompt.prompt();
            await prompt.userChoice;
            // The event is single-use whichever way it goes; a player who
            // declines should not be asked again on the next page.
            dismiss();
          }}
        >
          Install
        </button>
      ) : null}
    </div>
  );
}
