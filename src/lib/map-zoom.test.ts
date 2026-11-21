import { describe, expect, it } from 'vitest';
import { MAX_MAP_ZOOM, MIN_MAP_ZOOM } from './map-interactions';
import {
  clampScroll,
  formatMapZoom,
  getAnchoredScroll,
  getAnchoredView,
  getPinchTransform,
  getPinchZoom,
  getWheelZoomFactor,
  roundMapZoom,
  toCssTransform,
  type ZoomBounds
} from './map-zoom';

/** A 400×300 viewport over a map laid out 1600×900 at zoom 4. */
const bounds: ZoomBounds = { zoom: 4, content: { width: 1600, height: 900 }, viewport: { width: 400, height: 300 } };

describe('pinch zoom', () => {
  it('scales the start zoom by the change in finger separation, within the supported range', () => {
    expect(getPinchZoom(2, 100, 150)).toBe(3);
    expect(getPinchZoom(4, 200, 100)).toBe(2);
    expect(getPinchZoom(4, 100, 1000)).toBe(MAX_MAP_ZOOM);
    expect(getPinchZoom(2, 100, 10)).toBe(MIN_MAP_ZOOM);
  });

  it('ignores separations too small to give a stable ratio', () => {
    expect(getPinchZoom(3, 0, 200)).toBe(3);
    expect(getPinchZoom(3, 5, 200)).toBe(3);
    expect(getPinchZoom(3, Number.NaN, 200)).toBe(3);
    expect(getPinchZoom(3, 100, Number.NaN)).toBe(3);
  });

  it('rounds committed zooms to hundredths within the supported range', () => {
    expect(roundMapZoom(2.3456)).toBe(2.35);
    expect(roundMapZoom(0.4)).toBe(MIN_MAP_ZOOM);
    expect(roundMapZoom(9)).toBe(MAX_MAP_ZOOM);
  });
});

describe('anchored scrolling', () => {
  it('keeps the content under the anchor fixed', () => {
    const scroll = 300;
    const anchor = 120;
    const startZoom = 2;
    const zoom = 3.3;
    const nextScroll = getAnchoredScroll(scroll, anchor, anchor, zoom / startZoom);
    expect((nextScroll + anchor) / zoom).toBeCloseTo((scroll + anchor) / startZoom, 10);
  });

  it('matches centre-anchored zoom when both anchors are the viewport centre', () => {
    const scroll = 500;
    const centre = 200;
    const ratio = 4.25 / 4;
    expect(getAnchoredScroll(scroll, centre, centre, ratio)).toBeCloseTo((scroll + centre) * ratio - centre, 10);
  });

  it('pans by the opposite of the anchor movement when the zoom is unchanged', () => {
    expect(getAnchoredScroll(500, 100, 130, 1)).toBe(470);
    expect(getAnchoredScroll(500, 100, 60, 1)).toBe(540);
  });

  it('returns to the original scroll after zooming in and back out about the same point', () => {
    const zoomedIn = getAnchoredScroll(420, 150, 150, 1.7);
    expect(getAnchoredScroll(zoomedIn, 150, 150, 1 / 1.7)).toBeCloseTo(420, 10);
  });

  it('clamps scroll offsets to the scrollable range', () => {
    expect(clampScroll(-20, 1600, 400)).toBe(0);
    expect(clampScroll(1300, 1600, 400)).toBe(1200);
    expect(clampScroll(50, 300, 400)).toBe(0);
    expect(clampScroll(600, 1600, 400)).toBe(600);
  });

  it('zooms a view about its anchor and clamps the result at the new zoom', () => {
    const view = { zoom: 4, scroll: { x: 600, y: 300 } };
    const anchor = { x: 200, y: 150 };
    expect(getAnchoredView(view, 6, anchor, anchor, bounds)).toEqual({ zoom: 6, scroll: { x: 1000, y: 525 } });

    // Zooming out near the far edge keeps the map filling the viewport instead of showing empty space.
    const atEdge = { zoom: 4, scroll: { x: 1200, y: 600 } };
    expect(getAnchoredView(atEdge, 2, anchor, anchor, bounds)).toEqual({ zoom: 2, scroll: { x: 400, y: 150 } });

    // A map shorter than the viewport cannot scroll vertically.
    expect(getAnchoredView(view, 1, anchor, anchor, bounds).scroll.y).toBe(0);
  });

  it('follows the pinch midpoint as it moves', () => {
    const view = { zoom: 4, scroll: { x: 600, y: 300 } };
    const moved = getAnchoredView(view, 4, { x: 200, y: 150 }, { x: 240, y: 110 }, bounds);
    expect(moved.scroll).toEqual({ x: 560, y: 340 });
  });
});

