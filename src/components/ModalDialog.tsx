import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

interface ModalDialogProps {
  title: string;
  children: ReactNode;
  /** Escape. Ignored while `busy`, so a running action keeps its dialog. */
  onCancel: () => void;
  busy?: boolean;
  /** The button that opened the dialog: focus goes back to it on close (Safari doesn't focus buttons on click). */
  returnFocusTo: HTMLElement | null;
  /** Where focus goes instead when that button is gone, e.g. the section heading after backup was turned off. */
  fallbackFocusId: string;
}

/**
 * A modal `<dialog>` (docs/sync-design.md, "Dialogs"): showModal() keeps focus inside and makes the page behind inert;
 * Escape cancels; focus starts on the element marked `data-autofocus` and returns to the opener, or the fallback, on
 * close. The dialog is open for as long as it's mounted.
 */
export function ModalDialog({ title, children, onCancel, busy = false, returnFocusTo, fallbackFocusId }: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const latest = useRef({ onCancel, busy });
  useLayoutEffect(() => {
    latest.current = { onCancel, busy };
  });

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    // Escape: keep the dialog open until the parent unmounts it, so React and the element agree on its state.
    const handleCancel = (event: Event) => {
      event.preventDefault();
      if (!latest.current.busy) latest.current.onCancel();
    };
    // A second Escape in a row can't be prevented (browsers stop dialogs trapping the user). Honour it, unless an
    // action is still running: then the dialog has to stay to show its result. The event is queued, so it can arrive
    // after the dialog was opened again (React's StrictMode remounts effects): then it's stale.
    const handleClose = () => {
      if (dialog.open) return;
      if (latest.current.busy) dialog.showModal();
      else latest.current.onCancel();
    };
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('close', handleClose);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      // Listeners first: close() queues a close event, which mustn't count as Escape.
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', handleClose);
      if (dialog.open) dialog.close();
      // After the commit that removed the dialog, since the opener may have gone in the same commit.
      queueMicrotask(() => {
        if (dialog.isConnected && dialog.open) return;
        const opener = returnFocusTo?.isConnected && !returnFocusTo.matches(':disabled') ? returnFocusTo : null;
        (opener ?? document.getElementById(fallbackFocusId))?.focus();
      });
    };
  }, [returnFocusTo, fallbackFocusId]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(calc(100%-2rem),28rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-950/65 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
      {children}
    </dialog>
  );
}
