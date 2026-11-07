import { getStationById, lines, sections } from '../data/network';
import type { NetworkSummary, Progress, RouteResult } from './types';

export const EMPTY_PROGRESS: Progress = {
  travelledSegmentIDs: [],
  stationsEnteredOrExitedIDs: [],
  stationsChangedAtIDs: []
};

export function dedupe(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function routeIsAlreadyComplete(progress: Progress, route: RouteResult) {
  return route.segments.every((segment) => progress.travelledSegmentIDs.includes(segment.id));
}

export function addRouteToProgress(progress: Progress, route: RouteResult, startStationId: string, endStationId: string): Progress {
  if (route.segments.length === 0) {
    return progress;
  }

  const travelled = dedupe([...progress.travelledSegmentIDs, ...route.segments.map((segment) => segment.id)]);
  const enteredOrExited = dedupe([...progress.stationsEnteredOrExitedIDs, startStationId, endStationId]);
  const changed = dedupe([...progress.stationsChangedAtIDs, ...route.transferStations]);

  return {
    travelledSegmentIDs: travelled,
    stationsEnteredOrExitedIDs: enteredOrExited,
    stationsChangedAtIDs: changed
  };
}

export function summariseProgress(progress: Progress): NetworkSummary {
  const travelledSet = new Set(progress.travelledSegmentIDs);
  const totalDistance = sections.reduce((sum, segment) => sum + segment.distance, 0);
  const travelledDistance = sections.reduce((sum, segment) => (travelledSet.has(segment.id) ? sum + segment.distance : sum), 0);

  const stationsInProgress = new Set<string>([
    ...progress.stationsEnteredOrExitedIDs,
    ...progress.travelledSegmentIDs.flatMap((segmentId) => {
      const segment = sections.find((value) => value.id === segmentId);
      return segment ? [segment.from, segment.to] : [];
    })
  ]);

  const lineProgress = [] as NetworkSummary['lineProgress'];
  for (const line of lines) {
    const matches = sections.filter((segment) => segment.lineId === line.id);
    const completedSections = matches.filter((segment) => travelledSet.has(segment.id));
    const travelledLineDistance = matches.reduce((sum, segment) => (travelledSet.has(segment.id) ? sum + segment.distance : sum), 0);
    const totalLineDistance = matches.reduce((sum, segment) => sum + segment.distance, 0);
    const completion = totalLineDistance > 0 ? (travelledLineDistance / totalLineDistance) * 100 : 0;
    lineProgress.push({
      id: line.id,
      name: line.name,
      completion,
      travelledDistance: travelledLineDistance,
      totalDistance: totalLineDistance,
      completedSections: completedSections.length,
      totalSections: matches.length,
      complete: matches.length > 0 && completedSections.length === matches.length
    });
  }

  return {
    totalDistance,
    travelledDistance,
    coverage: totalDistance > 0 ? (travelledDistance / totalDistance) * 100 : 0,
    uniqueStations: stationsInProgress.size,
    completedLines: lineProgress.filter((entry) => entry.complete).length,
    lineProgress
  };
}

export function getStationState(stationId: string, progress: Progress) {
  if (progress.stationsEnteredOrExitedIDs.includes(stationId)) return 'entered';
  if (progress.stationsChangedAtIDs.includes(stationId)) return 'changed';
  const station = getStationById(stationId);
  if (station && progress.travelledSegmentIDs.some((segmentId) => {
    const segment = sections.find((entry) => entry.id === segmentId);
    return segment && (segment.from === stationId || segment.to === stationId);
  })) return 'visited';
  return 'neutral';
}
