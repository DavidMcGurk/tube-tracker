import { describe, expect, it } from 'vitest';
import referenceMapSvg from '../assets/reference-map-clean.svg?raw';
import { stations } from '../data/network';
import { getMarkerStationById } from './station-binding';

/** `<use id=… href=…>` markers inside the SVG's #station_nodes group, extracted without a DOM. */
function getStationNodeMarkers() {
  const start = referenceMapSvg.indexOf('id="station_nodes"');
  const end = referenceMapSvg.indexOf('id="text"', start);
  const stationNodes = referenceMapSvg.slice(start, end);
  return [...stationNodes.matchAll(/<use\b[^>]*>/g)].flatMap(([tag]) => {
    const id = /\sid="([^"]+)"/.exec(tag)?.[1];
    const href = /\s(?:xlink:)?href="([^"]+)"/.exec(tag)?.[1] ?? '';
    return id ? [{ id, href }] : [];
  });
}

describe('SVG station binding', () => {
  const markers = getStationNodeMarkers();

  it('finds the station markers in the reference map', () => {
    expect(markers.length).toBeGreaterThan(450);
  });

  it('resolves every station marker to a network station', () => {
    const unresolved = markers.filter(({ id, href }) => !getMarkerStationById(id, href)).map(({ id }) => id);
    expect(unresolved).toEqual([]);
  });

  it('has a marker for every station apart from the known hub-drawn stations', () => {
    const markedStationIds = new Set(markers.map(({ id, href }) => getMarkerStationById(id, href)?.id));
    const unmarked = stations.filter((station) => !markedStationIds.has(station.id)).map((station) => station.id);
    // Bank and Monument are drawn as one hub group, and Aldgate's marker has no id; F1 gives these explicit positions.
    expect(unmarked.sort()).toEqual(['aldgate', 'bank', 'monument']);
  });
});
