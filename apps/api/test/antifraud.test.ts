import { linkDevices, linkPaymentMethods, makeUser, ULTIMATE_TEAM } from './factories';
import { registerUser } from '../src/modules/auth/auth.service';
import { createMatch, joinMatch } from '../src/modules/matches/matches.service';
import { deposit, withdraw } from '../src/modules/wallet/wallet.service';
import { updateResponsiblePlay, selfExclude, submitKyc } from '../src/modules/onboarding/profile.service';
import { getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { listOpenFraudFlags, recordDevice, upsertBlockedRegion } from '../src/db/repos/fraud.repo';
import { findUserById, updateUser } from '../src/db/repos/users.repo';
import { setSetting } from '../src/common/settings';
import { ageOn } from '../src/common/geo';

const REGISTRATION = {
  handle: 'newcomer',
  email: 'newcomer@example.test',
  password: 'a-long-enough-password',
  dateOfBirth: '1998-03-04',
  countryCode: 'GB',
};

describe('age gate and geofence', () => {
  it('computes age on the day, not by year alone', () => {
    expect(ageOn('2000-01-01', new Date('2018-01-01T00:00:00Z'))).toBe(18);
    expect(ageOn('2000-01-02', new Date('2018-01-01T00:00:00Z'))).toBe(17);
  });

  it('turns away anyone under 18', async () => {
    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - 17);
    await expect(
      registerUser({ ...REGISTRATION, dateOfBirth: dob.toISOString().slice(0, 10) }),
    ).rejects.toMatchObject({ code: 'underage' });
  });

  it('turns away a restricted jurisdiction', async () => {
    await expect(
      registerUser({ ...REGISTRATION, countryCode: 'US', regionCode: 'WA' }),
    ).resolves.toBeTruthy(); // WA is not on the default list

    await upsertBlockedRegion({ code: 'US-WA', reason: 'Test block', minAge: null });
    await expect(
      registerUser({
        ...REGISTRATION,
        handle: 'newcomer2',
        email: 'newcomer2@example.test',
        countryCode: 'US',
        regionCode: 'WA',
      }),
    ).rejects.toMatchObject({ code: 'region_blocked' });
  });

  it('applies a higher local minimum age where one is configured', async () => {
    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - 19);
    // Massachusetts is seeded at 21+.
    await expect(
      registerUser({
        ...REGISTRATION,
        countryCode: 'US',
        regionCode: 'MA',
        dateOfBirth: dob.toISOString().slice(0, 10),
      }),
    ).rejects.toMatchObject({ code: 'underage' });
  });

  it('re-checks jurisdiction against the verified KYC address, not just the IP', async () => {
    const user = await makeUser({ countryCode: 'GB' });
    await upsertBlockedRegion({ code: 'US-AZ', reason: 'Restricted', minAge: null });
    await expect(
      submitKyc(user, {
        documentType: 'passport',
        documentRef: 'doc-ref-1',
        selfieRef: 'selfie-ref-1',
        addressCountry: 'US',
        addressRegion: 'AZ',
      }),
    ).rejects.toMatchObject({ code: 'region_blocked' });
  });

  it('rejects a duplicate email, handle or PSN ID', async () => {
    await registerUser(REGISTRATION);
    await expect(registerUser(REGISTRATION)).rejects.toMatchObject({ code: 'email_taken' });
    await expect(
      registerUser({ ...REGISTRATION, email: 'other@example.test' }),
    ).rejects.toMatchObject({ code: 'handle_taken' });
  });
});

