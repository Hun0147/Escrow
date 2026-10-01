/**
 * One error type for everything a client is allowed to see.
 *
 * Anything that isn't an AppError is a bug, and the error handler turns it
 * into a bare 500 without leaking the message — a stack trace in a JSON body
 * on a money-handling API is an information leak, not a debugging aid.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (what: string) =>
  new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooManyRequests = (code: string, message: string) =>
  new AppError(429, code, message);
