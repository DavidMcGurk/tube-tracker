import type { Station } from '../data/station';
import type { RouteResult } from './types';

export const MIN_MAP_ZOOM = 1;
export const DEFAULT_MAP_ZOOM = 4;
export const DESKTOP_DEFAULT_MAP_ZOOM = 2;
export const MAX_MAP_ZOOM = 6;

/**
 * About how wide (CSS px) the map first shows on a computer: 2× on a laptop. Wider screens start further out, at about
 * this size, so a big monitor shows more of the map rather than a bigger copy of the same part.
 */
export const DESKTOP_MAP_WIDTH = 2450;

/** The first zoom on a computer for a map viewport this wide: on the 0.25 grid, from 1× up to 2×. */
export function getDesktopDefaultZoom(mapViewportWidth: number) {
  if (!(mapViewportWidth > 0)) return DESKTOP_DEFAULT_MAP_ZOOM;
  const zoom = Math.round((DESKTOP_MAP_WIDTH / mapViewportWidth) * 4) / 4;
  return Math.min(DESKTOP_DEFAULT_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, zoom));
}

export function clampMapZoom(zoom: number) {
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, zoom));
}

/** Tolerance for treating a zoom as already on the step grid despite floating-point error. */
const ZOOM_GRID_EPSILON = 1e-6;

/** Steps to the next multiple of `step` in its direction, so continuous (pinched) zooms snap back onto the grid. */
export function stepMapZoom(zoom: number, step: number) {
  const size = Math.abs(step);
  if (size === 0) return clampMapZoom(zoom);
  const gridIndex = zoom / size;
  const nextIndex = step > 0 ? Math.floor(gridIndex + ZOOM_GRID_EPSILON) + 1 : Math.ceil(gridIndex - ZOOM_GRID_EPSILON) - 1;
  return clampMapZoom(Math.round(nextIndex * size * 100) / 100);
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

export function getRouteKey(route: RouteResult) {
  return route.key;
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
