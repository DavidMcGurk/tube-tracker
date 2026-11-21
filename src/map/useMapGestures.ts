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
  /** A double click on a station. */
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

function releasePointerCapture(element: Element, pointerId: number) {
  if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
}

/**
 * Pointer handling for the map viewport: mouse panning of empty space, long-press inspection, drag-to-select between
 * stations, hover tracking, and suppression of the click that follows a long press or drag. A second finger cancels all
 * of these, because it starts a pinch.
 */
export function useMapGestures(callbacks: MapGestureCallbacks) {
  const callbacksRef = useRef(callbacks);
  useLayoutEffect(() => { callbacksRef.current = callbacks; });

  const panRef = useRef<{ element: HTMLDivElement; pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const stationDragRef = useRef<{ element: HTMLDivElement; pointerId: number; stationId: string; x: number; y: number; dragged: boolean } | null>(null);
  const pressRef = useRef<{ pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /**
   * Abandons any press, station drag or pan in progress and swallows the click that would end it, e.g. when a second
   * finger turns the touch into a pinch.
   */
  const cancelInteractions = useCallback(() => {
    cancelPress();
    const pan = panRef.current;
    panRef.current = null;
    if (pan) {
      pan.element.classList.remove('is-panning');
      releasePointerCapture(pan.element, pan.pointerId);
    }
    const stationDrag = stationDragRef.current;
    stationDragRef.current = null;
    if (stationDrag) releasePointerCapture(stationDrag.element, stationDrag.pointerId);
    callbacksRef.current.onStationHover(null);
    suppressNextClick();
  }, [cancelPress, suppressNextClick]);

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
    const stationId = stationIdAt(event.target);
    if (stationId) {
      cancelPress();
      const timer = setTimeout(() => {
        pressRef.current = null;
        suppressNextClick();
        callbacksRef.current.onStationInspect(stationId);
      }, LONG_PRESS_MS);
      pressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
      stationDragRef.current = {
        element: event.currentTarget,
        pointerId: event.pointerId,
        stationId,
        x: event.clientX,
        y: event.clientY,
        dragged: false
      };
      return;
    }

    const viewport = event.currentTarget;
    panRef.current = {
      element: viewport,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
    event.preventDefault();
  }, [cancelInteractions, cancelPress, clearSuppressClick, suppressNextClick]);

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
    const releaseCapture = () => releasePointerCapture(viewport, event.pointerId);

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
    if (stationId) callbacksRef.current.onStationActivate(stationId);
  }, [clearSuppressClick]);

  const onDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const stationId = stationIdAt(event.target);
    if (!stationId) return;
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
