/**
 * The app logo for the header, drawn without its tile so it sits on the header in either theme. Same artwork as
 * public/favicon.svg (see scripts/generate-icons.mjs), cropped to the lines, with colours from the --tt-logo-* tokens.
 */
export function AppLogo({ className = '' }: { className?: string }) {
  const line = { fill: 'none', strokeWidth: 64, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg viewBox="64 160 384 192" className={className} aria-hidden="true" focusable="false">
      <path d="M256 256 L320 192 H416" stroke="var(--tt-logo-untravelled)" {...line} />
      <path d="M96 320 H192 L256 256" stroke="var(--tt-logo-travelled)" {...line} />
      <circle cx="256" cy="256" r="40" fill="#fff" stroke="var(--tt-logo-junction-ring)" strokeWidth="24" />
    </svg>
  );
}
