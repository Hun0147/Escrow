import { Router } from 'express';
import { z } from 'zod';
import { GAME_MODES, STAKE_TIERS_CENTS } from '@escrow/shared';
import { requireAuth, requirePlayEligible } from '../../common/auth-middleware';
import { handler } from '../../common/async-handler';
import { badRequest } from '../../common/errors';
import * as matches from './matches.service';
import * as results from '../results/results.service';
import * as screenshots from '../screenshots/screenshots.service';
import * as matchmaking from '../lobby/matchmaking.service';
import { leaderboardForStake } from '../../db/repos/tournaments.repo';

export const matchesRouter = Router();
matchesRouter.use(requireAuth);

const gameMode = z.enum(GAME_MODES as unknown as [string, ...string[]]);
const rulesSchema = z.object({
  halfLengthMinutes: z.number().int().optional(),
  customTactics: z.boolean().optional(),
  chemistryStyles: z.boolean().optional(),
  squadRatingCap: z.number().int().nullable().optional(),
  extraTimeAndPenalties: z.boolean().optional(),
  notes: z.string().max(280).nullable().optional(),
});

const createSchema = z.object({
  gameMode,
  stakeCents: z.number().int().refine((value) => (STAKE_TIERS_CENTS as readonly number[]).includes(value), {
    message: 'Stake must be one of the offered tiers',
  }),
  rules: rulesSchema.optional(),
  game: z.string().min(1).max(60).optional(),
});

matchesRouter.post(
  '/',
  requirePlayEligible,
  handler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    const match = await matches.createMatch(req.currentUser!, parsed.data as never);
    res.status(201).json({ match });
  }),
);

matchesRouter.get(
  '/',
  handler(async (req, res) => {
    const stake = req.query.stakeCents ? Number(req.query.stakeCents) : undefined;
    const halfLength = req.query.halfLengthMinutes ? Number(req.query.halfLengthMinutes) : undefined;
    res.json({
      matches: await matches.lobby({
        stakeCents: Number.isFinite(stake) ? stake : undefined,
        gameMode: (req.query.gameMode as never) || undefined,
        halfLengthMinutes: Number.isFinite(halfLength) ? halfLength : undefined,
        // Your own open match is not something you can join, so it does not
        // belong in the joinable list.
        excludeUserId: req.userId,
      }),
    });
  }),
);

matchesRouter.get(
  '/mine',
  handler(async (req, res) => {
    res.json({ matches: await matches.myMatches(req.userId!) });
  }),
);

const quickMatchSchema = z.object({ gameMode, stakeCents: z.number().int().positive() });

matchesRouter.post(
  '/quick',
  requirePlayEligible,
  handler(async (req, res) => {
    const parsed = quickMatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    res.json(await matchmaking.quickMatch(req.currentUser!, parsed.data as never));
  }),
);

matchesRouter.delete(
  '/quick',
  handler(async (req, res) => {
    await matchmaking.leaveQueue(req.userId!);
    res.json({ ok: true });
  }),
);

matchesRouter.get(
  '/leaderboard',
  handler(async (req, res) => {
    const stake = Number(req.query.stakeCents ?? STAKE_TIERS_CENTS[1]);
    res.json({ stakeCents: stake, rows: await leaderboardForStake(stake) });
  }),
);

matchesRouter.get(
  '/:matchId',
  handler(async (req, res) => {
    res.json(await matches.detail(req.params.matchId));
  }),
);

matchesRouter.post(
  '/:matchId/join',
  requirePlayEligible,
  handler(async (req, res) => {
    res.json({ match: await matches.joinMatch(req.currentUser!, req.params.matchId) });
  }),
);

matchesRouter.post(
  '/:matchId/ready',
  handler(async (req, res) => {
    const ready = req.body?.ready !== false;
    res.json({ match: await matches.setReady(req.currentUser!, req.params.matchId, ready) });
  }),
);

matchesRouter.post(
  '/:matchId/cancel',
  handler(async (req, res) => {
    res.json({ match: await matches.cancelOpenMatch(req.currentUser!, req.params.matchId) });
  }),
);

matchesRouter.post(
  '/:matchId/forfeit',
  handler(async (req, res) => {
    res.json({ match: await matches.forfeitMatch(req.currentUser!, req.params.matchId) });
  }),
);

const resultSchema = z.object({
  selfScore: z.number().int().min(0).max(99),
  opponentScore: z.number().int().min(0).max(99),
  screenshotId: z.string().uuid().nullable().optional(),
  clipUrl: z.string().url().max(500).nullable().optional(),
});

matchesRouter.post(
  '/:matchId/result',
  handler(async (req, res) => {
    const parsed = resultSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    res.status(201).json(
      await results.submitResult(req.currentUser!, { matchId: req.params.matchId, ...parsed.data }),
    );
  }),
);

const screenshotSchema = z.object({
  contentType: z.enum(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']),
  dataBase64: z.string().min(16),
  capturedAt: z.string().datetime().nullable().optional(),
});

matchesRouter.post(
  '/:matchId/screenshots',
  handler(async (req, res) => {
    const parsed = screenshotSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    const screenshot = await screenshots.uploadScreenshot(req.currentUser!, {
      matchId: req.params.matchId,
      ...parsed.data,
    });
    res.status(201).json({ screenshot });
  }),
);

const chatSchema = z.object({ body: z.string().min(1).max(500) });

matchesRouter.post(
  '/:matchId/chat',
  handler(async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Message must be 1-500 characters');
    res.status(201).json({
      message: await matches.postChatMessage(req.currentUser!, req.params.matchId, parsed.data.body),
    });
  }),
);

matchesRouter.get(
  '/:matchId/chat',
  handler(async (req, res) => {
    res.json({ messages: await matches.chatHistory(req.currentUser!, req.params.matchId) });
  }),
);
