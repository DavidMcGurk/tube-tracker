import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { findRoutes } from '../data/network';
import { getRouteKey, toggleStationSelection } from '../lib/map-interactions';
import type { RouteResult } from '../lib/types';

const COLLAPSED_ROUTE_COUNT = 2;
const EXPANDED_ROUTE_COUNT = 30;
const NO_ROUTES: RouteResult[] = [];

/** Selected journey endpoints, the route options between them, and which option the user picked. */
export function useRouteSelection() {
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([]);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  // Once alternatives have been shown, keep the full list so a chosen route keeps its number after hiding them.
  const [expanded, setExpanded] = useState(false);

  const [startId, endId] = selectedStationIds;
  // Routes are found in a render after the tap's own, so the station shows as chosen at once even when finding (and
  // first drawing) a long route takes a while on a slow phone. Until that render catches up, no route is offered.
  const routeStartId = useDeferredValue(startId);
  const routeEndId = useDeferredValue(endId);
  const routesFound = useMemo<RouteResult[]>(
    () => (routeStartId && routeEndId ? findRoutes(routeStartId, routeEndId, expanded ? EXPANDED_ROUTE_COUNT : COLLAPSED_ROUTE_COUNT) : []),
    [routeStartId, routeEndId, expanded]
  );
  const routeOptions = routeStartId === startId && routeEndId === endId ? routesFound : NO_ROUTES;
  /** Both stations are chosen and their routes are about to be offered. */
  const routesPending = Boolean(startId && endId) && (routeStartId !== startId || routeEndId !== endId);
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

  const clearSelection = useCallback(() => {
    resetRouteChoice();
    setSelectedStationIds([]);
  }, [resetRouteChoice]);

  /** Puts back an earlier selection, e.g. undoing the two clicks of a double click. */
  const restoreSelection = useCallback((stationIds: readonly string[]) => {
    resetRouteChoice();
    setSelectedStationIds([...stationIds]);
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
    routesPending,
    activeRoute,
    activeRouteIndex,
    chooserOpen,
    toggleStation,
    clearSelection,
    restoreSelection,
    chooseRoute,
    toggleChooser,
    closeChooser
  };
}

export type RouteSelection = ReturnType<typeof useRouteSelection>;
