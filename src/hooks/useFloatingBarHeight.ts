import { useEffect, type RefObject } from 'react';

/**
 * On phones the route actions, or the undo bar in their place, float over the map. The bar's height is measured into
 * this property so the map and page leave room for it (see styles.css). Only one such bar is shown at a time.
 */
const FLOATING_BAR_HEIGHT_PROPERTY = '--tt-route-bar-height';

export function useFloatingBarHeight(barRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    let frame = 0;
    // Applied on the next frame: the property changes other elements' layout, which must not re-enter this observer.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => root.style.setProperty(FLOATING_BAR_HEIGHT_PROPERTY, `${bar.offsetHeight}px`));
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      root.style.removeProperty(FLOATING_BAR_HEIGHT_PROPERTY);
    };
  }, [barRef]);
}