describe('gesture preview transform', () => {
  it('offsets the scaled map by the difference between the current and target scroll', () => {
    expect(getPinchTransform({ x: 600, y: 300 }, { x: 1000, y: 525 }, 1.5)).toEqual({ x: -400, y: -225, scale: 1.5 });
  });

  it('draws content where the committed view will show it', () => {
    const start = { zoom: 4, scroll: { x: 600, y: 300 } };
    const anchor = { x: 200, y: 150 };
    const target = getAnchoredView(start, 5, anchor, anchor, bounds);
    const transform = getPinchTransform(start.scroll, target.scroll, target.zoom / start.zoom);
    // A content point at (800, 450) in the zoom-4 layout is under the anchor before and during the gesture.
    const point = { x: 800, y: 450 };
    expect(transform.x + transform.scale * point.x - start.scroll.x).toBeCloseTo(anchor.x, 10);
    expect(transform.y + transform.scale * point.y - start.scroll.y).toBeCloseTo(anchor.y, 10);
  });

  it('formats the transform for CSS', () => {
    expect(toCssTransform({ x: -12.5, y: 30, scale: 1.25 })).toBe('translate(-12.5px, 30px) scale(1.25)');
  });
});

describe('ctrl+wheel zoom', () => {
  it('zooms in for upward deltas and out for downward ones, symmetrically', () => {
    expect(getWheelZoomFactor(-10, 0, 800)).toBeGreaterThan(1);
    expect(getWheelZoomFactor(10, 0, 800)).toBeLessThan(1);
    expect(getWheelZoomFactor(0, 0, 800)).toBe(1);
    for (const delta of [1, 7.5, 25, 120]) {
      expect(getWheelZoomFactor(delta, 0, 800) * getWheelZoomFactor(-delta, 0, 800)).toBeCloseTo(1, 12);
    }
  });

  it('matches the scale encoded in a Chromium trackpad pinch', () => {
    expect(getWheelZoomFactor(-100 * Math.log(1.1), 0, 800)).toBeCloseTo(1.1, 10);
  });

  it('caps the zoom from one large wheel event', () => {
    expect(getWheelZoomFactor(-1000, 0, 800)).toBe(getWheelZoomFactor(-25, 0, 800));
    expect(getWheelZoomFactor(-100, 0, 800)).toBeLessThan(1.3);
  });

  it('normalises line and page delta modes to pixels', () => {
    expect(getWheelZoomFactor(-1, 1, 800)).toBe(getWheelZoomFactor(-16, 0, 800));
    expect(getWheelZoomFactor(0.01, 2, 800)).toBe(getWheelZoomFactor(8, 0, 800));
    expect(getWheelZoomFactor(Number.NaN, 0, 800)).toBe(1);
  });
});

describe('zoom readout', () => {
  it('shows whole zooms without decimals and continuous ones to one decimal place', () => {
    expect(formatMapZoom(4)).toBe('4×');
    expect(formatMapZoom(2.37)).toBe('2.4×');
    expect(formatMapZoom(1.04)).toBe('1×');
    expect(formatMapZoom(5.5)).toBe('5.5×');
  });
});
