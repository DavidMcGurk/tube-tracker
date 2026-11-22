import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { describeMerge, describeMergeReset } from '../lib/backup-format';
import type { RestoreMerge } from '../lib/sync';
import { ModalDialog } from './ModalDialog';

export type ButtonTone = 'primary' | 'secondary' | 'neutral' | 'danger';

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-emerald-700 font-medium text-white hover:bg-emerald-800',
  secondary: 'border border-slate-300 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800',
  neutral: 'bg-slate-900 font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white',
  danger: 'bg-red-600 font-medium text-white hover:bg-red-700'
};

interface ActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled'> {
  tone: ButtonTone;
  /** A backup action is running: every backup button is disabled until it ends. */
  locked: boolean;
  /** This button started it, so it shows `busyLabel` ("Turning on…"). */
  pressed?: boolean;
  busyLabel?: string;
  onPress: (button: HTMLButtonElement) => void;
  children: ReactNode;
}

/**
 * Disabled with aria-disabled rather than `disabled`, so the pressed button keeps focus while the passkey window is
 * open and the result is read out where the user is.
 */
export function ActionButton({ tone, locked, pressed = false, busyLabel, onPress, children, className = '', ...rest }: ActionButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      aria-disabled={locked || undefined}
      aria-busy={pressed || undefined}
      onClick={(event) => {
        if (!locked) onPress(event.currentTarget);
      }}
      className={`min-h-11 rounded-xl px-4 py-2 text-sm aria-disabled:cursor-default aria-disabled:opacity-60 ${TONES[tone]} ${className}`}
    >
      {pressed && busyLabel ? busyLabel : children}
    </button>
  );
}

/** A backup's name ("Tube Tracker · K3F9") never breaks across lines. */
export function BackupName({ name }: { name: string }) {
  return <span className="whitespace-nowrap">{name}</span>;
}

export interface Note {
  text: string;
  /** error: something went wrong. neutral: nothing was done (the passkey window was closed). info: what to do next. */
  tone: 'error' | 'neutral' | 'info';
}

export function NoteText({ note, className = '' }: { note: Note | null; className?: string }) {
  if (!note) return null;
  const colour = note.tone === 'error' ? 'text-red-700 dark:text-red-300' : 'text-slate-700 dark:text-slate-200';
  return <p data-note-tone={note.tone} className={`text-sm leading-6 ${colour} ${className}`}>{note.text}</p>;
}

/**
 * A dialog's result. While a modal dialog is open the rest of the page is inert, so the section's status region can't
 * be heard: the dialog reads out its own results.
 */
function DialogNote({ note }: { note: Note | null }) {
  return (
    <div aria-live="polite">
      <NoteText note={note} className="mt-3" />
    </div>
  );
}

const BODY = 'mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300';
const BUTTON_ROW = 'mt-5 flex flex-wrap justify-end gap-3';

interface DialogBaseProps {
  busy: string | null;
  note: Note | null;
  returnFocusTo: HTMLElement | null;
  fallbackFocusId: string;
  onCancel: () => void;
}

export function RestoreMergeDialog({ merge, onChoose, ...base }: DialogBaseProps & { merge: RestoreMerge; onChoose: (addLocal: boolean, button: HTMLButtonElement) => void }) {
  const sublineId = useId();
  const locked = base.busy !== null;
  return (
    <ModalDialog title="Add this device’s journeys to your backup?" busy={locked} onCancel={base.onCancel} returnFocusTo={base.returnFocusTo} fallbackFocusId={base.fallbackFocusId}>
      <p className={BODY}>{describeMerge(merge)}</p>
      {merge.resetAt > 0 && <p className={BODY}>{describeMergeReset(merge.resetAt)}</p>}
      <DialogNote note={base.note} />
      <div className="mt-5 flex flex-col gap-3 sm:flex-row-reverse sm:items-start">
        <ActionButton tone="primary" data-autofocus locked={locked} pressed={base.busy === 'addLocal'} busyLabel="Restoring…" onPress={(button) => onChoose(true, button)} className="sm:flex-1">
          Add them
        </ActionButton>
        <div className="sm:flex-1">
          <ActionButton tone="secondary" aria-describedby={sublineId} locked={locked} pressed={base.busy === 'keepBackup'} busyLabel="Restoring…" onPress={(button) => onChoose(false, button)} className="w-full">
            Don’t add them
          </ActionButton>
          <p id={sublineId} className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">This device will show your backup’s journeys instead.</p>
        </div>
      </div>
    </ModalDialog>
  );
}

