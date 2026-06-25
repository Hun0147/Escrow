import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../common/auth-middleware';
import { cancelMatch, createMatch, fundEscrow, MatchError } from './matches.service';
import { settleMatch, SettlementError } from '../settlement/settlement.service';
import { WalletError } from '../wallet/wallet.service';

export const matchesRouter = Router();
matchesRouter.use(requireAuth);

const createSchema = z.object({
  game: z.string().min(1),
  stakeCents: z.number().int().positive(),
});

matchesRouter.post('/', async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const match = await createMatch(req.userId!, parsed.data.game, parsed.data.stakeCents);
    res.status(201).json(match);
  } catch (err) {
    if (err instanceof MatchError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

matchesRouter.post('/:matchId/fund', async (req, res, next) => {
  try {
    const result = await fundEscrow(req.params.matchId, req.userId!);
    res.json(result);
  } catch (err) {
    if (err instanceof MatchError || err instanceof WalletError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// Settlement is moderator-triggered for now (manual result verification in Phase 1),
// so the winner is supplied explicitly rather than inferred from the caller's identity.
const settleSchema = z.object({ winnerId: z.string().uuid() });

matchesRouter.post('/:matchId/settle', async (req, res, next) => {
  const parsed = settleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await settleMatch(req.params.matchId, parsed.data.winnerId);
    res.json(result);
  } catch (err) {
    if (err instanceof SettlementError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

matchesRouter.post('/:matchId/cancel', async (req, res, next) => {
  try {
    const match = await cancelMatch(req.params.matchId);
    res.json(match);
  } catch (err) {
    if (err instanceof MatchError) return res.status(400).json({ error: err.message });
    next(err);
  }
});
