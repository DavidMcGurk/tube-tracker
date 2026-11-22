import { describe, expect, it } from 'vitest';
import { findRoute, findRoutes, lines, sections } from '../data/network';
import {
  addRouteToProgress,
  EMPTY_PROGRESS,
  getJourneyStations,
  getRouteItems,
  getStationState,
  isStreetWalkOnly,
  routeIsAlreadyComplete,
  sortLineProgress,
  sanitizeProgress,
  summariseProgress
} from './progress';
import type { RouteResult } from './types';

function route(start: string, end: string): RouteResult {
  const found = findRoute(start, end);
  if (!found) throw new Error(`Expected a route from ${start} to ${end}`);
  return found;
}

describe('recording journeys', () => {
  it('ignores duplicate additions and returns the same object when nothing is new', () => {
    const journey = route('paddington', 'waterloo');
    const progress = addRouteToProgress(EMPTY_PROGRESS, journey);
    expect(progress).not.toBe(EMPTY_PROGRESS);
    expect(addRouteToProgress(progress, journey)).toBe(progress);
    expect(routeIsAlreadyComplete(progress, journey)).toBe(true);
  });

  it('only reports a journey as already explored when recording it would add nothing', () => {
    const progress = addRouteToProgress(EMPTY_PROGRESS, route('paddington', 'waterloo'));
    const sameTrackNewStations = route('oxford_circus', 'embankment');
    expect(sameTrackNewStations.sections.every((section) => progress.travelledSegmentIDs.includes(section.id))).toBe(true);
    expect(routeIsAlreadyComplete(progress, sameTrackNewStations)).toBe(false);
    expect(routeIsAlreadyComplete(progress, route('paddington', 'waterloo'))).toBe(true);
  });

  it('records journey ends as entered/exited and line changes as changed', () => {
    const journey = route('paddington', 'london_bridge');
    const lineChanges = journey.changes.flatMap((change) => (change.type === 'line' ? [change.at] : []));
    expect(lineChanges.length).toBeGreaterThan(0);

    const progress = addRouteToProgress(EMPTY_PROGRESS, journey);
    expect(progress.stationsEnteredOrExitedIDs).toEqual(['paddington', 'london_bridge']);
    expect(progress.stationsChangedAtIDs).toEqual(lineChanges);
    expect(lineChanges.every((stationId) => getStationState(stationId, progress) === 'changed')).toBe(true);
  });

  it('treats both ends of an out-of-station interchange as entered/exited and records the walk, not as track', () => {
    const journey = route('golders_green', 'caledonian_road_barnsbury');
    expect(journey.walks.map((walk) => walk.id)).toEqual(['osi_camden_town_camden_road']);

    const progress = addRouteToProgress(EMPTY_PROGRESS, journey);
    expect(progress.walkedLinkIDs).toEqual(['osi_camden_town_camden_road']);
    expect(progress.travelledSegmentIDs).toEqual(journey.sections.map((section) => section.id));
    expect(progress.stationsEnteredOrExitedIDs).toEqual(expect.arrayContaining(['golders_green', 'caledonian_road_barnsbury', 'camden_road', 'camden_town']));
    expect(progress.stationsChangedAtIDs).toEqual([]);
    expect(getStationState('camden_town', progress)).toBe('entered');
  });

  it('treats both ends of an in-station interchange as changes', () => {
    const journey = {
      path: ['st_paul_s', 'bank', 'monument', 'tower_hill'],
      links: [{ type: 'track' }, { type: 'walk', id: 'isi_bank_monument', kind: 'isi' }, { type: 'track' }],
      changes: [{ type: 'walk', from: 'bank', to: 'monument', kind: 'isi' }]
    } as unknown as RouteResult;
    expect(getJourneyStations(journey)).toEqual({ enteredOrExited: ['st_paul_s', 'tower_hill'], changedAt: ['bank', 'monument'] });
  });

  it('does not visit the station a journey walks from along the street before its first train, or to after its last', () => {
    // One way from the Bakerloo line's Edgware Road onto the Circle line is to walk to the other Edgware Road.
    const startsWithWalk = findRoutes('edgware_road_bakerloo', 'notting_hill_gate', 30).find((option) => option.links[0]?.type === 'walk');
    expect(startsWithWalk?.walks.map((walk) => walk.id)).toEqual(['osi_edgware_road']);
    const progress = addRouteToProgress(EMPTY_PROGRESS, startsWithWalk!);
    expect(progress.stationsEnteredOrExitedIDs).toEqual(['edgware_road_circle', 'notting_hill_gate']);
    expect(progress.walkedLinkIDs).toEqual([]);
    expect(progress.stationsChangedAtIDs).toEqual([]);
    expect(getStationState('edgware_road_bakerloo', progress)).toBe('neutral');

    const endsWithWalk = findRoutes('notting_hill_gate', 'edgware_road_bakerloo', 30).find((option) => option.links.at(-1)?.type === 'walk');
    expect(endsWithWalk).toBeDefined();
    expect(getJourneyStations(endsWithWalk!)).toEqual({ enteredOrExited: ['notting_hill_gate', 'edgware_road_circle'], changedAt: [] });
  });

  it('records nothing for a journey that is only a walk along the street', () => {
    const walk = route('edgware_road_bakerloo', 'edgware_road_circle');
    expect(walk.walks.map((link) => [link.id, link.kind])).toEqual([['osi_edgware_road', 'osi']]);
    expect(isStreetWalkOnly(walk)).toBe(true);
    expect(addRouteToProgress(EMPTY_PROGRESS, walk)).toBe(EMPTY_PROGRESS);
  });

  it('keeps a walkway behind the gates at either end: the first station was entered, the other changed at', () => {
    // Bank to Tower Hill starts along the walkway from Bank to Monument, inside the stations.
    const startsWithWalkway = findRoutes('bank', 'tower_hill', 30).find((option) => option.links[0]?.type === 'walk');
    expect(startsWithWalkway?.walks.map((walk) => walk.id)).toEqual(['isi_bank_monument']);
    const progress = addRouteToProgress(EMPTY_PROGRESS, startsWithWalkway!);
    expect(progress.stationsEnteredOrExitedIDs).toEqual(['bank', 'tower_hill']);
    expect(progress.stationsChangedAtIDs).toEqual(['monument']);
    expect(progress.walkedLinkIDs).toEqual(['isi_bank_monument']);

    // On its own, the walkway goes in through one station's gates and out through the other's.
    const walkwayOnly = route('bank', 'monument');
    expect(isStreetWalkOnly(walkwayOnly)).toBe(false);
    expect(getJourneyStations(walkwayOnly)).toEqual({ enteredOrExited: ['bank', 'monument'], changedAt: [] });
  });

  it('keeps stations passed through distinct from journey ends and changes', () => {
    const journey = route('paddington', 'waterloo');
    const progress = addRouteToProgress(EMPTY_PROGRESS, journey);
    const passedThrough = journey.path.slice(1, -1);
    expect(passedThrough.length).toBeGreaterThan(0);
    expect(getStationState('paddington', progress)).toBe('entered');
    expect(getStationState('waterloo', progress)).toBe('entered');
    expect(passedThrough.every((stationId) => getStationState(stationId, progress) === 'visited')).toBe(true);
    expect(getStationState('upminster', progress)).toBe('neutral');
    expect(getStationState('paddington', EMPTY_PROGRESS)).toBe('neutral');
  });

  it('lists every id a journey touches, even ones already recorded, and nothing for a street walk', () => {
    const journey = route('paddington', 'waterloo');
    const items = getRouteItems(journey);
    expect(addRouteToProgress(EMPTY_PROGRESS, journey)).toEqual(items);
    // Already explored: recording adds nothing locally, but backup still needs every id (a reset may be on its way).
    expect(getRouteItems(journey)).toEqual(items);
    expect(items.travelledSegmentIDs).toEqual(journey.sections.map((section) => section.id));
    expect(items.stationsEnteredOrExitedIDs).toEqual(['paddington', 'waterloo']);
    expect(getRouteItems(route('edgware_road_bakerloo', 'edgware_road_circle'))).toEqual(EMPTY_PROGRESS);

    const withWalkway = findRoutes('bank', 'tower_hill', 30).find((option) => option.links[0]?.type === 'walk')!;
    expect(getRouteItems(withWalkway)).toEqual(addRouteToProgress(EMPTY_PROGRESS, withWalkway));
  });
});

