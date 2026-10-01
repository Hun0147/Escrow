/**
 * The API as a serverless function.
 *
 * This exists so the client can be demonstrated end to end without a
 * container host. It is **not** the real deployment, and the difference is not
 * cosmetic:
 *
 *   - No Socket.io. A function has no connection to hold open, so the lobby,
 *     chat, ready state and countdowns do not update live. The product is
 *     built to degrade here rather than break — every one of those screens
 *     still works on a reload — but it is a worse product.
 *   - No background workers. Nothing drains the OCR queue, releases a
 *     settlement hold, or escalates a lapsed reporting deadline. Escrow is
 *     never lost, and nothing settles that should not; it simply waits.
 *
 * Everything that moves money still goes through the same HTTP paths, the
 * same transactions and the same invariants. Use `apps/api/Dockerfile` for
 * anything real.
 */
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';

const app = createApp();

// A cold start is the only hook a function gets, so it is where the schema is
// brought up to date. The migration runner takes an advisory lock, so several
// cold starts at once are safe.
let migrated: Promise<unknown> | null = null;
function ensureMigrated() {
  if (process.env.MIGRATE_ON_BOOT !== '1') return Promise.resolve();
  if (!migrated) {
    migrated = runMigrations(() => undefined).catch((err) => {
      // Let the next invocation try again rather than caching a failure for
      // the life of the instance.
      migrated = null;
      throw err;
    });
  }
  return migrated;
}

export default async function handler(req: unknown, res: unknown) {
  await ensureMigrated();
  return (app as unknown as (a: unknown, b: unknown) => void)(req, res);
}
