import { getSectionById, lines, sections, stations } from '../data/network';
import type { LineProgress, NetworkSummary, Progress, RouteResult, StationState } from './types';

export const EMPTY_PROGRESS: Progress = {
  travelledSegmentIDs: [],
  stationsEnteredOrExitedIDs: [],
  stationsChangedAtIDs: []
};

/** Set-based view of a progress record so per-station lookups are O(1). */
export interface ProgressIndex {
  travelledSectionIds: ReadonlySet<string>;
  enteredOrExitedStationIds: ReadonlySet<string>;
  changedAtStationIds: ReadonlySet<string>;
  /** Every station at either end of a travelled section, including stations only passed through. */
  passedStationIds: ReadonlySet<string>;
}

const progressIndexCache = new WeakMap<Progress, ProgressIndex>();

export function getProgressIndex(progress: Progress): ProgressIndex {
  const cached = progressIndexCache.get(progress);
  if (cached) return cached;

  const passedStationIds = new Set<string>();
  for (const sectionId of progress.travelledSegmentIDs) {
    const section = getSectionById(sectionId);
    if (!section) continue;
    passedStationIds.add(section.from);
    passedStationIds.add(section.to);
  }
  const index: ProgressIndex = {
    travelledSectionIds: new Set(progress.travelledSegmentIDs),
    enteredOrExitedStationIds: new Set(progress.stationsEnteredOrExitedIDs),
    changedAtStationIds: new Set(progress.stationsChangedAtIDs),
    passedStationIds
  };
  progressIndexCache.set(progress, index);
  return index;
}

function appendUnique(existing: string[], additions: readonly string[]): string[] {
  const seen = new Set(existing);
  const added = additions.filter((value) => value && !seen.has(value) && seen.add(value));
  return added.length > 0 ? [...existing, ...added] : existing;
}

export function routeIsAlreadyComplete(progress: Progress, route: RouteResult) {
  const { travelledSectionIds } = getProgressIndex(progress);
  return route.sections.every((section) => travelledSectionIds.has(section.id));
}

/** Returns the same object when the route adds nothing new, so callers can compare by reference. */
export function addRouteToProgress(progress: Progress, route: RouteResult, startStationId: string, endStationId: string): Progress {
  if (route.sections.length === 0) return progress;

  const travelled = appendUnique(progress.travelledSegmentIDs, route.sections.map((section) => section.id));
  const enteredOrExited = appendUnique(progress.stationsEnteredOrExitedIDs, [startStationId, endStationId]);
  const changed = appendUnique(progress.stationsChangedAtIDs, route.transferStations);
  if (
    travelled === progress.travelledSegmentIDs
    && enteredOrExited === progress.stationsEnteredOrExitedIDs
    && changed === progress.stationsChangedAtIDs
  ) return progress;

  return {
    travelledSegmentIDs: travelled,
    stationsEnteredOrExitedIDs: enteredOrExited,
    stationsChangedAtIDs: changed
  };
}

const sectionsByLine = new Map(lines.map((line) => [line.id, sections.filter((section) => section.lineId === line.id)]));
const stationsByLine = new Map(lines.map((line) => [line.id, stations.filter((station) => station.lines.includes(line.id))]));
const totalNetworkDistance = sections.reduce((sum, section) => sum + section.distance, 0);

export function summariseProgress(progress: Progress): NetworkSummary {
  const index = getProgressIndex(progress);
  const travelledDistance = sections.reduce(
    (sum, section) => (index.travelledSectionIds.has(section.id) ? sum + section.distance : sum),
    0
  );
  const stationsInProgress = new Set([...index.enteredOrExitedStationIds, ...index.passedStationIds]);

  const lineProgress = lines.map((line): LineProgress => {
    const lineSections = sectionsByLine.get(line.id) ?? [];
    const completedSections = lineSections.filter((section) => index.travelledSectionIds.has(section.id));
    const travelledLineDistance = completedSections.reduce((sum, section) => sum + section.distance, 0);
    const totalLineDistance = lineSections.reduce((sum, section) => sum + section.distance, 0);
    const lineStations = stationsByLine.get(line.id) ?? [];
    const visitedStationIds = new Set(completedSections.flatMap((section) => [section.from, section.to]));
    const visitedStations = lineStations.filter((station) => visitedStationIds.has(station.id)).length;
    return {
      id: line.id,
      name: line.name,
      completion: totalLineDistance > 0 ? (travelledLineDistance / totalLineDistance) * 100 : 0,
      stationCompletion: lineStations.length > 0 ? (visitedStations / lineStations.length) * 100 : 0,
      travelledDistance: travelledLineDistance,
      totalDistance: totalLineDistance,
      visitedStations,
      totalStations: lineStations.length,
      complete: lineSections.length > 0 && completedSections.length === lineSections.length
    };
  });

  return {
    totalDistance: totalNetworkDistance,
    travelledDistance,
    coverage: totalNetworkDistance > 0 ? (travelledDistance / totalNetworkDistance) * 100 : 0,
    uniqueStations: stationsInProgress.size,
    completedLines: lineProgress.filter((entry) => entry.complete).length,
    lineProgress
  };
}

export function getStationState(stationId: string, progress: Progress): StationState {
  const index = getProgressIndex(progress);
  if (index.enteredOrExitedStationIds.has(stationId)) return 'entered';
  if (index.changedAtStationIds.has(stationId)) return 'changed';
  if (index.passedStationIds.has(stationId)) return 'visited';
  return 'neutral';
}
