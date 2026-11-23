import { useLayoutEffect, type RefObject } from 'react';

/**
 * On phones the route actions, or the undo bar in their place, float over the map. The bar's height is measured into
 * this property so the map and page leave room for it (see styles.css). Only one such bar is shown at a time.
 */
const FLOATING_BAR_HEIGHT_PROPERTY = '--tt-route-bar-height';

/**
 * Keeps the property at the bar's height while it's shown. The last height stays when the bar goes, so the room it
 * left can be kept while a journey is still being chosen; App clears it with clearFloatingBarHeight once it isn't.
 */
export function useFloatingBarHeight(barRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty(FLOATING_BAR_HEIGHT_PROPERTY, `${bar.offsetHeight}px`);
    // At once, so there's no frame without the room (e.g. when the undo bar takes the route bar's place).
    apply();
    let frame = 0;
    // Later changes are applied on the next frame: the property changes other elements' layout, which must not
    // re-enter this observer.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [barRef]);
}

export function clearFloatingBarHeight() {
  document.documentElement.style.removeProperty(FLOATING_BAR_HEIGHT_PROPERTY);
}
