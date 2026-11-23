import { useEffect } from 'react';

/**
 * Stops the page itself zooming: pinching zooms the map instead, and everything else fits the screen. Android browsers
 * follow the viewport tag (index.html) and touch-action (styles.css); iOS ignores both for pinches, so Safari's gesture
 * events, which start a page zoom, are cancelled here.
 */
export function usePreventPageZoom() {
  useEffect(() => {
    const cancel = (event: Event) => event.preventDefault();
    document.addEventListener('gesturestart', cancel, { passive: false });
    document.addEventListener('gesturechange', cancel, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', cancel);
      document.removeEventListener('gesturechange', cancel);
    };
  }, []);
}
