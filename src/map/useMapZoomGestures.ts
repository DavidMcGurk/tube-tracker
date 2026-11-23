import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { clampMapZoom } from '../lib/map-interactions';
import {
  getAnchoredView,
  getPinchTransform,
  getPinchZoom,
  getWheelZoomFactor,
  roundMapZoom,
  toCssTransform,
  type Point,
  type ZoomBounds,
  type ZoomView
} from '../lib/map-zoom';

/** A ctrl+wheel burst (a trackpad pinch in Chrome, Edge and Firefox) commits once input pauses for this long. */
const WHEEL_COMMIT_DELAY_MS = 150;

export interface MapZoomGestureCallbacks {
  /** The zoom the map is laid out at. */
  getZoom: () => number;
  /** A two-finger pinch began: abandon whatever the first finger started. */
  onTouchPinchStart: () => void;
  /** The last finger of a pinch lifted. */
  onTouchPinchEnd: () => void;
  /** Called once per frame while a gesture previews a zoom, and again with the committed zoom. */
  onPreview: (zoom: number) => void;
  /** Lays the map out at a gesture's final zoom and scroll offset. */
  onCommit: (zoom: number, scrollLeft: number, scrollTop: number) => void;
}

interface MapZoomGestureOptions extends MapZoomGestureCallbacks {
  viewportRef: RefObject<HTMLDivElement | null>;
  svgMarkup: string;
}

/** WebKit's non-standard GestureEvent: a trackpad pinch in macOS Safari, or a two-finger touch on iOS. */
interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX?: number;
  clientY?: number;
}

interface ZoomSession {
  svg: SVGSVGElement;
  /** The viewport's padding-box origin in client coordinates. */
  origin: Point;
  /** The view the map is laid out at for the whole gesture. */
  start: ZoomView;
  bounds: ZoomBounds;
  /** The view the gesture will commit, previewed with a transform. */
  view: ZoomView;
  anchor: Point;
}

/**
 * The viewport's inner height once the map fills it. On phones the viewport only has a max-height, so while the map
 * is shorter than that the viewport shrinks to fit, and grows again as the map is zoomed in.
 */
function getScrollportHeight(viewport: HTMLElement) {
  const maxHeight = Number.parseFloat(getComputedStyle(viewport).maxHeight);
  if (!Number.isFinite(maxHeight)) return viewport.clientHeight;
  const bordersAndScrollbar = viewport.offsetHeight - viewport.clientHeight;
  return Math.max(viewport.clientHeight, maxHeight - bordersAndScrollbar);
}

function findTouch(touches: TouchList, identifier: number) {
  return Array.from(touches).find((touch) => touch.identifier === identifier);
}

