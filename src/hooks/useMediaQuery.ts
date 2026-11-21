import { useCallback, useSyncExternalStore } from 'react';

/** Matches the Tailwind `sm` breakpoint boundary used by the layout CSS. */
export const MOBILE_VIEWPORT_QUERY = '(max-width: 640px)';
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

export function useMediaQuery(query: string) {
  const subscribe = useCallback((onChange: () => void) => {
    const mediaQuery = window.matchMedia(query);
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
