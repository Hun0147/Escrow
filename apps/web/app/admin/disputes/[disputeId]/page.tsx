'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { describeRules } from '@escrow/shared';
import type {
  ChatMessage,
  Dispute,
  DisputeResolution,
  Match,
  MatchResult,
  PublicUser,
  Screenshot,
} from '@escrow/shared';
import { API_URL, ApiError, api, getToken } from '../../../../lib/api';
import { formatCents, modeLabel, relativeTime } from '../../../../lib/format';
import { useRequireSession } from '../../../../components/SessionProvider';
import { AppShell } from '../../../../components/AppShell';
import { Banner, Empty, SectionTitle, Spinner, TrustBadge } from '../../../../components/ui';

interface CaseFile {
  dispute: Dispute;
  match: Match;
  creator: PublicUser;
  opponent: PublicUser | null;
  results: MatchResult[];
  screenshots: Screenshot[];
  chat: ChatMessage[];
  history: { userId: string; disputes: number; disputesLost: number; strikes: number }[];
}

const RESOLUTIONS: { value: DisputeResolution; label: string; hint: string; tone: string }[] = [
  { value: 'creator_wins', label: 'Creator wins', hint: 'Release the pool to the match creator', tone: 'btn-primary' },
  { value: 'opponent_wins', label: 'Opponent wins', hint: 'Release the pool to the opponent', tone: 'btn-primary' },
  { value: 'void_refund', label: 'Void and refund', hint: 'Return both stakes, take no fee', tone: 'btn-ghost' },
  { value: 'replay', label: 'Order a replay', hint: 'Refund both and let them run it back', tone: 'btn-ghost' },
  { value: 'dismissed', label: 'Dismiss', hint: 'Reopen reporting with a fresh deadline', tone: 'btn-ghost' },
];

