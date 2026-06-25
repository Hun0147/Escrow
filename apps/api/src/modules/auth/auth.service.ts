import bcrypt from 'bcryptjs';
import { createUser, findUserByEmail } from '../../db/users.repo';

export class AuthError extends Error {}

export async function registerUser(email: string, password: string, psnId?: string) {
  if (await findUserByEmail(email)) {
    throw new AuthError('Email already registered');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({ email, passwordHash, psnId });
  return sanitize(user);
}

export async function loginUser(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AuthError('Invalid credentials');
  }
  return sanitize(user);
}

function sanitize<T extends { passwordHash: string }>(user: T) {
  const { passwordHash, ...rest } = user;
  return rest;
}
