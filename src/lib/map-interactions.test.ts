import { describe, expect, it } from 'vitest';
import { findRoutes, stations } from '../data/network';
import {
  clampMapZoom,
  createStationLabelIndex,
  DEFAULT_MAP_ZOOM,
  formatRouteEndpoints,
  getActiveRoute,
  getRouteKey,
  getRouteStationIds,
  hasAlternativeRoutes,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  normalizeStationLabel,
  stepMapZoom,
  toggleStationSelection
} from './map-interactions';

describe('map interaction helpers', () => {
  it('keeps map zoom within its supported range and uses the expected default', () => {
    expect(DEFAULT_MAP_ZOOM).toBe(4);
    expect(clampMapZoom(0.5)).toBe(MIN_MAP_ZOOM);
    expect(clampMapZoom(8)).toBe(MAX_MAP_ZOOM);
    expect(stepMapZoom(1, -0.25)).toBe(MIN_MAP_ZOOM);
    expect(stepMapZoom(5.75, 0.25)).toBe(MAX_MAP_ZOOM);
    expect(stepMapZoom(4, 0.25)).toBe(4.25);
  });

  it('toggles selected stations, supports two endpoints, and replaces both when choosing a third', () => {
    expect(toggleStationSelection([], 'arsenal')).toEqual(['arsenal']);
    expect(toggleStationSelection(['arsenal'], 'holloway_road')).toEqual(['arsenal', 'holloway_road']);
    expect(toggleStationSelection(['arsenal', 'holloway_road'], 'arsenal')).toEqual(['holloway_road']);
    expect(toggleStationSelection(['arsenal', 'holloway_road'], 'finsbury_park')).toEqual(['finsbury_park']);
  });

  it('shows alternatives only when the exact route list contains more than the primary route', () => {
    const primaryRoute = { path: ['a', 'b'], segments: [], transferStations: [] };
    const alternateRoute = { path: ['a', 'c'], segments: [], transferStations: [] };

    expect(hasAlternativeRoutes([])).toBe(false);
    expect(hasAlternativeRoutes([primaryRoute])).toBe(false);
    expect(hasAlternativeRoutes([primaryRoute, alternateRoute])).toBe(true);
  });

  it('can identify only the stations and sections belonging to a route preview', () => {
    const stationId = (name: string) => stations.find((station) => station.name === name)?.id;
    const cannonStreet = stationId('Cannon Street');
    const waterloo = stationId('Waterloo');
    if (!cannonStreet || !waterloo) throw new Error('Expected route-preview stations in the network');

    const options = findRoutes(cannonStreet, waterloo, 2);
    const first = options[0];
    const alternative = options[1];
    expect(first).toBeDefined();
    expect(alternative).toBeDefined();
    if (!first || !alternative) throw new Error('Expected alternative route options');

    const routeStationIds = getRouteStationIds(first);
    expect(routeStationIds.has(cannonStreet)).toBe(true);
    expect(routeStationIds.has(waterloo)).toBe(true);
    expect(routeStationIds.size).toBe(first.path.length);
    expect(getRouteKey(first)).not.toBe(getRouteKey(alternative));
    expect(getRouteStationIds(alternative)).toEqual(new Set(alternative.path));
    expect(getActiveRoute(alternative, first)).toBe(alternative);
    expect(getActiveRoute(null, first)).toBe(first);
  });

  it('hides the alternatives control for a direct journey and offers it when options exist', () => {
    const stationId = (name: string) => stations.find((station) => station.name === name)?.id;
    const arsenal = stationId('Arsenal');
    const hollowayRoad = stationId('Holloway Road');
    const cannonStreet = stationId('Cannon Street');
    const waterloo = stationId('Waterloo');

    if (!arsenal || !hollowayRoad || !cannonStreet || !waterloo) {
      throw new Error('Expected the test stations to exist in the network');
    }

    const directJourneyRoutes = findRoutes(arsenal, hollowayRoad, 2);
    const alternateJourneyRoutes = findRoutes(cannonStreet, waterloo, 2);
    expect(directJourneyRoutes).toHaveLength(1);
    expect(hasAlternativeRoutes(directJourneyRoutes)).toBe(false);
    expect(alternateJourneyRoutes.length).toBeGreaterThan(1);
    expect(hasAlternativeRoutes(alternateJourneyRoutes)).toBe(true);
  });

  it('formats the selected journey endpoints and avoids incomplete labels', () => {
    expect(formatRouteEndpoints('Arsenal', 'Holloway Road')).toBe('Arsenal → Holloway Road');
    expect(formatRouteEndpoints('Arsenal')).toBe('');
  });

  it('matches complete multi-line SVG station labels despite whitespace and ampersands', () => {
    const labelIndex = createStationLabelIndex([
      { id: 'hayes', name: 'Hayes & Harlington', lines: [], system: 'Elizabeth line' },
      { id: 'woolwich', name: 'Woolwich Arsenal', lines: [], system: 'Elizabeth line' }
    ]);

    expect(normalizeStationLabel('Woolwich\n Arsenal')).toBe('woolwicharsenal');
    expect(labelIndex.get(normalizeStationLabel('Woolwich\n Arsenal'))?.map((station) => station.id)).toEqual(['woolwich']);
    expect(labelIndex.get(normalizeStationLabel('Hayes and Harlington'))?.map((station) => station.id)).toEqual(['hayes']);
  });
});
