import { getStationById, lines, stations } from '../data/network';
import type { LineDefinition, RouteChange, RouteResult } from './types';

export const lineById: ReadonlyMap<string, LineDefinition> = new Map(lines.map((line) => [line.id, line]));

export function getLineName(lineId: string) {
  return lineById.get(lineId)?.name ?? lineId;
}

const stationNameCounts = stations.reduce((counts, station) => counts.set(station.name, (counts.get(station.name) ?? 0) + 1), new Map<string, number>());

/** The station's name, with its lines appended when another station shares the name (e.g. the two Edgware Roads). */
export function getStationName(stationId: string) {
  const station = getStationById(stationId);
  if (!station) return stationId;
  if ((stationNameCounts.get(station.name) ?? 0) < 2) return station.name;
  return `${station.name} (${station.lines.map(getLineName).join(', ')})`;
}

/** Each leg of the journey in order, e.g. ["Northern", "Walk"]. */
export function getRouteLegNames(route: RouteResult) {
  return route.legs.map((leg) => (leg.type === 'walk' ? 'Walk' : getLineName(leg.lineId)));
}

function describeChange(change: RouteChange) {
  return change.type === 'line'
    ? `change at ${getStationName(change.at)}`
    : `walk ${getStationName(change.from)} → ${getStationName(change.to)}`;
}

/** e.g. "Change at Bond Street · walk Camden Town → Camden Road", or '' for a direct journey. */
export function describeRouteChanges(route: RouteResult, { capitalise = true } = {}) {
  const text = route.changes.map(describeChange).join(' · ');
  return capitalise && text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** e.g. "Northern → Walk", with the distinguishing station when another option rides the same legs. */
export function describeRouteTitle(route: RouteResult) {
  const legs = getRouteLegNames(route).join(' → ');
  if (!route.via?.length) return legs;
  const names = route.via.map(getStationName);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `${legs} (via ${list})`;
}

export function formatDistance(metres: number) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export function formatKilometres(metres: number) {
  return (metres / 1000).toFixed(1);
}

/** e.g. "5.2 km + 450 m walk", "350 m walk" or "12.1 km". */
export function describeRouteDistance(route: RouteResult) {
  if (route.trackDistance === 0) return `${formatDistance(route.walkDistance)} walk`;
  const track = formatDistance(route.trackDistance);
  return route.walkDistance > 0 ? `${track} + ${formatDistance(route.walkDistance)} walk` : track;
}

export function describeRouteNumberOfChanges(route: RouteResult) {
  const count = route.changes.length;
  return count === 0 ? 'no changes' : `${count} ${count === 1 ? 'change' : 'changes'}`;
}
