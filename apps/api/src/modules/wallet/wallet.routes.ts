import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePlayEligible } from '../../common/auth-middleware';
import { handler } from '../../common/async-handler';
import { badRequest } from '../../common/errors';
import * as wallet from './wallet.service';

export const walletRouter = Router();
walletRouter.use(requireAuth);

const depositSchema = z.object({
  amountCents: z.number().int().positive(),
  instrumentFingerprint: z.string().min(4).max(128).optional(),
  instrumentKind: z.enum(['card', 'paypal', 'bank']).optional(),
});

walletRouter.post(
  '/deposit',
  requirePlayEligible,
  handler(async (req, res) => {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    const result = await wallet.deposit({ user: req.currentUser!, ...parsed.data });
    res.json(result);
  }),
);

const withdrawSchema = z.object({
  amountCents: z.number().int().positive(),
  method: z.enum(['stripe', 'paypal', 'bank']),
});

walletRouter.post(
  '/withdraw',
  handler(async (req, res) => {
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    const result = await wallet.withdraw({ user: req.currentUser!, ...parsed.data });
    res.json(result);
  }),
);

walletRouter.get(
  '/',
  handler(async (req, res) => {
    res.json({
      wallet: await wallet.balance(req.userId!),
      dailyLossExposureCents: await wallet.dailyLossExposureCents(req.userId!),
    });
  }),
);

walletRouter.get(
  '/history',
  handler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ entries: await wallet.history(req.userId!, limit) });
  }),
);
