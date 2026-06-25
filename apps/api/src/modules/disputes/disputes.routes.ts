import { Router } from 'express';
import { z } from 'zod';
import { DisputeError, openDispute, resolveDispute } from './disputes.service';

export const disputesRouter = Router();

const openSchema = z.object({
  matchId: z.string().uuid(),
  raisedBy: z.string().uuid(),
  evidence: z.array(z.string()).default([]),
});

disputesRouter.post('/', (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const dispute = openDispute(parsed.data.matchId, parsed.data.raisedBy, parsed.data.evidence);
    res.status(201).json(dispute);
  } catch (err) {
    if (err instanceof DisputeError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

const resolveSchema = z.object({
  resolution: z.string().min(1),
  winnerId: z.string().uuid().nullable(),
});

disputesRouter.post('/:disputeId/resolve', (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const dispute = resolveDispute(req.params.disputeId, parsed.data.resolution, parsed.data.winnerId);
    res.json(dispute);
  } catch (err) {
    if (err instanceof DisputeError) return res.status(400).json({ error: err.message });
    throw err;
  }
});
