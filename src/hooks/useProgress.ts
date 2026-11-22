import { useCallback, useEffect, useRef, useState } from 'react';
import { addRouteToProgress, EMPTY_PROGRESS, isStreetWalkOnly } from '../lib/progress';
import {
  endUndoWindow,
  observeJourneyUndo,
  observeProgress,
  recordJourney,
  requestPersistentStorage,
  resetStoredProgress,
  undoLastJourney,
  type JourneyUndo,
  type UndoOutcome
} from '../lib/storage';
import { nudgeSync } from '../lib/sync';
import type { Progress, RouteResult } from '../lib/types';

export type { JourneyUndo } from '../lib/storage';

export type RecordOutcome = 'recorded' | 'unchanged' | 'failed';
export type ProgressErrorKind = 'load' | 'save';

/** How undoing went, and for an undone journey recorded in this copy of the app, the stations it went between. */
export interface UndoResult {
  outcome: UndoOutcome | 'failed';
  stationIds: readonly string[] | null;
}

const ERROR_MESSAGES: Record<ProgressErrorKind, string> = {
  load: 'Your saved progress could not be loaded, so new journeys will not be saved.',
  save: 'That change could not be saved on this device. Please try again.'
};

/**
 * Saves a journey (queuing it for backup when that's on) and lets the backup engine know: recording ends the previous
 * journey's undo window, so its backup is due now.
 */
async function saveJourney(route: RouteResult) {
  const result = await recordJourney(route);
  if (result.queued) nudgeSync();
  return result;
}

/** Clears progress (queuing a reset for backup when that's on) and lets the backup engine know. */
async function saveReset() {
  const { progress, queued } = await resetStoredProgress();
  if (queued) nudgeSync();
  return progress;
}

function sameProgress(a: Progress, b: Progress) {
  return (Object.keys(a) as Array<keyof Progress>).every((field) =>
    a[field].length === b[field].length && a[field].every((id, index) => id === b[field][index]));
}

/**
 * Keeps progress in sync with IndexedDB. The stored record is observed, so every open copy of the app shows the
 * same progress, and each change is applied to the stored record in a transaction, so copies never overwrite each
 * other. Changes wait for the first load, can never replace a record that failed to load, and roll back (with an
 * error) if they can't be saved. While backup is on, the same transactions queue each journey and reset for it.
 *
 * A journey that added something new can be undone for a few minutes (docs/sync-design.md, "Timed undo"): `undo` is
 * that window while it's open, in every copy of the app, and it closes by itself when time runs out.
 */
