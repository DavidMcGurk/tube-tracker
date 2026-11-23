import type { InstallPromptController } from '../hooks/useInstallPrompt';
import { buttonClass, SECTION_BUTTON } from './button-styles';
import { IosInstallSteps, isIosPlatform } from './InstallSteps';

interface InstallAppSectionProps {
  install: InstallPromptController;
  hasProgress: boolean;
  /** Backup & sync, when this build and browser have it: the Home Screen app gets its journeys by restoring. */
  backup: 'on' | 'off' | null;
}

/** Settings fallback for installing the app, available even after the pop-up was dismissed. */
export function InstallAppSection({ install, hasProgress, backup }: InstallAppSectionProps) {
  if (install.standalone) return null;
  const ios = isIosPlatform(install.platform);
  // How the Home Screen app gets the journeys: there's only a backup to restore once Backup & sync (above) is on.
  const restoreNote = backup === 'on'
    ? ' until you restore your backup there'
    : backup === 'off' ? ' unless you turn on Backup & sync above, then restore your backup in the app' : '';

  let body;
  if (install.canInstallNatively) {
    body = (
      <button
        onClick={() => void install.install()}
        className={`${buttonClass('primary')} ${SECTION_BUTTON}`}
      >
        Install app
      </button>
    );
  } else if (ios) {
    body = <IosInstallSteps platform={install.platform} />;
  } else if (install.installed) {
    body = <p className="text-sm text-slate-600 dark:text-slate-300">Tube Tracker is installed on this device. Open it from your home screen or app list.</p>;
  } else {
    body = (
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Look for <strong>Install app</strong>, <strong>Add to Home screen</strong> or <strong>Add to Dock</strong> in your browser’s menu.
      </p>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Install app</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
        Add Tube Tracker to your home screen to open it full screen and use it offline.
        {ios && (hasProgress
          ? ` On iPhone and iPad the Home Screen app keeps its own data, so journeys recorded in Safari won’t appear in it${restoreNote}.`
          : ' It also protects your progress: Safari can clear a website’s saved data after 7 days without a visit.')}
      </p>
      <div className="mt-3">{body}</div>
    </div>
  );
}
