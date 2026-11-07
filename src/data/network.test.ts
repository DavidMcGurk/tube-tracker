import { describe, expect, it } from 'vitest';
import { findRoute, lines, network, sections, stations } from './network';
import referenceMapSvg from '../assets/reference-map-clean.svg?raw';
import { Station } from './station';
import { TrackSection } from './track-section';
import { TransitNetwork } from './transit-network';

describe('TfL network graph', () => {
  it('keeps every Overground line on the current TfL palette across graph and map styles', () => {
    const palette = [
      { id: 'lioness', className: 'lioness', color: '#feb231' },
      { id: 'liberty', className: 'liberty', color: '#5e6867' },
      { id: 'mildmay', className: 'mildmay', color: '#3784c7' },
      { id: 'windrush', className: 'windrush', color: '#ff4e5a' },
      { id: 'weaver', className: 'weaver', color: '#9a2c62' },
      { id: 'suffragette', className: 'suffragette', color: '#49c07d' }
    ];

    for (const { id, className, color } of palette) {
      expect(lines.find((line) => line.id === id)?.color).toBe(color);
      expect(referenceMapSvg).toMatch(new RegExp(`\\.f${className}\\s*\\{[^}]*fill:${color}`, 'i'));
      expect(referenceMapSvg).toMatch(new RegExp(`\\.s${className}\\s*\\{[^}]*stroke:${color}`, 'i'));
    }
  });

  it('uses graph entity instances with station-owned connections and route finding', () => {
    expect(network).toBeInstanceOf(TransitNetwork);
    expect(stations.every((station) => station instanceof Station)).toBe(true);
    expect(sections.every((section) => section instanceof TrackSection)).toBe(true);

    const sample = new TransitNetwork(
      [
        { id: 'a', name: 'A', system: 'Underground', lines: ['red'] },
        { id: 'b', name: 'B', system: 'Underground', lines: ['red', 'blue'] },
        { id: 'c', name: 'C', system: 'Underground', lines: ['blue'] }
      ],
      [
        { id: 'ab', lineId: 'red', from: 'a', to: 'b', distance: 100 },
        { id: 'bc', lineId: 'blue', from: 'b', to: 'c', distance: 150 }
      ]
    );

    expect(sample.getStation('a')?.getNeighborIds()).toEqual(['b']);
    expect(sample.findRoute('a', 'c')?.transferStations).toEqual(['b']);
    expect(() => new TransitNetwork(
      [{ id: 'a', name: 'A', system: 'Underground', lines: [] }],
      [{ id: 'ab', lineId: 'red', from: 'a', to: 'missing', distance: 100 }]
    )).toThrow('references an unknown station');
  });

  it('returns only distinct near-shortest route options ordered by distance', () => {
    const sample = new TransitNetwork(
      [
        { id: 'a', name: 'A', system: 'Underground', lines: ['red'] },
        { id: 'b', name: 'B', system: 'Underground', lines: ['red'] },
        { id: 'c', name: 'C', system: 'Underground', lines: ['blue'] },
        { id: 'd', name: 'D', system: 'Underground', lines: ['red', 'blue'] },
        { id: 'e', name: 'E', system: 'Underground', lines: ['green'] }
      ],
      [
        { id: 'ab', lineId: 'red', from: 'a', to: 'b', distance: 100 },
        { id: 'bd', lineId: 'red', from: 'b', to: 'd', distance: 100 },
        { id: 'ac', lineId: 'blue', from: 'a', to: 'c', distance: 110 },
        { id: 'cd', lineId: 'blue', from: 'c', to: 'd', distance: 110 },
        { id: 'ae', lineId: 'green', from: 'a', to: 'e', distance: 160 },
        { id: 'ed', lineId: 'green', from: 'e', to: 'd', distance: 160 }
      ]
    );

    const routes = sample.findRoutes('a', 'd');
    expect(routes.map((route) => route.segments.map((section) => section.id))).toEqual([
      ['ab', 'bd'],
      ['ac', 'cd']
    ]);
    expect(routes[0]?.transferStations).toEqual([]);
    expect(sample.findRoute('a', 'd')?.segments.map((section) => section.id)).toEqual(['ab', 'bd']);
    expect(sample.findRoutes('a', 'd', 1)).toHaveLength(1);
    expect(sample.findRoutes('a', 'd', 30).map((route) => route.segments.map((section) => section.id))).toEqual([
      ['ab', 'bd'],
      ['ac', 'cd']
    ]);
  });

  it('omits routes outside the distance and transfer limits used by alternatives', () => {
    const sample = new TransitNetwork(
      [
        { id: 'a', name: 'A', system: 'Underground', lines: ['red', 'blue'] },
        { id: 'b', name: 'B', system: 'Underground', lines: ['red'] },
        { id: 'd', name: 'D', system: 'Underground', lines: ['red', 'black'] },
        { id: 'x', name: 'X', system: 'Underground', lines: ['blue', 'green'] },
        { id: 'y', name: 'Y', system: 'Underground', lines: ['green', 'black'] },
        { id: 'far', name: 'Far', system: 'Underground', lines: ['purple'] }
      ],
      [
        { id: 'ab', lineId: 'red', from: 'a', to: 'b', distance: 100 },
        { id: 'bd', lineId: 'red', from: 'b', to: 'd', distance: 100 },
        { id: 'ax', lineId: 'blue', from: 'a', to: 'x', distance: 70 },
        { id: 'xy', lineId: 'green', from: 'x', to: 'y', distance: 70 },
        { id: 'yd', lineId: 'black', from: 'y', to: 'd', distance: 70 },
        { id: 'af', lineId: 'purple', from: 'a', to: 'far', distance: 150 },
        { id: 'fd', lineId: 'purple', from: 'far', to: 'd', distance: 150 }
      ]
    );

    expect(sample.findRoutes('a', 'd', 30).map((route) => route.segments.map((section) => section.id))).toEqual([
      ['ab', 'bd']
    ]);
  });

  it('prefers fewer transfers when route distances are equal', () => {
    const sample = new TransitNetwork(
      [
        { id: 'a', name: 'A', system: 'Underground', lines: ['red', 'blue'] },
        { id: 'b', name: 'B', system: 'Underground', lines: ['red'] },
        { id: 'c', name: 'C', system: 'Underground', lines: ['blue', 'green'] },
        { id: 'd', name: 'D', system: 'Underground', lines: ['red', 'green'] }
      ],
      [
        { id: 'ab', lineId: 'red', from: 'a', to: 'b', distance: 100 },
        { id: 'bd', lineId: 'red', from: 'b', to: 'd', distance: 100 },
        { id: 'ac', lineId: 'blue', from: 'a', to: 'c', distance: 100 },
        { id: 'cd', lineId: 'green', from: 'c', to: 'd', distance: 100 }
      ]
    );

    expect(sample.findRoute('a', 'd')?.segments.map((section) => section.id)).toEqual(['ab', 'bd']);
    expect(sample.findRoute('a', 'd')?.transferStations).toEqual([]);
  });

  it('reports the station where each line change occurs and keeps route sections aligned to the path', () => {
    const sample = new TransitNetwork(
      [
        { id: 'a', name: 'A', system: 'Underground', lines: ['red'] },
        { id: 'b', name: 'B', system: 'Underground', lines: ['red', 'blue'] },
        { id: 'c', name: 'C', system: 'Underground', lines: ['blue', 'green'] },
        { id: 'd', name: 'D', system: 'Underground', lines: ['green'] }
      ],
      [
        { id: 'ab', lineId: 'red', from: 'a', to: 'b', distance: 100 },
        { id: 'bc', lineId: 'blue', from: 'b', to: 'c', distance: 100 },
        { id: 'cd', lineId: 'green', from: 'c', to: 'd', distance: 100 }
      ]
    );
    const route = sample.findRoute('a', 'd');

    expect(route?.path).toEqual(['a', 'b', 'c', 'd']);
    expect(route?.segments.map((section, index) => [section.from, section.to])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd']
    ]);
    expect(route?.transferStations).toEqual(['b', 'c']);
  });

  it('includes the complete set of TfL stations and adjacent sections', () => {
    expect(stations.length).toBeGreaterThan(400);
    expect(sections.length).toBeGreaterThan(550);
    expect(new Set(stations.map((station) => station.id)).size).toBe(stations.length);
    expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
    expect(lines.every((line) => sections.some((section) => section.lineId === line.id))).toBe(true);

    const stationIds = new Set(stations.map((station) => station.id));
    const lineIds = new Set([...lines.map((line) => line.id), 'interchange']);
    expect(sections.every((section) =>
      stationIds.has(section.from)
      && stationIds.has(section.to)
      && lineIds.has(section.lineId)
      && section.distance > 0
    )).toBe(true);
  });

  it('connects every station and routes through distinct TfL networks', () => {
    const adjacency = new Map(stations.map((station) => [station.id, new Set<string>()]));
    for (const section of sections) {
      adjacency.get(section.from)?.add(section.to);
      adjacency.get(section.to)?.add(section.from);
    }

    const visited = new Set<string>();
    const queue = [stations[0].id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    expect(visited.size).toBe(stations.length);

    const stationId = (name: string) => {
      const station = stations.find((entry) => entry.name === name);
      expect(station, `Expected station "${name}" in the TfL graph`).toBeDefined();
      return station!.id;
    };
    for (const [from, to] of [
      ['Reading', 'Abbey Wood'],
      ['Stratford', 'Woolwich Arsenal'],
      ['Harrow & Wealdstone', 'Elephant & Castle'],
      ['Bank', 'Monument']
    ]) {
      const start = stationId(from);
      const end = stationId(to);
      const route = findRoute(start, end);
      expect(route, `Expected a route from ${from} to ${to}`).not.toBeNull();
      expect(route?.path[0]).toBe(start);
      expect(route?.path.at(-1)).toBe(end);
      expect(route?.path).toHaveLength((route?.segments.length ?? 0) + 1);
      expect(route?.segments.every((section, index) =>
        section.from === route.path[index] && section.to === route.path[index + 1]
        || section.to === route.path[index] && section.from === route.path[index + 1]
      )).toBe(true);
    }

    expect(findRoute(stationId('Bank'), stationId('Monument'))?.segments[0]?.lineId).toBe('interchange');
  });

  it('handles same-station and unknown-station route requests safely', () => {
    const sameStation = network.findRoutes('bank', 'bank');
    expect(sameStation).toEqual([{ path: ['bank'], segments: [], transferStations: [] }]);
    expect(network.findRoute('unknown', 'bank')).toBeNull();
    expect(network.findRoutes('bank', 'unknown')).toEqual([]);
  });
});
