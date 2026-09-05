import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from '../src/db/pool';
import { invalidateSettingsCache } from '../src/common/settings';
import { setMatchmakingQueue } from '../src/queue/matchmaking';
import { setEvidenceStore } from '../src/storage';
import { setOcrEngine } from '../src/ocr/engine';

// Configuration is seeded by a migration; tests are allowed to change it, so
// it is wiped and re-seeded rather than left to leak between cases.
const SEED_SQL = readFileSync(
  join(__dirname, '../src/db/migrations/002_seed_settings.sql'),
  'utf8',
);


const TABLES = [
  'admin_actions',
  'fraud_flags',
  'payment_intents',
  'payment_methods',
  'device_fingerprints',
  'tournament_matches',
  'tournament_entries',
  'tournaments',
  'chat_messages',
  'notifications',
  'kyc_records',
  'trust_events',
  'disputes',
  'match_results',
  'ocr_jobs',
  'screenshots',
  'matches',
  'ledger_entries',
  'ledger_transactions',
  'wallets',
  'users',
];

beforeEach(async () => {
  // The ledger's append-only trigger blocks DELETE but not TRUNCATE, which is
  // exactly the distinction we want: no application path can rewrite history,
  // but a test fixture can start from an empty book.
  await pool.query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query('TRUNCATE TABLE platform_settings, blocked_regions');
  await pool.query(SEED_SQL);
  invalidateSettingsCache();
  setMatchmakingQueue(null);
  setEvidenceStore(null);
  setOcrEngine(null);
});

afterAll(async () => {
  await pool.end();
});
