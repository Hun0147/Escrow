import { Router } from 'express';
import { requireAuth } from '../../common/auth-middleware';
import { handler } from '../../common/async-handler';
import * as subscriptions from './subscriptions.service';

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth);

subscriptionRouter.get(
  '/',
  handler(async (req, res) => {
    res.json(await subscriptions.status(req.userId!));
  }),
);

subscriptionRouter.post(
  '/',
  handler(async (req, res) => {
    res.status(201).json({ subscription: await subscriptions.subscribe(req.currentUser!) });
  }),
);

subscriptionRouter.delete(
  '/',
  handler(async (req, res) => {
    res.json({ subscription: await subscriptions.cancel(req.currentUser!) });
  }),
);
