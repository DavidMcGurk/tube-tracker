import type { RouteResult, Station } from './types';

export const MIN_MAP_ZOOM = 1;
export const DEFAULT_MAP_ZOOM = 4;
export const DESKTOP_DEFAULT_MAP_ZOOM = 2;
export const MAX_MAP_ZOOM = 6;

export function clampMapZoom(zoom: number) {
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, zoom));
}

export function stepMapZoom(zoom: number, step: number) {
  return clampMapZoom(Math.round((zoom + step) * 100) / 100);
}

export function toggleStationSelection(selectedStationIds: string[], stationId: string) {
  if (selectedStationIds.includes(stationId)) {
    return selectedStationIds.filter((selectedId) => selectedId !== stationId);
  }
  if (selectedStationIds.length >= 2) {
    return [stationId];
  }
  return [...selectedStationIds, stationId];
}

export function hasAlternativeRoutes(routes: readonly RouteResult[]) {
  return routes.length > 1;
}

export function getRouteStationIds(route: RouteResult | null, completedSectionIds: readonly string[] = []) {
  if (!route) return new Set<string>();
  const completed = new Set(completedSectionIds);
  return new Set(route.segments
    .filter((section) => !completed.has(section.id))
    .flatMap((section) => [section.from, section.to]));
}

export function getActiveRoute(selectedRoute: RouteResult | null, shortestRoute: RouteResult | null) {
  return selectedRoute ?? shortestRoute;
}

export function getRouteKey(route: RouteResult) {
  return route.segments.map((section) => section.id).join('|');
}

export function formatRouteEndpoints(startStationName?: string, endStationName?: string) {
  return startStationName && endStationName ? `${startStationName} → ${endStationName}` : '';
}

export function normalizeStationLabel(label: string) {
  return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function createStationLabelIndex<T extends Pick<Station, 'name'>>(stations: readonly T[]) {
  const index = new Map<string, T[]>();
  for (const station of stations) {
    for (const label of new Set([
      normalizeStationLabel(station.name),
      normalizeStationLabel(station.name.replace(/&/g, ' and '))
    ])) {
      index.set(label, [...(index.get(label) ?? []), station]);
    }
  }
  return index;
}
