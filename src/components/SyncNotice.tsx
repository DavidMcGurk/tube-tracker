import { BackupName } from './BackupDialogs';

interface SyncNoticeProps {
  accountName: string;
  onOpenSettings: () => void;
  onDismiss: () => void;
}

/**
 * Shown above the map and statistics when the backup server no longer knew this device's session (docs/sync-design.md,
 * "Elsewhere"), in the page's flow so it never covers the tabs. Settings shows the same line in the Backup & sync
 * section instead.
 */
export function SyncNotice({ accountName, onOpenSettings, onDismiss }: SyncNoticeProps) {
  return (
    <div
      role="status"
      data-sync-notice
      className="flex flex-col gap-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between sm:gap-3 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <span className="pt-1 sm:pt-0">
        This device was signed out of backup <BackupName name={accountName} />. It may have been deleted on another device or not used for over a year. Your journeys
        are still on this device.
      </span>
      <div className="-ml-3 flex shrink-0 gap-1 sm:ml-0">
        <button type="button" className="min-h-11 rounded-full px-3 font-medium underline" onClick={onOpenSettings}>Backup settings</button>
        <button type="button" className="min-h-11 rounded-full px-3 font-medium underline" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
