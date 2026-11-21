import type { ReactNode } from 'react';
import type { InstallPlatform } from '../lib/install-prompt';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block h-[1.25em] w-[1.25em] shrink-0 align-[-0.3em] text-blue-600 dark:text-blue-400"
    >
      {children}
    </svg>
  );
}

/** Safari's Share icon: an arrow leaving a box. */
export function ShareGlyph() {
  return (
    <Glyph>
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" />
    </Glyph>
  );
}

function AddToHomeScreenGlyph() {
  return (
    <Glyph>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 8.5v7M8.5 12h7" />
    </Glyph>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100">
        {number}
      </span>
      <span>{children}</span>
    </li>
  );
}

export const isIosPlatform = (platform: InstallPlatform) =>
  platform === 'ios-safari' || platform === 'ios-other-browser' || platform === 'ipados';

/** "Tap Share, then Add to Home Screen", worded for Safari or for another iOS browser. */
export function IosInstallSteps({ platform }: { platform: InstallPlatform }) {
  const otherBrowser = platform === 'ios-other-browser';
  return (
    <>
      <ol className="space-y-2 text-sm" aria-label="How to add Tube Tracker to your Home Screen">
        <Step number={1}>
          Tap {otherBrowser ? 'your browser’s ' : ''}<ShareGlyph /> <strong>Share</strong> button
        </Step>
        <Step number={2}>
          Choose <strong>Add to Home Screen</strong> <AddToHomeScreenGlyph />
        </Step>
      </ol>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        {otherBrowser ? 'Not there? Open this page in Safari instead.' : 'Don’t see Share? Tap ••• first.'}
      </p>
    </>
  );
}
