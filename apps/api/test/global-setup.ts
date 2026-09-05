import { runMigrations } from '../src/db/migrate';
import { pool } from '../src/db/pool';

/** Applies migrations once before the suite runs. */
export default async function globalSetup(): Promise<void> {
  await runMigrations(() => undefined);
  await pool.end();
}