describe('summariseProgress', () => {
  it('calculates coverage and line status', () => {
    const summary = summariseProgress(addRouteToProgress(EMPTY_PROGRESS, route('paddington', 'waterloo')));
    expect(summary.travelledDistance).toBeGreaterThan(0);
    expect(summary.coverage).toBeGreaterThan(0);
    expect(summary.lineProgress.map((line) => line.id)).toEqual(lines.map((line) => line.id));
    for (const line of summary.lineProgress) {
      expect(line.stationCompletion).toBe(line.totalStations > 0 ? (line.visitedStations / line.totalStations) * 100 : 0);
      expect(line.completion).toBe(line.totalDistance > 0 ? (line.travelledDistance / line.totalDistance) * 100 : 0);
      expect(line.completion).toBeGreaterThanOrEqual(0);
      expect(line.completion).toBeLessThanOrEqual(100);
    }
  });

  it('counts only track: every section travelled is exactly 100% and walks add nothing', () => {
    const everything = summariseProgress({ ...EMPTY_PROGRESS, travelledSegmentIDs: sections.map((section) => section.id) });
    expect(everything.completedLines).toBe(19);
    expect(everything.totalDistance / 1000).toBeCloseTo(784.2, 1);
    expect(everything.coverage).toBe(100);

    const walked = summariseProgress({ ...EMPTY_PROGRESS, walkedLinkIDs: ['isi_bank_monument'] });
    expect(walked.travelledDistance).toBe(0);
  });

  it('counts stations entered, exited or changed at as visited, but not stations only passed through', () => {
    const journey = route('paddington', 'london_bridge');
    const summary = summariseProgress(addRouteToProgress(EMPTY_PROGRESS, journey));
    const visited = new Set([journey.path[0], journey.path.at(-1), ...journey.changes.flatMap((change) => (change.type === 'line' ? [change.at] : []))]);
    expect(journey.path.length).toBeGreaterThan(visited.size);
    expect(summary.uniqueStations).toBe(visited.size);

    const passedOnly = summariseProgress({ ...EMPTY_PROGRESS, travelledSegmentIDs: journey.sections.map((section) => section.id) });
    expect(passedOnly.uniqueStations).toBe(0);
    expect(passedOnly.lineProgress.every((line) => line.visitedStations === 0)).toBe(true);
  });

  it('counts a visited station towards every line that serves it', () => {
    const summary = summariseProgress({ ...EMPTY_PROGRESS, stationsEnteredOrExitedIDs: ['kings_cross'] });
    const linesWithVisit = summary.lineProgress.filter((line) => line.visitedStations === 1).map((line) => line.id).sort();
    expect(linesWithVisit).toEqual(['circle', 'hammersmith_city', 'metropolitan', 'northern', 'piccadilly', 'victoria']);
  });

  it('keeps distance and station coverage independent when either is higher', () => {
    const comparisons = sections.map((section) => {
      const summary = summariseProgress({
        ...EMPTY_PROGRESS,
        travelledSegmentIDs: [section.id],
        stationsEnteredOrExitedIDs: [section.from, section.to]
      });
      return summary.lineProgress.find((line) => line.id === section.lineId)!;
    });
    expect(comparisons.some((line) => line.completion > line.stationCompletion)).toBe(true);
    expect(comparisons.some((line) => line.stationCompletion > line.completion)).toBe(true);
  });
});

