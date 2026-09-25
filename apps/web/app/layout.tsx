import './globals.css';
import { SessionProvider } from '../components/SessionProvider';
import { InstallApp } from '../components/InstallApp';

export const metadata = {
  title: 'Goal 27 — PS5 money matches',
  description:
    'Stake, play EA Sports FC head-to-head on your own PS5, and get paid in minutes. Escrow-backed, screenshot-verified.',
  applicationName: 'Goal 27',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  // iOS ignores the manifest's display mode and reads these instead; without
  // them the home-screen icon opens a Safari tab rather than the app.
  appleWebApp: {
    capable: true,
    title: 'Goal 27',
    statusBarStyle: 'black-translucent' as const,
  },
  formatDetection: { telephone: false },
};

export const viewport = {
  themeColor: '#05070a',
  width: 'device-width',
  initialScale: 1,
  // The app draws its own background under the status bar and home indicator;
  // AppShell pays for that with safe-area padding.
  viewportFit: 'cover' as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
        <InstallApp />
      </body>
    </html>
  );
}
