import { describe, expect, it } from 'vitest';
import type { RouteResult } from '../lib/types';
import { lineServices } from './line-services';
import { findRoutes, network, sections, stations, walkLinks } from './network';
import { TransitNetwork } from './transit-network';

const legs = (route: RouteResult | undefined) =>
  route?.legs.map((leg) => (leg.type === 'walk' ? `walk:${leg.from}>${leg.to}` : leg.lineId));

describe('route planner on the real network', () => {
  it.each([
    // [from, to, expected legs of the top suggestion, expected number of changes]
    ['golders_green', 'camden_road', ['northern', 'walk:camden_town>camden_road'], 1],
    ['richmond', 'stratford', ['mildmay'], 0],
    ['paddington', 'waterloo', ['bakerloo'], 0],
    ['heathrow_terminal_5', 'upminster', ['elizabeth', 'district'], 1],
    ['bank', 'monument', ['walk:bank>monument'], 1],
    ['canning_town', 'queensbury', ['jubilee'], 0],
    ['hammersmith', 'barking', ['district'], 0],
    ['golders_green', 'battersea_power_station', ['northern'], 0],
    ['edgware', 'high_barnet', ['northern', 'northern'], 1],
    ['mill_hill_east', 'euston', ['northern', 'northern'], 1],
    ['edgware_road_bakerloo', 'edgware_road_circle', ['walk:edgware_road_bakerloo>edgware_road_circle'], 1]
  ] as const)('suggests %s → %s as %j', (from, to, expectedLegs, expectedChanges) => {
    const [top] = findRoutes(from, to, 30);
    expect(legs(top)).toEqual(expectedLegs);
    expect(top?.changes).toHaveLength(expectedChanges);
  });

  it('rides rather than walks when a train goes there directly', () => {
    for (const [from, to] of [['farringdon', 'barbican'], ['liverpool_street', 'moorgate'], ['canary_wharf', 'heron_quays']] as const) {
      const [top] = findRoutes(from, to, 5);
      expect(top?.walks, `${from} → ${to}`).toEqual([]);
      expect(top?.changes, `${from} → ${to}`).toEqual([]);
    }
  });

  it('never chains walks together', () => {
    for (const route of findRoutes('euston', 'warren_street', 30)) {
      expect(route.walks.length).toBeLessThanOrEqual(1);
    }
  });

  it('offers each line sharing the track as a separate option without extra changes', () => {
    const options = findRoutes('farringdon', 'barbican', 30);
    expect(options.map((route) => legs(route))).toEqual([['circle'], ['hammersmith_city'], ['metropolitan']]);
  });

  it('labels same-line options that take different paths', () => {
    const options = findRoutes('golders_green', 'kennington', 30).filter((route) => route.changes.length === 0);
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.slice(0, 2).map((route) => route.via)).toEqual(['mornington_crescent', 'kings_cross']);
  });

  it('counts switching between Northern line branches as a change', () => {
    const viaBankThenCharingCross = findRoutes('golders_green', 'kennington', 30)
      .find((route) => route.sections.some((section) => section.id === 'northern_camden_town_euston')
        && route.sections.some((section) => section.id === 'northern_warren_street_euston'));
    expect(viaBankThenCharingCross?.changes).toEqual([{ type: 'line', at: 'euston' }]);
  });
});

