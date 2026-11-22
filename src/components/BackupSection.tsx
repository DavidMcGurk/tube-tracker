import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useOnline } from '../hooks/useOnline';
import { useSync, type Outcome, type RestoreMerge, type SyncStatus } from '../hooks/useSync';
import { describeStatus, describeUndoWait, formatDate } from '../lib/backup-format';
import { getSyncSnapshot } from '../lib/sync';
import type { Passkey } from '../lib/sync-api';
import { ActionButton, BackupName, ConfirmDialog, NoteText, RestoreMergeDialog, TurnOffDialog, type Note } from './BackupDialogs';

export const BACKUP_HEADING_ID = 'backup-heading';
export const PRIVACY_DETAILS_ID = 'privacy-details';

/** Which action is running, so its button can say so ("Turning on…") while every other one waits. */
type Busy = 'turnOn' | 'restore' | 'addLocal' | 'keepBackup' | 'addPasskey' | 'removePasskey' | 'signOutOthers' | 'backUpFirst' | 'turnOff' | 'delete';

type DialogState =
  | { kind: 'merge'; merge: RestoreMerge }
  | { kind: 'turnOff' }
  | { kind: 'delete'; accountName: string }
  | { kind: 'removePasskey'; passkey: Passkey }
  | { kind: 'signOutOthers'; accountName: string };

const MUTED = 'text-sm leading-6 text-slate-600 dark:text-slate-300';
const CAPTION = 'mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300';
const STATUS_TICK_MS = 30_000;

/** Opens the privacy details in Settings → About and moves to them. */
function showPrivacyDetails() {
  const details = document.getElementById(PRIVACY_DETAILS_ID);
  if (!(details instanceof HTMLDetailsElement)) return;
  details.open = true;
  details.scrollIntoView({ block: 'start', behavior: 'smooth' });
  details.querySelector('summary')?.focus({ preventScroll: true });
}

interface BackupSectionProps {
  /** Journeys recorded on this device: turning on then asks whether there's a backup to restore instead. */
  hasProgress: boolean;
  /** The Home Screen app, whose data is "this app’s data" rather than "this browser’s data". */
  standalone: boolean;
}

/**
 * Settings → "Backup & sync" (docs/sync-design.md, "UI"). Only rendered in builds with VITE_SYNC_URL. Off, it offers to
 * turn backup on or restore one; on, it shows the status, the backup's passkeys and the ways to manage or leave it.
 * Results are announced in one polite status region; after turning on or off, focus moves to the heading.
 */
