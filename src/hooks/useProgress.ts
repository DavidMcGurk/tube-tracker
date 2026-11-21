import { useCallback, useEffect, useRef, useState } from 'react';
import { addRouteToProgress, EMPTY_PROGRESS } from '../lib/progress';
import { loadProgress, saveProgress } from '../lib/storage';
import type { Progress, RouteResult } from '../lib/types';

export type RecordOutcome = 'recorded' | 'unchanged' | 'failed';

const LOAD_FAILED_MESSAGE = 'Your saved progress could not be loaded, so changes will not be saved. Try reloading the app.';
const SAVE_FAILED_MESSAGE = 'That change could not be saved on this device. Please try again.';

/**
 * Loads progress from IndexedDB and persists every change. Saving is blocked until loading succeeds, so a failed
 * load can never overwrite the stored record; a failed save rolls the change back and reports an error.
 */
export function useProgress() {
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef(progress);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadProgress()
      .then((stored) => {
        if (cancelled) return;
        progressRef.current = stored;
        loadedRef.current = true;
        setProgress(stored);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        console.error('Unable to load saved progress', loadError);
        setError(LOAD_FAILED_MESSAGE);
      });
    return () => { cancelled = true; };
  }, []);

  const commit = useCallback(async (next: Progress) => {
    if (!loadedRef.current) {
      setError(LOAD_FAILED_MESSAGE);
      return false;
    }
    const previous = progressRef.current;
    progressRef.current = next;
    setProgress(next);
    try {
      await saveProgress(next);
      return true;
    } catch (saveError) {
      console.error('Unable to save progress', saveError);
      progressRef.current = previous;
      setProgress(previous);
      setError(SAVE_FAILED_MESSAGE);
      return false;
    }
  }, []);

  const recordRoute = useCallback(async (route: RouteResult): Promise<RecordOutcome> => {
    const next = addRouteToProgress(progressRef.current, route);
    if (next === progressRef.current) return 'unchanged';
    return (await commit(next)) ? 'recorded' : 'failed';
  }, [commit]);

  const resetProgress = useCallback(() => commit(EMPTY_PROGRESS), [commit]);
  const dismissError = useCallback(() => setError(null), []);

  return { progress, error, dismissError, recordRoute, resetProgress };
}
