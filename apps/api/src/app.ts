import express from 'express';
import { authRouter } from './modules/auth/auth.routes';
import { walletRouter } from './modules/wallet/wallet.routes';
import { matchesRouter } from './modules/matches/matches.routes';
import { disputesRouter } from './modules/disputes/disputes.routes';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/auth', authRouter);
  app.use('/wallet', walletRouter);
  app.use('/matches', matchesRouter);
  app.use('/disputes', disputesRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
