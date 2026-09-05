import { Router } from 'express';
import { z } from 'zod';
import { SKILL_TIERS } from '@escrow/shared';
import { requireAuth } from '../../common/auth-middleware';
import { handler } from '../../common/async-handler';
import { badRequest, notFound } from '../../common/errors';
import { findUserById, toPublicUser, toSelfUser } from '../../db/repos/users.repo';
import { getWallet } from '../../db/repos/ledger.repo';
import * as profile from './profile.service';
import * as trust from '../trust/trust.service';
import * as notifications from '../notifications/notifications.service';

/** Mounted at /me — everything about the caller's own account. */
export const meRouter = Router();
meRouter.use(requireAuth);

/** Mounted at /users — public profiles. */
export const usersRouter = Router();
usersRouter.use(requireAuth);

meRouter.get(
  '/',
  handler(async (req, res) => {
    res.json({
      user: toSelfUser(req.currentUser!),
      wallet: await getWallet(req.userId!),
      kyc: await profile.getKycStatus(req.userId!),
    });
  }),
);

usersRouter.get(
  '/:userId',
  handler(async (req, res) => {
    const user = await findUserById(req.params.userId);
    if (!user) throw notFound('User');
    res.json({
      user: toPublicUser(user),
      trustEvents: await trust.history(user.id, 20),
    });
  }),
);

const psnSchema = z.object({ psnId: z.string().min(3).max(16).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,15}$/) });

meRouter.post(
  '/psn',
  handler(async (req, res) => {
    const parsed = psnSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_psn', 'PSN IDs are 3-16 letters, digits, _ or -');
    res.json({ user: await profile.linkPsnId(req.currentUser!, parsed.data.psnId) });
  }),
);

const skillSchema = z.object({ skillTier: z.enum(SKILL_TIERS as unknown as [string, ...string[]]) });

meRouter.post(
  '/skill-tier',
  handler(async (req, res) => {
    const parsed = skillSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_tier', 'Unknown skill tier');
    res.json({ user: await profile.setSkillTier(req.userId!, parsed.data.skillTier as never) });
  }),
);

// Mock verification endpoints. A real deployment sends and checks a code here.
meRouter.post(
  '/verify-email',
  handler(async (req, res) => {
    res.json({ user: await profile.markEmailVerified(req.userId!) });
  }),
);

const phoneSchema = z.object({ phone: z.string().min(7).max(20) });

meRouter.post(
  '/verify-phone',
  handler(async (req, res) => {
    const parsed = phoneSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_phone', 'Enter a valid phone number');
    res.json({ user: await profile.markPhoneVerified(req.userId!, parsed.data.phone) });
  }),
);

const kycSchema = z.object({
  documentType: z.enum(['passport', 'drivers_license', 'national_id']),
  documentRef: z.string().min(4),
  selfieRef: z.string().min(4),
  addressCountry: z.string().length(2),
  addressRegion: z.string().min(2).max(3).nullable().default(null),
});

meRouter.post(
  '/kyc',
  handler(async (req, res) => {
    const parsed = kycSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    res.status(201).json({ kyc: await profile.submitKyc(req.currentUser!, parsed.data) });
  }),
);

const limitsSchema = z.object({
  depositLimitDailyCents: z.number().int().nonnegative().nullable().optional(),
  lossLimitDailyCents: z.number().int().nonnegative().nullable().optional(),
  sessionReminderMinutes: z.number().int().positive().nullable().optional(),
});

meRouter.post(
  '/responsible-play',
  handler(async (req, res) => {
    const parsed = limitsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    res.json({ user: await profile.updateResponsiblePlay(req.currentUser!, parsed.data) });
  }),
);

meRouter.post(
  '/self-exclude',
  handler(async (req, res) => {
    const days = Number(req.body?.days);
    res.json({ user: await profile.selfExclude(req.userId!, days) });
  }),
);

meRouter.post(
  '/cool-off',
  handler(async (req, res) => {
    const hours = Number(req.body?.hours);
    res.json({ user: await profile.startCoolOff(req.userId!, hours) });
  }),
);

meRouter.get(
  '/notifications',
  handler(async (req, res) => {
    res.json({ notifications: await notifications.listForUser(req.userId!) });
  }),
);

meRouter.post(
  '/notifications/read',
  handler(async (req, res) => {
    await notifications.markAllRead(req.userId!);
    res.json({ ok: true });
  }),
);

meRouter.get(
  '/trust',
  handler(async (req, res) => {
    res.json({
      trustScore: req.currentUser!.trustScore,
      events: await trust.history(req.userId!),
    });
  }),
);
