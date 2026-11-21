import { useEffect, type ReactNode } from 'react';
import type { InstallPromptController } from '../hooks/useInstallPrompt';
import { IosInstallSteps } from './InstallSteps';

interface InstallPromptProps {
  install: InstallPromptController;
  /** Whether journeys have been recorded here, which an iOS Home Screen app would not see (it keeps its own data). */
  hasProgress: boolean;
  /** Set while something else needs the screen, such as the route actions or a confirmation dialog. */
  suppressed: boolean;
}

const APP_ICON_URL = `${import.meta.env.BASE_URL}favicon.svg`;

/**
 * Points at the browser's Share button, on a chip so it stays visible over the map. The bounce is skipped for people
 * who prefer reduced motion. On iPad, Safari's Share button sits about 7rem in from the right edge of the screen.
 */
function ShareArrow({ direction }: { direction: 'up' | 'down' }) {
  const placement = direction === 'down' ? 'top-full left-1/2 mt-1.5 -ml-[1.125rem]' : 'bottom-full right-[5.25rem] mb-1.5';
  return (
    <span
      aria-hidden="true"
      data-install-arrow={direction}
      className={`pointer-events-none absolute grid h-9 w-9 place-items-center rounded-full border border-slate-200 bg-white text-blue-600 shadow-lg motion-safe:animate-bounce dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 ${placement}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        {direction === 'down' ? <path d="M12 5v14M6 13l6 6 6-6" /> : <path d="M12 19V5M6 11l6-6 6 6" />}
      </svg>
    </span>
  );
}

function PromptCard({ children, onClose, arrow }: { children: ReactNode; onClose: () => void; arrow?: ReactNode }) {
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="install-prompt-title"
      aria-describedby="install-prompt-description"
      className="pointer-events-auto relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-2xl shadow-slate-900/25 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:shadow-black/50"
    >
      <div className="flex items-start gap-3">
        <img src={APP_ICON_URL} alt="" width="44" height="44" className="h-11 w-11 shrink-0 rounded-[0.6rem] ring-1 ring-slate-900/5 dark:ring-white/20" />
        <div className="min-w-0 flex-1">
          <h2 id="install-prompt-title" className="text-base font-semibold leading-snug">Install Tube Tracker</h2>
          <p id="install-prompt-description" className="mt-0.5 text-sm leading-snug text-slate-600 dark:text-slate-300">
            Opens full screen and works offline.
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 -mt-2 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-2xl leading-none text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          ×
        </button>
      </div>
      <div className="mt-3">{children}</div>
      {arrow}
    </section>
  );
}

/** The "Add to Home Screen" pop-up shown to mobile visitors who are not using the installed app. */
export function InstallPrompt({ install, hasProgress, suppressed }: InstallPromptProps) {
  const { promptVariant: variant, platform, dismiss } = install;
  const visible = variant !== null && !suppressed;

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, dismiss]);

  if (!visible) return null;

  if (variant === 'native') {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[120] flex justify-center px-[max(0.75rem,env(safe-area-inset-left))] pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]" data-install-prompt="native">
        <PromptCard onClose={dismiss}>
          <button
            onClick={() => void install.install()}
            className="min-h-11 w-full rounded-xl bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            Install app
          </button>
        </PromptCard>
      </div>
    );
  }

  // An iOS Home Screen app has its own storage, so journeys already recorded in the browser don't carry over.
  const storageNote = hasProgress
    ? 'The Home Screen app keeps its own data, so journeys recorded here won’t appear in it.'
    : platform === 'ios-other-browser' ? null : 'In a Safari tab, saved data can be cleared after 7 days without a visit.';
  const safariNote = storageNote && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{storageNote}</p>;

  if (variant === 'ipad-share') {
    return (
      <div className="pointer-events-none fixed right-0 top-0 z-[120] flex w-full justify-end pl-3 pr-[max(0.75rem,env(safe-area-inset-right))] pt-[calc(3.25rem_+_env(safe-area-inset-top))]" data-install-prompt="ipad-share">
        <PromptCard onClose={dismiss} arrow={<ShareArrow direction="up" />}>
          <IosInstallSteps platform={platform} />
          {safariNote}
        </PromptCard>
      </div>
    );
  }

  const pointsAtSafari = platform === 'ios-safari';
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-[120] flex justify-center px-[max(0.75rem,env(safe-area-inset-left))] ${pointsAtSafari ? 'pb-[calc(3.25rem_+_env(safe-area-inset-bottom))]' : 'pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]'}`}
      data-install-prompt="ios-share"
    >
      <PromptCard onClose={dismiss} arrow={pointsAtSafari ? <ShareArrow direction="down" /> : undefined}>
        <IosInstallSteps platform={platform} />
        {safariNote}
      </PromptCard>
    </div>
  );
}
