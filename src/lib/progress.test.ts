import { describe, expect, it } from 'vitest';
import { findRoute, lines, sections } from '../data/network';
import {
  addRouteToProgress,
  EMPTY_PROGRESS,
  getJourneyStations,
  getStationState,
  routeIsAlreadyComplete,
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
    const journey = route('golders_green', 'camden_road');
    expect(journey.walks.map((walk) => walk.id)).toEqual(['osi_camden_town_camden_road']);

    const progress = addRouteToProgress(EMPTY_PROGRESS, journey);
    expect(progress.walkedLinkIDs).toEqual(['osi_camden_town_camden_road']);
    expect(progress.travelledSegmentIDs).toEqual(journey.sections.map((section) => section.id));
    expect(progress.stationsEnteredOrExitedIDs).toEqual(expect.arrayContaining(['golders_green', 'camden_road', 'camden_town']));
    expect(progress.stationsChangedAtIDs).toEqual([]);
    expect(getStationState('camden_town', progress)).toBe('entered');
  });

  it('treats both ends of an in-station interchange as changes', () => {
    const journey = {
      path: ['st_paul_s', 'bank', 'monument', 'tower_hill'],
      changes: [{ type: 'walk', from: 'bank', to: 'monument', kind: 'isi' }]
    } as unknown as RouteResult;
    expect(getJourneyStations(journey)).toEqual({ enteredOrExited: ['st_paul_s', 'tower_hill'], changedAt: ['bank', 'monument'] });
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

  it('keeps distance and station coverage independent when either is higher', () => {
    const comparisons = sections.map((section) => {
      const summary = summariseProgress({ ...EMPTY_PROGRESS, travelledSegmentIDs: [section.id] });
      return summary.lineProgress.find((line) => line.id === section.lineId)!;
    });
    expect(comparisons.some((line) => line.completion > line.stationCompletion)).toBe(true);
    expect(comparisons.some((line) => line.stationCompletion > line.completion)).toBe(true);
  });
});

describe('sanitizeProgress', () => {
  it('accepts a valid record unchanged', () => {
    const progress = addRouteToProgress(EMPTY_PROGRESS, route('golders_green', 'camden_road'));
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
    })).toEqual({ ...EMPTY_PROGRESS, stationsEnteredOrExitedIDs: ['bank'] });
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
