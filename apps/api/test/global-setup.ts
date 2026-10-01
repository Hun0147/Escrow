import { Client } from 'pg';
import { runMigrations } from '../src/db/migrate';
import { pool } from '../src/db/pool';

/**
 * Prepares the test database once, before the suite runs.
 *
 * The suite talks to a real PostgreSQL — the money paths are only meaningful
 * if the transactions, row locks and constraints are real — so this creates
 * the database if it is missing and applies the migrations. The point is that
 * `npm test` works from a clean checkout with nothing but a running Postgres,
 * and that when it can't, it says so in one line instead of a Jest stack
 * trace.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  // The suite truncates every table between cases, so pointing it at anything
  // but a throwaway database destroys data. Refuse rather than discover it.
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `Refusing to run the suite against "${databaseName}": it truncates every table.\n` +
        `  Point TEST_DATABASE_URL at a database whose name contains "test".`,
    );
  }

  await ensureDatabaseExists(url);
  await resetSchema();
  await runMigrations(() => undefined);
  await snapshotSeededConfig();
  await pool.end();
}

/**
 * Rebuilds the schema from the migrations on every run.
 *
 * Applying only the new migrations would be faster, but the suite is allowed
 * to change configuration rows, so a database carried over from a previous run
 * holds whatever the last test left behind — and a migration's seed insert is
 * ON CONFLICT DO NOTHING, so it never corrects it. Starting from nothing makes
 * the fixture below exactly what the migrations produce.
 */
async function resetSchema(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

/**
 * Configuration lives in tables (`platform_settings`, `blocked_regions`) that
 * the migrations seed and tests are allowed to change. Rather than re-reading
 * one migration file — which silently misses every setting a later migration
 * adds — the freshly migrated state is copied here, and `test/setup.ts`
 * restores each test from that copy.
 */
const CONFIG_TABLES = ['platform_settings', 'blocked_regions'] as const;

async function snapshotSeededConfig(): Promise<void> {
  for (const table of CONFIG_TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${snapshotOf(table)}`);
    await pool.query(`CREATE TABLE ${snapshotOf(table)} AS TABLE ${table}`);
  }
}

function snapshotOf(table: string): string {
  return `test_seed_${table}`;
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const parsed = new URL(url);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  const probe = new Client({ connectionString: url });
  try {
    await probe.connect();
    await probe.end();
    return;
  } catch (err) {
    await probe.end().catch(() => undefined);
    const code = (err as { code?: string }).code;

    // 3D000 is "database does not exist" — the one failure we can fix here.
    if (code !== '3D000') throw explain(err as Error, parsed, databaseName);

    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    try {
      await admin.connect();
      // Identifiers cannot be parameterised; the name comes from our own
      // DATABASE_URL, and quoting it keeps a surprising one from breaking out.
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    } catch (createErr) {
      throw explain(createErr as Error, parsed, databaseName);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }
}

function explain(err: Error, parsed: URL, databaseName: string): Error {
  const code = (err as { code?: string }).code;
  const where = `${parsed.hostname}:${parsed.port || 5432}`;

  if (code === 'ECONNREFUSED') {
    return new Error(
      `Cannot reach PostgreSQL at ${where}. Start it, then re-run.\n` +
        `  Linux:  sudo service postgresql start\n` +
        `  macOS:  brew services start postgresql\n` +
        `  Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=escrow -e POSTGRES_USER=escrow -e POSTGRES_DB=escrow_test postgres:16`,
    );
  }
  if (code === '28P01' || code === '28000') {
    return new Error(
      `PostgreSQL at ${where} rejected the credentials in DATABASE_URL.\n` +
        `  Create the role with: createuser ${parsed.username} --pwprompt --createdb`,
    );
  }
  if (code === '42501') {
    return new Error(
      `The role "${parsed.username}" is not allowed to create the "${databaseName}" database.\n` +
        `  Either grant it: ALTER ROLE ${parsed.username} CREATEDB;\n` +
        `  or create it by hand: createdb ${databaseName} -O ${parsed.username}`,
    );
  }
  return new Error(`Could not prepare the test database "${databaseName}" at ${where}: ${err.message}`);
}
