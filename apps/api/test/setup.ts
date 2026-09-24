import { pool } from '../src/db/pool';
import { invalidateSettingsCache } from '../src/common/settings';
import { setMatchmakingQueue } from '../src/queue/matchmaking';
import { setEvidenceStore } from '../src/storage';
import { setOcrEngine } from '../src/ocr/engine';
import { setPaymentProvider } from '../src/payments';
import { setDiscordClient } from '../src/discord/client';
import { stopDiscordRelay } from '../src/discord/relay';

// Configuration is seeded by the migrations; tests are allowed to change it,
// so it is wiped and restored rather than left to leak between cases. The
// fixture is the copy `test/global-setup.ts` takes once the migrations have
// run — reading one migration file instead would quietly miss every setting a
// later migration adds.
const CONFIG_RESTORE = [
  'TRUNCATE TABLE platform_settings, blocked_regions',
  'INSERT INTO platform_settings SELECT * FROM test_seed_platform_settings',
  'INSERT INTO blocked_regions SELECT * FROM test_seed_blocked_regions',
].join('; ');

const TABLES = [
  'payment_events',
  'subscriptions',
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
  await pool.query(CONFIG_RESTORE);
  invalidateSettingsCache();
  setMatchmakingQueue(null);
  setEvidenceStore(null);
  setOcrEngine(null);
  setPaymentProvider(null);
  stopDiscordRelay();
  setDiscordClient(null);
});

afterAll(async () => {
  await pool.end();
});
