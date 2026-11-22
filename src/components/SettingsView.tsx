import type { InstallPromptController } from '../hooks/useInstallPrompt';
import { SYNC_CONFIGURED } from '../lib/sync-api';
import type { ProgressStyle } from '../lib/types';
import { BackupSection } from './BackupSection';
import { TravelledSwatch } from './HighlightSwatches';
import { InstallAppSection } from './InstallAppSection';
import { PrivacyDetails } from './PrivacyDetails';

function ExternalLink({ href, children }: { href: string; children: string }) {
  return <a className="underline" href={href} target="_blank" rel="noreferrer">{children}</a>;
}

/** The Progress heading: where focus goes if the reset confirmation's button has gone when it closes. */
export const PROGRESS_HEADING_ID = 'progress-heading';

interface SettingsViewProps {
  /** "Reset progress" was pressed: confirm first, then return focus to `button`. */
  onResetRequest: (button: HTMLButtonElement) => void;
  install: InstallPromptController;
  hasProgress: boolean;
  progressStyle: ProgressStyle;
  onProgressStyleChange: (style: ProgressStyle) => void;
  /** Backup & sync is in this build and this browser can use passkeys. */
  backupAvailable: boolean;
  /** Backup & sync is on, so the install section can say how to restore the backup in the Home Screen app. */
  backedUp: boolean;
}

const PROGRESS_STYLE_OPTIONS: ReadonlyArray<{ value: ProgressStyle; label: string; description: string }> = [
  { value: 'lines', label: 'Bold lines', description: 'Travelled track is drawn bold in its line’s colour; lines you haven’t travelled are drawn thinner.' },
  { value: 'band', label: 'Yellow highlight', description: 'Travelled track is highlighted with a yellow band beneath the lines.' }
];

function ProgressStyleSetting({ value, onChange }: { value: ProgressStyle; onChange: (style: ProgressStyle) => void }) {
  return (
    <fieldset>
      <legend className="text-lg font-semibold">Map</legend>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Show travelled track as:</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {PROGRESS_STYLE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 has-checked:border-slate-900 has-checked:bg-slate-50 has-focus-visible:outline-2 has-focus-visible:outline-blue-600 dark:border-slate-700 dark:has-checked:border-slate-300 dark:has-checked:bg-slate-800"
          >
            <input
              type="radio"
              name="progress-style"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-1 h-4 w-4 shrink-0 accent-slate-900 dark:accent-slate-200"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                {option.label}
                <TravelledSwatch progressStyle={option.value} />
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-slate-600 dark:text-slate-300">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SettingsView({ onResetRequest, install, hasProgress, progressStyle, onProgressStyleChange, backupAvailable, backedUp }: SettingsViewProps) {
  return (
    <main className="mx-auto max-w-3xl px-4 pb-10">
      <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h2 id={PROGRESS_HEADING_ID} tabIndex={-1} className="rounded text-lg font-semibold outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
            Progress
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            <button onClick={(event) => onResetRequest(event.currentTarget)} className="min-h-11 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white">Reset progress</button>
          </div>
        </div>

        {/* Absent from builds without a backup server, so they read exactly as before. */}
        {SYNC_CONFIGURED && <BackupSection hasProgress={hasProgress} standalone={install.standalone} />}

        <ProgressStyleSetting value={progressStyle} onChange={onProgressStyleChange} />

        <InstallAppSection install={install} hasProgress={hasProgress} backup={backupAvailable ? (backedUp ? 'on' : 'off') : null} />

        <div>
          <h2 className="text-lg font-semibold">About</h2>
          {backupAvailable ? (
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Tube Tracker uses a local graph model of London transport stations and sections. Your progress is stored on this device. If you turn on
              Backup &amp; sync, a copy is also kept on Tube Tracker’s server so you can restore it. The app keeps working offline after its first
              successful load.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Tube Tracker uses a local graph model of London transport stations and sections. Your progress is stored only on
              this device (in IndexedDB), and the app keeps working offline after its first successful load.
            </p>
          )}
          {backupAvailable && <PrivacyDetails />}
        </div>

        <div>
          <h2 className="text-lg font-semibold">Data sources</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>
              Map SVG based on work by <ExternalLink href="https://commons.wikimedia.org/wiki/User:Sameboat">Sameboat</ExternalLink>,
              adapted for this app and licensed under <ExternalLink href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</ExternalLink>.
            </li>
            <li>
              Station and network data from the <ExternalLink href="https://api.tfl.gov.uk/">TfL Unified API</ExternalLink>,
              licensed under the <ExternalLink href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/">Open Government Licence v3.0</ExternalLink>.
            </li>
            <li>Reference project: <ExternalLink href="https://github.com/Demianeen/tube-map">Demianeen/tube-map</ExternalLink>.</li>
            <li>
              This is not an official TfL service. See the{' '}
              <ExternalLink href={`${import.meta.env.BASE_URL}licenses/reference-map-LICENCE.txt`}>full attribution and licence notice</ExternalLink>.
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}
