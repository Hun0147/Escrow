export const metadata = {
  title: 'PS5 Skill Wager Escrow',
  description: 'Escrow-backed skill wagers for PlayStation 5 competitive gaming.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#0b0d10', color: '#f0f0f0' }}>
        {children}
      </body>
    </html>
  );
}