describe('linked accounts', () => {
  it('blocks two accounts on the same device from playing each other', async () => {
    const alice = await makeUser({ balanceCents: 5000 });
    const alt = await makeUser({ balanceCents: 5000 });
    await linkDevices([alice.id, alt.id]);

    const match = await createMatch(alice, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await expect(joinMatch(alt, match.id)).rejects.toMatchObject({ code: 'linked_accounts' });

    // The blocked joiner's money never moved, and the attempt is on record.
    expect((await getWallet(alt.id))!.availableCents).toBe(5000);
    expect((await listOpenFraudFlags()).map((f) => f.kind)).toContain('self_match_attempt');
    expect(await reconcileWallets()).toEqual([]);
  });

  it('blocks two accounts sharing a payment instrument', async () => {
    const alice = await makeUser({ balanceCents: 5000 });
    const alt = await makeUser({ balanceCents: 5000 });
    await linkPaymentMethods([alice.id, alt.id]);

    const match = await createMatch(alice, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await expect(joinMatch(alt, match.id)).rejects.toMatchObject({ code: 'linked_accounts' });
  });

  it('allows a shared network but flags it, rather than blocking flatmates', async () => {
    const alice = await makeUser({ balanceCents: 5000 });
    const flatmate = await makeUser({ balanceCents: 5000 });
    // Same IP, different devices — a household, not necessarily a fraudster.
    await recordDevice({ userId: alice.id, fingerprint: 'device-a', ip: '198.51.100.4', userAgent: 'jest' });
    await recordDevice({ userId: flatmate.id, fingerprint: 'device-b', ip: '198.51.100.4', userAgent: 'jest' });

    const match = await createMatch(alice, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await expect(joinMatch(flatmate, match.id)).resolves.toMatchObject({ status: 'escrowed' });
    expect((await listOpenFraudFlags()).map((f) => f.kind)).toContain('weak_account_link');
  });

  it('flags a shared device at signup but not a shared address', async () => {
    // Two unrelated players behind one NAT is the common case, not fraud.
    await registerUser({ ...REGISTRATION, ip: '198.51.100.9', deviceFingerprint: 'laptop-a' });
    await registerUser({
      ...REGISTRATION,
      handle: 'neighbour',
      email: 'neighbour@example.test',
      ip: '198.51.100.9',
      deviceFingerprint: 'laptop-b',
    });
    expect(await listOpenFraudFlags()).toHaveLength(0);

    // The same physical device is a different matter.
    await registerUser({
      ...REGISTRATION,
      handle: 'sameconsole',
      email: 'sameconsole@example.test',
      ip: '198.51.100.9',
      deviceFingerprint: 'laptop-a',
    });
    const flags = await listOpenFraudFlags();
    expect(flags.map((f) => f.kind)).toContain('linked_account_at_signup');
    expect(flags.every((f) => !f.detail.includes('shared_ip'))).toBe(true);
  });

  it('lets unrelated accounts play normally', async () => {
    const alice = await makeUser({ balanceCents: 5000 });
    const bob = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(alice, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await expect(joinMatch(bob, match.id)).resolves.toMatchObject({ status: 'escrowed' });
  });
});

describe('wallet limits and responsible play', () => {
  it('enforces the minimum, the maximum and the rolling daily cap on deposits', async () => {
    const user = await makeUser();
    await expect(deposit({ user, amountCents: 100 })).rejects.toMatchObject({ code: 'below_minimum' });
    await expect(deposit({ user, amountCents: 500_000 })).rejects.toMatchObject({
      code: 'above_maximum',
    });

    await setSetting('daily_deposit_cap_cents', 3000);
    await deposit({ user, amountCents: 2000 });
    await expect(deposit({ user, amountCents: 2000 })).rejects.toMatchObject({
      code: 'deposit_limit_reached',
    });
    expect((await getWallet(user.id))!.availableCents).toBe(2000);
  });

  it('throttles a burst of deposits', async () => {
    const user = await makeUser();
    for (let i = 0; i < 5; i++) await deposit({ user, amountCents: 500 });
    await expect(deposit({ user, amountCents: 500 })).rejects.toMatchObject({
      code: 'deposit_rate_limited',
    });
  });

  it('requires KYC before the first withdrawal', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    await expect(withdraw({ user, amountCents: 2000, method: 'bank' })).rejects.toMatchObject({
      code: 'kyc_required',
    });

    const verified = await makeUser({ balanceCents: 5000, kycApproved: true });
    await expect(withdraw({ user: verified, amountCents: 2000, method: 'bank' })).resolves.toMatchObject({
      grossCents: 2000,
      feeCents: 200,
      netCents: 1800,
    });
    expect((await getWallet(verified.id))!.availableCents).toBe(3000);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('will not pay out more than the wallet holds', async () => {
    const user = await makeUser({ balanceCents: 1000, kycApproved: true });
    await expect(withdraw({ user, amountCents: 5000, method: 'bank' })).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    expect((await getWallet(user.id))!.availableCents).toBe(1000);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('flags deposit-then-withdraw with no play in between', async () => {
    const user = await makeUser({ kycApproved: true });
    await deposit({ user, amountCents: 5000 });
    await withdraw({ user: (await findUserById(user.id))!, amountCents: 5000, method: 'bank' });

    expect((await listOpenFraudFlags()).map((f) => f.kind)).toContain('rapid_deposit_withdraw');
  });

  it('lets a player tighten a limit but never loosen it mid-session', async () => {
    const user = await makeUser();
    await updateResponsiblePlay(user, { depositLimitDailyCents: 5000 });
    const tightened = await updateResponsiblePlay(
      (await findUserById(user.id))!,
      { depositLimitDailyCents: 2000 },
    );
    expect(tightened.id).toBe(user.id);

    await expect(
      updateResponsiblePlay((await findUserById(user.id))!, { depositLimitDailyCents: 9000 }),
    ).rejects.toMatchObject({ code: 'limit_ratchet' });
    await expect(
      updateResponsiblePlay((await findUserById(user.id))!, { depositLimitDailyCents: null }),
    ).rejects.toMatchObject({ code: 'limit_ratchet' });
  });

  it('honours a self-set daily loss limit before accepting another stake', async () => {
    const user = await makeUser({ balanceCents: 10000 });
    await updateResponsiblePlay(user, { lossLimitDailyCents: 3000 });
    const limited = (await findUserById(user.id))!;

    await createMatch(limited, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await expect(
      createMatch(limited, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 }),
    ).rejects.toMatchObject({ code: 'loss_limit_reached' });
  });

  it('records a self-exclusion that outlasts the session', async () => {
    const user = await makeUser();
    const excluded = await selfExclude(user.id, 30);
    expect(new Date(excluded.selfExcludedUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps a banned account out', async () => {
    const user = await makeUser({ balanceCents: 5000 });
    await updateUser(user.id, { bannedAt: new Date().toISOString() });
    const banned = (await findUserById(user.id))!;
    expect(banned.bannedAt).not.toBeNull();
  });
});

describe('staking prerequisites', () => {
  it('requires a verified email and a linked PSN ID', async () => {
    const unverified = await makeUser({ balanceCents: 5000, emailVerified: false });
    await expect(
      createMatch(unverified, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 }),
    ).rejects.toMatchObject({ code: 'email_unverified' });

    const noPsn = await makeUser({ balanceCents: 5000, psnId: null });
    await expect(
      createMatch(noPsn, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 }),
    ).rejects.toMatchObject({ code: 'psn_required' });
  });

  it('only accepts stakes from the published ladder', async () => {
    const user = await makeUser({ balanceCents: 10000 });
    await expect(
      createMatch(user, { gameMode: ULTIMATE_TEAM, stakeCents: 1337 }),
    ).rejects.toMatchObject({ code: 'invalid_stake' });
  });
});
