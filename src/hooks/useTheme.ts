import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadTheme, readThemeSync, saveTheme } from '../lib/storage';
import type { ResolvedTheme, Theme } from '../lib/types';
import { PREFERS_DARK_QUERY, useMediaQuery } from './useMediaQuery';

/** The header's colour in each theme, so the browser toolbar and iOS status bar blend into it. */
const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#fcfdfe', dark: '#0c1327' };

/** Follows the system theme until the user picks one; the choice is persisted only when the user makes it. */
export function useTheme() {
  // Start from the localStorage mirror (the same value index.html applied before the app loaded), so there's no flash.
  const [theme, setTheme] = useState<Theme>(() => readThemeSync() ?? 'system');
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
    // index.html has one theme-color per system scheme; both follow the app's theme, which the user can override.
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute('content', THEME_COLORS[resolvedTheme]));
  }, [resolvedTheme]);

  const toggleTheme = useCallback(() => {
    const nextTheme: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    userChoseThemeRef.current = true;
    setTheme(nextTheme);
    saveTheme(nextTheme).catch((error: unknown) => console.error('Unable to save the theme', error));
  }, [resolvedTheme]);

  return { resolvedTheme, toggleTheme };
}
