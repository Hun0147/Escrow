/**
 * Line icons, drawn rather than typed.
 *
 * Emoji were standing in here, which renders a different picture on every
 * platform and never matches the type around it. These inherit currentColor
 * and sit on a 24px grid with a 1.75 stroke, so they read at nav size without
 * going muddy.
 */
type IconProps = { className?: string };

function Svg({ children, className }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ?? 'h-[22px] w-[22px]'}
    >
      {children}
    </svg>
  );
}

export function PitchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="M12 4.5v15" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M2.5 9.2h2.6v5.6H2.5M21.5 9.2h-2.6v5.6h2.6" />
    </Svg>
  );
}

export function TrophyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M7 6H4.5v1.5A3.5 3.5 0 0 0 8 11M17 6h2.5v1.5A3.5 3.5 0 0 1 16 11" />
      <path d="M12 14v3m-3.5 3h7l-.7-2.2a1.2 1.2 0 0 0-1.1-.8h-3.4a1.2 1.2 0 0 0-1.1.8L8.5 20Z" />
    </Svg>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H18a2 2 0 0 1 2 2v1" />
      <rect x="3" y="8.5" width="18" height="10.5" rx="2.5" />
      <path d="M16.5 13.75h.01" />
    </Svg>
  );
}

export function RanksIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20V11M10 20V5M16 20v-6M22 20H2" />
    </Svg>
  );
}

export function PlayerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </Svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 10a6 6 0 1 1 12 0c0 3 .8 4.6 1.6 5.5.4.5.1 1.3-.6 1.3H5c-.7 0-1-.8-.6-1.3C5.2 14.6 6 13 6 10Z" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 5.8v5.4c0 4.3 2.9 7.6 7 9.8 4.1-2.2 7-5.5 7-9.8V5.8L12 3Z" />
    </Svg>
  );
}