function midpoint(first: Touch, second: Touch) {
  return { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
}

function distance(first: Touch, second: Touch) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

/**
 * Pinch zoom for the map: two-finger touch pinches, ctrl+wheel (trackpad pinch in Chrome, Edge and Firefox) and Safari
 * gesture events. One-finger panning is useMapGestures', and plain wheel scrolling stays native.
 *
 * During a gesture the map keeps its layout and is scaled with a CSS transform, so every frame is cheap; when the
 * gesture ends the zoom is committed once as a new layout width and scroll offset. A pinch can only start while the
 * browser still lets us cancel the touch: if a native one-finger pan is already under way, the second finger pans too.
 */
export function useMapZoomGestures({ viewportRef, svgMarkup, ...callbacks }: MapZoomGestureOptions) {
  const callbacksRef = useRef(callbacks);
  useLayoutEffect(() => { callbacksRef.current = callbacks; });

  // React registers touch and wheel listeners as passive, so these are native listeners that may preventDefault.
  // svgMarkup is a dependency so the listeners are bound once the viewport holds the map.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let session: ZoomSession | null = null;
    let pinch: { ids: [number, number]; startDistance: number; startAnchor: Point } | null = null;
    let safariPinch: { startAnchor: Point } | null = null;
    /** The finger left on the map after a pinch, which pans until it lifts. */
    let remainingFinger: { id: number; x: number; y: number } | null = null;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    let touchCount = 0;

    const toViewportPoint = (clientX: number, clientY: number, origin: Point) => ({ x: clientX - origin.x, y: clientY - origin.y });
    // Not targetTouches: that only lists touches on the same element, and two fingers usually land on different parts
    // of the map.
    const touchesOnMap = (event: TouchEvent) => Array.from(event.touches)
      .filter((touch) => touch.target instanceof Node && viewport.contains(touch.target));

    const render = () => {
      frame = 0;
      if (!session) return;
      const { svg, start, view } = session;
      const scroll = { x: viewport.scrollLeft, y: viewport.scrollTop };
      svg.style.transform = toCssTransform(getPinchTransform(scroll, view.scroll, view.zoom / start.zoom));
      callbacksRef.current.onPreview(view.zoom);
    };

    const scheduleRender = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    const preview = (view: ZoomView, anchor: Point) => {
      if (!session) return;
      session.view = view;
      session.anchor = anchor;
      scheduleRender();
    };

    const commit = () => {
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const ended = session;
      session = null;
      if (!ended) return;
      ended.svg.style.transform = '';
      ended.svg.style.willChange = '';
      const zoom = roundMapZoom(ended.view.zoom);
      const { scroll } = getAnchoredView(ended.view, zoom, ended.anchor, ended.anchor, ended.bounds);
      callbacksRef.current.onPreview(zoom);
      callbacksRef.current.onCommit(zoom, scroll.x, scroll.y);
    };

    const begin = (): ZoomSession | null => {
      commit();
      const svg = viewport.querySelector('svg');
      if (!svg) return null;
      const viewportBox = viewport.getBoundingClientRect();
      const svgBox = svg.getBoundingClientRect();
      const start = { zoom: callbacksRef.current.getZoom(), scroll: { x: viewport.scrollLeft, y: viewport.scrollTop } };
      svg.style.willChange = 'transform';
      session = {
        svg,
        origin: { x: viewportBox.left + viewport.clientLeft, y: viewportBox.top + viewport.clientTop },
        start,
        bounds: {
          zoom: start.zoom,
          content: { width: svgBox.width, height: svgBox.height },
          viewport: { width: viewport.clientWidth, height: getScrollportHeight(viewport) }
        },
        view: start,
        anchor: { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
      };
      return session;
    };

    const startPinch = (first: Touch, second: Touch) => {
      remainingFinger = null;
      const started = begin();
      if (!started) return;
      callbacksRef.current.onTouchPinchStart();
      const centre = midpoint(first, second);
      const startAnchor = toViewportPoint(centre.x, centre.y, started.origin);
      pinch = { ids: [first.identifier, second.identifier], startDistance: distance(first, second), startAnchor };
      started.anchor = startAnchor;
    };

    const onTouchStart = (event: TouchEvent) => {
      touchCount = event.touches.length;
      if (pinch) {
        // Further fingers are ignored until one of the pinching fingers lifts.
        if (event.cancelable) event.preventDefault();
        return;
      }
      const [first, second] = touchesOnMap(event);
      // Without cancelable events a native pan is already under way, so the browser keeps panning.
      if (!first || !second || !event.cancelable) return;
      event.preventDefault();
      startPinch(first, second);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (pinch && session) {
        if (event.cancelable) event.preventDefault();
        const first = findTouch(event.touches, pinch.ids[0]);
        const second = findTouch(event.touches, pinch.ids[1]);
        if (!first || !second) return;
        const centre = midpoint(first, second);
        const anchor = toViewportPoint(centre.x, centre.y, session.origin);
        const zoom = getPinchZoom(session.start.zoom, pinch.startDistance, distance(first, second));
        preview(getAnchoredView(session.start, zoom, pinch.startAnchor, anchor, session.bounds), anchor);
        return;
      }
      if (!remainingFinger) return;
      const touch = findTouch(event.touches, remainingFinger.id);
      if (!touch) return;
      if (!event.cancelable) {
        remainingFinger = null;
        return;
      }
      event.preventDefault();
      viewport.scrollLeft -= touch.clientX - remainingFinger.x;
      viewport.scrollTop -= touch.clientY - remainingFinger.y;
      remainingFinger = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    };

    const onTouchEnd = (event: TouchEvent) => {
      touchCount = event.touches.length;
      if (pinch) {
        if (findTouch(event.touches, pinch.ids[0]) && findTouch(event.touches, pinch.ids[1])) return;
        // Cancelling the end of a pinch stops the browser from turning it into a click.
        if (event.cancelable) event.preventDefault();
        pinch = null;
        commit();
        const [first, second] = touchesOnMap(event);
        if (first && second && event.cancelable) startPinch(first, second);
        else if (first) remainingFinger = { id: first.identifier, x: first.clientX, y: first.clientY };
        else callbacksRef.current.onTouchPinchEnd();
        return;
      }
      if (remainingFinger && !findTouch(event.touches, remainingFinger.id)) {
        if (event.cancelable) event.preventDefault();
        remainingFinger = null;
        callbacksRef.current.onTouchPinchEnd();
      }
    };

    // Safari sends gesture events for pinches. On iOS they accompany touch events, which drive the zoom, so they are
    // only cancelled to stop the page zooming; on a Mac trackpad they are the only pinch input.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      if (touchCount > 0 || pinch) return;
      const started = begin();
      if (!started) return;
      const { clientX, clientY } = event as WebKitGestureEvent;
      const startAnchor = clientX !== undefined && clientY !== undefined && Number.isFinite(clientX) && Number.isFinite(clientY)
        ? toViewportPoint(clientX, clientY, started.origin)
        : started.anchor;
      safariPinch = { startAnchor };
      started.anchor = startAnchor;
    };

    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (!safariPinch || !session) return;
      const { scale } = event as WebKitGestureEvent;
      if (!Number.isFinite(scale) || scale <= 0) return;
      const { startAnchor } = safariPinch;
      preview(getAnchoredView(session.start, clampMapZoom(session.start.zoom * scale), startAnchor, startAnchor, session.bounds), startAnchor);
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      if (!safariPinch) return;
      safariPinch = null;
      commit();
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        // Commit a settling pinch before native scrolling moves the map underneath it.
        if (wheelTimer) commit();
        return;
      }
      event.preventDefault();
      if (pinch || safariPinch) return;
      const current = wheelTimer && session ? session : begin();
      if (!current) return;
      const anchor = toViewportPoint(event.clientX, event.clientY, current.origin);
      const factor = getWheelZoomFactor(event.deltaY, event.deltaMode, current.bounds.viewport.height);
      preview(getAnchoredView(current.view, clampMapZoom(current.view.zoom * factor), anchor, anchor, current.bounds), anchor);
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(commit, WHEEL_COMMIT_DELAY_MS);
    };

    // The preview transform is relative to the current scroll offset, so redraw if anything scrolls mid-gesture.
    const onScroll = () => {
      if (session) scheduleRender();
    };

    const onResize = () => {
      pinch = null;
      safariPinch = null;
      remainingFinger = null;
      commit();
    };

    const active = { passive: false } as const;
    viewport.addEventListener('touchstart', onTouchStart, active);
    viewport.addEventListener('touchmove', onTouchMove, active);
    viewport.addEventListener('touchend', onTouchEnd, active);
    viewport.addEventListener('touchcancel', onTouchEnd, active);
    viewport.addEventListener('gesturestart', onGestureStart, active);
    viewport.addEventListener('gesturechange', onGestureChange, active);
    viewport.addEventListener('gestureend', onGestureEnd, active);
    viewport.addEventListener('wheel', onWheel, active);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    return () => {
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('touchend', onTouchEnd);
      viewport.removeEventListener('touchcancel', onTouchEnd);
      viewport.removeEventListener('gesturestart', onGestureStart);
      viewport.removeEventListener('gesturechange', onGestureChange);
      viewport.removeEventListener('gestureend', onGestureEnd);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (wheelTimer) clearTimeout(wheelTimer);
      if (frame) cancelAnimationFrame(frame);
      if (session) {
        session.svg.style.transform = '';
        session.svg.style.willChange = '';
      }
    };
  }, [viewportRef, svgMarkup]);
}
