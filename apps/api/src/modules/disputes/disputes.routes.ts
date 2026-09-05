import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../common/auth-middleware';
import { handler } from '../../common/async-handler';
import { badRequest } from '../../common/errors';
import * as disputes from './disputes.service';
import * as screenshots from '../screenshots/screenshots.service';

export const disputesRouter = Router();
disputesRouter.use(requireAuth);

const openSchema = z.object({
  matchId: z.string().uuid(),
  reason: z.string().min(5).max(1000),
});

disputesRouter.post(
  '/',
  handler(async (req, res) => {
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Describe the problem in a sentence or two');
    res.status(201).json({
      dispute: await disputes.raiseDispute(req.currentUser!, parsed.data.matchId, parsed.data.reason),
    });
  }),
);

// Everything below is the moderation queue.
disputesRouter.get(
  '/',
  requireRole('moderator', 'admin'),
  handler(async (req, res) => {
    const status = (req.query.status as never) ?? 'open';
    res.json({ disputes: await disputes.queue(status) });
  }),
);

disputesRouter.get(
  '/:disputeId',
  requireRole('moderator', 'admin'),
  handler(async (req, res) => {
    res.json(await disputes.caseFile(req.params.disputeId));
  }),
);

const resolveSchema = z.object({
  resolution: z.enum(['creator_wins', 'opponent_wins', 'void_refund', 'replay', 'dismissed']),
  notes: z.string().min(5).max(2000),
  strikeUserId: z.string().uuid().nullable().optional(),
});

disputesRouter.post(
  '/:disputeId/resolve',
  requireRole('moderator', 'admin'),
  handler(async (req, res) => {
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    res.json({
      dispute: await disputes.resolveDispute(req.currentUser!, {
        disputeId: req.params.disputeId,
        ...parsed.data,
      }),
    });
  }),
);

/** Evidence is served through the API, never as a public URL: a screenshot is
 *  visible to its match participants and to moderators, and to nobody else. */
disputesRouter.get(
  '/screenshots/:screenshotId/image',
  handler(async (req, res) => {
    const { buffer, contentType } = await screenshots.screenshotBytes(
      req.currentUser!,
      req.params.screenshotId,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  }),
);
