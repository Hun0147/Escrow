import { KycRecord } from '@escrow/shared';
import { pool } from '../../db/pool';
import { UserRow, findUserById, updateUser } from '../../db/repos/users.repo';
import { findKycById, listPendingKyc, reviewKyc } from '../../db/repos/misc.repo';
import {
  deleteBlockedRegion,
  listBlockedRegions,
  listOpenFraudFlags,
  logAdminAction,
  upsertBlockedRegion,
} from '../../db/repos/fraud.repo';
import { reconcileWallets } from '../../db/repos/ledger.repo';
import { notFound } from '../../common/errors';
import { loadSettings, setSetting } from '../../common/settings';
import { notify } from '../notifications/notifications.service';
import { addStrike } from '../trust/trust.service';

export async function pendingKyc(): Promise<KycRecord[]> {
  return listPendingKyc();
}

export async function decideKyc(
  moderator: UserRow,
  kycId: string,
  approve: boolean,
  rejectionReason: string | null,
): Promise<KycRecord> {
  const record = await findKycById(kycId);
  if (!record) throw notFound('KYC record');

  const updated = await reviewKyc({
    id: kycId,
    status: approve ? 'approved' : 'rejected',
    reviewedBy: moderator.id,
    rejectionReason: approve ? null : rejectionReason,
  });
  await updateUser(record.userId, { kycStatus: updated.status });
  await notify({
    userId: record.userId,
    type: 'kyc_updated',
    title: approve ? 'Identity verified' : 'Verification needs attention',
    body: approve
      ? 'You can now withdraw funds.'
      : `We could not verify your documents: ${rejectionReason ?? 'please re-submit'}.`,
  });
  await logAdminAction({
    adminId: moderator.id,
    action: approve ? 'kyc_approved' : 'kyc_rejected',
    targetType: 'kyc_record',
    targetId: kycId,
    notes: rejectionReason,
  });
  return updated;
}

export async function banUser(admin: UserRow, userId: string, reason: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw notFound('User');
  await updateUser(userId, { bannedAt: new Date().toISOString() });
  await logAdminAction({
    adminId: admin.id,
    action: 'user_banned',
    targetType: 'user',
    targetId: userId,
    notes: reason,
  });
}

export async function unbanUser(admin: UserRow, userId: string): Promise<void> {
  await updateUser(userId, { bannedAt: null });
  await logAdminAction({
    adminId: admin.id,
    action: 'user_unbanned',
    targetType: 'user',
    targetId: userId,
  });
}

export async function strikeUser(admin: UserRow, userId: string, note: string): Promise<number> {
  const score = await addStrike(userId, note);
  await logAdminAction({
    adminId: admin.id,
    action: 'user_struck',
    targetType: 'user',
    targetId: userId,
    notes: note,
  });
  return score;
}

/** Operator health view: the numbers that say whether the books are sound. */
export async function dashboard() {
  const [{ rows: matchRows }, { rows: disputeRows }, { rows: ledgerRows }, { rows: ocrRows }] =
    await Promise.all([
      pool.query(`SELECT status, COUNT(*) AS count FROM matches GROUP BY status`),
      pool.query(`SELECT status, COUNT(*) AS count FROM disputes GROUP BY status`),
      pool.query(`SELECT account, balance_cents FROM v_ledger_balances ORDER BY account`),
      pool.query(`SELECT status, COUNT(*) AS count FROM ocr_jobs GROUP BY status`),
    ]);

  return {
    matches: Object.fromEntries(matchRows.map((r) => [r.status, Number(r.count)])),
    disputes: Object.fromEntries(disputeRows.map((r) => [r.status, Number(r.count)])),
    ocrJobs: Object.fromEntries(ocrRows.map((r) => [r.status, Number(r.count)])),
    platformRevenueCents: Number(
      ledgerRows.find((r) => r.account === 'platform:revenue')?.balance_cents ?? 0,
    ),
    escrowHeldCents: ledgerRows
      .filter((r) => r.account.startsWith('escrow:'))
      .reduce((total, r) => total + Number(r.balance_cents), 0),
    // Non-empty means a money path wrote the ledger and the wallet cache out of
    // step. It should always be empty.
    reconciliationBreaks: await reconcileWallets(),
    openFraudFlags: await listOpenFraudFlags(25),
    settings: await loadSettings(true),
    blockedRegions: await listBlockedRegions(),
  };
}

export async function updateSetting(admin: UserRow, key: string, value: unknown): Promise<void> {
  await setSetting(key, value);
  await logAdminAction({
    adminId: admin.id,
    action: 'setting_updated',
    targetType: 'setting',
    targetId: key,
    notes: JSON.stringify(value),
  });
}

export async function blockRegion(
  admin: UserRow,
  code: string,
  reason: string,
  minAge: number | null,
): Promise<void> {
  await upsertBlockedRegion({ code, reason, minAge });
  await logAdminAction({
    adminId: admin.id,
    action: 'region_blocked',
    targetType: 'region',
    targetId: code,
    notes: reason,
  });
}

export async function unblockRegion(admin: UserRow, code: string): Promise<void> {
  await deleteBlockedRegion(code);
  await logAdminAction({
    adminId: admin.id,
    action: 'region_unblocked',
    targetType: 'region',
    targetId: code,
  });
}
