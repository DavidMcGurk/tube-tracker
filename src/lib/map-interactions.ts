import type { Station } from '../data/station';
import type { RouteResult } from './types';

export const MIN_MAP_ZOOM = 1;
export const DEFAULT_MAP_ZOOM = 4;
export const DESKTOP_DEFAULT_MAP_ZOOM = 2;
export const MAX_MAP_ZOOM = 6;

/** Map viewport widths (CSS px) for the first zoom on a computer: a 1280 px laptop's, and a 1920 px monitor's. */
const LAPTOP_MAP_VIEWPORT_WIDTH = 1220;
const WIDESCREEN_MAP_VIEWPORT_WIDTH = 1800;

/**
 * The first zoom on a computer for a map viewport this wide: 2× on a laptop, the whole map's width (1×) on a
 * widescreen monitor, and in between on the 0.25 grid, so wider screens show more of the map.
 */
export function getDesktopDefaultZoom(mapViewportWidth: number) {
  if (!(mapViewportWidth > 0)) return DESKTOP_DEFAULT_MAP_ZOOM;
  const progress = (mapViewportWidth - LAPTOP_MAP_VIEWPORT_WIDTH) / (WIDESCREEN_MAP_VIEWPORT_WIDTH - LAPTOP_MAP_VIEWPORT_WIDTH);
  const zoom = DESKTOP_DEFAULT_MAP_ZOOM - Math.min(Math.max(progress, 0), 1) * (DESKTOP_DEFAULT_MAP_ZOOM - MIN_MAP_ZOOM);
  return Math.round(zoom * 4) / 4;
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
