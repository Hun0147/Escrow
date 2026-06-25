import { Router } from 'express';
import { z } from 'zod';
import { AuthError, loginUser, registerUser } from './auth.service';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  psnId: z.string().optional(),
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const user = await registerUser(parsed.data.email, parsed.data.password, parsed.data.psnId);
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof AuthError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const user = await loginUser(parsed.data.email, parsed.data.password);
    res.json(user);
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message });
    throw err;
  }
});
