import express, { NextFunction, Request, Response } from 'express';
import { STAKE_TIERS_CENTS, GAME_MODES, ALLOWED_HALF_LENGTHS, SKILL_TIERS } from '@escrow/shared';
import { AppError } from './common/errors';
import { handler } from './common/async-handler';
import { publishedFeeRates } from './common/fees';
import { authRouter } from './modules/auth/auth.routes';
import { meRouter, usersRouter } from './modules/onboarding/profile.routes';
import { walletRouter } from './modules/wallet/wallet.routes';
import { matchesRouter } from './modules/matches/matches.routes';
import { disputesRouter, evidenceRouter } from './modules/disputes/disputes.routes';
import { tournamentsRouter } from './modules/tournaments/tournaments.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { subscriptionRouter } from './modules/subscriptions/subscriptions.routes';
import { webhookRouter } from './modules/wallet/webhooks.routes';

export function createApp() {
  const app = express();

  // Webhooks must see the exact bytes the provider signed, so they are mounted
  // ahead of the JSON parser and read their body raw.
  app.use('/webhooks', webhookRouter);

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

  /** Everything the client needs to render the lobby and quote a fee without
   *  hard-coding either. */
  app.get(
    '/config',
    handler(async (_req, res) => {
      const { standardBps, proBps } = await publishedFeeRates();
      res.json({
        stakeTiersCents: STAKE_TIERS_CENTS,
        gameModes: GAME_MODES,
        halfLengths: ALLOWED_HALF_LENGTHS,
        skillTiers: SKILL_TIERS,
        escrowFeeBps: standardBps,
        proEscrowFeeBps: proBps,
      });
    }),
  );

  app.use('/auth', authRouter);
  app.use('/me', meRouter);
  app.use('/users', usersRouter);
  app.use('/wallet', walletRouter);
  app.use('/subscription', subscriptionRouter);
  app.use('/matches', matchesRouter);
  app.use('/disputes', disputesRouter);
  app.use('/evidence', evidenceRouter);
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
