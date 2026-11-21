import { clampMapZoom } from './map-interactions';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ZoomView {
  zoom: number;
  /** Scroll offset of the map viewport, in CSS px. */
  scroll: Point;
}

/** The map's laid-out size at one zoom, which gives its size (and so the scroll limits) at any other zoom. */
export interface ZoomBounds {
  zoom: number;
  content: Size;
  viewport: Size;
}

export interface MapTransform {
  x: number;
  y: number;
  scale: number;
}

/** Finger separations below this (CSS px) give unstable pinch ratios. */
const MIN_PINCH_DISTANCE_PX = 10;
/** Line-mode wheel deltas (Firefox) are converted to pixels with this line height. */
const WHEEL_LINE_HEIGHT_PX = 16;
/** Caps one wheel event so a mouse-wheel notch zooms by about 28% instead of jumping. */
const MAX_WHEEL_DELTA_PX = 25;
/** exp(-deltaY / 100) reproduces the scale change Chromium encodes in the ctrl+wheel events of a trackpad pinch. */
const WHEEL_ZOOM_RATE = 0.01;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** The zoom a gesture commits: rounded to 0.01 and kept within the supported range. */
export function roundMapZoom(zoom: number) {
  return clampMapZoom(Math.round(zoom * 100) / 100);
}

export function getPinchZoom(startZoom: number, startDistance: number, distance: number) {
  if (!(startDistance >= MIN_PINCH_DISTANCE_PX) || !Number.isFinite(distance)) return startZoom;
  return clampMapZoom((startZoom * distance) / startDistance);
}

/**
 * The scroll offset on one axis after zooming by `ratio`, such that the content that was under `startAnchor` (viewport
 * px) ends up under `anchor`.
 */
export function getAnchoredScroll(scroll: number, startAnchor: number, anchor: number, ratio: number) {
  return (scroll + startAnchor) * ratio - anchor;
}

export function clampScroll(scroll: number, contentSize: number, viewportSize: number) {
  return Math.min(Math.max(0, contentSize - viewportSize), Math.max(0, scroll));
}

/** Zooms `view` to `zoom` about the anchors, keeping the scroll within the map at the new zoom. */
export function getAnchoredView(view: ZoomView, zoom: number, startAnchor: Point, anchor: Point, bounds: ZoomBounds): ZoomView {
  const ratio = zoom / view.zoom;
  const scale = zoom / bounds.zoom;
  return {
    zoom,
    scroll: {
      x: clampScroll(getAnchoredScroll(view.scroll.x, startAnchor.x, anchor.x, ratio), bounds.content.width * scale, bounds.viewport.width),
      y: clampScroll(getAnchoredScroll(view.scroll.y, startAnchor.y, anchor.y, ratio), bounds.content.height * scale, bounds.viewport.height)
    }
  };
}

/**
 * The transform (origin 0 0) that makes the map, still laid out at its gesture-start zoom with the viewport scrolled to
 * `scroll`, look exactly as it will once the gesture commits: `scale` times larger and scrolled to `targetScroll`.
 */
export function getPinchTransform(scroll: Point, targetScroll: Point, scale: number): MapTransform {
  return { x: scroll.x - targetScroll.x, y: scroll.y - targetScroll.y, scale };
}

export function toCssTransform({ x, y, scale }: MapTransform) {
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

/** The zoom multiplier for one ctrl+wheel event: above 1 when scrolling up, and f(d) × f(−d) = 1. */
export function getWheelZoomFactor(deltaY: number, deltaMode: number, pageHeight: number) {
  const pixels = deltaMode === DOM_DELTA_LINE
    ? deltaY * WHEEL_LINE_HEIGHT_PX
    : deltaMode === DOM_DELTA_PAGE ? deltaY * pageHeight : deltaY;
  if (!Number.isFinite(pixels)) return 1;
  const capped = Math.min(MAX_WHEEL_DELTA_PX, Math.max(-MAX_WHEEL_DELTA_PX, pixels));
  return Math.exp(-capped * WHEEL_ZOOM_RATE);
}

export function formatMapZoom(zoom: number) {
  return `${Math.round(zoom * 10) / 10}×`;
}
