import { NextFunction, Request, Response } from 'express';
import { UserRole } from '@escrow/shared';
import { pool } from '../db/pool';
import { verifyToken } from './jwt';
import { UserRow, findUserById, updateUser } from '../db/repos/users.repo';
import { forbidden, unauthorized } from './errors';
import { recordDevice } from '../db/repos/fraud.repo';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      currentUser?: UserRow;
    }
  }
}

/**
 * Authenticates the caller and loads their row.
 *
 * The acting identity always comes from the token — never from the request
 * body — so a client cannot deposit into, stake from, or report for another
 * account by editing a payload.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized('Missing bearer token'));

  let userId: string;
  try {
    userId = verifyToken(header.slice('Bearer '.length)).sub;
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }

  try {
    const user = await findUserById(userId);
    if (!user) return next(unauthorized('Account no longer exists'));
    if (user.bannedAt) return next(forbidden('account_banned', 'This account is banned'));

    req.userId = user.id;
    req.currentUser = user;

    // Passive fingerprinting: every authenticated request refreshes the
    // device/IP trail that linked-account detection reads from.
    const fingerprint = req.header('x-device-fingerprint');
    if (fingerprint) {
      await recordDevice({
        userId: user.id,
        fingerprint,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      });
    }
    if (req.ip && req.ip !== null) {
      await updateUser(user.id, { lastIp: req.ip });
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.currentUser) return next(unauthorized());
    if (!roles.includes(req.currentUser.role)) {
      return next(forbidden('insufficient_role', 'This action requires elevated privileges'));
    }
    next();
  };
}

/**
 * Gate for anything that stakes or deposits money.
 *
 * Self-exclusion and cool-off are deliberately checked here rather than in
 * each service: a responsible-play block that only covers some entry points is
 * not a block at all.
 */
export async function requirePlayEligible(req: Request, _res: Response, next: NextFunction) {
  const user = req.currentUser;
  if (!user) return next(unauthorized());
  const { rows } = await pool.query(
    'SELECT self_excluded_until, cool_off_until FROM users WHERE id = $1',
    [user.id],
  );
  const row = rows[0];
  const now = Date.now();
  if (row?.self_excluded_until && row.self_excluded_until.getTime() > now) {
    return next(
      forbidden(
        'self_excluded',
        `Self-exclusion is active until ${row.self_excluded_until.toISOString()}`,
      ),
    );
  }
  if (row?.cool_off_until && row.cool_off_until.getTime() > now) {
    return next(
      forbidden('cool_off', `Cool-off period is active until ${row.cool_off_until.toISOString()}`),
    );
  }
  next();
}
