import { pool } from '../db/pool';
import { findUserById } from '../db/repos/users.repo';
import { realtime } from './bus';

/**
 * Session-time reminders.
 *
 * A player who has asked to be nudged every N minutes gets one push per N
 * minutes of *continuous presence*, not per connection: opening a second tab
 * must not double the reminders, and closing one must not reset the clock. The
 * session ends when their last socket goes away.
 */
interface Session {
  startedAt: number;
  connections: number;
  timer: NodeJS.Timeout | null;
  intervalMinutes: number;
}

const sessions = new Map<string, Session>();

/**
 * Starts (or joins) a player's presence clock.
 *
 * Split from `openSession` so the timing rules can be tested without a
 * database round trip — fake timers and a live connection pool do not mix.
 */
export function startSessionClock(userId: string, intervalMinutes: number | null): void {
  const existing = sessions.get(userId);
  if (existing) {
    existing.connections += 1;
    return;
  }

  const session: Session = {
    startedAt: Date.now(),
    connections: 1,
    timer: null,
    intervalMinutes: intervalMinutes ?? 0,
  };
  sessions.set(userId, session);

  if (!intervalMinutes || intervalMinutes <= 0) return; // not asked for

  session.timer = setInterval(
    () => {
      const current = sessions.get(userId);
      if (!current) return;
      realtime.toUser(userId, 'session:reminder', {
        elapsedMinutes: Math.round((Date.now() - current.startedAt) / 60_000),
        intervalMinutes,
        at: new Date().toISOString(),
      });
    },
    intervalMinutes * 60_000,
  );
  // A reminder timer must never be the reason the process stays alive.
  session.timer.unref();
}

export async function openSession(userId: string): Promise<void> {
  // A second tab joins the existing session; only the first one needs the
  // lookup.
  if (sessions.has(userId)) {
    startSessionClock(userId, null);
    return;
  }
  const user = await findUserById(userId);
  if (!user) return;
  startSessionClock(userId, await reminderMinutes(userId));
}

export function closeSession(userId: string): void {
  const session = sessions.get(userId);
  if (!session) return;
  session.connections -= 1;
  if (session.connections > 0) return;
  if (session.timer) clearInterval(session.timer);
  sessions.delete(userId);
}

export function sessionMinutes(userId: string): number | null {
  const session = sessions.get(userId);
  return session ? Math.round((Date.now() - session.startedAt) / 60_000) : null;
}

async function reminderMinutes(userId: string): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT session_reminder_minutes FROM users WHERE id = $1',
    [userId],
  );
  const value = rows[0]?.session_reminder_minutes;
  return value === null || value === undefined ? null : Number(value);
}

/** Test/shutdown helper: drop every tracked session and its timer. */
export function clearSessions(): void {
  for (const session of sessions.values()) {
    if (session.timer) clearInterval(session.timer);
  }
  sessions.clear();
}
