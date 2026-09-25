'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, api } from '../../../lib/api';
import { useRequireSession } from '../../../components/SessionProvider';
import { AppShell } from '../../../components/AppShell';
import { Banner, Spinner } from '../../../components/ui';

/**
 * Where Discord sends the player back after they authorise.
 *
 * The code in the query string is one half of an OAuth exchange the API
 * completes server-side with the bot secret — the browser never holds a
 * Discord token, and the account we link is the one Discord vouched for, not
 * one the client claimed.
 */
function DiscordCallback() {
  const { user, loading, refresh } = useRequireSession();
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  const code = params.get('code');
  const denied = params.get('error');

  useEffect(() => {
    if (!user || exchanged.current) return;
    exchanged.current = true;

    if (denied) {
      setError('Discord authorisation was cancelled. Nothing was linked.');
      return;
    }
    if (!code) {
      router.replace('/settings');
      return;
    }

    void (async () => {
      try {
        // An authorisation code is single-use, hence the ref guard: React's
        // development double-render would otherwise spend it on the first try
        // and show the player a failure for a link that worked.
        await api('/me/discord', { body: { code } });
        await refresh();
        router.replace('/settings?discord=linked');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not link that Discord account');
      }
    })();
  }, [user?.id, code, denied]);

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="mb-4 font-display text-2xl font-black">Discord</h1>
      {error ? (
        <>
          <Banner tone="danger">{error}</Banner>
          <button className="btn-ghost mt-4 w-full" onClick={() => router.replace('/settings')}>
            Back to settings
          </button>
        </>
      ) : (
        <>
          <Spinner />
          <p className="mt-3 text-center text-sm text-slate-400">Linking your Discord account…</p>
        </>
      )}
    </AppShell>
  );
}

export default function DiscordCallbackPage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <Spinner />
        </AppShell>
      }
    >
      <DiscordCallback />
    </Suspense>
  );
}
