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

  await ensureDatabaseExists(url);
  await runMigrations(() => undefined);
  await pool.end();
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
