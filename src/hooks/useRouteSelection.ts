import { useCallback, useMemo, useState } from 'react';
import { findRoutes } from '../data/network';
import { getRouteKey, toggleStationSelection } from '../lib/map-interactions';
import type { RouteResult } from '../lib/types';

const COLLAPSED_ROUTE_COUNT = 2;
const EXPANDED_ROUTE_COUNT = 30;

/** Selected journey endpoints, the route options between them, and which option the user picked. */
export function useRouteSelection() {
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([]);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  // Once alternatives have been shown, keep the full list so a chosen route keeps its number after hiding them.
  const [expanded, setExpanded] = useState(false);

  const [startId, endId] = selectedStationIds;
  const routeOptions = useMemo<RouteResult[]>(
    () => (startId && endId ? findRoutes(startId, endId, expanded ? EXPANDED_ROUTE_COUNT : COLLAPSED_ROUTE_COUNT) : []),
    [startId, endId, expanded]
  );
  const selectedIndex = selectedRouteKey ? routeOptions.findIndex((route) => getRouteKey(route) === selectedRouteKey) : -1;
  const activeRouteIndex = Math.max(0, selectedIndex);
  const activeRoute = routeOptions[activeRouteIndex] ?? null;

  const resetRouteChoice = useCallback(() => {
    setSelectedRouteKey(null);
    setChooserOpen(false);
    setExpanded(false);
  }, []);

  const toggleStation = useCallback((stationId: string) => {
    resetRouteChoice();
    setSelectedStationIds((current) => toggleStationSelection(current, stationId));
  }, [resetRouteChoice]);

  const selectPair = useCallback((fromStationId: string, toStationId: string) => {
    resetRouteChoice();
    setSelectedStationIds([fromStationId, toStationId]);
  }, [resetRouteChoice]);

  const clearSelection = useCallback(() => {
    resetRouteChoice();
    setSelectedStationIds([]);
  }, [resetRouteChoice]);

  const chooseRoute = useCallback((route: RouteResult) => setSelectedRouteKey(getRouteKey(route)), []);

  const toggleChooser = useCallback(() => {
    setExpanded(true);
    setChooserOpen((open) => !open);
  }, []);

  const closeChooser = useCallback(() => setChooserOpen(false), []);

  return {
    selectedStationIds,
    routeOptions,
    activeRoute,
    activeRouteIndex,
    chooserOpen,
    toggleStation,
    selectPair,
    clearSelection,
    chooseRoute,
    toggleChooser,
    closeChooser
  };
}

export type RouteSelection = ReturnType<typeof useRouteSelection>;
