import { describe, expect, it } from 'vitest';
import { getScrollPositionToCenterBounds } from './map-view';

describe('map view helpers', () => {
  it('centers a target within the viewport while accounting for the current scroll position', () => {
    expect(getScrollPositionToCenterBounds(
      { scrollLeft: 555, scrollTop: 113.5 },
      { left: 29, top: 214, width: 335, height: 562 },
      { left: -39, top: 382, width: 426, height: 316 },
      { width: 1332, height: 748 }
    )).toEqual({ scrollLeft: 532.5, scrollTop: 158.5 });
  });

  it('keeps the centered position within the scrollable content bounds', () => {
    expect(getScrollPositionToCenterBounds(
      { scrollLeft: 0, scrollTop: 0 },
      { left: 0, top: 0, width: 320, height: 600 },
      { left: -100, top: -100, width: 100, height: 100 },
      { width: 900, height: 1200 }
    )).toEqual({ scrollLeft: 0, scrollTop: 0 });

    expect(getScrollPositionToCenterBounds(
      { scrollLeft: 0, scrollTop: 0 },
      { left: 0, top: 0, width: 320, height: 600 },
      { left: 1200, top: 1500, width: 200, height: 200 },
      { width: 900, height: 1200 }
    )).toEqual({ scrollLeft: 580, scrollTop: 600 });
  });
});
