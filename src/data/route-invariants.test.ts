import { describe, expect, it } from 'vitest';
import { findRoutes, sections, stations } from './network';
import type { RouteResult } from '../lib/types';

/**
 * Structural invariants every route must satisfy, whatever ranking the router uses.
 * These deliberately avoid pinning *which* route is chosen so they stay valid when routing changes.
 */
const SAMPLE_PAIRS: Array<[string, string]> = [
  ['paddington', 'waterloo'],
  ['golders_green', 'camden_road'],
  ['richmond', 'stratford'],
  ['heathrow_terminal_5', 'upminster'],
  ['bank', 'victoria'],
  ['baker_street', 'aldgate'],
  ['arsenal', 'holloway_road'],
  ['reading', 'abbey_wood'],
  ['amersham', 'upminster'],
  ['canning_town', 'queensbury']
];

const stationIds = new Set(stations.map((station) => station.id));
const sectionIds = new Set(sections.map((section) => section.id));

function expectWellFormed(route: RouteResult, start: string, end: string) {
  expect(route.path[0]).toBe(start);
  expect(route.path.at(-1)).toBe(end);
  expect(route.path).toHaveLength(route.sections.length + 1);
  route.sections.forEach((section, index) => {
    const a = route.path[index];
    const b = route.path[index + 1];
    expect(sectionIds.has(section.id)).toBe(true);
    expect((section.from === a && section.to === b) || (section.from === b && section.to === a)).toBe(true);
  });
  expect(route.path.every((stationId) => stationIds.has(stationId))).toBe(true);
  expect(route.transferStations.every((stationId) => route.path.includes(stationId))).toBe(true);
}

describe('route invariants', () => {
  it('uses real station ids in the sample pairs', () => {
    for (const [start, end] of SAMPLE_PAIRS) {
      expect(stationIds.has(start), start).toBe(true);
      expect(stationIds.has(end), end).toBe(true);
    }
  });

  it.each(SAMPLE_PAIRS)('returns contiguous, aligned, unique routes from %s to %s', (start, end) => {
    const routes = findRoutes(start, end, 30);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expectWellFormed(route, start, end);

    const keys = routes.map((route) => route.sections.map((section) => section.id).join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(SAMPLE_PAIRS)('returns a stable prefix regardless of how many routes are requested (%s to %s)', (start, end) => {
    const many = findRoutes(start, end, 30);
    expect(findRoutes(start, end, 2)).toEqual(many.slice(0, 2));
    expect(findRoutes(start, end, 1)[0]).toEqual(many[0]);
  });
});
