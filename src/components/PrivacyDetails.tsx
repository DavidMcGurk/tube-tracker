import { PRIVACY_DETAILS_ID } from './BackupSection';

const PROJECT_ISSUES_URL = 'https://github.com/DavidMcGurk/tube-tracker/issues';

/** Settings → About: what Backup & sync keeps and for how long (docs/sync-design.md, "Privacy details"). */
export function PrivacyDetails() {
  return (
    <details id={PRIVACY_DETAILS_ID} className="mt-3 scroll-mt-4 rounded-xl border border-slate-200 dark:border-slate-700">
      <summary className="flex min-h-11 cursor-pointer items-center rounded-xl px-3 text-sm font-medium">Privacy details</summary>
      <div className="space-y-2 px-3 pb-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <p>Tube Tracker is a personal project run by an independent developer. Backup &amp; sync runs on Cloudflare (Workers and a D1 database).</p>
        <p>
          Your backup holds the journeys you’ve recorded and when you recorded them, plus each passkey’s public key, which password manager saved
          it and when it was last used. For each device signed in to your backup, it also keeps a random sign-in code (stored only as a hash), when
          it signed in and the day it last connected. Sign-ins unused for 400 days are deleted. No name, email or password, and we don’t keep your IP
          address.
        </p>
        <p>Request logs keep no IP addresses or headers. Error logs record only what went wrong, never your journeys, and are kept for up to 7 days.</p>
        <p>Deleting your backup removes it at once. It leaves Cloudflare’s recovery copies within 7 days.</p>
        <p>
          Questions or problems? <a className="underline" href={PROJECT_ISSUES_URL} target="_blank" rel="noreferrer">Open an issue on GitHub</a>.
        </p>
      </div>
    </details>
  );
}
