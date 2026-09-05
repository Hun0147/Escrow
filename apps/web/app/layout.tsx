import './globals.css';
import { SessionProvider } from '../components/SessionProvider';

export const metadata = {
  title: 'Goal 27 — PS5 money matches',
  description:
    'Stake, play EA Sports FC head-to-head on your own PS5, and get paid in minutes. Escrow-backed, screenshot-verified.',
};

export const viewport = {
  themeColor: '#05070a',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
