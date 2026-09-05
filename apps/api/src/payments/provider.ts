/**
 * Payment provider seam.
 *
 * A deposit is two steps, always: we record an intent, the provider captures
 * the money, and only then is the ledger credited. The mock provider collapses
 * those into one call so development and tests behave as if payment were
 * instant; a real provider leaves the intent pending until its webhook
 * arrives. Nothing outside this directory knows which is in use.
 */
export interface DepositRequest {
  intentId: string;
  userId: string;
  amountCents: number;
  /** Processor-side instrument fingerprint, when the client supplied one. */
  instrumentFingerprint?: string | null;
}

export interface DepositTicket {
  providerRef: string;
  /**
   * True when the funds are already captured and the ledger may be credited
   * now. False means "wait for the webhook" — the caller must not credit.
   */
  captured: boolean;
  /** Passed to the client to complete the payment, when the provider needs it. */
  clientSecret?: string;
}

export interface PayoutRequest {
  intentId: string;
  userId: string;
  amountCents: number;
  method: 'stripe' | 'paypal' | 'bank';
}

export interface PayoutTicket {
  providerRef: string;
  /** False means the payout is in flight and will settle asynchronously. */
  settled: boolean;
}

export interface WebhookEvent {
  id: string;
  type: string;
  providerRef: string | null;
  amountCents: number | null;
}

export interface PaymentProvider {
  readonly name: 'mock' | 'stripe';
  createDeposit(request: DepositRequest): Promise<DepositTicket>;
  createPayout(request: PayoutRequest): Promise<PayoutTicket>;
  /**
   * Verifies the signature and parses the event. Throws if the signature does
   * not check out — an unverified webhook is an attacker with our endpoint,
   * not a payment.
   */
  parseWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookEvent;
}
