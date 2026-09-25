import { KycRecord, SelfUser, SkillTier } from '@escrow/shared';
import {
  UserRow,
  findUserById,
  findUserByPsnId,
  toSelfUser,
  updateUser,
} from '../../db/repos/users.repo';
import { insertKycRecord, latestKycForUser } from '../../db/repos/misc.repo';
import { pool } from '../../db/pool';
import { assertEligible } from '../../common/geo';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';

export async function linkPsnId(user: UserRow, psnId: string): Promise<SelfUser> {
  const existing = await findUserByPsnId(psnId);
  if (existing && existing.id !== user.id) {
    throw conflict('psn_taken', 'That PSN ID is already linked to another account');
  }
  // A PSN ID is the identity opponents actually verify in-game. Letting a
  // player swap it freely would let them dodge a bad reputation, so it can be
  // set once and afterwards only changed by support.
  if (user.psnId && user.psnId.toLowerCase() !== psnId.toLowerCase()) {
    throw forbidden('psn_locked', 'Contact support to change a linked PSN ID');
  }
  return toSelfUser(await updateUser(user.id, { psnId }));
}

export async function setSkillTier(userId: string, skillTier: SkillTier): Promise<SelfUser> {
  return toSelfUser(await updateUser(userId, { skillTier }));
}

/**
 * Mock verification. A real deployment sends a code by email/SMS and verifies
 * it here; the rest of the platform only cares about the resulting flags, so
 * swapping the provider in does not touch any other module.
 */
export async function markEmailVerified(userId: string): Promise<SelfUser> {
  return toSelfUser(await updateUser(userId, { emailVerified: true }));
}

export async function markPhoneVerified(userId: string, phone: string): Promise<SelfUser> {
  return toSelfUser(await updateUser(userId, { phone, phoneVerified: true }));
}

export interface KycSubmission {
  documentType: string;
  documentRef: string;
  selfieRef: string;
  addressCountry: string;
  addressRegion: string | null;
}

export async function submitKyc(user: UserRow, submission: KycSubmission): Promise<KycRecord> {
  if (user.kycStatus === 'approved') {
    throw conflict('kyc_already_approved', 'This account is already verified');
  }
  if (!user.dateOfBirth) throw badRequest('missing_dob', 'Date of birth is required');

  // The KYC address is the authoritative jurisdiction — an IP can be tunnelled,
  // a verified address cannot.
  await assertEligible({
    countryCode: submission.addressCountry,
    regionCode: submission.addressRegion,
    dateOfBirth: user.dateOfBirth,
  });

  const record = await insertKycRecord({ userId: user.id, ...submission });
  await updateUser(user.id, {
    kycStatus: 'pending',
    countryCode: submission.addressCountry.toUpperCase(),
    regionCode: submission.addressRegion ? submission.addressRegion.toUpperCase() : null,
  });
  return record;
}

export async function getKycStatus(userId: string): Promise<KycRecord | null> {
  return latestKycForUser(userId);
}

export interface ResponsiblePlaySettings {
  depositLimitDailyCents?: number | null;
  lossLimitDailyCents?: number | null;
  sessionReminderMinutes?: number | null;
}

/**
 * Responsible-play limits ratchet one way: tightening takes effect at once,
 * loosening is refused. A player in the middle of a bad session must not be
 * able to raise their own limit to keep going.
 */
export async function updateResponsiblePlay(
  user: UserRow,
  settings: ResponsiblePlaySettings,
): Promise<SelfUser> {
  const current = await findUserById(user.id);
  if (!current) throw notFound('User');
  const currentRow = await rawLimits(user.id);

  const patch: ResponsiblePlaySettings = {};
  for (const key of ['depositLimitDailyCents', 'lossLimitDailyCents'] as const) {
    const next = settings[key];
    if (next === undefined) continue;
    const existing = currentRow[key];
    if (next === null && existing !== null) {
      throw forbidden('limit_ratchet', 'Removing a limit requires a 24-hour cool-off — contact support');
    }
    if (next !== null && existing !== null && next > existing) {
      throw forbidden('limit_ratchet', 'Limits can be lowered immediately, but not raised');
    }
    patch[key] = next;
  }
  if (settings.sessionReminderMinutes !== undefined) {
    patch.sessionReminderMinutes = settings.sessionReminderMinutes;
  }

  return toSelfUser(await updateUser(user.id, patch));
}

async function rawLimits(userId: string): Promise<{
  depositLimitDailyCents: number | null;
  lossLimitDailyCents: number | null;
}> {
  const { rows } = await pool.query(
    'SELECT deposit_limit_daily_cents, loss_limit_daily_cents FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw notFound('User');
  return {
    depositLimitDailyCents:
      rows[0].deposit_limit_daily_cents === null ? null : Number(rows[0].deposit_limit_daily_cents),
    lossLimitDailyCents:
      rows[0].loss_limit_daily_cents === null ? null : Number(rows[0].loss_limit_daily_cents),
  };
}

/** Self-exclusion is absolute for its duration: no deposits, no matches. */
export async function selfExclude(userId: string, days: number): Promise<SelfUser> {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw badRequest('invalid_period', 'Self-exclusion must be between 1 and 3650 days');
  }
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  return toSelfUser(await updateUser(userId, { selfExcludedUntil: until }));
}

export async function startCoolOff(userId: string, hours: number): Promise<SelfUser> {
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw badRequest('invalid_period', 'Cool-off must be between 1 and 720 hours');
  }
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  return toSelfUser(await updateUser(userId, { coolOffUntil: until }));
}
