import { useCallback, useEffect, useRef, useState } from 'react';
import { loadProgressStyle, readProgressStyleSync, saveProgressStyle } from '../lib/storage';
import type { ProgressStyle } from '../lib/types';

const DEFAULT_PROGRESS_STYLE: ProgressStyle = 'lines';

/** The chosen way of showing travelled track on the map; persisted only when the user changes it. */
export function useProgressStyle() {
  const [progressStyle, setProgressStyleState] = useState<ProgressStyle>(() => readProgressStyleSync() ?? DEFAULT_PROGRESS_STYLE);
  const userChoseRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadProgressStyle()
      .then((stored) => {
        if (stored && !cancelled && !userChoseRef.current) setProgressStyleState(stored);
      })
      .catch((error: unknown) => console.error('Unable to load the saved progress style', error));
    return () => { cancelled = true; };
  }, []);

  const setProgressStyle = useCallback((style: ProgressStyle) => {
    userChoseRef.current = true;
    setProgressStyleState(style);
    saveProgressStyle(style).catch((error: unknown) => console.error('Unable to save the progress style', error));
  }, []);

  return { progressStyle, setProgressStyle };
}
