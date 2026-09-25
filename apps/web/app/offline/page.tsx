'use client';

/**
 * Shown when a navigation fails with no connection.
 *
 * It deliberately shows no balance, no lobby and no match state: everything
 * this app is about is server truth, and a cached number here would be a
 * guess with somebody's stake behind it. What it can say truthfully is what
 * is happening to their money while they are offline.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <p className="font-display text-lg font-black tracking-tight">
        GOAL<span className="text-volt">27</span>
      </p>

      <h1 className="mt-6 font-display text-3xl font-black leading-tight">You&rsquo;re offline</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">
        Goal 27 needs a connection to show anything about your money, because the only honest
        version of your balance and your matches lives on the server.
      </p>

      <div className="card mt-6">
        <p className="label">While you&rsquo;re disconnected</p>
        <ul className="space-y-2 text-sm text-slate-300">
          <li>
            <span className="text-volt">·</span> Anything in escrow stays in escrow. It is released
            on agreement or a moderator&rsquo;s ruling — never by a timeout.
          </li>
          <li>
            <span className="text-warn">·</span> A reporting deadline you are already inside keeps
            running. Miss it and the match goes to a moderator with whatever evidence exists — you
            do not forfeit, but it stops being quick.
          </li>
          <li>
            <span className="text-volt">·</span> Nothing you tapped before losing signal was queued
            or will be sent later. If you do not see it confirmed, it did not happen.
          </li>
        </ul>
      </div>

      <button className="btn-primary mt-6 w-full" onClick={() => window.location.reload()}>
        Try again
      </button>
    </main>
  );
}
