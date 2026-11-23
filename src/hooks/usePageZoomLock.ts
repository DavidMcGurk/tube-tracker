import { useEffect } from 'react';

const NO_ZOOM = 'maximum-scale=1, user-scalable=no';

/**
 * Stops the page itself zooming while `locked` (the map tab, where pinching zooms the map instead and the page fits the
 * screen exactly). Android browsers follow the viewport tag; iOS ignores it for pinches, so Safari's gesture events,
 * which start a page zoom, are cancelled too. Double-tap zoom is turned off in styles.css (touch-action).
 */
export function usePageZoomLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const original = meta?.content;
    if (meta && original && !original.includes('user-scalable')) meta.content = `${original}, ${NO_ZOOM}`;
    const cancel = (event: Event) => event.preventDefault();
    document.addEventListener('gesturestart', cancel, { passive: false });
    document.addEventListener('gesturechange', cancel, { passive: false });
    return () => {
      if (meta && original !== undefined) meta.content = original;
      document.removeEventListener('gesturestart', cancel);
      document.removeEventListener('gesturechange', cancel);
    };
  }, [locked]);
}
