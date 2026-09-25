import { GAME_MODE_LABELS, formatCents } from '@escrow/shared';
import type { GameMode, MatchStatus } from '@escrow/shared';

export { formatCents, GAME_MODE_LABELS };

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  open: 'Waiting for opponent',
  escrowed: 'Both stakes escrowed',
  in_progress: 'Playing now',
  awaiting_results: 'Reporting',
  disputed: 'Under review',
  settled: 'Settled',
  voided: 'Voided',
  cancelled: 'Cancelled',
};

/** Status colour carries meaning: green is money moving your way, amber is
 *  waiting on someone, red is stuck. */
export const MATCH_STATUS_TONE: Record<MatchStatus, string> = {
  open: 'text-cyanline',
  escrowed: 'text-volt',
  in_progress: 'text-volt',
  awaiting_results: 'text-warn',
  disputed: 'text-danger',
  settled: 'text-slate-400',
  voided: 'text-slate-400',
  cancelled: 'text-slate-500',
};

export function modeLabel(mode: GameMode): string {
  return GAME_MODE_LABELS[mode] ?? mode;
}

export function trustTone(score: number): string {
  if (score >= 75) return 'text-volt';
  if (score >= 40) return 'text-warn';
  return 'text-danger';
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function countdown(toIso: string | null): string | null {
  if (!toIso) return null;
  const remaining = Math.round((new Date(toIso).getTime() - Date.now()) / 1000);
  if (remaining <= 0) return 'overdue';
  const minutes = Math.floor(remaining / 60);
  return `${minutes}:${String(remaining % 60).padStart(2, '0')}`;
}
