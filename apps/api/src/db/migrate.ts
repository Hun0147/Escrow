import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './pool';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Applies every .sql file in migrations/ in filename order, exactly once.
 * Each migration runs inside its own transaction alongside the bookkeeping
 * insert, so a failed migration leaves no partial state and no phantom record.
 */
export async function runMigrations(log: (msg: string) => void = console.log): Promise<string[]> {
  // Two instances booting at once would otherwise race: both read an empty
  // schema_migrations, both try to apply 001, and one dies on a duplicate
  // object. The lock is held on one connection for the whole run and released
  // with it, including if the process dies.
  const gate = await pool.connect();
  try {
    await gate.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    return await applyMigrations(log);
  } finally {
    await gate.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    gate.release();
  }
}

/** Arbitrary but fixed: every deployment of this app must agree on it. */
const MIGRATION_LOCK_KEY = 2709_2027;

async function applyMigrations(log: (msg: string) => void): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`applied ${file}`);
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  if (newlyApplied.length === 0) log('database already up to date');
  return newlyApplied;
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
