import request from 'supertest';
import { createApp } from '../src/app';
import { makeUser } from './factories';
import {
  DepositRequest,
  DepositTicket,
  PayoutRequest,
  PayoutTicket,
  PaymentProvider,
  WebhookEvent,
  setPaymentProvider,
  signStripePayload,
  verifyStripeSignature,
} from '../src/payments';
import { StripePaymentProvider } from '../src/payments/stripe';
import { deposit, captureDeposit, handlePaymentWebhook, withdraw } from '../src/modules/wallet/wallet.service';
import { PLATFORM_REVENUE } from '@escrow/shared';
import { accountBalance, getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { findPaymentIntent, listOpenFraudFlags } from '../src/db/repos/fraud.repo';
import { findUserById } from '../src/db/repos/users.repo';
import { pool } from '../src/db/pool';

const WEBHOOK_SECRET = 'whsec_test_secret';

/** A provider that behaves like a real one: nothing is captured until a
 *  webhook says so. */
class DeferredProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  readonly deposits: DepositRequest[] = [];
  payoutSettles = true;
  failPayout = false;

  async createDeposit(request: DepositRequest): Promise<DepositTicket> {
    this.deposits.push(request);
    return {
      providerRef: `pi_${request.intentId}`,
      captured: false,
      clientSecret: `pi_${request.intentId}_secret`,
    };
  }

  async createPayout(request: PayoutRequest): Promise<PayoutTicket> {
    if (this.failPayout) throw new Error('provider declined the payout');
    return { providerRef: `po_${request.intentId}`, settled: this.payoutSettles };
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent {
    return new StripePaymentProvider('sk_test', WEBHOOK_SECRET).parseWebhook(rawBody, signature);
  }
}

function stripeEvent(params: {
  id: string;
  type: string;
  providerRef: string;
  amountCents?: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: params.id,
      type: params.type,
      data: { object: { id: params.providerRef, amount: params.amountCents } },
    }),
  );
}

describe('Stripe webhook signatures', () => {
  const body = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}');

  it('accepts a correctly signed payload', () => {
    const header = signStripePayload(body, WEBHOOK_SECRET);
    expect(() => verifyStripeSignature(body, header, WEBHOOK_SECRET)).not.toThrow();
  });

  it('rejects a payload signed with the wrong secret', () => {
    const header = signStripePayload(body, 'whsec_someone_elses_secret');
    expect(() => verifyStripeSignature(body, header, WEBHOOK_SECRET)).toThrow(/does not match/);
  });

  it('rejects a body that was altered after signing', () => {
    const header = signStripePayload(body, WEBHOOK_SECRET);
    const tampered = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded","amount":999999}');
    expect(() => verifyStripeSignature(tampered, header, WEBHOOK_SECRET)).toThrow(/does not match/);
  });

  it('rejects a replay of an old but genuine request', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const header = signStripePayload(body, WEBHOOK_SECRET, oldTimestamp);
    expect(() => verifyStripeSignature(body, header, WEBHOOK_SECRET)).toThrow(/tolerance/);
  });

  it('rejects a missing or malformed header', () => {
    expect(() => verifyStripeSignature(body, undefined, WEBHOOK_SECRET)).toThrow(/Missing/);
    expect(() => verifyStripeSignature(body, 'garbage', WEBHOOK_SECRET)).toThrow(/Malformed/);
    expect(() => verifyStripeSignature(body, 't=123', WEBHOOK_SECRET)).toThrow(/Malformed/);
  });

  it('accepts a header carrying several candidate signatures', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = signStripePayload(body, WEBHOOK_SECRET, timestamp).split('v1=')[1];
    const header = `t=${timestamp},v1=deadbeef,v1=${valid}`;
    expect(() => verifyStripeSignature(body, header, WEBHOOK_SECRET)).not.toThrow();
  });
});

