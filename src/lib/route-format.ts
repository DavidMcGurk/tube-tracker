import { getStationById, lines } from '../data/network';
import type { LineDefinition, RouteResult } from './types';

export const lineById: ReadonlyMap<string, LineDefinition> = new Map(lines.map((line) => [line.id, line]));

const INTERCHANGE_NAME = 'Bank–Monument interchange';

export function getLineName(lineId: string) {
  return lineId === 'interchange' ? INTERCHANGE_NAME : lineById.get(lineId)?.name ?? lineId;
}

/** The sequence of lines ridden, collapsing consecutive sections on the same line. */
export function getRouteLineNames(route: RouteResult) {
  const lineIds = route.sections.reduce<string[]>((result, section) => {
    if (result.at(-1) !== section.lineId) result.push(section.lineId);
    return result;
  }, []);
  return lineIds.map(getLineName);
}

export function getRouteTransferNames(route: RouteResult) {
  return route.transferStations.map((stationId) => getStationById(stationId)?.name ?? stationId);
}

export function getRouteDistance(route: RouteResult) {
  return route.sections.reduce((total, section) => total + section.distance, 0);
}

export function formatDistance(metres: number) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export function formatKilometres(metres: number) {
  return (metres / 1000).toFixed(1);
}
