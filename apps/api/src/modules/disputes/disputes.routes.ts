import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../common/auth-middleware';
import { DisputeError, openDispute, resolveDispute } from './disputes.service';

export const disputesRouter = Router();
disputesRouter.use(requireAuth);

const openSchema = z.object({
  matchId: z.string().uuid(),
  evidence: z.array(z.string()).default([]),
});

disputesRouter.post('/', async (req, res, next) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const dispute = await openDispute(parsed.data.matchId, req.userId!, parsed.data.evidence);
    res.status(201).json(dispute);
  } catch (err) {
    if (err instanceof DisputeError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// Resolution is moderator-only in practice; role-based access control is not yet
// implemented (Phase 1 has no roles), so this currently trusts any authenticated caller.
const resolveSchema = z.object({
  resolution: z.string().min(1),
  winnerId: z.string().uuid().nullable(),
});

disputesRouter.post('/:disputeId/resolve', async (req, res, next) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const dispute = await resolveDispute(req.params.disputeId, parsed.data.resolution, parsed.data.winnerId);
    res.json(dispute);
  } catch (err) {
    if (err instanceof DisputeError) return res.status(400).json({ error: err.message });
    next(err);
  }
});
