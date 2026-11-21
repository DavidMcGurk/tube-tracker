import { getSectionById, getStationById, getWalkLinkById, lines, sections, stations } from '../data/network';
import type { LineProgress, NetworkSummary, Progress, RouteResult, StationState } from './types';

export const EMPTY_PROGRESS: Progress = {
  travelledSegmentIDs: [],
  walkedLinkIDs: [],
  stationsEnteredOrExitedIDs: [],
  stationsChangedAtIDs: []
};

const LEGACY_BANK_MONUMENT_SECTION = 'bank_monument_interchange';
const BANK_MONUMENT_WALK = 'isi_bank_monument';

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
  // Before walking interchanges existed, the Bank–Monument walkway was stored as a track section.
  const legacyWalks = Array.isArray(record.travelledSegmentIDs) && record.travelledSegmentIDs.includes(LEGACY_BANK_MONUMENT_SECTION)
    ? [BANK_MONUMENT_WALK]
    : [];
  return {
    travelledSegmentIDs: knownIds(record.travelledSegmentIDs, (id) => getSectionById(id) !== undefined),
    walkedLinkIDs: knownIds([...(Array.isArray(record.walkedLinkIDs) ? record.walkedLinkIDs : []), ...legacyWalks], (id) => getWalkLinkById(id) !== undefined),
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

/** True when recording the route would add nothing: no new track, walks, or visited or changed-at stations. */
export function routeIsAlreadyComplete(progress: Progress, route: RouteResult) {
  return addRouteToProgress(progress, route) === progress;
}

const isStreetWalk = (link: RouteResult['links'][number]) => link.type === 'walk' && link.kind === 'osi';

/**
 * The part of a journey that went through stations, as indices into its links. A walk along the street before the
 * first train or after the last isn't part of it: starting at the "wrong" Edgware Road and walking to the other one
 * doesn't visit the first. (A walkway behind the gates, like Bank to Monument, is: you entered the first station.)
 * Null when the journey is only a walk along the street.
 */
function getRiddenLinks(route: RouteResult) {
  let first = 0;
  let last = route.links.length - 1;
  while (first <= last && isStreetWalk(route.links[first]!)) first += 1;
  while (last >= first && isStreetWalk(route.links[last]!)) last -= 1;
  return first <= last ? { first, last } : null;
}

/**
 * Stations a journey went through the gates of (the ends of its ridden part, and both ends of out-of-station walks
 * within it) and stations where it changed without leaving (line changes, and both ends of in-station walks).
 */
export function getJourneyStations(route: RouteResult) {
  const ridden = getRiddenLinks(route);
  if (!ridden) return { enteredOrExited: [], changedAt: [] };
  const enteredOrExited = [route.path[ridden.first], route.path[ridden.last + 1]].filter((stationId): stationId is string => Boolean(stationId));
  const isRiddenWalk = (from: string, to: string) => route.links.some((link, index) =>
    link.type === 'walk' && index >= ridden.first && index <= ridden.last && route.path[index] === from && route.path[index + 1] === to);
  const changedAt: string[] = [];
  for (const change of route.changes) {
    if (change.type === 'line') changedAt.push(change.at);
    else if (!isRiddenWalk(change.from, change.to)) continue;
    else if (change.kind === 'osi') enteredOrExited.push(change.from, change.to);
    else changedAt.push(change.from, change.to);
  }
  return { enteredOrExited, changedAt: changedAt.filter((stationId) => !enteredOrExited.includes(stationId)) };
}

/** Whether a journey is only a walk along the street, which visits no station and so has nothing to record. */
export function isStreetWalkOnly(route: RouteResult) {
  return getRiddenLinks(route) === null;
}

/** Returns the same object when the route adds nothing new, so callers can compare by reference. */
export function addRouteToProgress(progress: Progress, route: RouteResult): Progress {
  const ridden = getRiddenLinks(route);
  if (!ridden) return progress;

  const { enteredOrExited, changedAt } = getJourneyStations(route);
  const riddenWalkIds = route.links.slice(ridden.first, ridden.last + 1).flatMap((link) => (link.type === 'walk' ? [link.id] : []));
  const next: Progress = {
    travelledSegmentIDs: appendUnique(progress.travelledSegmentIDs, route.sections.map((section) => section.id)),
    walkedLinkIDs: appendUnique(progress.walkedLinkIDs, riddenWalkIds),
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

/** Lines ordered by progress: track travelled, then stations visited, then name. */
export function sortLineProgress(lineProgress: readonly LineProgress[]): LineProgress[] {
  return [...lineProgress].sort((a, b) =>
    b.completion - a.completion
    || b.stationCompletion - a.stationCompletion
    || a.name.localeCompare(b.name));
}

export function getStationState(stationId: string, progress: Progress): StationState {
  const index = getProgressIndex(progress);
  if (index.enteredOrExitedStationIds.has(stationId)) return 'entered';
  if (index.changedAtStationIds.has(stationId)) return 'changed';
  if (index.passedStationIds.has(stationId)) return 'visited';
  return 'neutral';
}
