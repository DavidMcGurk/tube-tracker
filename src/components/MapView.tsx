import { useMemo, useRef, useState } from 'react';
import { getStationById } from '../data/network';
import type { RouteSelection } from '../hooks/useRouteSelection';
import { getLineName } from '../lib/route-format';
import type { Progress, ResolvedTheme, RouteResult } from '../lib/types';
import { useMapDecorations } from '../map/useMapDecorations';
import { useMapGestures } from '../map/useMapGestures';
import { useMapViewport } from '../map/useMapViewport';
import { useReferenceMapSvg } from '../map/useReferenceMapSvg';
import { MapToolbar } from './MapToolbar';
import { RouteActionBar } from './RouteActionBar';

interface MapViewProps {
  progress: Progress;
  selection: RouteSelection;
  onRecordRoute: (route: RouteResult) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  resolvedTheme: ResolvedTheme;
  onToggleTheme: () => void;
}

export function MapView({ progress, selection, onRecordRoute, fullscreen, onToggleFullscreen, resolvedTheme, onToggleTheme }: MapViewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { markup, error: mapLoadError } = useReferenceMapSvg();
  const viewport = useMapViewport({ viewportRef, svgMarkup: markup, fullscreen });
  const [inspectedStationId, setInspectedStationId] = useState<string | null>(null);
  const { activeRoute, selectedStationIds } = selection;

  const newRouteSectionIds = useMemo(() => {
    const travelled = new Set(progress.travelledSegmentIDs);
    return activeRoute?.sections.filter((section) => !travelled.has(section.id)).map((section) => section.id) ?? [];
  }, [activeRoute, progress.travelledSegmentIDs]);

  const decorations = useMapDecorations({
    viewportRef,
    svgMarkup: markup,
    progress,
    selectedStationIds,
    previewSectionIds: newRouteSectionIds
  });

  const gestures = useMapGestures({
    onStationActivate: (stationId) => {
      setInspectedStationId(null);
      selection.toggleStation(stationId);
    },
    onStationInspect: setInspectedStationId,
    onStationDoubleClick: (stationId) => {
      setInspectedStationId(stationId);
      selection.clearSelection();
    },
    onStationDragSelect: (fromStationId, toStationId) => {
      setInspectedStationId(null);
      selection.selectPair(fromStationId, toStationId);
    },
    onStationHover: decorations.setHoveredStation
  });

  const inspectedStation = inspectedStationId ? getStationById(inspectedStationId) : undefined;

  return (
    <main className={`map-main mx-auto max-w-6xl px-4 pb-10${fullscreen ? ' is-fullscreen' : ''}`}>
      <div className="map-card rounded-3xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <MapToolbar
          onClear={selection.clearSelection}
          zoom={viewport.zoom}
          canZoomIn={viewport.canZoomIn}
          canZoomOut={viewport.canZoomOut}
          onZoomIn={viewport.zoomIn}
          onZoomOut={viewport.zoomOut}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          resolvedTheme={resolvedTheme}
          onToggleTheme={onToggleTheme}
          showNewRouteLegend={newRouteSectionIds.length > 0}
        />

        <div
          ref={viewportRef}
          className="tube-map-viewport overflow-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-700"
          {...gestures}
          onScroll={viewport.handleScroll}
          aria-label="Interactive London transport map. Tap station names or markers to select; drag empty space to pan."
          dangerouslySetInnerHTML={{ __html: markup }}
        />
        {inspectedStation && (
          <div role="status" className="map-inspection-panel mt-3 flex items-center justify-between gap-3 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800">
            <div>
              <p className="font-semibold">{inspectedStation.name}</p>
              <p className="text-slate-600 dark:text-slate-300">{inspectedStation.lines.map(getLineName).join(' · ')}</p>
            </div>
            <button
              className="min-h-11 min-w-11 rounded-full border border-slate-300 dark:border-slate-600"
              onClick={() => setInspectedStationId(null)}
              aria-label="Close map details"
            >
              ×
            </button>
          </div>
        )}
        {!markup && !mapLoadError && <p role="status" className="mt-3 text-sm text-slate-500 dark:text-slate-300">Loading network map...</p>}
        {mapLoadError && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">Unable to load the network map: {mapLoadError}</p>
        )}

        {activeRoute && (
          <RouteActionBar
            selectedStationIds={selectedStationIds}
            routeOptions={selection.routeOptions}
            activeRoute={activeRoute}
            activeRouteIndex={selection.activeRouteIndex}
            chooserOpen={selection.chooserOpen}
            progress={progress}
            onRecord={() => onRecordRoute(activeRoute)}
            onClear={selection.clearSelection}
            onChooseRoute={selection.chooseRoute}
            onToggleChooser={selection.toggleChooser}
          />
        )}
      </div>
    </main>
  );
}
