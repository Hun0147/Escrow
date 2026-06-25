import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../common/auth-middleware';
import { store } from '../../db/store';
import { deposit, WalletError, withdraw } from './wallet.service';

export const walletRouter = Router();
walletRouter.use(requireAuth);

const amountSchema = z.object({ amountCents: z.number().int().positive() });

walletRouter.post('/deposit', (req, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const balance = deposit(req.userId!, parsed.data.amountCents);
    res.json({ walletBalanceCents: balance });
  } catch (err) {
    if (err instanceof WalletError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

walletRouter.post('/withdraw', (req, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const balance = withdraw(req.userId!, parsed.data.amountCents);
    res.json({ walletBalanceCents: balance });
  } catch (err) {
    if (err instanceof WalletError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

walletRouter.get('/balance', (req, res) => {
  const user = store.users.get(req.userId!);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ walletBalanceCents: user.walletBalanceCents });
});
