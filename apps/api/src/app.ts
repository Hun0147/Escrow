import express, { NextFunction, Request, Response } from 'express';
import { STAKE_TIERS_CENTS, GAME_MODES, ALLOWED_HALF_LENGTHS, SKILL_TIERS } from '@escrow/shared';
import { AppError } from './common/errors';
import { authRouter } from './modules/auth/auth.routes';
import { meRouter, usersRouter } from './modules/onboarding/profile.routes';
import { walletRouter } from './modules/wallet/wallet.routes';
import { matchesRouter } from './modules/matches/matches.routes';
import { disputesRouter } from './modules/disputes/disputes.routes';
import { tournamentsRouter } from './modules/tournaments/tournaments.routes';
import { adminRouter } from './modules/admin/admin.routes';

export function createApp() {
  const app = express();

  // Screenshots arrive as base64 in JSON, so the body limit has to clear the
  // 8 MB upload cap with room for the encoding overhead.
  app.use(express.json({ limit: '12mb' }));
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.WEB_ORIGIN ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Fingerprint');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  /** Everything the client needs to render the lobby filters without hard-coding. */
  app.get('/config', (_req, res) =>
    res.json({
      stakeTiersCents: STAKE_TIERS_CENTS,
      gameModes: GAME_MODES,
      halfLengths: ALLOWED_HALF_LENGTHS,
      skillTiers: SKILL_TIERS,
    }),
  );

  app.use('/auth', authRouter);
  app.use('/me', meRouter);
  app.use('/users', usersRouter);
  app.use('/wallet', walletRouter);
  app.use('/matches', matchesRouter);
  app.use('/disputes', disputesRouter);
  app.use('/tournaments', tournamentsRouter);
  app.use('/admin', adminRouter);

  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such route' } }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    // Anything else is a bug. Log it in full, tell the client nothing.
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  return app;
}
