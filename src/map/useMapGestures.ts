import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { addPanSample, glideStep, releaseVelocity, type PanSample, type Velocity } from './map-glide';

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

/**
 * A fingertip is much bigger than a station's label or symbol at phone zooms, and iOS doesn't move a tap onto the
 * nearest one (the whole map counts as clickable). So a touch that lands on no station takes the nearest one within
 * about 20 px (half of Apple's 44 pt target), probing rings around the touch point, nearest first.
 */
const SNAP_RINGS_PX = [5, 10, 15, 20];
const SNAP_DIRECTIONS = 8;

function stationNear(x: number, y: number, viewport: Element) {
  const bounds = viewport.getBoundingClientRect();
  for (const radius of SNAP_RINGS_PX) {
    for (let i = 0; i < SNAP_DIRECTIONS; i++) {
      const angle = (i / SNAP_DIRECTIONS) * 2 * Math.PI;
      const px = x + radius * Math.cos(angle);
      const py = y + radius * Math.sin(angle);
      if (px < bounds.left || px > bounds.right || py < bounds.top || py > bounds.bottom) continue;
      const stationId = stationIdAt(viewport.ownerDocument.elementFromPoint(px, py));
      if (stationId) return stationId;
    }
  }
  return null;
}

function releasePointerCapture(element: Element, pointerId: number) {
  if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
}

