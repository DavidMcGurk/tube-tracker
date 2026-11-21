import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadTheme, saveTheme } from '../lib/storage';
import type { ResolvedTheme, Theme } from '../lib/types';
import { PREFERS_DARK_QUERY, useMediaQuery } from './useMediaQuery';

/** Follows the system theme until the user picks one; the choice is persisted only when the user makes it. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>('system');
  const userChoseThemeRef = useRef(false);
  const prefersDark = useMediaQuery(PREFERS_DARK_QUERY);
  const resolvedTheme: ResolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    let cancelled = false;
    loadTheme()
      .then((storedTheme) => {
        if (!cancelled && !userChoseThemeRef.current) setTheme(storedTheme);
      })
      .catch((error: unknown) => console.error('Unable to load the saved theme', error));
    return () => { cancelled = true; };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const toggleTheme = useCallback(() => {
    const nextTheme: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    userChoseThemeRef.current = true;
    setTheme(nextTheme);
    saveTheme(nextTheme).catch((error: unknown) => console.error('Unable to save the theme', error));
  }, [resolvedTheme]);

  return { resolvedTheme, toggleTheme };
}
