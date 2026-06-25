import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../common/auth-middleware';
import { findUserById } from '../../db/users.repo';
import { deposit, WalletError, withdraw } from './wallet.service';

export const walletRouter = Router();
walletRouter.use(requireAuth);

const amountSchema = z.object({ amountCents: z.number().int().positive() });

walletRouter.post('/deposit', async (req, res, next) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const balance = await deposit(req.userId!, parsed.data.amountCents);
    res.json({ walletBalanceCents: balance });
  } catch (err) {
    if (err instanceof WalletError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

walletRouter.post('/withdraw', async (req, res, next) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const balance = await withdraw(req.userId!, parsed.data.amountCents);
    res.json({ walletBalanceCents: balance });
  } catch (err) {
    if (err instanceof WalletError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

walletRouter.get('/balance', async (req, res, next) => {
  try {
    const user = await findUserById(req.userId!);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ walletBalanceCents: user.walletBalanceCents });
  } catch (err) {
    next(err);
  }
});
