import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';

const LONG_PRESS_MS = 550;
const DRAG_THRESHOLD_PX = 10;
const SUPPRESS_CLICK_MS = 1000;

export interface MapGestureCallbacks {
  /** A tap, click or Enter/Space on a station. */
  onStationActivate: (stationId: string) => void;
  /** A long press on a station. */
  onStationInspect: (stationId: string) => void;
  /** A double click (or double tap) on one station. */
  onStationDoubleClick: (stationId: string) => void;
  /** The station under the pointer changed. */
  onStationHover: (stationId: string | null) => void;
}

function stationIdAt(target: EventTarget | Element | null) {
  return target instanceof Element
    ? target.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id') ?? null
    : null;
}

function releasePointerCapture(element: Element, pointerId: number) {
  if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
}

/**
 * Pointer handling for the map viewport. Clicking a station selects it (journeys are chosen by clicking the start and
 * end stations); pressing and dragging anywhere, stations included, pans the map; a long press on a station shows its
 * details. The click that ends a drag or long press is swallowed. A second finger cancels all of these, because it
 * starts a pinch. (On touch screens, one-finger panning is the browser's own scrolling.)
 */
export function useMapGestures(callbacks: MapGestureCallbacks) {
  const callbacksRef = useRef(callbacks);
  useLayoutEffect(() => { callbacksRef.current = callbacks; });

  /** A press that pans the map once it moves past the drag threshold (immediately if it began on empty map). */
  const panRef = useRef<{
    element: HTMLDivElement;
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
    panning: boolean;
  } | null>(null);
  const pressRef = useRef<{ pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stations of the two most recent clicks: browsers also fire dblclick for quick taps on two different stations. */
  const recentClicksRef = useRef<Array<string | null>>([]);

  const clearSuppressClick = useCallback(() => {
    suppressClickRef.current = false;
    if (suppressClickTimeoutRef.current) clearTimeout(suppressClickTimeoutRef.current);
    suppressClickTimeoutRef.current = null;
  }, []);

  const suppressNextClick = useCallback(() => {
    clearSuppressClick();
    suppressClickRef.current = true;
    suppressClickTimeoutRef.current = setTimeout(clearSuppressClick, SUPPRESS_CLICK_MS);
  }, [clearSuppressClick]);

  const cancelPress = useCallback((pointerId?: number) => {
    if (!pressRef.current || (pointerId !== undefined && pressRef.current.pointerId !== pointerId)) return;
    clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);

  const startPanning = useCallback((pan: NonNullable<typeof panRef.current>) => {
    pan.panning = true;
    pan.element.setPointerCapture(pan.pointerId);
    pan.element.classList.add('is-panning');
  }, []);

  const endPan = useCallback(() => {
    const pan = panRef.current;
    panRef.current = null;
    if (!pan) return;
    pan.element.classList.remove('is-panning');
    releasePointerCapture(pan.element, pan.pointerId);
  }, []);

  /**
   * Abandons any press or pan in progress and swallows the click that would end it, e.g. when a second finger turns
   * the touch into a pinch.
   */
  const cancelInteractions = useCallback(() => {
    cancelPress();
    endPan();
    callbacksRef.current.onStationHover(null);
    suppressNextClick();
  }, [cancelPress, endPan, suppressNextClick]);

  useEffect(() => () => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    if (suppressClickTimeoutRef.current) clearTimeout(suppressClickTimeoutRef.current);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' && !event.isPrimary) {
      // A second finger means a pinch (see useMapZoomGestures), so neither finger may select or inspect a station.
      cancelInteractions();
      return;
    }
    if (event.button !== 0) return;
    // Suppression only applies to the click that ends the previous press, even if the browser never sent that click.
    clearSuppressClick();
    cancelPress();
    const viewport = event.currentTarget;
    const pan = {
      element: viewport,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      panning: false
    };
    panRef.current = pan;

    const stationId = stationIdAt(event.target);
    if (stationId) {
      // Not panning yet: released without moving, this press is a click that selects the station.
      const timer = setTimeout(() => {
        pressRef.current = null;
        suppressNextClick();
        callbacksRef.current.onStationInspect(stationId);
      }, LONG_PRESS_MS);
      pressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
      return;
    }

    startPanning(pan);
    event.preventDefault();
  }, [cancelInteractions, cancelPress, clearSuppressClick, startPanning, suppressNextClick]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (!pan.panning) {
      if (Math.hypot(event.clientX - pan.x, event.clientY - pan.y) <= DRAG_THRESHOLD_PX) return;
      cancelPress(event.pointerId);
      startPanning(pan);
    }
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.y);
  }, [cancelPress, startPanning]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    cancelPress(event.pointerId);
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return;
    // A press that panned from a station must not also select it.
    if (pan.panning) suppressNextClick();
    endPan();
  }, [cancelPress, endPan, suppressNextClick]);

  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      clearSuppressClick();
      return;
    }
    const stationId = stationIdAt(event.target);
    recentClicksRef.current = [recentClicksRef.current.at(-1) ?? null, stationId];
    if (stationId) callbacksRef.current.onStationActivate(stationId);
  }, [clearSuppressClick]);

  const onDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const stationId = stationIdAt(event.target);
    const [previous, latest] = recentClicksRef.current;
    if (!stationId || previous !== stationId || latest !== stationId) return;
    event.preventDefault();
    callbacksRef.current.onStationDoubleClick(stationId);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const stationId = stationIdAt(event.target);
    if (!stationId) return;
    event.preventDefault();
    callbacksRef.current.onStationActivate(stationId);
  }, []);

  const onPointerOver = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' && !event.isPrimary) return;
    callbacksRef.current.onStationHover(stationIdAt(event.target));
  }, []);

  const onPointerOut = useCallback((event: PointerEvent<HTMLDivElement>) => {
    callbacksRef.current.onStationHover(stationIdAt(event.relatedTarget));
  }, []);

  return {
    cancelInteractions,
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onPointerOver,
    onPointerOut,
    onClick,
    onDoubleClick,
    onKeyDown
  };
}
