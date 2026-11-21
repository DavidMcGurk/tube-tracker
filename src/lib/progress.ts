import { getSectionById, getStationById, getWalkLinkById, lines, sections, stations } from '../data/network';
import type { LineProgress, NetworkSummary, Progress, RouteResult, StationState } from './types';

export const EMPTY_PROGRESS: Progress = {
  travelledSegmentIDs: [],
  walkedLinkIDs: [],
  stationsEnteredOrExitedIDs: [],
  stationsChangedAtIDs: []
};

function knownIds(value: unknown, isKnown: (id: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && isKnown(id)))];
}

/**
 * Validates a stored progress record: tolerates missing or malformed fields and drops ids that no longer exist in
 * the network data (e.g. after a data update), so stale storage can never crash the app.
 */
export function sanitizeProgress(value: unknown): Progress {
  if (typeof value !== 'object' || value === null) return EMPTY_PROGRESS;
  const record = value as Partial<Record<keyof Progress, unknown>>;
  const isStation = (id: string) => getStationById(id) !== undefined;
  return {
    travelledSegmentIDs: knownIds(record.travelledSegmentIDs, (id) => getSectionById(id) !== undefined),
    walkedLinkIDs: knownIds(record.walkedLinkIDs, (id) => getWalkLinkById(id) !== undefined),
    stationsEnteredOrExitedIDs: knownIds(record.stationsEnteredOrExitedIDs, isStation),
    stationsChangedAtIDs: knownIds(record.stationsChangedAtIDs, isStation)
  };
}

/** Set-based view of a progress record so per-station lookups are O(1). */
export interface ProgressIndex {
  travelledSectionIds: ReadonlySet<string>;
  walkedLinkIds: ReadonlySet<string>;
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
    walkedLinkIds: new Set(progress.walkedLinkIDs),
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
  const { travelledSectionIds, walkedLinkIds } = getProgressIndex(progress);
  return route.sections.every((section) => travelledSectionIds.has(section.id))
    && route.walks.every((walk) => walkedLinkIds.has(walk.id));
}

/**
 * Stations a journey went through the gates of (its ends, and both ends of out-of-station walks) and stations where
 * it changed without leaving (line changes, and both ends of in-station walks).
 */
export function getJourneyStations(route: RouteResult) {
  const enteredOrExited = [route.path[0], route.path.at(-1)].filter((stationId): stationId is string => Boolean(stationId));
  const changedAt: string[] = [];
  for (const change of route.changes) {
    if (change.type === 'line') changedAt.push(change.at);
    else if (change.kind === 'osi') enteredOrExited.push(change.from, change.to);
    else changedAt.push(change.from, change.to);
  }
  return { enteredOrExited, changedAt: changedAt.filter((stationId) => !enteredOrExited.includes(stationId)) };
}

/** Returns the same object when the route adds nothing new, so callers can compare by reference. */
export function addRouteToProgress(progress: Progress, route: RouteResult): Progress {
  if (route.links.length === 0) return progress;

  const { enteredOrExited, changedAt } = getJourneyStations(route);
  const next: Progress = {
    travelledSegmentIDs: appendUnique(progress.travelledSegmentIDs, route.sections.map((section) => section.id)),
    walkedLinkIDs: appendUnique(progress.walkedLinkIDs, route.walks.map((walk) => walk.id)),
    stationsEnteredOrExitedIDs: appendUnique(progress.stationsEnteredOrExitedIDs, enteredOrExited),
    stationsChangedAtIDs: appendUnique(progress.stationsChangedAtIDs, changedAt)
  };
  const unchanged = (Object.keys(next) as Array<keyof Progress>).every((field) => next[field] === progress[field]);
  return unchanged ? progress : next;
}

const sectionsByLine = new Map(lines.map((line) => [line.id, sections.filter((section) => section.lineId === line.id)]));
const stationsByLine = new Map(lines.map((line) => [line.id, stations.filter((station) => station.lines.includes(line.id))]));
const totalNetworkDistance = sections.reduce((sum, section) => sum + section.distance, 0);

/** Stations you have been to: entered, exited or changed at. Stations only passed through are not counted. */
function getVisitedStationIds(index: ProgressIndex) {
  return new Set([...index.enteredOrExitedStationIds, ...index.changedAtStationIds]);
}

export function summariseProgress(progress: Progress): NetworkSummary {
  const index = getProgressIndex(progress);
  const visitedStationIds = getVisitedStationIds(index);
  const travelledDistance = sections.reduce(
    (sum, section) => (index.travelledSectionIds.has(section.id) ? sum + section.distance : sum),
    0
  );

  const lineProgress = lines.map((line): LineProgress => {
    const lineSections = sectionsByLine.get(line.id) ?? [];
    const completedSections = lineSections.filter((section) => index.travelledSectionIds.has(section.id));
    const travelledLineDistance = completedSections.reduce((sum, section) => sum + section.distance, 0);
    const totalLineDistance = lineSections.reduce((sum, section) => sum + section.distance, 0);
    const lineStations = stationsByLine.get(line.id) ?? [];
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
    uniqueStations: visitedStationIds.size,
    totalStations: stations.length,
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
