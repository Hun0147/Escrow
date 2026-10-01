/**
 * Goal 27 service worker.
 *
 * What it does: makes the installed app open instantly and say something
 * honest when the phone is offline.
 *
 * What it deliberately does not do: cache anything about money or match
 * state. A cached balance, lobby or scoreline is a lie with a player's stake
 * behind it — and a "helpful" replayed POST could stake, report or withdraw
 * twice. So only the build's own immutable assets and a static offline page
 * are ever stored, every non-GET request is passed straight through, and
 * cross-origin requests (the API lives on its own host) are never touched.
 *
 * Same rule as the rest of the platform: money moves over HTTP, validated and
 * transactional, against the server that owns the ledger. Nothing here is
 * allowed to stand in for that.
 */

const VERSION = 'goal27-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL = ['/offline', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One missing file must not fail the whole install, or a renamed asset
      // leaves the app with no offline page at all.
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything that changes state is a POST/PUT/DELETE. Never intercepted,
  // never retried, never replayed.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The API and the socket gateway are another origin entirely. Leave them
  // alone: a cached /wallet or /matches response is a stale balance.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;

  // Hashed build output — immutable by construction, so cache-first is both
  // safe and the whole reason the installed app opens instantly.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigateOrExplain(request));
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/**
 * Pages are always fetched fresh. Offline, the player gets a page that says
 * so — not yesterday's lobby with yesterday's stakes in it.
 */
async function navigateOrExplain(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const offline = await cache.match('/offline');
    return (
      offline ??
      new Response('<h1>Offline</h1>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    );
  }
}
