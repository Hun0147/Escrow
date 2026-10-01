import jwt from 'jsonwebtoken';

/**
 * The signing secret.
 *
 * The development default is in a public repository, so a production
 * deployment that forgets to set one would hand anybody who reads it the
 * ability to mint a valid token for any account — every wallet on the
 * platform, from a text editor. That is not a warning-level problem, so
 * production refuses to start instead.
 */
const JWT_SECRET = resolveSecret();
const JWT_EXPIRES_IN = '7d';

function resolveSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (configured && configured.length >= 16) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      configured
        ? 'JWT_SECRET is too short: use at least 16 characters of random value.'
        : 'JWT_SECRET is not set. Every session token is signed with it, and the\n' +
          '  development default is public, so this deployment refuses to start.\n' +
          '  Generate one with: openssl rand -base64 48',
    );
  }
  return configured ?? 'dev-secret-do-not-use-in-production';
}

export interface AuthTokenPayload {
  sub: string; // user id
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}
