import { MockPaymentProvider } from './mock';
import { PaymentProvider } from './provider';
import { StripePaymentProvider } from './stripe';

export * from './provider';
export { verifyStripeSignature, signStripePayload } from './stripe';

let provider: PaymentProvider | null = null;

/**
 * Stripe activates on configuration, not on a flag: if the keys are present it
 * is used, otherwise the mock is. That makes it impossible to deploy with
 * `PAYMENTS=live` set but no credentials behind it.
 */
export function paymentProvider(): PaymentProvider {
  if (provider) return provider;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  provider =
    secretKey && webhookSecret
      ? new StripePaymentProvider(secretKey, webhookSecret)
      : new MockPaymentProvider();
  return provider;
}

export function setPaymentProvider(next: PaymentProvider | null): void {
  provider = next;
}