describe('sortLineProgress', () => {
  it('orders lines by track travelled, then stations visited, then name', () => {
    const line = (name: string, completion: number, stationCompletion: number) => ({
      id: name, name, completion, stationCompletion, travelledDistance: 0, totalDistance: 1, visitedStations: 0, totalStations: 1, complete: false
    });
    const sorted = sortLineProgress([
      line('Bakerloo', 0, 0),
      line('Central', 0, 4),
      line('Jubilee', 14, 7),
      line('Circle', 0, 4),
      line('Victoria', 2, 0)
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['Jubilee', 'Victoria', 'Central', 'Circle', 'Bakerloo']);
  });
});

describe('sanitizeProgress', () => {
  it('accepts a valid record unchanged', () => {
    // A journey with a walk between trains, so every field of the record is filled in.
    const progress = addRouteToProgress(EMPTY_PROGRESS, route('golders_green', 'caledonian_road_barnsbury'));
    expect(sanitizeProgress(progress)).toEqual(progress);
  });

  it('falls back to empty progress for missing or malformed records, and upgrades older records', () => {
    expect(sanitizeProgress(undefined)).toEqual(EMPTY_PROGRESS);
    expect(sanitizeProgress('nonsense')).toEqual(EMPTY_PROGRESS);
    expect(sanitizeProgress({ travelledSegmentIDs: 'bakerloo_x' })).toEqual(EMPTY_PROGRESS);
    // Records saved before walks existed have no walkedLinkIDs and may contain the old Bank–Monument pseudo-section.
    expect(sanitizeProgress({
      travelledSegmentIDs: ['bank_monument_interchange'],
      stationsEnteredOrExitedIDs: ['bank'],
      stationsChangedAtIDs: []
    })).toEqual({ ...EMPTY_PROGRESS, walkedLinkIDs: ['isi_bank_monument'], stationsEnteredOrExitedIDs: ['bank'] });
  });

  it('drops unknown ids, non-strings and duplicates', () => {
    const sectionId = sections[0]!.id;
    expect(sanitizeProgress({
      travelledSegmentIDs: [sectionId, sectionId, 'removed_section', 42],
      walkedLinkIDs: ['osi_edgware_road', 'not_a_walk', sectionId],
      stationsEnteredOrExitedIDs: ['bank', 'atlantis'],
      stationsChangedAtIDs: [null, 'victoria']
    })).toEqual({
      travelledSegmentIDs: [sectionId],
      walkedLinkIDs: ['osi_edgware_road'],
      stationsEnteredOrExitedIDs: ['bank'],
      stationsChangedAtIDs: ['victoria']
    });
  });
});