/**
 * Pointer handling for the map viewport. Clicking a station selects it (journeys are chosen by clicking the start and
 * end stations); pressing and dragging anywhere, stations included, pans the map; a long press on a station shows its
 * details. The click that ends a drag or long press is swallowed. A second finger cancels all of these, because it
 * starts a pinch.
 *
 * Touch panning is done here too, not by the browser (the viewport has touch-action: none): on iOS, a tap while a
 * native scroll is still gliding only stops it and never reaches the page. So a flick glides in script (map-glide.ts),
 * and a tap during that glide stops it and still counts. Dragging past the map's top or bottom edge scrolls the page.
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
    /** Where the pointer was at the last pan step. */
    lastX: number;
    lastY: number;
    /**
     * The map's scroll position, kept unrounded: browsers round scroll offsets, and reading them back between moves
     * would add up the rounding, so the map would lag or run ahead of the finger.
     */
    left: number;
    top: number;
    /** Movement past the map's top or bottom edge not yet passed on to the page (it scrolls in whole pixels). */
    pageLeftover: number;
    panning: boolean;
    /** A finger or pen, which gets page scrolling at the map's edges and a glide after a flick. */
    direct: boolean;
    /** Recent positions, for the flick's speed. */
    samples: PanSample[];
  } | null>(null);
  /** The glide's animation frame, while a flick is gliding. */
  const glideFrameRef = useRef(0);
  const pressRef = useRef<{ pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stations of the two most recent clicks: browsers also fire dblclick for quick taps on two different stations. */
  const recentClicksRef = useRef<Array<string | null>>([]);
  /** The station a touch near (not on) a station was given (see stationNear), for the click that ends it. */
  const nearStationRef = useRef<string | null>(null);

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
    // Only for the cursor; restyling the whole map for a finger would cost a frame on a slow phone.
    if (!pan.direct) pan.element.classList.add('is-panning');
  }, []);

  const stopGlide = useCallback(() => {
    cancelAnimationFrame(glideFrameRef.current);
    glideFrameRef.current = 0;
  }, []);

  /**
   * Keeps the map moving after a flick, slowing to a stop, until it reaches an edge or something else moves the map
   * (the zoom buttons, full screen, rotating the phone).
   */
  const startGlide = useCallback((viewport: HTMLDivElement, from: { left: number; top: number }, velocity: Velocity) => {
    stopGlide();
    // Kept unrounded: browsers round scroll offsets, which would stall the slow end of a glide.
    let x = from.left;
    let y = from.top;
    // What the browser made of the last position written, to tell its rounding from another change.
    let writtenLeft = viewport.scrollLeft;
    let writtenTop = viewport.scrollTop;
    let current: Velocity | null = velocity;
    let last = performance.now();
    const frame = (now: number) => {
      if (!current) return;
      if (Math.abs(viewport.scrollLeft - writtenLeft) > 1 || Math.abs(viewport.scrollTop - writtenTop) > 1) {
        glideFrameRef.current = 0;
        return;
      }
      // A frame can begin before the lift that started the glide: wait for one after it.
      if (now <= last) {
        glideFrameRef.current = requestAnimationFrame(frame);
        return;
      }
      // A long gap (e.g. the tab was hidden) shouldn't jump the map.
      const dt = Math.min(now - last, 50);
      last = now;
      const step = glideStep(current, dt);
      const maxX = viewport.scrollWidth - viewport.clientWidth;
      const maxY = viewport.scrollHeight - viewport.clientHeight;
      // The map moves with the finger, so scrolling goes the other way.
      const nextX = Math.min(Math.max(x - step.dx, 0), maxX);
      const nextY = Math.min(Math.max(y - step.dy, 0), maxY);
      const moved = nextX !== x || nextY !== y;
      x = nextX;
      y = nextY;
      viewport.scrollLeft = x;
      viewport.scrollTop = y;
      writtenLeft = viewport.scrollLeft;
      writtenTop = viewport.scrollTop;
      current = moved ? step.velocity : null;
      glideFrameRef.current = current ? requestAnimationFrame(frame) : 0;
    };
    glideFrameRef.current = requestAnimationFrame(frame);
  }, [stopGlide]);

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
    stopGlide();
    cancelPress();
    endPan();
    callbacksRef.current.onStationHover(null);
    suppressNextClick();
  }, [cancelPress, endPan, stopGlide, suppressNextClick]);

  useEffect(() => () => {
    cancelAnimationFrame(glideFrameRef.current);
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
    // A touch during a glide stops it, and is then a tap, press or drag like any other.
    stopGlide();
    // Suppression only applies to the click that ends the previous press, even if the browser never sent that click.
    clearSuppressClick();
    cancelPress();
    const viewport = event.currentTarget;
    const pan = {
      element: viewport,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      pageLeftover: 0,
      panning: false,
      direct: event.pointerType !== 'mouse',
      // The press counts towards a flick: a quick one may have only one move past the drag threshold.
      samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }] as PanSample[]
    };
    panRef.current = pan;

    let stationId = stationIdAt(event.target);
    nearStationRef.current = null;
    if (!stationId && event.pointerType === 'touch') {
      stationId = stationNear(event.clientX, event.clientY, viewport);
      // The click is hit-tested at the touch point, which is on no station, so it needs telling which one.
      nearStationRef.current = stationId;
    }
    if (stationId) {
      // Not panning yet: released without moving, this press is a click that selects the station. Only a press right
      // on a station shows its details when held: a finger resting near one before panning shouldn't.
      if (!nearStationRef.current) {
        const timer = setTimeout(() => {
          pressRef.current = null;
          suppressNextClick();
          callbacksRef.current.onStationInspect(stationId);
        }, LONG_PRESS_MS);
        pressRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
      }
      return;
    }

    startPanning(pan);
    event.preventDefault();
  }, [cancelInteractions, cancelPress, clearSuppressClick, startPanning, stopGlide, suppressNextClick]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (!pan.panning) {
      if (Math.hypot(event.clientX - pan.x, event.clientY - pan.y) <= DRAG_THRESHOLD_PX) return;
      cancelPress(event.pointerId);
      startPanning(pan);
    }
    const viewport = event.currentTarget;
    const dx = event.clientX - pan.lastX;
    const dy = event.clientY - pan.lastY;
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
    const wantedTop = pan.top - dy;
    pan.left = Math.min(Math.max(pan.left - dx, 0), viewport.scrollWidth - viewport.clientWidth);
    pan.top = Math.min(Math.max(wantedTop, 0), viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollLeft = pan.left;
    viewport.scrollTop = pan.top;
    if (!pan.direct) return;
    // Past the map's top or bottom edge, the rest of the drag scrolls the page, as a native scroll would.
    pan.pageLeftover += wantedTop - pan.top;
    const whole = Math.trunc(pan.pageLeftover);
    if (whole) {
      viewport.ownerDocument.defaultView?.scrollBy(0, whole);
      pan.pageLeftover -= whole;
    }
    pan.samples = addPanSample(pan.samples, { t: event.timeStamp, x: event.clientX, y: event.clientY });
  }, [cancelPress, startPanning]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    cancelPress(event.pointerId);
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return;
    // A press that panned from a station must not also select it.
    if (pan.panning) suppressNextClick();
    const velocity = pan.panning && pan.direct && event.type === 'pointerup' ? releaseVelocity(pan.samples, event.timeStamp) : null;
    endPan();
    if (velocity) startGlide(pan.element, pan, velocity);
  }, [cancelPress, endPan, startGlide, suppressNextClick]);

  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const nearStation = nearStationRef.current;
    nearStationRef.current = null;
    if (suppressClickRef.current) {
      clearSuppressClick();
      return;
    }
    const stationId = stationIdAt(event.target) ?? nearStation;
    recentClicksRef.current = [recentClicksRef.current.at(-1) ?? null, stationId];
    if (stationId) callbacksRef.current.onStationActivate(stationId);
  }, [clearSuppressClick]);

  const onDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    // A double tap near a station is aimed at the station its two taps chose.
    const stationId = stationIdAt(event.target) ?? recentClicksRef.current.at(-1) ?? null;
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
