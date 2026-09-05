'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { calculateSettlement, describeRules } from '@escrow/shared';
import type {
  ChatMessage,
  Match,
  MatchResult,
  PublicUser,
  Screenshot,
  SettlementPolicy,
} from '@escrow/shared';
import { ApiError, api } from '../../../lib/api';
import { countdown, formatCents, modeLabel, MATCH_STATUS_LABELS, MATCH_STATUS_TONE } from '../../../lib/format';
import { useRequireSession } from '../../../components/SessionProvider';
import { AppShell } from '../../../components/AppShell';
import { Banner, Spinner, TrustBadge } from '../../../components/ui';

interface MatchDetail {
  match: Match;
  creator: PublicUser;
  opponent: PublicUser | null;
  results: MatchResult[];
  screenshots: Screenshot[];
  disputeId: string | null;
  policy: SettlementPolicy;
}

export default function MatchRoomPage() {
  const params = useParams<{ matchId: string }>();
  const matchId = params.matchId;
  const { user, loading, socket } = useRequireSession();
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opponentOnline, setOpponentOnline] = useState<boolean | null>(null);
  const [now, setNow] = useState(Date.now());
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setDetail(await api<MatchDetail>(`/matches/${matchId}`));
  }, [matchId]);

  useEffect(() => {
    if (!user) return;
    void load();
    void api<{ messages: ChatMessage[] }>(`/matches/${matchId}/chat`).then((data) => setChat(data.messages));
  }, [user, matchId, load]);

  // Deadlines are shown as a live countdown, so "10 minutes to report" is a
  // number that moves rather than a claim.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!socket || !user) return;
    socket.emit('match:join', matchId);

    const onChat = (message: ChatMessage) => setChat((current) => [...current, message]);
    const onUpdate = () => void load();
    const onDisconnected = () => setOpponentOnline(false);
    const onPresence = () => setOpponentOnline(true);

    socket.on('chat:message', onChat);
    socket.on('match:updated', onUpdate);
    socket.on('match:ready_state', onUpdate);
    socket.on('match:settled', onUpdate);
    socket.on('match:voided', onUpdate);
    socket.on('match:disputed', onUpdate);
    socket.on('result:submitted', onUpdate);
    socket.on('screenshot:analysed', onUpdate);
    socket.on('presence:disconnected', onDisconnected);
    socket.on('presence:joined', onPresence);

    return () => {
      socket.emit('match:leave', matchId);
      socket.off('chat:message', onChat);
      socket.off('match:updated', onUpdate);
      socket.off('match:ready_state', onUpdate);
      socket.off('match:settled', onUpdate);
      socket.off('match:voided', onUpdate);
      socket.off('match:disputed', onUpdate);
      socket.off('result:submitted', onUpdate);
      socket.off('screenshot:analysed', onUpdate);
      socket.off('presence:disconnected', onDisconnected);
      socket.off('presence:joined', onPresence);
    };
  }, [socket, user, matchId, load]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.length]);

  if (loading || !user || !detail) {
    return (
      <AppShell>
        <Spinner label="Opening the match room" />
      </AppShell>
    );
  }

  const { match, creator, opponent, results, screenshots, policy } = detail;
  const isCreator = match.creatorId === user.id;
  const me = isCreator ? creator : opponent;
  const them = isCreator ? opponent : creator;
  const myReady = isCreator ? match.creatorReady : match.opponentReady;
  const theirReady = isCreator ? match.opponentReady : match.creatorReady;
  const myReport = results.find((result) => result.reporterId === user.id) ?? null;
  const payout = calculateSettlement(match.stakeCents, match.stakeCents, match.rakeBps);
  const deadline = countdown(match.reportDeadlineAt);

  async function act(work: () => Promise<unknown>, message?: string) {
    setError(null);
    setNotice(null);
    try {
      await work();
      if (message) setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  }

  return (
    <AppShell>
      {/* Match state and money, pinned above everything else. */}
      <section className="card mb-3 border-volt/30">
        <div className="flex items-start justify-between">
          <div>
            <p className={`text-xs font-bold uppercase tracking-widest ${MATCH_STATUS_TONE[match.status]}`}>
              {MATCH_STATUS_LABELS[match.status]}
            </p>
            <p className="mt-1 text-sm text-slate-300">{modeLabel(match.gameMode)}</p>
          </div>
          <div className="text-right">
            <div className="stake">{formatCents(payout.payoutCents)}</div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500">
              to the winner · {formatCents(match.stakeCents)} each
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <PlayerCell player={me} ready={myReady} you />
          <span className="font-display text-xs font-black text-slate-600">VS</span>
          <PlayerCell player={them} ready={theirReady} online={opponentOnline} />
        </div>

        <p className="mt-3 rounded-lg bg-pitch-900/70 px-3 py-2 text-xs text-slate-400">
          {describeRules(match.rules)}
          {match.rules.notes ? <span className="block text-slate-300">“{match.rules.notes}”</span> : null}
        </p>

        {deadline ? (
          <p className="mt-2 text-center text-xs font-semibold text-warn">
            Reporting window: {deadline === 'overdue' ? 'closed — escalating to review' : deadline}
          </p>
        ) : null}
      </section>

      {error ? <div className="mb-3"><Banner tone="danger">{error}</Banner></div> : null}
      {notice ? <div className="mb-3"><Banner tone="good">{notice}</Banner></div> : null}
      {opponentOnline === false && !['settled', 'voided'].includes(match.status) ? (
        <div className="mb-3">
          <Banner tone="warn">
            Your opponent’s connection dropped. If they don’t come back, report your result and the
            match goes to review — your stake stays in escrow either way.
          </Banner>
        </div>
      ) : null}
      {match.status === 'disputed' ? (
        <div className="mb-3">
          <Banner tone="danger">
            This match is with a moderator. Both stakes stay in escrow until they rule.
          </Banner>
        </div>
      ) : null}

      {/* Ready / kick-off */}
      {['escrowed', 'in_progress'].includes(match.status) && them ? (
        <section className="card mb-3">
          <p className="label">Kick off</p>
          <p className="mb-3 text-sm text-slate-400">
            Invite <span className="font-semibold text-volt">{them.psnId ?? them.handle}</span> on PS5,
            set the rules above, then ready up.
          </p>
          <button
            className={myReady ? 'btn-ghost w-full' : 'btn-primary w-full'}
            onClick={() => act(() => api(`/matches/${matchId}/ready`, { body: { ready: !myReady } }))}
          >
            {myReady ? 'Ready ✓ — tap to cancel' : 'I’m ready'}
          </button>
          {match.status === 'in_progress' ? (
            <p className="mt-2 text-center text-xs font-semibold text-volt">
              Both ready — play it now.
            </p>
          ) : null}
        </section>
      ) : null}

      {match.status === 'open' ? (
        <section className="card mb-3">
          <p className="text-sm text-slate-400">
            Your {formatCents(match.stakeCents)} is escrowed and the match is live in the lobby. It
            stays yours until someone joins.
          </p>
          <button
            className="btn-danger mt-3 w-full"
            onClick={() => act(() => api(`/matches/${matchId}/cancel`, { body: {} }), 'Match withdrawn and stake returned.')}
          >
            Withdraw match and refund my stake
          </button>
        </section>
      ) : null}

      {/* Result submission */}
      {['escrowed', 'in_progress', 'awaiting_results'].includes(match.status) && them ? (
        <ResultPanel
          matchId={matchId}
          alreadyReported={myReport}
          policy={policy}
          myScreenshot={screenshots.find((shot) => shot.uploaderId === user.id) ?? null}
          onDone={(message) => {
            setNotice(message);
            void load();
          }}
        />
      ) : null}

      {match.status === 'settled' || match.status === 'voided' ? (
        <section className="card mb-3">
          <p className="label">Final</p>
          <p className="font-display text-3xl font-black tabular-nums">
            {match.creatorScore ?? '–'} – {match.opponentScore ?? '–'}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {match.winnerId === null
              ? 'Draw — both stakes returned in full, no rake taken.'
              : match.winnerId === user.id
                ? `You won ${formatCents(payout.payoutCents)}.`
                : 'Your opponent took the pool.'}
          </p>
        </section>
      ) : null}

      {/* Evidence */}
      {screenshots.length > 0 ? (
        <section className="card mb-3">
          <p className="label">Evidence on file</p>
          <ul className="space-y-2 text-xs">
            {screenshots.map((shot) => (
              <li key={shot.id} className="flex items-center justify-between gap-2">
                <span className="text-slate-400">
                  {shot.uploaderId === user.id ? 'You' : them?.handle ?? 'Opponent'} ·{' '}
                  {new Date(shot.createdAt).toLocaleTimeString()}
                </span>
                <VerdictChip verdict={shot.verdict} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-500">
            Screenshots are hashed on upload and cannot be edited or replaced.
          </p>
        </section>
      ) : null}

      {/* Chat */}
      {them ? (
        <section className="card mb-3">
          <p className="label">Match chat</p>
          <div className="mb-2 max-h-64 space-y-2 overflow-y-auto pr-1">
            {chat.length === 0 ? (
              <p className="text-sm text-slate-500">No messages yet. Say hello, agree the rules.</p>
            ) : (
              chat.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                    message.userId === user.id
                      ? 'ml-auto bg-volt/15 text-emerald-50'
                      : 'bg-pitch-700 text-slate-200'
                  }`}
                >
                  <span className="block text-[10px] uppercase tracking-wider text-slate-400">
                    {message.handle}
                  </span>
                  {message.body}
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
          <form
            className="flex gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!draft.trim()) return;
              const body = draft.trim();
              setDraft('');
              await act(() => api(`/matches/${matchId}/chat`, { body: { body } }));
            }}
          >
            <input
              className="field"
              value={draft}
              maxLength={500}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message your opponent"
            />
            <button className="btn-primary" type="submit">
              Send
            </button>
          </form>
        </section>
      ) : null}

      {/* Escape hatches */}
      {['escrowed', 'in_progress', 'awaiting_results'].includes(match.status) ? (
        <section className="card space-y-2">
          <p className="label">Something went wrong?</p>
          <DisputeButton matchId={matchId} onDone={() => void load()} />
          <button
            className="btn-ghost w-full"
            onClick={() =>
              act(
                () => api(`/matches/${matchId}/forfeit`, { body: {} }),
                'You forfeited — your opponent has been paid.',
              )
            }
          >
            Forfeit and pay my opponent
          </button>
          <p className="text-[11px] text-slate-500">
            Forfeiting is honest and costs you less trust than a dispute you lose.
          </p>
        </section>
      ) : null}

      {detail.disputeId && user.role !== 'player' ? (
        <Link href={`/admin/disputes/${detail.disputeId}`} className="btn-ghost mt-3 w-full">
          Open the moderation case
        </Link>
      ) : null}
    </AppShell>
  );
}

function PlayerCell({
  player,
  ready,
  you,
  online,
}: {
  player: PublicUser | null;
  ready: boolean;
  you?: boolean;
  online?: boolean | null;
}) {
  if (!player) {
    return (
      <div className="rounded-xl border border-dashed border-pitch-500 px-3 py-3 text-center text-xs text-slate-500">
        Waiting for an opponent
      </div>
    );
  }
  return (
    <div className={`rounded-xl border px-3 py-3 ${ready ? 'border-volt/60 bg-volt/5' : 'border-pitch-500'}`}>
      <p className="truncate font-display text-sm font-bold">
        {player.handle}
        {you ? <span className="text-slate-500"> (you)</span> : null}
      </p>
      <p className="truncate text-[11px] text-slate-400">{player.psnId ?? 'no PSN linked'}</p>
      <div className="mt-1 flex items-center gap-2">
        <TrustBadge score={player.trustScore} />
        <span className={`text-[10px] font-bold uppercase ${ready ? 'text-volt' : 'text-slate-500'}`}>
          {ready ? 'Ready' : 'Not ready'}
        </span>
      </div>
      {online === false ? <p className="text-[10px] font-semibold text-danger">Disconnected</p> : null}
    </div>
  );
}

function VerdictChip({ verdict }: { verdict: Screenshot['verdict'] }) {
  const tone: Record<Screenshot['verdict'], string> = {
    pending: 'border-pitch-500 text-slate-400',
    match: 'border-volt/60 text-volt',
    mismatch: 'border-danger/60 text-danger',
    duplicate: 'border-danger/60 text-danger',
    unreadable: 'border-warn/60 text-warn',
  };
  const label: Record<Screenshot['verdict'], string> = {
    pending: 'checking…',
    match: 'verified',
    mismatch: 'does not match report',
    duplicate: 'seen before',
    unreadable: 'could not read',
  };
  return <span className={`rounded-full border px-2 py-0.5 ${tone[verdict]}`}>{label[verdict]}</span>;
}

function ResultPanel({
  matchId,
  alreadyReported,
  policy,
  myScreenshot,
  onDone,
}: {
  matchId: string;
  alreadyReported: MatchResult | null;
  policy: SettlementPolicy;
  myScreenshot: Screenshot | null;
  onDone: (message: string) => void;
}) {
  const [selfScore, setSelfScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [clipUrl, setClipUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let screenshotId = myScreenshot?.id ?? null;
      if (file) {
        const dataBase64 = await toBase64(file);
        const uploaded = await api<{ screenshot: Screenshot }>(`/matches/${matchId}/screenshots`, {
          body: { contentType: file.type, dataBase64 },
        });
        screenshotId = uploaded.screenshot.id;
      }
      const result = await api<{ status: string; detail: string }>(`/matches/${matchId}/result`, {
        body: {
          selfScore,
          opponentScore,
          screenshotId,
          clipUrl: clipUrl.trim() || null,
        },
      });
      onDone(result.detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit the result');
    } finally {
      setBusy(false);
    }
  }

  if (alreadyReported) {
    return (
      <section className="card mb-3">
        <p className="label">Your report</p>
        <p className="font-display text-2xl font-black tabular-nums">
          {alreadyReported.selfScore} – {alreadyReported.opponentScore}
        </p>
        <p className="mt-1 text-sm text-slate-400">
          Submitted. Escrow releases as soon as your opponent’s report agrees.
        </p>
      </section>
    );
  }

  return (
    <section className="card mb-3">
      <p className="label">Report the result</p>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <ScoreInput label="You scored" value={selfScore} onChange={setSelfScore} />
        <ScoreInput label="They scored" value={opponentScore} onChange={setOpponentScore} />
      </div>

      <label className="label" htmlFor="shot">
        Post-match summary screenshot
      </label>
      <input
        id="shot"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="field"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <p className="mt-1 text-xs text-slate-500">
        {policy.requireBothScreenshots
          ? 'Both players must upload one before escrow releases at your trust level.'
          : 'Optional at your trust level, but it settles disputes instantly if one comes up.'}
      </p>

      <label className="label mt-3" htmlFor="clip">
        Clip or share-factory link (optional)
      </label>
      <input
        id="clip"
        className="field"
        value={clipUrl}
        onChange={(event) => setClipUrl(event.target.value)}
        placeholder="https://…"
      />

      {error ? <div className="mt-3"><Banner tone="danger">{error}</Banner></div> : null}

      <button className="btn-primary mt-4 w-full" disabled={busy} onClick={submit}>
        {busy ? 'Submitting…' : 'Submit result'}
      </button>
      <p className="mt-2 text-[11px] text-slate-500">
        Escrow only releases when both reports agree or a moderator rules. Reporting a score you did
        not get costs you trust and can end in a ban.
      </p>
    </section>
  );
}

function ScoreInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <p className="label">{label}</p>
      <div className="flex items-center gap-2">
        <button className="btn-ghost px-3 py-2" onClick={() => onChange(Math.max(0, value - 1))}>
          −
        </button>
        <span className="flex-1 text-center font-display text-3xl font-black tabular-nums">{value}</span>
        <button className="btn-ghost px-3 py-2" onClick={() => onChange(Math.min(99, value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

function DisputeButton({ matchId, onDone }: { matchId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="btn-danger w-full" onClick={() => setOpen(true)}>
        Raise a dispute
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        className="field"
        rows={3}
        value={reason}
        maxLength={1000}
        placeholder="What happened? Be specific — a moderator reads this alongside both screenshots and the chat log."
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="flex gap-2">
        <button className="btn-ghost flex-1" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          className="btn-danger flex-1"
          disabled={reason.trim().length < 5 || busy}
          onClick={async () => {
            setBusy(true);
            await api('/disputes', { body: { matchId, reason: reason.trim() } }).catch(() => undefined);
            setBusy(false);
            setOpen(false);
            onDone();
          }}
        >
          Send to review
        </button>
      </div>
    </div>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
