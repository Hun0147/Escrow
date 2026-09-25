import bcrypt from 'bcryptjs';
import { GameMode, SelfUser } from '@escrow/shared';
import { UserRow, findUserById, insertUser, updateUser } from '../src/db/repos/users.repo';
import { createWallet } from '../src/db/repos/ledger.repo';
import { withTransaction } from '../src/db/transaction';
import { creditDeposit } from '../src/modules/wallet/money.service';
import { recordDevice, recordPaymentMethod } from '../src/db/repos/fraud.repo';

let counter = 0;

export interface MakeUserOptions {
  handle?: string;
  email?: string;
  psnId?: string | null;
  dateOfBirth?: string;
  countryCode?: string;
  regionCode?: string | null;
  role?: 'player' | 'moderator' | 'admin';
  emailVerified?: boolean;
  balanceCents?: number;
  trustScore?: number;
  kycApproved?: boolean;
  subscriptionTier?: 'free' | 'pro';
}

/** A ready-to-play account: verified, PSN linked, funded. */
export async function makeUser(options: MakeUserOptions = {}): Promise<UserRow> {
  counter += 1;
  const handle = options.handle ?? `player${counter}`;
  const user = await insertUser({
    handle,
    email: options.email ?? `${handle}@example.test`,
    passwordHash: await bcrypt.hash('correct-horse-battery', 4),
    dateOfBirth: options.dateOfBirth ?? '1995-06-15',
    countryCode: options.countryCode ?? 'GB',
    regionCode: options.regionCode ?? null,
    psnId: options.psnId === undefined ? `${handle}_psn` : options.psnId,
    role: options.role ?? 'player',
  });
  await createWallet(user.id);

  const patch: Record<string, unknown> = {
    emailVerified: options.emailVerified ?? true,
  };
  if (options.trustScore !== undefined) patch.trustScore = options.trustScore;
  if (options.kycApproved) patch.kycStatus = 'approved';
  if (options.subscriptionTier) patch.subscriptionTier = options.subscriptionTier;
  const updated = await updateUser(user.id, patch as never);

  if (options.balanceCents) await fund(updated.id, options.balanceCents);
  const fresh = await findUserById(updated.id);
  if (!fresh) throw new Error('Fixture user vanished');
  return fresh;
}

/** Credits a wallet directly through the ledger, bypassing deposit limits. */
export async function fund(userId: string, amountCents: number): Promise<void> {
  await withTransaction((client) => creditDeposit(client, userId, amountCents, 'test fixture'));
}

export async function linkDevices(userIds: string[], fingerprint = 'shared-device-abc'): Promise<void> {
  for (const userId of userIds) {
    await recordDevice({ userId, fingerprint, ip: '203.0.113.7', userAgent: 'jest' });
  }
}

export async function linkPaymentMethods(userIds: string[], instrument = 'card_fp_123'): Promise<void> {
  for (const userId of userIds) {
    await recordPaymentMethod({ userId, kind: 'card', instrumentFingerprint: instrument });
  }
}

export const ULTIMATE_TEAM: GameMode = 'ultimate_team';

export function selfUser(user: UserRow): SelfUser {
  const { passwordHash, ...rest } = user;
  return rest;
}
