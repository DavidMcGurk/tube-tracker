import { describe, expect, it } from 'vitest';
import { getTickLineId } from './station-ticks';

describe('getTickLineId', () => {
  it('reads the line from the map’s tick and terminus symbols', () => {
    expect(getTickLineId('#stcentral')).toBe('central');
    expect(getTickLineId('#termmildmay')).toBe('mildmay');
  });

  it('keeps line names that end in "e"', () => {
    expect(getTickLineId('#stcircle')).toBe('circle');
    expect(getTickLineId('#stjubilee')).toBe('jubilee');
    expect(getTickLineId('#termsuffragette')).toBe('suffragette');
  });

  it('maps the map’s own class names and variant suffixes to lines', () => {
    expect(getTickLineId('#sthnc')).toBe('hammersmith_city');
    expect(getTickLineId('#stedgware')).toBe('northern');
    expect(getTickLineId('#termedgware')).toBe('northern');
    expect(getTickLineId('#stpiccadilly2')).toBe('piccadilly');
    expect(getTickLineId('#stpiccadillye')).toBe('piccadilly');
    expect(getTickLineId('#termmetropolitan2')).toBe('metropolitan');
  });

  it('ignores symbols that are not ticks', () => {
    expect(getTickLineId('#int')).toBeNull();
    expect(getTickLineId('#cap2')).toBeNull();
    expect(getTickLineId('#stx')).toBeNull();
  });
});