export function TurnOffDialog({ unsent, unsentReset, onTurnOff, ...base }: DialogBaseProps & {
  unsent: boolean;
  unsentReset: boolean;
  onTurnOff: (options: { backUpFirst: boolean; removeLocal: boolean }, button: HTMLButtonElement) => void;
}) {
  const [removeLocal, setRemoveLocal] = useState(false);
  const locked = base.busy !== null;
  return (
    <ModalDialog title="Turn off backup on this device?" busy={locked} onCancel={base.onCancel} returnFocusTo={base.returnFocusTo} fallbackFocusId={base.fallbackFocusId}>
      <p className={BODY}>Your backup and your other devices aren’t affected. Journeys stay on this device unless you remove them.</p>
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={removeLocal}
          onChange={(event) => setRemoveLocal(event.target.checked)}
          disabled={locked}
          className="h-5 w-5 shrink-0 accent-slate-900 dark:accent-slate-200"
        />
        Also remove journeys from this device
      </label>
      {unsent && (
        <p className="mt-2 text-sm leading-6 font-medium text-amber-800 dark:text-amber-300">
          {unsentReset ? 'Your reset on this device hasn’t been backed up yet, so your other devices haven’t cleared.' : 'Some journeys on this device haven’t been backed up yet.'}
        </p>
      )}
      <DialogNote note={base.note} />
      {/* Up to three buttons: stacked full width on phones, where they wouldn't fit in a row. */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
        <ActionButton tone="secondary" data-autofocus locked={locked} onPress={base.onCancel}>Cancel</ActionButton>
        {unsent && (
          <ActionButton tone="primary" locked={locked} pressed={base.busy === 'backUpFirst'} busyLabel="Backing up…" onPress={(button) => onTurnOff({ backUpFirst: true, removeLocal }, button)}>
            Back up first
          </ActionButton>
        )}
        <ActionButton tone="neutral" locked={locked} pressed={base.busy === 'turnOff'} busyLabel="Turning off…" onPress={(button) => onTurnOff({ backUpFirst: false, removeLocal }, button)}>
          Turn off
        </ActionButton>
      </div>
    </ModalDialog>
  );
}

interface ConfirmDialogProps extends DialogBaseProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  tone: ButtonTone;
  onConfirm: (button: HTMLButtonElement) => void;
}

/** Cancel (focused first) or one action: Delete backup, Remove passkey, Sign out other devices. */
export function ConfirmDialog({ title, children, confirmLabel, busyLabel, tone, onConfirm, ...base }: ConfirmDialogProps) {
  const locked = base.busy !== null;
  return (
    <ModalDialog title={title} busy={locked} onCancel={base.onCancel} returnFocusTo={base.returnFocusTo} fallbackFocusId={base.fallbackFocusId}>
      <p className={BODY}>{children}</p>
      <DialogNote note={base.note} />
      <div className={BUTTON_ROW}>
        <ActionButton tone="secondary" data-autofocus locked={locked} onPress={base.onCancel}>Cancel</ActionButton>
        <ActionButton tone={tone} locked={locked} pressed={locked} busyLabel={busyLabel} onPress={onConfirm}>{confirmLabel}</ActionButton>
      </div>
    </ModalDialog>
  );
}
