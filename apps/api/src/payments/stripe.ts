import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../common/errors';
import {
  DepositRequest,
  DepositTicket,
  PaymentProvider,
  PayoutRequest,
  PayoutTicket,
  WebhookEvent,
} from './provider';

/**
 * Stripe, over the REST API directly rather than the SDK.
 *
 * The only Stripe-specific logic that carries real risk is webhook signature
 * verification, and doing it here — as a pure function over the raw body —
 * means it is testable without network access or a Stripe account.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly apiBase = 'https://api.stripe.com/v1',
  ) {}

  async createDeposit(request: DepositRequest): Promise<DepositTicket> {
    const body = new URLSearchParams({
      amount: String(request.amountCents),
      currency: 'usd',
      'automatic_payment_methods[enabled]': 'true',
      'metadata[intent_id]': request.intentId,
      'metadata[user_id]': request.userId,
    });

    const payload = await this.post('/payment_intents', body, request.intentId);
    return {
      providerRef: String(payload.id),
      // Never captured at creation. The ledger waits for the webhook, because
      // a client that says "it worked" is not evidence that money moved.
      captured: false,
      clientSecret: payload.client_secret ? String(payload.client_secret) : undefined,
    };
  }

  async createPayout(request: PayoutRequest): Promise<PayoutTicket> {
    const body = new URLSearchParams({
      amount: String(request.amountCents),
      currency: 'usd',
      'metadata[intent_id]': request.intentId,
      'metadata[user_id]': request.userId,
    });
    const payload = await this.post('/payouts', body, request.intentId);
    return { providerRef: String(payload.id), settled: false };
  }

  parseWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookEvent {
    verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret);
    const payload = JSON.parse(rawBody.toString('utf8'));
    const object = payload?.data?.object ?? {};
    return {
      id: String(payload.id),
      type: String(payload.type),
      providerRef: object.id ? String(object.id) : null,
      amountCents: typeof object.amount === 'number' ? object.amount : null,
    };
  }

  private async post(
    path: string,
    body: URLSearchParams,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Our own intent id: a retried request cannot create a second charge.
        'Idempotency-Key': idempotencyKey,
      },
      body,
    });
    const payload = (await response.json()) as Record<string, any>;
    if (!response.ok) {
      throw new AppError(
        502,
        'provider_error',
        payload?.error?.message ?? 'The payment provider rejected the request',
      );
    }
    return payload;
  }
}

/** How far a webhook timestamp may drift before we treat it as a replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header: `t=<unix>,v1=<hmac>[,v1=<hmac>…]`.
 *
 * The signed payload is `<timestamp>.<raw body>`, so the body must be the
 * exact bytes received — this is why the webhook route parses raw rather than
 * JSON. Comparison is constant-time, and an old timestamp is rejected so a
 * captured request cannot be replayed later.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  if (!signatureHeader) {
    throw new AppError(400, 'missing_signature', 'Missing webhook signature');
  }

  const parts = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));

  if (!timestamp || signatures.length === 0) {
    throw new AppError(400, 'malformed_signature', 'Malformed webhook signature');
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new AppError(400, 'stale_signature', 'Webhook timestamp is outside the tolerance window');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  const matched = signatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    return (
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer)
    );
  });

  if (!matched) {
    throw new AppError(400, 'bad_signature', 'Webhook signature does not match');
  }
}

/** Builds a valid header — used by the tests, and handy for local replay. */
export function signStripePayload(
  rawBody: Buffer,
  secret: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody.toString('utf8')}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}
