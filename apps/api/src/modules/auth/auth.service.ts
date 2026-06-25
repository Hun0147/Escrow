import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { store } from '../../db/store';

export class AuthError extends Error {}

export async function registerUser(email: string, password: string, psnId?: string) {
  if (store.findUserByEmail(email)) {
    throw new AuthError('Email already registered');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuid(),
    email,
    passwordHash,
    psnId: psnId ?? null,
    walletBalanceCents: 0,
    kycStatus: 'pending' as const,
    createdAt: new Date().toISOString(),
  };
  store.users.set(user.id, user);
  return sanitize(user);
}

export async function loginUser(email: string, password: string) {
  const user = store.findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AuthError('Invalid credentials');
  }
  return sanitize(user);
}

function sanitize<T extends { passwordHash: string }>(user: T) {
  const { passwordHash, ...rest } = user;
  return rest;
}