describe('route planner rules', () => {
  const sample = (routing = {}) => new TransitNetwork(
    ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase(), system: 'Underground' as const, lines: [] })),
    [
      { id: 'red_ab', lineId: 'red', from: 'a', to: 'b', distance: 1000 },
      { id: 'blue_cd', lineId: 'blue', from: 'c', to: 'd', distance: 1000 },
      { id: 'red_bd', lineId: 'red', from: 'b', to: 'd', distance: 5000 },
      { id: 'green_de', lineId: 'green', from: 'd', to: 'e', distance: 1000 },
      { id: 'purple_de', lineId: 'purple', from: 'd', to: 'e', distance: 1000 }
    ],
    [
      { id: 'walk_bc', from: 'b', to: 'c', distance: 200, kind: 'osi', mapPath: '' },
      { id: 'walk_ce', from: 'c', to: 'e', distance: 200, kind: 'osi', mapPath: '' }
    ],
    routing
  );

  it('counts ride → walk → ride as a single change', () => {
    const route = sample().findRoutes('a', 'd').find((option) => option.walks.length === 1 && option.sections.length === 2);
    expect(route?.changes).toEqual([{ type: 'walk', from: 'b', to: 'c', kind: 'osi' }]);
  });

  it('does not allow one walk straight after another', () => {
    const routes = sample().findRoutes('b', 'e', 30);
    expect(routes.every((route) => !route.links.some((link, index) => link.type === 'walk' && route.links[index + 1]?.type === 'walk'))).toBe(true);
  });

  it('treats moving between services of the same line as a change', () => {
    const network = new TransitNetwork(
      ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, system: 'Underground' as const, lines: ['y'] })),
      [
        { id: 'y_ab', lineId: 'y', from: 'a', to: 'b', distance: 1000 },
        { id: 'y_bc', lineId: 'y', from: 'b', to: 'c', distance: 1000 },
        { id: 'y_bd', lineId: 'y', from: 'b', to: 'd', distance: 1000 }
      ],
      [],
      { lineServices: { y: [[['a', 'b', 'c']], [['a', 'b', 'd']]] } }
    );
    expect(network.findRoute('a', 'c')?.changes).toEqual([]);
    expect(network.findRoute('c', 'd')?.changes).toEqual([{ type: 'line', at: 'b' }]);
  });
});

describe('network data integrity', () => {
  it('connects every walking interchange between two real stations with a connector path', () => {
    const stationIds = new Set(stations.map((station) => station.id));
    for (const walk of walkLinks) {
      expect(stationIds.has(walk.from) && stationIds.has(walk.to), walk.id).toBe(true);
      expect(walk.mapPath, walk.id).toMatch(/^M\s*[\d.]+[ ,][\d.]+/);
    }
    expect(network.getWalkLink('osi_camden_town_camden_road')?.kind).toBe('osi');
  });

  it('describes each line service with consecutive stations joined by that line', () => {
    const sectionPairs = new Set(sections.map((section) => `${section.lineId}:${[section.from, section.to].sort().join('~')}`));
    for (const [lineId, services] of Object.entries(lineServices)) {
      for (const segments of services) {
        for (const stops of segments) {
          stops.slice(1).forEach((stop, index) => {
            expect(sectionPairs.has(`${lineId}:${[stops[index], stop].sort().join('~')}`), `${lineId} ${stops[index]}–${stop}`).toBe(true);
          });
        }
      }
    }
  });
});

describe('route planner properties', () => {
  // A deterministic sample of journeys across the network.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pairs = Array.from({ length: 60 }, () => [
    stations[Math.floor(random() * stations.length)]!.id,
    stations[Math.floor(random() * stations.length)]!.id
  ] as const).filter(([from, to]) => from !== to);

  it('returns well-formed options ordered by changes then distance, quickly', () => {
    const effective = (route: RouteResult) => route.trackDistance + 3 * route.walkDistance;
    let slowest = 0;
    for (const [from, to] of pairs) {
      const started = performance.now();
      const routes = findRoutes(from, to, 30);
      slowest = Math.max(slowest, performance.now() - started);
      expect(routes.length, `${from} → ${to}`).toBeGreaterThan(0);
      expect(new Set(routes.map((route) => route.key)).size).toBe(routes.length);
      routes.forEach((route, index) => {
        expect(route.path[0]).toBe(from);
        expect(route.path.at(-1)).toBe(to);
        expect(new Set(route.path).size).toBe(route.path.length);
        const previous = routes[index - 1];
        if (previous) {
          expect(previous.changes.length <= route.changes.length, `${from} → ${to} ordering by changes`).toBe(true);
          if (previous.changes.length === route.changes.length) {
            expect(effective(previous)).toBeLessThanOrEqual(effective(route) + 1e-6);
          }
        }
      });
    }
    expect(slowest).toBeLessThan(250);
  });
});