describe('deposits with a deferred provider', () => {
  let provider: DeferredProvider;

  beforeEach(() => {
    provider = new DeferredProvider();
    setPaymentProvider(provider);
  });

  afterEach(() => setPaymentProvider(null));

  it('does not credit the wallet until the provider confirms', async () => {
    const user = await makeUser();
    const result = await deposit({ user, amountCents: 5000 });

    expect(result.status).toBe('pending');
    expect(result.clientSecret).toBeTruthy();
    // The client has a payment sheet open; the balance has not moved.
    expect((await getWallet(user.id))!.availableCents).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('credits once the webhook arrives', async () => {
    const user = await makeUser();
    const result = await deposit({ user, amountCents: 5000 });

    const outcome = await handleSignedEvent({
      id: 'evt_capture_1',
      type: 'payment_intent.succeeded',
      providerRef: `pi_${result.intentId}`,
      amountCents: 5000,
    });

    expect(outcome).toMatchObject({ handled: true, reason: 'captured' });
    expect((await getWallet(user.id))!.availableCents).toBe(5000);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('credits exactly once however many times the webhook is redelivered', async () => {
    const user = await makeUser();
    const result = await deposit({ user, amountCents: 2500 });
    const event = {
      id: 'evt_capture_2',
      type: 'payment_intent.succeeded',
      providerRef: `pi_${result.intentId}`,
      amountCents: 2500,
    };

    await handleSignedEvent(event);
    const second = await handleSignedEvent(event);
    const third = await handleSignedEvent(event);

    expect(second).toMatchObject({ handled: false, reason: 'duplicate_event' });
    expect(third).toMatchObject({ handled: false, reason: 'duplicate_event' });
    expect((await getWallet(user.id))!.availableCents).toBe(2500);

    const { rows } = await pool.query(
      "SELECT COUNT(*) AS count FROM ledger_transactions WHERE type = 'deposit' AND user_id = $1",
      [user.id],
    );
    expect(Number(rows[0].count)).toBe(1);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('credits once even when two distinct events name the same payment', async () => {
    const user = await makeUser();
    const result = await deposit({ user, amountCents: 1000 });

    await handleSignedEvent({
      id: 'evt_a',
      type: 'payment_intent.succeeded',
      providerRef: `pi_${result.intentId}`,
      amountCents: 1000,
    });
    // A different event id — de-duplication by event alone would let this
    // through, so the intent's own state has to be the gate.
    const second = await handleSignedEvent({
      id: 'evt_b',
      type: 'payment_intent.succeeded',
      providerRef: `pi_${result.intentId}`,
      amountCents: 1000,
    });

    expect(second).toMatchObject({ handled: true });
    expect((await getWallet(user.id))!.availableCents).toBe(1000);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('refuses to credit when the provider reports a different amount', async () => {
    const user = await makeUser();
    const result = await deposit({ user, amountCents: 1000 });

    const outcome = await handleSignedEvent({
      id: 'evt_mismatch',
      type: 'payment_intent.succeeded',
      providerRef: `pi_${result.intentId}`,
      amountCents: 500_000,
    });

    expect(outcome).toMatchObject({ handled: false, reason: 'amount_mismatch' });
    expect((await getWallet(user.id))!.availableCents).toBe(0);
    expect((await listOpenFraudFlags()).map((f) => f.kind)).toContain('payment_amount_mismatch');
  });

  it('marks a failed payment failed and credits nothing', async () => {
    const user = await makeUser();
    const result = await deposit({ user, amountCents: 1000 });

    const outcome = await handleSignedEvent({
      id: 'evt_failed',
      type: 'payment_intent.payment_failed',
      providerRef: `pi_${result.intentId}`,
      amountCents: 1000,
    });

    expect(outcome).toMatchObject({ handled: true, reason: 'failed' });
    expect((await findPaymentIntent(result.intentId))!.status).toBe('failed');
    expect((await getWallet(user.id))!.availableCents).toBe(0);
  });

  it('ignores a webhook for a payment it does not recognise', async () => {
    const outcome = await handleSignedEvent({
      id: 'evt_unknown',
      type: 'payment_intent.succeeded',
      providerRef: 'pi_not_ours',
      amountCents: 100,
    });
    expect(outcome).toMatchObject({ handled: false, reason: 'unknown_payment' });
  });

  it('counts money still in flight against the daily deposit cap', async () => {
    const user = await makeUser();
    // 100_000 is the seeded daily cap; two pending 60_000 deposits must not
    // both be accepted just because neither has confirmed.
    await deposit({ user, amountCents: 60_000 });
    await expect(deposit({ user, amountCents: 60_000 })).rejects.toMatchObject({
      code: 'deposit_limit_reached',
    });
  });

  it('returns the balance when a payout is still in flight', async () => {
    const user = await makeUser({ balanceCents: 5000, kycApproved: true });
    provider.payoutSettles = false;

    const result = await withdraw({ user, amountCents: 2000, method: 'stripe' });
    // $20 leaves the wallet; $2 is the escrow fee, $18 is what the payout moves.
    expect(result.wallet.availableCents).toBe(3000);
    expect(result.feeCents).toBe(200);
    expect(result.netCents).toBe(1800);
    // Debited and reserved, but the intent stays open until the payout settles.
    const { rows } = await pool.query(
      "SELECT status FROM payment_intents WHERE user_id = $1 AND direction = 'withdrawal'",
      [user.id],
    );
    expect(rows[0].status).toBe('pending');
    expect(await reconcileWallets()).toEqual([]);
  });

  it('gives the money back when the provider refuses the payout', async () => {
    const user = await makeUser({ balanceCents: 5000, kycApproved: true });
    provider.failPayout = true;

    await expect(withdraw({ user, amountCents: 2000, method: 'stripe' })).rejects.toThrow(/declined/);
    // The debit posted before the provider call, so it has to be reversed —
    // including the fee, which the platform has no claim to on a transfer that
    // never happened.
    expect((await getWallet(user.id))!.availableCents).toBe(5000);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  async function handleSignedEvent(params: {
    id: string;
    type: string;
    providerRef: string;
    amountCents?: number;
  }) {
    const body = stripeEvent(params);
    return handlePaymentWebhook(body, signStripePayload(body, WEBHOOK_SECRET));
  }
});

describe('the webhook endpoint', () => {
  const app = createApp();

  beforeEach(() => setPaymentProvider(new DeferredProvider()));
  afterEach(() => setPaymentProvider(null));

  it('is reachable without a session and reads the raw signed body', async () => {
    const user = await makeUser();
    const result = await deposit({ user: (await findUserById(user.id))!, amountCents: 1500 });
    const body = stripeEvent({
      id: 'evt_http',
      type: 'payment_intent.succeeded',
      providerRef: `pi_${result.intentId}`,
      amountCents: 1500,
    });

    const response = await request(app)
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signStripePayload(body, WEBHOOK_SECRET))
      // Sent as the exact string that was signed: superagent would otherwise
      // re-serialise a Buffer and change the bytes under the signature.
      .send(body.toString('utf8'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ handled: true, reason: 'captured' });
    expect((await getWallet(user.id))!.availableCents).toBe(1500);
  });

  it('turns away an unsigned request', async () => {
    const body = stripeEvent({ id: 'evt_bad', type: 'payment_intent.succeeded', providerRef: 'pi_x' });
    const response = await request(app)
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .send(body.toString('utf8'));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('missing_signature');
  });

  it('turns away a forged signature', async () => {
    const body = stripeEvent({ id: 'evt_forged', type: 'payment_intent.succeeded', providerRef: 'pi_x' });
    const response = await request(app)
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signStripePayload(body, 'whsec_wrong'))
      .send(body.toString('utf8'));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('bad_signature');
  });
});
