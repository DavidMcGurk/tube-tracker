import { useCallback, useEffect, useRef, useState } from 'react';
import { addRouteToProgress, EMPTY_PROGRESS } from '../lib/progress';
import { observeProgress, updateProgress } from '../lib/storage';
import type { Progress, RouteResult } from '../lib/types';

export type RecordOutcome = 'recorded' | 'unchanged' | 'failed';
export type ProgressErrorKind = 'load' | 'save';

const ERROR_MESSAGES: Record<ProgressErrorKind, string> = {
  load: 'Your saved progress could not be loaded, so new journeys will not be saved.',
  save: 'That change could not be saved on this device. Please try again.'
};

function sameProgress(a: Progress, b: Progress) {
  return (Object.keys(a) as Array<keyof Progress>).every((field) =>
    a[field].length === b[field].length && a[field].every((id, index) => id === b[field][index]));
}

/**
 * Keeps progress in sync with IndexedDB. The stored record is observed, so every open copy of the app shows the
 * same progress, and each change is applied to the stored record in a transaction, so copies never overwrite each
 * other. Changes wait for the first load, can never replace a record that failed to load, and roll back (with an
 * error) if they can't be saved.
 */
export function useProgress() {
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [errorKind, setErrorKind] = useState<ProgressErrorKind | null>(null);
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

  const apply = useCallback(async (change: (current: Progress) => Progress) => {
    if (!(await loadRef.current!.promise)) {
      setErrorKind('load');
      return false;
    }
    const previous = progressRef.current;
    const optimistic = change(previous);
    progressRef.current = optimistic;
    setProgress(optimistic);
    try {
      const stored = await updateProgress(change);
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
    if (addRouteToProgress(progressRef.current, route) === progressRef.current) return 'unchanged';
    return (await apply((current) => addRouteToProgress(current, route))) ? 'recorded' : 'failed';
  }, [apply]);

  const resetProgress = useCallback(() => apply(() => EMPTY_PROGRESS), [apply]);
  const dismissError = useCallback(() => setErrorKind(null), []);

  return {
    progress,
    error: errorKind ? ERROR_MESSAGES[errorKind] : null,
    errorKind,
    dismissError,
    recordRoute,
    resetProgress
  };
}
