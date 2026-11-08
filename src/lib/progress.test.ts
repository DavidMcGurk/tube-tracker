import { describe, expect, it } from 'vitest';
import { findRoute, lines, sections } from '../data/network';
import { addRouteToProgress, EMPTY_PROGRESS, getStationState, routeIsAlreadyComplete, summariseProgress } from './progress';

describe('Tube Tracker logic', () => {
  it('finds a route between stations', () => {
    const route = findRoute('paddington', 'waterloo');
    expect(route).not.toBeNull();
    expect(route?.path[0]).toBe('paddington');
    expect(route?.path.at(-1)).toBe('waterloo');
    expect(route?.segments.length).toBeGreaterThan(0);
  });

  it('ignores duplicate section additions', () => {
    const route = findRoute('paddington', 'waterloo');
    expect(route).not.toBeNull();

    const updated = addRouteToProgress(EMPTY_PROGRESS, route!, 'paddington', 'waterloo');
    const second = addRouteToProgress(updated, route!, 'paddington', 'waterloo');
    expect(second.travelledSegmentIDs).toHaveLength(updated.travelledSegmentIDs.length);
    expect(routeIsAlreadyComplete(updated, route!)).toBe(true);
  });

  it('records journey endpoints and every transfer station without duplicating progress', () => {
    const route = findRoute('bank', 'victoria');
    expect(route).not.toBeNull();
    expect(route?.transferStations.length).toBeGreaterThan(0);

    const progress = addRouteToProgress(EMPTY_PROGRESS, route!, 'bank', 'victoria');
    const repeated = addRouteToProgress(progress, route!, 'bank', 'victoria');
    expect(progress.stationsEnteredOrExitedIDs).toEqual(['bank', 'victoria']);
    expect(progress.stationsChangedAtIDs).toEqual(route?.transferStations);
    expect(new Set(repeated.stationsChangedAtIDs).size).toBe(repeated.stationsChangedAtIDs.length);
    expect(route?.transferStations.every((stationId) => getStationState(stationId, progress) === 'changed')).toBe(true);
  });

  it('keeps stations passed through distinct from journey endpoints and transfer stations', () => {
    const route = findRoute('paddington', 'waterloo');
    expect(route).not.toBeNull();
    const progress = addRouteToProgress(EMPTY_PROGRESS, route!, 'paddington', 'waterloo');
    const intermediateStation = route!.path.find((stationId) =>
      stationId !== 'paddington'
      && stationId !== 'waterloo'
      && !route!.transferStations.includes(stationId)
    );

    expect(intermediateStation).toBeDefined();
    expect(getStationState('paddington', progress)).toBe('entered');
    expect(getStationState('waterloo', progress)).toBe('entered');
    expect(getStationState(intermediateStation!, progress)).toBe('visited');
  });

  it('calculates coverage and line status', () => {
    const route = findRoute('paddington', 'waterloo');
    const progress = addRouteToProgress(EMPTY_PROGRESS, route!, 'paddington', 'waterloo');
    const summary = summariseProgress(progress);
    expect(summary.travelledDistance).toBeGreaterThan(0);
    expect(summary.coverage).toBeGreaterThan(0);
    expect(summary.lineProgress.map((line) => line.id)).toEqual(lines.map((line) => line.id));
    for (const line of summary.lineProgress) {
      expect(line.stationCompletion).toBe(line.totalStations > 0 ? (line.visitedStations / line.totalStations) * 100 : 0);
      expect(line.completion).toBe(line.totalDistance > 0 ? (line.travelledDistance / line.totalDistance) * 100 : 0);
      expect(line.stationCompletion).toBeGreaterThanOrEqual(0);
      expect(line.stationCompletion).toBeLessThanOrEqual(100);
      expect(line.completion).toBeGreaterThanOrEqual(0);
      expect(line.completion).toBeLessThanOrEqual(100);
    }
  });

  it('keeps distance and station coverage independent when either is higher', () => {
    const comparisons = sections.map((section) => {
      const summary = summariseProgress({
        ...EMPTY_PROGRESS,
        travelledSegmentIDs: [section.id]
      });
      return summary.lineProgress.find((line) => line.id === section.lineId)!;
    });

    expect(comparisons.some((line) => line.completion > line.stationCompletion)).toBe(true);
    expect(comparisons.some((line) => line.stationCompletion > line.completion)).toBe(true);
  });
});
