import type { MetadataRoute } from 'next';

/**
 * The installed app.
 *
 * Goal 27 is a phone product that happens to be delivered over the web, so
 * this is not a nicety: installed, it opens full-screen from the home screen,
 * keeps its own session, and loses the browser chrome that was eating the
 * space the money bar needs.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Goal 27 — PS5 money matches',
    short_name: 'Goal 27',
    description:
      'Stake, play EA Sports FC head-to-head on your own PS5, and get paid in minutes. Escrow-backed, screenshot-verified.',
    id: '/lobby',
    // Straight to the lobby: an installed app opening on a marketing splash
    // is a wasted tap for the only people who install it.
    start_url: '/lobby',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#05070a',
    theme_color: '#05070a',
    categories: ['games', 'sports', 'finance'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Lobby', short_name: 'Lobby', url: '/lobby' },
      { name: 'Wallet', short_name: 'Wallet', url: '/wallet' },
      { name: 'Create a match', short_name: 'New match', url: '/lobby/new' },
    ],
  };
}