export default function DisputeCasePage() {
  const { disputeId } = useParams<{ disputeId: string }>();
  const router = useRouter();
  const { user, loading } = useRequireSession();
  const [file, setFile] = useState<CaseFile | null>(null);
  const [resolution, setResolution] = useState<DisputeResolution | null>(null);
  const [notes, setNotes] = useState('');
  const [strikeUserId, setStrikeUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFile(await api<CaseFile>(`/disputes/${disputeId}`));
  }, [disputeId]);

  useEffect(() => {
    if (!user || user.role === 'player') return;
    void load().catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the case'));
  }, [user, load]);

  if (loading || !user) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }
  if (user.role === 'player') {
    return (
      <AppShell>
        <Empty title="Staff only" />
      </AppShell>
    );
  }
  if (!file) {
    return (
      <AppShell>
        {error ? <Banner tone="danger">{error}</Banner> : <Spinner label="Opening the case" />}
      </AppShell>
    );
  }

  const { match, creator, opponent, results, screenshots, chat, history, dispute } = file;
  const pool = match.stakeCents * 2;
  const fee = Math.round((pool * match.escrowFeeBps) / 10000);

  const reportFor = (userId: string) => results.find((result) => result.reporterId === userId) ?? null;
  const historyFor = (userId: string) => history.find((entry) => entry.userId === userId);

  async function rule() {
    if (!resolution) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/disputes/${disputeId}/resolve`, {
        body: { resolution, notes: notes.trim(), strikeUserId },
      });
      router.push('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the ruling');
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1 className="font-display text-2xl font-black">Dispute</h1>
      <p className="mb-4 text-sm text-slate-400">{dispute.reason}</p>

      {dispute.status === 'resolved' ? (
        <div className="mb-3">
          <Banner tone="good">
            Already ruled: {dispute.resolution}. {dispute.resolutionNotes}
          </Banner>
        </div>
      ) : null}
      {error ? <div className="mb-3"><Banner tone="danger">{error}</Banner></div> : null}

      <section className="card mb-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-slate-400">{modeLabel(match.gameMode)}</span>
          <span className="stake">{formatCents(pool)}</span>
        </div>
        <p className="text-xs text-slate-500">
          {formatCents(match.stakeCents)} each · escrow fee {formatCents(fee)} · winner takes{' '}
          {formatCents(pool - fee)}
        </p>
        <p className="mt-2 text-xs text-slate-400">{describeRules(match.rules)}</p>
        {match.rules.notes ? <p className="text-xs text-slate-300">“{match.rules.notes}”</p> : null}
      </section>

      <SectionTitle>The two claims</SectionTitle>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {[creator, opponent].map((player, index) =>
          player ? (
            <div key={player.id} className="card">
              <p className="truncate font-display font-bold">{player.handle}</p>
              <p className="truncate text-[11px] text-slate-400">{player.psnId ?? 'no PSN'}</p>
              <div className="mt-1">
                <TrustBadge score={player.trustScore} />
              </div>
              <p className="mt-2 font-display text-2xl font-black tabular-nums">
                {reportFor(player.id)
                  ? `${reportFor(player.id)!.selfScore}–${reportFor(player.id)!.opponentScore}`
                  : 'no report'}
              </p>
              <p className="text-[11px] uppercase tracking-wider text-slate-500">
                {index === 0 ? 'creator' : 'opponent'} claim
              </p>
              <p className="mt-2 text-[11px] text-slate-500">
                {historyFor(player.id)?.disputes ?? 0} disputes ·{' '}
                {historyFor(player.id)?.disputesLost ?? 0} lost · {historyFor(player.id)?.strikes ?? 0} strikes
              </p>
            </div>
          ) : (
            <div key="none" className="card text-sm text-slate-500">
              No opponent
            </div>
          ),
        )}
      </div>

      <SectionTitle>Evidence</SectionTitle>
      {screenshots.length === 0 ? (
        <Empty title="No screenshots on file" hint="Neither player uploaded evidence." />
      ) : (
        <div className="mb-4 space-y-3">
          {screenshots.map((shot) => (
            <div key={shot.id} className="card">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  {shot.uploaderId === creator.id ? creator.handle : opponent?.handle ?? 'opponent'} ·{' '}
                  {relativeTime(shot.createdAt)}
                </span>
                <span
                  className={
                    shot.verdict === 'match'
                      ? 'text-volt'
                      : shot.verdict === 'pending'
                        ? 'text-slate-400'
                        : 'text-danger'
                  }
                >
                  {shot.verdict}
                </span>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${API_URL}/evidence/${shot.id}?token=${encodeURIComponent(getToken() ?? '')}`}
                alt="Post-match summary"
                className="w-full rounded-lg border border-pitch-600"
              />
              <dl className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                <div>
                  <dt className="text-slate-500">OCR scoreline</dt>
                  <dd>
                    {shot.ocrHomeScore ?? '?'}–{shot.ocrAwayScore ?? '?'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">OCR gamertags</dt>
                  <dd>
                    {shot.ocrHomeTag ?? '?'} vs {shot.ocrAwayTag ?? '?'}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-slate-500">SHA-256</dt>
                  <dd className="break-all font-mono text-[10px]">{shot.sha256}</dd>
                </div>
                {shot.duplicateOfId ? (
                  <div className="col-span-2 text-danger">
                    Perceptual match to an earlier screenshot ({shot.duplicateOfId.slice(0, 8)}…)
                  </div>
                ) : null}
              </dl>
            </div>
          ))}
        </div>
      )}

      <SectionTitle>Chat log</SectionTitle>
      {chat.length === 0 ? (
        <Empty title="No messages" />
      ) : (
        <div className="card mb-4 max-h-72 space-y-2 overflow-y-auto">
          {chat.map((message) => (
            <p key={message.id} className="text-sm">
              <span className="text-[11px] uppercase tracking-wider text-slate-500">{message.handle}: </span>
              {message.body}
            </p>
          ))}
        </div>
      )}

      {dispute.status !== 'resolved' ? (
        <section className="card">
          <SectionTitle>Ruling</SectionTitle>
          <div className="mb-3 space-y-2">
            {RESOLUTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setResolution(option.value)}
                className={`w-full rounded-xl border px-3 py-2 text-left ${
                  resolution === option.value ? 'border-volt bg-volt/10' : 'border-pitch-500'
                }`}
              >
                <span className="block text-sm font-semibold">{option.label}</span>
                <span className="block text-xs text-slate-500">{option.hint}</span>
              </button>
            ))}
          </div>

          <label className="label" htmlFor="notes">
            Reasoning (kept on the audit log)
          </label>
          <textarea
            id="notes"
            className="field"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="What the evidence shows and why this ruling follows from it."
          />

          <div className="mt-3">
            <p className="label">Issue a strike (optional)</p>
            <div className="flex gap-2">
              {[creator, opponent].filter(Boolean).map((player) => (
                <button
                  key={player!.id}
                  className={`chip ${strikeUserId === player!.id ? 'chip-active' : ''}`}
                  onClick={() => setStrikeUserId(strikeUserId === player!.id ? null : player!.id)}
                >
                  {player!.handle}
                </button>
              ))}
            </div>
          </div>

          <button
            className="btn-primary mt-4 w-full"
            disabled={!resolution || notes.trim().length < 5 || busy}
            onClick={rule}
          >
            {busy ? 'Recording…' : 'Record ruling and release escrow'}
          </button>
        </section>
      ) : null}
    </AppShell>
  );
}