export function BackupSection({ hasProgress, standalone }: BackupSectionProps) {
  const sync = useSync();
  const { account, status, notice, available, prepare } = sync;
  const online = useOnline();
  const [busy, setBusy] = useState<Busy | null>(null);
  const busyRef = useRef<Busy | null>(null);
  const [dialog, setDialog] = useState<{ state: DialogState; opener: HTMLElement | null } | null>(null);
  const [sectionNote, setSectionNote] = useState<Note | null>(null);
  const [dialogNote, setDialogNote] = useState<Note | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [deletedName, setDeletedName] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; id: number } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepRef = useRef<HTMLParagraphElement>(null);
  const [, setTick] = useState(0);

  const announce = useCallback((text: string) => setAnnouncement((current) => ({ text, id: (current?.id ?? 0) + 1 })), []);
  const focusHeading = useCallback(() => headingRef.current?.focus(), []);

  // Prefetch passkey options (signed out) or load the passkey list (signed in): now, and when the app comes back.
  useEffect(() => {
    prepare();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') prepare();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [prepare]);

  // "Backed up · 2 minutes ago" moves on by itself.
  const signedIn = account !== null;
  useEffect(() => {
    if (!signedIn) return undefined;
    const timer = setInterval(() => setTick((tick) => tick + 1), STATUS_TICK_MS);
    return () => clearInterval(timer);
  }, [signedIn]);

  useEffect(() => {
    if (signedIn) setChoosing(false);
  }, [signedIn]);

  useLayoutEffect(() => {
    if (choosing) stepRef.current?.focus();
  }, [choosing]);

  // A restore waiting for its answer mustn't outlive the section: it holds a signed-in session.
  const dialogRef = useRef(dialog);
  useLayoutEffect(() => {
    dialogRef.current = dialog;
  });
  const cancelRestore = sync.cancelRestore;
  useEffect(() => () => {
    if (dialogRef.current?.state.kind === 'merge') cancelRestore();
  }, [cancelRestore]);

  /** Runs one backup action at a time, with its button showing progress and every other one disabled. */
  const run = useCallback(async (action: Busy, work: () => Promise<Outcome>): Promise<Outcome> => {
    if (busyRef.current) return { status: 'ignored' };
    busyRef.current = action;
    setBusy(action);
    setSectionNote(null);
    setDialogNote(null);
    try {
      return await work();
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  const noteFor = useCallback((outcome: Outcome, setNote: (note: Note) => void) => {
    if (outcome.status !== 'failed') return;
    setNote({ text: outcome.message, tone: outcome.neutral ? 'neutral' : 'error' });
    announce(outcome.message);
  }, [announce]);

  const restored = useCallback(() => {
    setDeletedName(null);
    announce(`Restored ${getSyncSnapshot().account?.name ?? 'your backup'}`);
    focusHeading();
  }, [announce, focusHeading]);

  const turnOn = async () => {
    const outcome = await run('turnOn', sync.turnOn);
    if (outcome.status === 'done') {
      setDeletedName(null);
      announce('Backup turned on');
      focusHeading();
    } else {
      noteFor(outcome, setSectionNote);
    }
  };

  const restore = async (button: HTMLButtonElement) => {
    const outcome = await run('restore', sync.restore);
    if (outcome.status === 'done') restored();
    else if (outcome.status === 'confirm') setDialog({ state: { kind: 'merge', merge: outcome.merge }, opener: button });
    else noteFor(outcome, setSectionNote);
  };

  const confirmRestore = async (addLocal: boolean) => {
    const outcome = await run(addLocal ? 'addLocal' : 'keepBackup', () => sync.confirmRestore(addLocal));
    if (outcome.status === 'ignored') return;
    // The restore's session is used up either way, so the dialog can't be tried again.
    setDialog(null);
    if (outcome.status === 'done') restored();
    else noteFor(outcome, setSectionNote);
  };

  const closeDialog = () => {
    if (dialog?.state.kind === 'merge') sync.cancelRestore();
    setDialogNote(null);
    setDialog(null);
  };

  const openDialog = (state: DialogState, opener: HTMLElement) => {
    setSectionNote(null);
    setDialogNote(null);
    setDialog({ state, opener });
  };

  /**
   * Runs a dialog's action: done closes it (and says so), and the dialog returns focus to its button, or to the heading
   * if that's gone (after turning off or deleting); a failure stays in the dialog.
   */
  const runInDialog = async (action: Busy, work: () => Promise<Outcome>, done: () => void) => {
    const outcome = await run(action, work);
    if (outcome.status === 'done') {
      setDialog(null);
      done();
    } else {
      noteFor(outcome, setDialogNote);
    }
  };

  const turnOff = (options: { backUpFirst: boolean; removeLocal: boolean }) =>
    runInDialog(options.backUpFirst ? 'backUpFirst' : 'turnOff', () => sync.turnOff(options), () => announce('Backup turned off'));

  const deleteBackup = (accountName: string) =>
    runInDialog('delete', sync.deleteBackup, () => {
      setDeletedName(accountName);
      announce('Backup deleted');
    });

  const removePasskey = (id: string) => runInDialog('removePasskey', () => sync.removePasskey(id), () => announce('Passkey removed'));
  const signOutOthers = () => runInDialog('signOutOthers', sync.signOutOthers, () => announce('Other devices signed out'));

  const addPasskey = async () => {
    const outcome = await run('addPasskey', sync.addPasskey);
    if (outcome.status === 'done') {
      announce('Passkey added');
    } else if (outcome.status === 'verified') {
      const text = 'That confirmed it’s you. Tap “Add a passkey” again to save the new passkey.';
      setSectionNote({ text, tone: 'info' });
      announce(text);
    } else {
      noteFor(outcome, setSectionNote);
    }
  };

  /** Announces how "Back up now" went once its sync has finished. Signed out by it, the notice says why instead. */
  const backUpNow = async () => {
    setSectionNote(null);
    const before = getSyncSnapshot().status.lastSyncedAt;
    await sync.backUpNow();
    const after = getSyncSnapshot();
    if (!after.account) return;
    const { status: result } = after;
    if (!result.error && result.lastSyncedAt !== before) announce('Backed up');
    else if (result.phase === 'paused' || result.phase === 'error') announce(describeStatus(result, { now: Date.now(), online: navigator.onLine !== false }));
    else announce('Can’t reach the backup service');
  };

  const noticeLine = notice && !account && (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <p>This device was signed out of backup <BackupName name={notice.accountName} />. It may have been deleted on another device or not used for over a year. Your journeys are still on this device.</p>
      <button type="button" onClick={sync.dismissNotice} className="-ml-2 min-h-11 rounded-full px-2 font-medium underline">Dismiss</button>
    </div>
  );

  let body;
  if (account) {
    body = (
      <SignedIn
        accountName={account.name}
        passkeys={account.passkeys}
        status={status}
        online={online}
        busy={busy}
        note={sectionNote}
        onBackUpNow={() => void backUpNow()}
        onAddPasskey={() => void addPasskey()}
        onRemovePasskey={(passkey, button) => openDialog({ kind: 'removePasskey', passkey }, button)}
        onSignOutOthers={(button) => openDialog({ kind: 'signOutOthers', accountName: account.name }, button)}
        onTurnOff={(button) => openDialog({ kind: 'turnOff' }, button)}
        onDelete={(button) => openDialog({ kind: 'delete', accountName: account.name }, button)}
      />
    );
  } else if (!available) {
    body = <p className={`mt-2 ${MUTED}`}>This browser can’t use passkeys, so backup isn’t available here.</p>;
  } else {
    body = (
      <SignedOut
        hasProgress={hasProgress}
        standalone={standalone}
        choosing={choosing}
        stepRef={stepRef}
        busy={busy}
        note={sectionNote}
        deletedName={deletedName}
        onChoose={() => setChoosing(true)}
        onTurnOn={() => void turnOn()}
        onRestore={(button) => void restore(button)}
      />
    );
  }

  const fallback = BACKUP_HEADING_ID;
  const base = { busy, note: dialogNote, returnFocusTo: dialog?.opener ?? null, fallbackFocusId: fallback, onCancel: closeDialog };
  let dialogElement = null;
  const state = dialog?.state;
  if (state?.kind === 'merge') {
    dialogElement = <RestoreMergeDialog {...base} merge={state.merge} onChoose={(addLocal) => void confirmRestore(addLocal)} />;
  } else if (state?.kind === 'turnOff') {
    // A journey that can still be undone hasn't been backed up either; "Back up first" ends its window and sends it.
    dialogElement = <TurnOffDialog {...base} unsent={status.unsent || status.awaitingUndo} unsentReset={status.unsentReset} onTurnOff={(options) => void turnOff(options)} />;
  } else if (state?.kind === 'delete') {
    dialogElement = (
      <ConfirmDialog {...base} title="Delete your backup for all devices?" confirmLabel="Delete backup" busyLabel="Deleting…" tone="danger" onConfirm={() => void deleteBackup(state.accountName)}>
        This permanently deletes <BackupName name={state.accountName} /> and its journeys from Tube Tracker’s server. Every device using it stops backing up; each keeps the journeys it already has, including this one. This can’t be undone.
      </ConfirmDialog>
    );
  } else if (state?.kind === 'removePasskey') {
    dialogElement = (
      <ConfirmDialog {...base} title="Remove this passkey?" confirmLabel="Remove passkey" busyLabel="Removing…" tone="danger" onConfirm={() => void removePasskey(state.passkey.id)}>
        You won’t be able to restore your backup with this passkey any more. Your other devices will be signed out of backup; restore it on them with another passkey.
      </ConfirmDialog>
    );
  } else if (state?.kind === 'signOutOthers') {
    dialogElement = (
      <ConfirmDialog {...base} title="Sign out your other devices?" confirmLabel="Sign out other devices" busyLabel="Signing out…" tone="neutral" onConfirm={() => void signOutOthers()}>
        Every other device using <BackupName name={state.accountName} /> stops backing up and keeps the journeys it already has. You can restore the backup on them again with a passkey.
      </ConfirmDialog>
    );
  }

  return (
    <section aria-labelledby={BACKUP_HEADING_ID} onPointerDownCapture={prepare} onFocusCapture={prepare} data-backup-section={account ? 'on' : 'off'}>
      <h2 id={BACKUP_HEADING_ID} ref={headingRef} tabIndex={-1} className="scroll-mt-4 rounded text-lg font-semibold outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
        Backup &amp; sync
      </h2>
      {noticeLine}
      {body}
      {/* Announces results only ("Backup turned on"), never progress. */}
      <div role="status" className="sr-only">
        {announcement && <p key={announcement.id}>{announcement.text}</p>}
      </div>
      {dialogElement}
    </section>
  );
}

interface SignedOutProps {
  hasProgress: boolean;
  standalone: boolean;
  choosing: boolean;
  stepRef: RefObject<HTMLParagraphElement | null>;
  busy: Busy | null;
  /** How turning on or restoring went, shown under its buttons. */
  note: Note | null;
  deletedName: string | null;
  onChoose: () => void;
  onTurnOn: () => void;
  onRestore: (button: HTMLButtonElement) => void;
}

function SignedOut({ hasProgress, standalone, choosing, stepRef, busy, note, deletedName, onChoose, onTurnOn, onRestore }: SignedOutProps) {
  const restoreCaptionId = useId();
  const turnOnCaptionId = useId();
  const stepId = useId();
  const locked = busy !== null;
  const turnOnButton = (tone: 'primary' | 'secondary', label: string, describedBy?: string) => (
    <ActionButton tone={tone} aria-describedby={describedBy} locked={locked} pressed={busy === 'turnOn'} busyLabel="Turning on…" onPress={onTurnOn} className="w-full sm:w-auto">
      {label}
    </ActionButton>
  );
  const restoreButton = (tone: 'primary' | 'secondary', label: string, describedBy?: string) => (
    <ActionButton tone={tone} aria-describedby={describedBy} locked={locked} pressed={busy === 'restore'} busyLabel="Restoring…" onPress={onRestore} className="w-full sm:w-auto">
      {label}
    </ActionButton>
  );

  let choices;
  if (!hasProgress) {
    choices = (
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          {restoreButton('primary', 'Restore from a backup', restoreCaptionId)}
          <p id={restoreCaptionId} className={CAPTION}>Backed up before, here or on another device?</p>
        </div>
        <div>
          {turnOnButton('secondary', 'Turn on backup', turnOnCaptionId)}
          <p id={turnOnCaptionId} className={CAPTION}>New to backup? Start one.</p>
        </div>
      </div>
    );
  } else if (choosing) {
    choices = (
      <div role="group" aria-labelledby={stepId} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
        <p id={stepId} ref={stepRef} tabIndex={-1} className="text-sm leading-6 outline-none">
          Already backing up Tube Tracker on another device? Restore that backup instead, so your devices share one.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          {restoreButton('primary', 'Restore my backup')}
          {turnOnButton('secondary', 'Start a new backup')}
        </div>
      </div>
    );
  } else {
    choices = (
      <div className="mt-4 flex flex-wrap gap-3">
        <ActionButton tone="primary" locked={locked} onPress={onChoose} className="w-full sm:w-auto">Turn on backup</ActionButton>
        {restoreButton('secondary', 'Restore from a backup')}
      </div>
    );
  }

  return (
    <>
      {deletedName && (
        <p className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 dark:border-slate-700 dark:bg-slate-800/60">
          You can also delete the “<BackupName name={deletedName} />” passkey in your passwords app.
        </p>
      )}
      <div className={`mt-2 space-y-2 ${MUTED}`}>
        <p>
          Back up your journeys so you can get them back if {standalone ? 'this app’s data' : 'this browser’s data'} is cleared, and use them on your
          other devices.
        </p>
        <p>You sign in with a passkey (Face ID, Touch ID, fingerprint or your screen lock), with no email or password.</p>
        <p>
          Your passkey is the only way into your backup. Your password manager (such as iCloud Keychain or Google Password Manager) keeps it and
          syncs it to your other devices. If it’s lost, the backup can’t be recovered.
        </p>
      </div>
      {choices}
      <NoteText note={note} className="mt-3" />
      <p className="mt-4 text-xs leading-5 text-slate-600 dark:text-slate-300">
        Your backup holds the journeys you’ve recorded and when you recorded them, plus each passkey’s public key, which password manager saved it
        and when it was last used, and when each signed-in device last connected. No name, email or password, and we don’t keep your IP address.
        You can delete your backup at any time from a device that’s using it.{' '}
        <a
          href={`#${PRIVACY_DETAILS_ID}`}
          className="underline"
          onClick={(event) => {
            event.preventDefault();
            showPrivacyDetails();
          }}
        >
          Privacy details
        </a>
      </p>
    </>
  );
}

interface SignedInProps {
  accountName: string;
  passkeys: Passkey[] | null;
  status: SyncStatus;
  online: boolean;
  busy: Busy | null;
  /** How adding a passkey went, shown under its button. */
  note: Note | null;
  onBackUpNow: () => void;
  onAddPasskey: () => void;
  onRemovePasskey: (passkey: Passkey, button: HTMLButtonElement) => void;
  onSignOutOthers: (button: HTMLButtonElement) => void;
  onTurnOff: (button: HTMLButtonElement) => void;
  onDelete: (button: HTMLButtonElement) => void;
}

function SignedIn({ accountName, passkeys, status, online, busy, note, onBackUpNow, onAddPasskey, onRemovePasskey, onSignOutOthers, onTurnOff, onDelete }: SignedInProps) {
  const addHelperId = useId();
  const locked = busy !== null;
  const undoWait = describeUndoWait(status);
  return (
    <>
      <div className="mt-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        {/* Plain text, not a live region: it changes with every sync. */}
        <p className="text-sm font-medium" data-backup-status={status.phase}>{describeStatus(status, { now: Date.now(), online })}</p>
        {undoWait && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300" data-backup-undo-wait>{undoWait}</p>}
        {status.heldCount > 0 && <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">Some journeys couldn’t be backed up.</p>}
        <ActionButton tone="secondary" locked={locked} onPress={onBackUpNow} className="mt-3">Back up now</ActionButton>
      </div>

      <p className="mt-4 text-sm">Backup: <span className="font-medium whitespace-nowrap">{accountName}</span></p>
      <p className={`mt-1 ${MUTED}`}>Keep the “<BackupName name={accountName} />” passkey in your passwords app. Without it, this backup can’t be restored.</p>

      <h3 className="mt-4 text-base font-semibold">Passkeys</h3>
      {passkeys === null ? (
        <p className={`mt-1 ${MUTED}`}>Loading passkeys…</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {passkeys.map((passkey) => {
            const title = passkey.provider ?? 'Passkey';
            const added = formatDate(passkey.createdAt);
            return (
              <li key={passkey.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">
                    Added {added}{passkey.lastUsedAt !== null && ` · Last used ${formatDate(passkey.lastUsedAt)}`}
                  </p>
                  {!passkey.synced && (
                    <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-300">
                      This passkey is saved only on this device. If you lose the device, you can’t restore your backup. Tap Add a passkey and save one
                      somewhere that syncs, such as your phone or a password manager.
                    </p>
                  )}
                </div>
                {passkeys.length > 1 && (
                  <ActionButton tone="secondary" aria-label={`Remove ${title}, added ${added}`} locked={locked} onPress={(button) => onRemovePasskey(passkey, button)}>
                    Remove
                  </ActionButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3">
        <ActionButton tone="secondary" aria-describedby={addHelperId} locked={locked} pressed={busy === 'addPasskey'} busyLabel="Adding passkey…" onPress={onAddPasskey}>
          Add a passkey
        </ActionButton>
        <p id={addHelperId} className={CAPTION}>
          Save another passkey for this backup, for example on another phone, in a different password manager or on a security key, so you can
          restore it from more places.
        </p>
        <NoteText note={note} className="mt-2" />
      </div>

      <div className="mt-4">
        <ActionButton tone="secondary" locked={locked} onPress={onSignOutOthers}>Sign out other devices</ActionButton>
      </div>

      <p className={`mt-4 ${MUTED}`}>
        Using a different backup on your other devices? Delete this one, then choose Restore from a backup. This device’s journeys are added to it.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <ActionButton tone="secondary" locked={locked} onPress={onTurnOff}>Turn off on this device</ActionButton>
        <ActionButton tone="danger" locked={locked} onPress={onDelete}>Delete backup…</ActionButton>
      </div>
    </>
  );
}
