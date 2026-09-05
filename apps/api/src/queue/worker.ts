import { drainOcrQueue } from './ocr-worker';
import { sweepLapsedMatches } from '../modules/results/results.service';
import { sweepRenewals } from '../modules/subscriptions/subscriptions.service';

const OCR_INTERVAL_MS = 2_000;
const DEADLINE_INTERVAL_MS = 30_000;
const RENEWAL_INTERVAL_MS = 300_000;

/**
 * Background jobs.
 *
 * Two loops: drain the OCR queue, and escalate matches whose reporting window
 * has closed. Both are idempotent and safe to run in several processes at once
 * (the OCR queue claims jobs with SKIP LOCKED; the deadline sweep only touches
 * matches still in `awaiting_results`).
 */
export function startWorkers(): () => void {
  const timers: NodeJS.Timeout[] = [];

  timers.push(
    loop(OCR_INTERVAL_MS, async () => {
      await drainOcrQueue();
    }),
  );
  timers.push(
    loop(DEADLINE_INTERVAL_MS, async () => {
      const escalated = await sweepLapsedMatches();
      if (escalated.length > 0) {
        console.log(`Escalated ${escalated.length} match(es) past their reporting deadline`);
      }
    }),
  );

  timers.push(
    loop(RENEWAL_INTERVAL_MS, async () => {
      const { renewed, closed } = await sweepRenewals();
      if (renewed.length || closed.length) {
        console.log(`Subscriptions: ${renewed.length} renewed, ${closed.length} closed`);
      }
    }),
  );

  return () => timers.forEach(clearInterval);
}

function loop(intervalMs: number, work: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap a slow pass with the next tick
    running = true;
    try {
      await work();
    } catch (err) {
      console.error('Worker pass failed:', err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
