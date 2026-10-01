import { Archivo, Inter } from 'next/font/google';

/**
 * Two faces, each doing one job.
 *
 * Archivo carries the money and the headings: it is wide, heavy at 800+, and
 * its figures are flat-sided, so a stake reads as a number rather than as
 * text. Inter carries everything a player has to read rather than glance at.
 *
 * Both are self-hosted by next/font — no render-blocking request to a third
 * party, and no flash of a fallback face under a balance.
 */
export const display = Archivo({
  subsets: ['latin'],
  weight: ['600', '700', '800', '900'],
  variable: '--font-display',
  display: 'swap',
});

export const body = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});