export function useProgress() {
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [errorKind, setErrorKind] = useState<ProgressErrorKind | null>(null);
  const [undoWindow, setUndoWindow] = useState<JourneyUndo | null>(null);
  /** The expiresAt of a window that has run out by the clock (its record stays until something else ends it). */
  const [ranOut, setRanOut] = useState<number | null>(null);
  /** The stations between which this copy of the app recorded the journey that can be undone. */
  const recordedRef = useRef<{ recordedAt: number; stationIds: readonly string[] } | null>(null);
  const progressRef = useRef(progress);
  const loadRef = useRef<{ promise: Promise<boolean>; resolve: (loaded: boolean) => void } | null>(null);
  if (!loadRef.current) {
    let resolve: (loaded: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    loadRef.current = { promise, resolve };
  }

  useEffect(() => {
    const load = loadRef.current!;
    return observeProgress(
      (stored) => {
        load.resolve(true);
        setErrorKind((current) => (current === 'load' ? null : current));
        if (sameProgress(stored, progressRef.current)) return;
        progressRef.current = stored;
        setProgress(stored);
      },
      (loadError: unknown) => {
        console.error('Unable to load saved progress', loadError);
        load.resolve(false);
        setErrorKind('load');
      }
    );
  }, []);

  useEffect(() => observeJourneyUndo(
    // A window that has already run out (the app reopened later) never shows, not even for a moment.
    (stored) => setUndoWindow(stored && stored.expiresAt > Date.now() ? stored : null),
    (undoError: unknown) => console.error('Unable to load the undo window', undoError)
  ), []);

  useEffect(() => {
    if (!undoWindow) return undefined;
    const timer = setTimeout(() => setRanOut(undoWindow.expiresAt), Math.max(0, undoWindow.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [undoWindow]);

  /** Shows `change` straight away, then stores it with `save`, which returns what was stored. */
  const apply = useCallback(async (change: (current: Progress) => Progress, save: () => Promise<Progress>) => {
    if (!(await loadRef.current!.promise)) {
      setErrorKind('load');
      return false;
    }
    const previous = progressRef.current;
    const optimistic = change(previous);
    progressRef.current = optimistic;
    setProgress(optimistic);
    try {
      const stored = await save();
      setErrorKind((current) => (current === 'save' ? null : current));
      if (!sameProgress(stored, progressRef.current)) {
        progressRef.current = stored;
        setProgress(stored);
      }
      return true;
    } catch (saveError) {
      console.error('Unable to save progress', saveError);
      progressRef.current = previous;
      setProgress(previous);
      setErrorKind('save');
      return false;
    }
  }, []);

  const recordRoute = useCallback(async (route: RouteResult): Promise<RecordOutcome> => {
    await loadRef.current!.promise;
    if (addRouteToProgress(progressRef.current, route) === progressRef.current) {
      // Already explored here, but backup still records it: another device may have reset since.
      if (isStreetWalkOnly(route)) return 'unchanged';
      try {
        await saveJourney(route);
      } catch (saveError) {
        console.error('Unable to save progress', saveError);
        setErrorKind('save');
        return 'failed';
      }
      return 'unchanged';
    }
    const saved = await apply((current) => addRouteToProgress(current, route), async () => {
      const { progress: stored, undo } = await saveJourney(route);
      recordedRef.current = undo && { recordedAt: undo.recordedAt, stationIds: [route.path[0]!, route.path[route.path.length - 1]!] };
      return stored;
    });
    if (!saved) return 'failed';
    // Now there's a journey worth keeping, ask the browser not to clear it when space runs low.
    requestPersistentStorage();
    return 'recorded';
  }, [apply]);

  /** Undoes the latest journey, if its window is still open. */
  const undoJourney = useCallback(async (): Promise<UndoResult> => {
    try {
      const { outcome, progress: stored, undone } = await undoLastJourney();
      if (!sameProgress(stored, progressRef.current)) {
        progressRef.current = stored;
        setProgress(stored);
      }
      const recorded = recordedRef.current;
      const stationIds = undone && recorded?.recordedAt === undone.recordedAt ? recorded.stationIds : null;
      if (outcome === 'undone') recordedRef.current = null;
      return { outcome, stationIds };
    } catch (undoError) {
      console.error('Unable to undo the journey', undoError);
      setErrorKind('save');
      return { outcome: 'failed', stationIds: null };
    }
  }, []);

  /** Keeps the latest journey: ends its undo window, so it's backed up now (when backup is on). */
  const dismissUndo = useCallback(() => {
    endUndoWindow()
      .then((released) => {
        if (released) nudgeSync();
      })
      .catch((undoError: unknown) => console.error('Unable to end the undo window', undoError));
  }, []);

  const resetProgress = useCallback(() => apply(() => EMPTY_PROGRESS, saveReset), [apply]);
  const dismissError = useCallback(() => setErrorKind(null), []);

  return {
    progress,
    error: errorKind ? ERROR_MESSAGES[errorKind] : null,
    errorKind,
    dismissError,
    recordRoute,
    resetProgress,
    /** The latest journey's undo window while it's open. */
    undo: undoWindow && undoWindow.expiresAt !== ranOut ? undoWindow : null,
    undoJourney,
    dismissUndo
  };
}
