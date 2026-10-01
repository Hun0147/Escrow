import { Router } from 'express';
import { z } from 'zod';
import { signToken } from '../../common/jwt';
import { handler } from '../../common/async-handler';
import { badRequest } from '../../common/errors';
import { loginUser, registerUser } from './auth.service';
import { getWallet } from '../../db/repos/ledger.repo';

export const authRouter = Router();

const registerSchema = z.object({
  handle: z.string().min(3).max(20).regex(/^[A-Za-z0-9_-]+$/, 'Handle may use letters, digits, _ and - only'),
  email: z.string().email(),
  password: z.string().min(10, 'Use at least 10 characters'),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  countryCode: z.string().length(2),
  regionCode: z.string().min(2).max(3).optional(),
  psnId: z.string().min(3).max(16).optional(),
  phone: z.string().min(7).max(20).optional(),
});

authRouter.post(
  '/register',
  handler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());

    const user = await registerUser({
      ...parsed.data,
      deviceFingerprint: req.header('x-device-fingerprint') ?? null,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    const wallet = await getWallet(user.id);
    res.status(201).json({ user, wallet, token: signToken(user.id) });
  }),
);

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post(
  '/login',
  handler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_body', 'Check the fields', parsed.error.flatten());
    const user = await loginUser(parsed.data.email, parsed.data.password);
    const wallet = await getWallet(user.id);
    res.json({ user, wallet, token: signToken(user.id) });
  }),
);
