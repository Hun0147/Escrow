import { Router } from 'express';
import { z } from 'zod';
import { store } from '../../db/store';
import { deposit, WalletError, withdraw } from './wallet.service';

export const walletRouter = Router();

const amountSchema = z.object({ userId: z.string().uuid(), amountCents: z.number().int().positive() });

walletRouter.post('/deposit', (req, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const balance = deposit(parsed.data.userId, parsed.data.amountCents);
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
    const balance = withdraw(parsed.data.userId, parsed.data.amountCents);
    res.json({ walletBalanceCents: balance });
  } catch (err) {
    if (err instanceof WalletError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

walletRouter.get('/:userId/balance', (req, res) => {
  const user = store.users.get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ walletBalanceCents: user.walletBalanceCents });
});
