import type { ReactNode } from 'react';
import type { ResolvedTheme } from '../lib/types';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-5 w-5">
      {children}
    </svg>
  );
}

/** Shows the theme the button switches to: a sun in dark mode, a moon in light mode. */
export function ThemeIcon({ resolvedTheme }: { resolvedTheme: ResolvedTheme }) {
  return resolvedTheme === 'dark' ? (
    <Icon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
    </Icon>
  ) : (
    <Icon>
      <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />
    </Icon>
  );
}

export function EnterFullscreenIcon() {
  return <Icon><path d="M3 8V3h5m8 0h5v5M21 16v5h-5M8 21H3v-5" /></Icon>;
}

export function ExitFullscreenIcon() {
  return <Icon><path d="M8 3v5H3m13-5v5h5M3 16h5v5m13-5h-5v5" /></Icon>;
}
