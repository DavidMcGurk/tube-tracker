import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useFloatingBarHeight } from '../hooks/useFloatingBarHeight';

/**
 * How long after the bar appears Undo ignores presses. The bar replaces the route actions as soon as a journey is saved
 * (a few milliseconds), and on phones Undo sits right where “Record route” was, so a double tap on Record would
 * otherwise undo the journey it just recorded. A deliberate Undo is never this quick.
 */
export const UNDO_GUARD_MS = 800;

export interface UndoBarProps {
  /** Undo was tapped, but the journey had already been backed up (by a copy of the app from before undo existed). */
  tooLate: boolean;
  /** Undoing is under way, so a second tap can't land on anything else. */
  busy: boolean;
  onUndo: () => void;
  /** Keeps the journey and ends its window, so it's backed up now. */
  onDismiss: () => void;
  /** The journey was just recorded with the route actions' button, which went with them: focus Undo instead (once). */
  focusOnMount?: boolean;
  onFocused?: () => void;
}

/**
 * Offers to undo the journey just recorded while its window is open (docs/sync-design.md, "Timed undo"). It sits where
 * the route actions do (floating over the map on phones), never at the same time as them, and goes by itself when the
 * window closes. The same whether backup is on or off.
 */
export function UndoBar({ tooLate, busy, onUndo, onDismiss, focusOnMount = false, onFocused }: UndoBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const undoRef = useRef<HTMLButtonElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  const labelId = useId();
  // When the bar appeared, on the same clock as event.timeStamp.
  const [shownAt] = useState(() => performance.now());
  useFloatingBarHeight(barRef);

  useLayoutEffect(() => {
    if (!focusOnMount) return;
    // preventScroll: on phones the bar floats over the map, and the page mustn't jump.
    (undoRef.current ?? dismissRef.current)?.focus({ preventScroll: true });
    onFocused?.();
  }, [focusOnMount, onFocused]);

  // Too late to undo: the Undo button goes, so focus moves to Dismiss rather than being lost with it.
  const wasTooLate = useRef(tooLate);
  useLayoutEffect(() => {
    if (tooLate && !wasTooLate.current) dismissRef.current?.focus({ preventScroll: true });
    wasTooLate.current = tooLate;
  }, [tooLate]);

  return (
    <div
      ref={barRef}
      role="group"
      aria-labelledby={labelId}
      data-undo-bar
      className="undo-bar mt-3 flex items-center gap-2 rounded-xl bg-slate-100 py-1.5 pl-3 pr-1.5 text-sm dark:bg-slate-800"
    >
      <p id={labelId} className="flex min-w-0 flex-1 items-center gap-2 font-medium">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        <span>{tooLate ? 'This journey has already been backed up, so it can’t be undone.' : 'Journey recorded'}</span>
      </p>
      {!tooLate && (
        <button
          ref={undoRef}
          type="button"
          onClick={(event) => {
            // A press that began before the bar appeared, or just after, was aimed at what was there before.
            if (event.timeStamp - shownAt < UNDO_GUARD_MS) return;
            onUndo();
          }}
          disabled={busy}
          className="min-h-11 shrink-0 rounded-full border border-slate-300 bg-white px-5 py-2 text-sm font-semibold dark:border-slate-600 dark:bg-slate-900"
        >
          Undo
        </button>
      )}
      <button
        ref={dismissRef}
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-2xl leading-none text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
      >
        ×
      </button>
    </div>
  );
}
