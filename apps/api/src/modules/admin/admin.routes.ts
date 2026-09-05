import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../common/auth-middleware';
import { handler } from '../../common/async-handler';
import { badRequest } from '../../common/errors';
import * as admin from './admin.service';
import { drainOcrQueue } from '../../queue/ocr-worker';
import { sweepLapsedMatches } from '../results/results.service';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('moderator', 'admin'));

adminRouter.get(
  '/dashboard',
  handler(async (_req, res) => {
    res.json(await admin.dashboard());
  }),
);

adminRouter.get(
  '/kyc',
  handler(async (_req, res) => {
    res.json({ pending: await admin.pendingKyc() });
  }),
);

const kycSchema = z.object({
  approve: z.boolean(),
  rejectionReason: z.string().max(500).nullable().optional(),
});

adminRouter.post(
  '/kyc/:kycId',
  handler(async (req, res) => {
    const parsed = kycSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    res.json({
      kyc: await admin.decideKyc(
        req.currentUser!,
        req.params.kycId,
        parsed.data.approve,
        parsed.data.rejectionReason ?? null,
      ),
    });
  }),
);

adminRouter.post(
  '/users/:userId/ban',
  requireRole('admin'),
  handler(async (req, res) => {
    await admin.banUser(req.currentUser!, req.params.userId, String(req.body?.reason ?? ''));
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/users/:userId/unban',
  requireRole('admin'),
  handler(async (req, res) => {
    await admin.unbanUser(req.currentUser!, req.params.userId);
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/users/:userId/strike',
  handler(async (req, res) => {
    const note = String(req.body?.note ?? '');
    if (note.length < 5) throw badRequest('missing_note', 'Record why the strike was issued');
    res.json({ trustScore: await admin.strikeUser(req.currentUser!, req.params.userId, note) });
  }),
);

const settingSchema = z.object({ key: z.string().min(2).max(64), value: z.unknown() });

adminRouter.post(
  '/settings',
  requireRole('admin'),
  handler(async (req, res) => {
    const parsed = settingSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Provide a key and a value');
    await admin.updateSetting(req.currentUser!, parsed.data.key, parsed.data.value);
    res.json({ ok: true });
  }),
);

const regionSchema = z.object({
  code: z.string().min(2).max(6),
  reason: z.string().min(3).max(200),
  minAge: z.number().int().min(18).max(25).nullable().optional(),
});

adminRouter.post(
  '/regions',
  requireRole('admin'),
  handler(async (req, res) => {
    const parsed = regionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    await admin.blockRegion(
      req.currentUser!,
      parsed.data.code,
      parsed.data.reason,
      parsed.data.minAge ?? null,
    );
    res.status(201).json({ ok: true });
  }),
);

adminRouter.delete(
  '/regions/:code',
  requireRole('admin'),
  handler(async (req, res) => {
    await admin.unblockRegion(req.currentUser!, req.params.code);
    res.json({ ok: true });
  }),
);

/** Manual triggers for the background jobs, so an operator can force a pass
 *  without waiting for the worker's timer. */
adminRouter.post(
  '/jobs/ocr',
  handler(async (_req, res) => {
    res.json({ processed: await drainOcrQueue() });
  }),
);

adminRouter.post(
  '/jobs/sweep-deadlines',
  handler(async (_req, res) => {
    res.json({ escalated: await sweepLapsedMatches() });
  }),
);
