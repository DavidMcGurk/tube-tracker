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
  /** Dragging from one station and releasing over another. */
  onStationDragSelect: (fromStationId: string, toStationId: string) => void;
  /** The station under the pointer (or drag) changed. */
  onStationHover: (stationId: string | null) => void;
}

function stationIdAt(target: EventTarget | Element | null) {
  return target instanceof Element
    ? target.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id') ?? null
    : null;
}

/**
 * Pointer handling for the map viewport: mouse panning of empty space, long-press inspection, drag-to-select between
 * stations, hover tracking, and suppression of the click that follows a long press or drag.
 */
export function useMapGestures(callbacks: MapGestureCallbacks) {
  const callbacksRef = useRef(callbacks);
  useLayoutEffect(() => { callbacksRef.current = callbacks; });

  const panRef = useRef<{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const stationDragRef = useRef<{ pointerId: number; stationId: string; x: number; y: number; dragged: boolean } | null>(null);
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

  useEffect(() => () => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    if (suppressClickTimeoutRef.current) clearTimeout(suppressClickTimeoutRef.current);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const stationId = stationIdAt(event.target);
    if (stationId) {
      cancelPress();
      const timer = setTimeout(() => {
        pressRef.current = null;
        suppressNextClick();
        callbacksRef.current.onStationInspect(stationId);
      }, LONG_PRESS_MS);
      pressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
      stationDragRef.current = { pointerId: event.pointerId, stationId, x: event.clientX, y: event.clientY, dragged: false };
      return;
    }

    const viewport = event.currentTarget;
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
    event.preventDefault();
  }, [cancelPress, suppressNextClick]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const stationDrag = stationDragRef.current;
    if (
      stationDrag?.pointerId === event.pointerId
      && Math.hypot(event.clientX - stationDrag.x, event.clientY - stationDrag.y) > DRAG_THRESHOLD_PX
    ) {
      if (!stationDrag.dragged) {
        stationDrag.dragged = true;
        cancelPress(event.pointerId);
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      callbacksRef.current.onStationHover(stationIdAt(document.elementFromPoint(event.clientX, event.clientY)));
      event.preventDefault();
      return;
    }

    const press = pressRef.current;
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD_PX) {
      cancelPress(event.pointerId);
    }
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.y);
  }, [cancelPress]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const releaseCapture = () => {
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };

    const stationDrag = stationDragRef.current;
    if (stationDrag?.pointerId === event.pointerId) {
      stationDragRef.current = null;
      if (stationDrag.dragged) {
        const destinationId = stationIdAt(document.elementFromPoint(event.clientX, event.clientY));
        if (destinationId && destinationId !== stationDrag.stationId) {
          callbacksRef.current.onStationDragSelect(stationDrag.stationId, destinationId);
        }
        suppressNextClick();
        releaseCapture();
        return;
      }
    }

    cancelPress(event.pointerId);
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    viewport.classList.remove('is-panning');
    releaseCapture();
  }, [cancelPress, suppressNextClick]);

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
    callbacksRef.current.onStationHover(stationIdAt(event.target));
  }, []);

  const onPointerOut = useCallback((event: PointerEvent<HTMLDivElement>) => {
    callbacksRef.current.onStationHover(stationIdAt(event.relatedTarget));
  }, []);

  return {
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
