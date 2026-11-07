import { describe, expect, it } from 'vitest';
import { findRoute, lines } from '../data/network';
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

  it('calculates coverage and line status', () => {
    const route = findRoute('paddington', 'waterloo');
    const progress = addRouteToProgress(EMPTY_PROGRESS, route!, 'paddington', 'waterloo');
    const summary = summariseProgress(progress);
    expect(summary.travelledDistance).toBeGreaterThan(0);
    expect(summary.coverage).toBeGreaterThan(0);
    expect(summary.lineProgress.map((line) => line.id)).toEqual(lines.map((line) => line.id));
  });
});
