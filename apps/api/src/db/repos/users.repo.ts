import { Pool, PoolClient } from 'pg';
import { KycStatus, PublicUser, SelfUser, SkillTier, SubscriptionTier, UserRole } from '@escrow/shared';
import { pool } from '../pool';

export type Queryable = Pool | PoolClient;

export interface UserRow extends SelfUser {
  passwordHash: string;
}

export function mapUser(row: any): UserRow {
  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    emailVerified: row.email_verified,
    phone: row.phone,
    phoneVerified: row.phone_verified,
    psnId: row.psn_id,
    skillTier: row.skill_tier,
    dateOfBirth: row.date_of_birth ? toDateString(row.date_of_birth) : null,
    countryCode: row.country_code,
    subscriptionTier: row.subscription_tier,
    kycStatus: row.kyc_status,
    trustScore: row.trust_score,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    strikes: row.strikes,
    bannedAt: row.banned_at ? row.banned_at.toISOString() : null,
    selfExcludedUntil: row.self_excluded_until ? row.self_excluded_until.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function toDateString(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
}

export function toPublicUser(user: UserRow | SelfUser): PublicUser {
  return {
    id: user.id,
    handle: user.handle,
    psnId: user.psnId,
    skillTier: user.skillTier,
    trustScore: user.trustScore,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
    subscriptionTier: user.subscriptionTier,
    createdAt: user.createdAt,
  };
}

export function toSelfUser(user: UserRow): SelfUser {
  const { passwordHash, ...rest } = user;
  return rest;
}

export interface CreateUserParams {
  handle: string;
  email: string;
  passwordHash: string;
  dateOfBirth: string;
  countryCode: string;
  regionCode?: string | null;
  psnId?: string | null;
  phone?: string | null;
  role?: UserRole;
  signupIp?: string | null;
}

export async function insertUser(params: CreateUserParams, db: Queryable = pool): Promise<UserRow> {
  const { rows } = await db.query(
    `INSERT INTO users (handle, email, password_hash, date_of_birth, country_code, region_code,
                        psn_id, phone, role, signup_ip, last_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING *`,
    [
      params.handle,
      params.email,
      params.passwordHash,
      params.dateOfBirth,
      params.countryCode,
      params.regionCode ?? null,
      params.psnId ?? null,
      params.phone ?? null,
      params.role ?? 'player',
      params.signupIp ?? null,
    ],
  );
  return mapUser(rows[0]);
}

export async function findUserById(id: string, db: Queryable = pool): Promise<UserRow | null> {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserByEmail(email: string, db: Queryable = pool): Promise<UserRow | null> {
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserByHandle(handle: string, db: Queryable = pool): Promise<UserRow | null> {
  const { rows } = await db.query('SELECT * FROM users WHERE lower(handle) = lower($1)', [handle]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserByPsnId(psnId: string, db: Queryable = pool): Promise<UserRow | null> {
  const { rows } = await db.query('SELECT * FROM users WHERE lower(psn_id) = lower($1)', [psnId]);
  return rows[0] ? mapUser(rows[0]) : null;
}

const UPDATABLE: Record<string, string> = {
  handle: 'handle',
  psnId: 'psn_id',
  phone: 'phone',
  phoneVerified: 'phone_verified',
  emailVerified: 'email_verified',
  skillTier: 'skill_tier',
  kycStatus: 'kyc_status',
  subscriptionTier: 'subscription_tier',
  trustScore: 'trust_score',
  strikes: 'strikes',
  bannedAt: 'banned_at',
  role: 'role',
  countryCode: 'country_code',
  regionCode: 'region_code',
  depositLimitDailyCents: 'deposit_limit_daily_cents',
  lossLimitDailyCents: 'loss_limit_daily_cents',
  sessionReminderMinutes: 'session_reminder_minutes',
  selfExcludedUntil: 'self_excluded_until',
  coolOffUntil: 'cool_off_until',
  lastIp: 'last_ip',
};

export interface UserPatch {
  handle?: string;
  psnId?: string | null;
  phone?: string | null;
  phoneVerified?: boolean;
  emailVerified?: boolean;
  skillTier?: SkillTier;
  kycStatus?: KycStatus;
  subscriptionTier?: SubscriptionTier;
  trustScore?: number;
  strikes?: number;
  bannedAt?: string | null;
  role?: UserRole;
  countryCode?: string;
  regionCode?: string | null;
  depositLimitDailyCents?: number | null;
  lossLimitDailyCents?: number | null;
  sessionReminderMinutes?: number | null;
  selfExcludedUntil?: string | null;
  coolOffUntil?: string | null;
  lastIp?: string | null;
}

/** Builds a partial UPDATE from whichever keys are actually present. */
export async function updateUser(id: string, patch: UserPatch, db: Queryable = pool): Promise<UserRow> {
  const keys = Object.keys(patch).filter((key) => key in UPDATABLE);
  if (keys.length === 0) {
    const existing = await findUserById(id, db);
    if (!existing) throw new Error('User not found');
    return existing;
  }
  const assignments = keys.map((key, index) => `${UPDATABLE[key]} = $${index + 2}`);
  const values = keys.map((key) => (patch as Record<string, unknown>)[key]);
  const { rows } = await db.query(
    `UPDATE users SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error('User not found');
  return mapUser(rows[0]);
}

export async function bumpRecord(
  userId: string,
  field: 'wins' | 'losses' | 'draws',
  db: Queryable = pool,
): Promise<void> {
  await db.query(`UPDATE users SET ${field} = ${field} + 1 WHERE id = $1`, [userId]);
}

/** Locks two user rows in a stable order, so two concurrent settlements
 *  touching the same pair can never deadlock against each other. */
export async function lockUsers(ids: string[], db: Queryable): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return;
  await db.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [unique]);
}
