import { randomUUID } from 'crypto';
import {
  DepositRequest,
  DepositTicket,
  PaymentProvider,
  PayoutRequest,
  PayoutTicket,
  WebhookEvent,
} from './provider';

/**
 * Development provider. Captures instantly and never fails, so the whole
 * deposit path — limits, intent, capture, ledger credit — runs end to end
 * without a processor account.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  async createDeposit(request: DepositRequest): Promise<DepositTicket> {
    return { providerRef: `mock_pi_${request.intentId}`, captured: true };
  }

  async createPayout(request: PayoutRequest): Promise<PayoutTicket> {
    return { providerRef: `mock_po_${request.intentId}`, settled: true };
  }

  parseWebhook(rawBody: Buffer): WebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8'));
    return {
      id: String(payload.id ?? randomUUID()),
      type: String(payload.type ?? 'payment_intent.succeeded'),
      providerRef: payload.data?.object?.id ?? null,
      amountCents: payload.data?.object?.amount ?? null,
    };
  }
}
