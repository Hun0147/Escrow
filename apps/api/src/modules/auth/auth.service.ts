import bcrypt from 'bcryptjs';
import { SelfUser } from '@escrow/shared';
import {
  UserRow,
  findUserByEmail,
  findUserByHandle,
  findUserByPsnId,
  insertUser,
  toSelfUser,
} from '../../db/repos/users.repo';
import { createWallet } from '../../db/repos/ledger.repo';
import { recordDevice, findLinkedAccounts, raiseFraudFlag } from '../../db/repos/fraud.repo';
import { withTransaction } from '../../db/transaction';
import { assertEligible } from '../../common/geo';
import { conflict, forbidden, unauthorized } from '../../common/errors';

export interface RegisterParams {
  handle: string;
  email: string;
  password: string;
  dateOfBirth: string;
  countryCode: string;
  regionCode?: string | null;
  psnId?: string | null;
  phone?: string | null;
  deviceFingerprint?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function registerUser(params: RegisterParams): Promise<SelfUser> {
  await assertEligible({
    countryCode: params.countryCode,
    regionCode: params.regionCode ?? null,
    dateOfBirth: params.dateOfBirth,
  });

  if (await findUserByEmail(params.email)) {
    throw conflict('email_taken', 'That email is already registered');
  }
  if (await findUserByHandle(params.handle)) {
    throw conflict('handle_taken', 'That handle is taken');
  }
  if (params.psnId && (await findUserByPsnId(params.psnId))) {
    throw conflict('psn_taken', 'That PSN ID is already linked to another account');
  }

  const passwordHash = await bcrypt.hash(params.password, 10);

  const user = await withTransaction(async (client) => {
    const created = await insertUser(
      {
        handle: params.handle,
        email: params.email,
        passwordHash,
        dateOfBirth: params.dateOfBirth,
        countryCode: params.countryCode.toUpperCase(),
        regionCode: params.regionCode ? params.regionCode.toUpperCase() : null,
        psnId: params.psnId ?? null,
        phone: params.phone ?? null,
        signupIp: params.ip ?? null,
      },
      client,
    );
    await createWallet(created.id, client);
    if (params.deviceFingerprint) {
      await recordDevice(
        {
          userId: created.id,
          fingerprint: params.deviceFingerprint,
          ip: params.ip ?? null,
          userAgent: params.userAgent ?? null,
        },
        client,
      );
    }
    return created;
  });

  // One account per identity. A shared device or IP at signup is not proof of
  // fraud (shared houses, campus NAT), so it raises a flag for review rather
  // than blocking the signup — but it does bar the two accounts from playing
  // each other, which is enforced when a match is joined.
  const linked = await findLinkedAccounts(user.id);
  for (const link of linked) {
    await raiseFraudFlag({
      userId: user.id,
      relatedUserId: link.userId,
      kind: 'linked_account_at_signup',
      detail: link.reasons.join(', '),
    });
  }

  return toSelfUser(user);
}

export async function loginUser(email: string, password: string): Promise<SelfUser> {
  const user = await findUserByEmail(email);
  // Compare against a dummy hash when the account is unknown so that response
  // timing doesn't reveal which emails are registered.
  const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) throw unauthorized('Invalid credentials');
  if (user.bannedAt) throw forbidden('account_banned', 'This account is banned');
  return toSelfUser(user);
}

export function sanitize(user: UserRow): SelfUser {
  return toSelfUser(user);
}
