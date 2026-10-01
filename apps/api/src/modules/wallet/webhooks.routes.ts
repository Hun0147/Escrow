import express, { Router } from 'express';
import { handler } from '../../common/async-handler';
import { handlePaymentWebhook } from './wallet.service';

/**
 * Provider webhooks.
 *
 * Mounted before the JSON body parser and parsed as raw bytes, because the
 * signature covers the exact payload received — re-serialising parsed JSON
 * would change it and every signature would fail. This route is
 * unauthenticated by necessity; the signature IS the authentication.
 */
export const webhookRouter = Router();

webhookRouter.post(
  '/payments',
  express.raw({ type: '*/*', limit: '1mb' }),
  handler(async (req, res) => {
    const signature =
      req.header('stripe-signature') ?? req.header('x-goal27-signature') ?? undefined;
    const result = await handlePaymentWebhook(req.body as Buffer, signature);
    // Always 200 once the signature checks out: a provider that gets an error
    // will retry forever, and a duplicate or irrelevant event is not a failure.
    res.json(result);
  }),
);
