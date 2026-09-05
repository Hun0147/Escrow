import { pool } from '../db/pool';

/**
 * Operational settings live in the database so compliance and ops can change
 * limits without a deploy. Reads are cached briefly — these are consulted on
 * every deposit and every match creation.
 */
const CACHE_TTL_MS = 10_000;

let cache: Record<string, unknown> = {};
let cachedAt = 0;

export const SETTING_DEFAULTS = {
  rake_bps: 1000,
  pro_rake_bps: 700,
  min_deposit_cents: 500,
  max_deposit_cents: 100_000,
  min_withdrawal_cents: 1000,
  daily_withdrawal_cap_cents: 200_000,
  daily_deposit_cap_cents: 100_000,
  result_deadline_minutes: 10,
  match_start_countdown_seconds: 120,
  min_age: 18,
  kyc_required_before_withdrawal: true,
  pro_subscription_cents: 999,
  pro_subscription_days: 30,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function loadSettings(force = false): Promise<Record<string, unknown>> {
  if (!force && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  const { rows } = await pool.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM platform_settings',
  );
  cache = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  cachedAt = Date.now();
  return cache;
}

export async function getSetting<K extends SettingKey>(
  key: K,
): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const settings = await loadSettings();
  const value = settings[key];
  return (value === undefined ? SETTING_DEFAULTS[key] : value) as (typeof SETTING_DEFAULTS)[K];
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  cachedAt = 0;
}

/** Test helper: drop the cache so a settings change takes effect immediately. */
export function invalidateSettingsCache(): void {
  cachedAt = 0;
}
