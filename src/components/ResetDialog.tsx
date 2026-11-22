import { BackupName } from './BackupDialogs';
import { ModalDialog } from './ModalDialog';
import { PROGRESS_HEADING_ID } from './SettingsView';

interface ResetDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
  /** The backup this device is using, if any: a reset clears it on every device. */
  backupName: string | null;
  /** Offline while backed up: the other devices clear later. */
  offline: boolean;
  /** The "Reset progress" button: focus goes back to it when the dialog closes. */
  returnFocusTo: HTMLElement | null;
}

/** "Reset all progress?": a modal dialog like the backup ones (docs/sync-design.md, "Dialogs"), Cancel focused first. */
export function ResetDialog({ onCancel, onConfirm, backupName, offline, returnFocusTo }: ResetDialogProps) {
  return (
    <ModalDialog title="Reset all progress?" onCancel={onCancel} returnFocusTo={returnFocusTo} fallbackFocusId={PROGRESS_HEADING_ID}>
      {backupName ? (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          This permanently clears your recorded routes on this device and on every device using <BackupName name={backupName} />. It can’t be undone.
          {offline && ' Your other devices will clear when this one is back online.'}
        </p>
      ) : (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          This permanently clears your recorded routes and cannot be undone. Are you sure?
        </p>
      )}
      <div className="mt-5 flex justify-end gap-3">
        <button type="button" data-autofocus className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm dark:border-slate-600" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="min-h-11 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white" onClick={onConfirm}>
          Reset progress
        </button>
      </div>
    </ModalDialog>
  );
}
