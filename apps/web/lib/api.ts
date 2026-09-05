'use client';

/**
 * Thin API client.
 *
 * The token lives in localStorage and is attached to every request; a 401
 * clears it and bounces to the splash screen, so an expired session can never
 * leave the UI showing a stale balance.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const TOKEN_KEY = 'goal27.token';
const DEVICE_KEY = 'goal27.device';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * A stable per-browser id. It is not a real fingerprint — a production build
 * would use a proper signal — but it gives the linked-account checks
 * something to work with and shows where that value plugs in.
 */
export function deviceFingerprint(): string {
  if (typeof window === 'undefined') return 'server';
  let value = window.localStorage.getItem(DEVICE_KEY);
  if (!value) {
    value = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, value);
  }
  return value;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Fingerprint': deviceFingerprint(),
  };
  const token = getToken();
  if (token && options.auth !== false) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      setToken(null);
      window.location.href = '/';
    }
    const error = payload.error ?? {};
    throw new ApiError(response.status, error.code ?? 'error', error.message ?? 'Request failed', error.details);
  }
  return payload as T;
}
