import { Router } from 'express';
import { z } from 'zod';
import { GAME_MODES } from '@escrow/shared';
import { requireAuth, requirePlayEligible, requireRole } from '../../common/auth-middleware';
import { handler } from '../../common/async-handler';
import { badRequest } from '../../common/errors';
import * as tournaments from './tournaments.service';
import { bracketFor, startTournament } from './bracket.service';

export const tournamentsRouter = Router();
tournamentsRouter.use(requireAuth);

tournamentsRouter.get(
  '/',
  handler(async (req, res) => {
    res.json({ tournaments: await tournaments.list((req.query.status as never) ?? 'all') });
  }),
);

tournamentsRouter.get(
  '/:tournamentId',
  handler(async (req, res) => {
    res.json({
      ...(await tournaments.detail(req.params.tournamentId)),
      bracket: await bracketFor(req.params.tournamentId),
    });
  }),
);

tournamentsRouter.post(
  '/:tournamentId/enter',
  requirePlayEligible,
  handler(async (req, res) => {
    res.status(201).json({
      entry: await tournaments.enterTournament(req.currentUser!, req.params.tournamentId),
    });
  }),
);

const createSchema = z.object({
  name: z.string().min(3).max(80),
  gameMode: z.enum(GAME_MODES as unknown as [string, ...string[]]),
  entryFeeCents: z.number().int().nonnegative(),
  escrowFeeBps: z.number().int().min(0).max(2000).optional(),
  maxEntrants: z.number().int().min(2).max(256),
  sponsorName: z.string().max(80).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
});

tournamentsRouter.post(
  '/',
  requireRole('admin'),
  handler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    res.status(201).json({ tournament: await tournaments.createTournament(parsed.data as never) });
  }),
);

tournamentsRouter.post(
  '/:tournamentId/start',
  requireRole('admin'),
  handler(async (req, res) => {
    res.json({ bracket: await startTournament(req.params.tournamentId) });
  }),
);

tournamentsRouter.post(
  '/:tournamentId/cancel',
  requireRole('admin'),
  handler(async (req, res) => {
    await tournaments.cancelTournament(req.params.tournamentId);
    res.json({ ok: true });
  }),
);
