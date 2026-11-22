import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getStationById } from '../data/network';
import type { RouteSelection } from '../hooks/useRouteSelection';
import { formatMapZoom } from '../lib/map-zoom';
import { getLineName } from '../lib/route-format';
import type { Progress, ProgressStyle, ResolvedTheme, RouteResult } from '../lib/types';
import { useMapDecorations } from '../map/useMapDecorations';
import { useMapGestures } from '../map/useMapGestures';
import { useMapViewport } from '../map/useMapViewport';
import { useMapZoomGestures } from '../map/useMapZoomGestures';
import { useReferenceMapSvg } from '../map/useReferenceMapSvg';
import { MapToolbar } from './MapToolbar';
import { RouteActionBar } from './RouteActionBar';
import { UndoBar, type UndoBarProps } from './UndoBar';

/**
 * Where keyboard focus goes after the bar under the map is swapped, since the focused button goes with the old bar:
 * Undo after recording, Record after undoing, the map itself once the undo bar is dismissed.
 */
export type MapFocusRequest = 'undo' | 'record' | 'map';

interface MapViewProps {
  progress: Progress;
  selection: RouteSelection;
  onRecordRoute: (route: RouteResult) => void;
  /** While the journey just recorded can be undone: shown where the route actions are, when they aren't. */
  undo: UndoBarProps | null;
  focusRequest: MapFocusRequest | null;
  /** The request was carried out (or can't be), so it isn't repeated. */
  onFocusDone: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  resolvedTheme: ResolvedTheme;
  onToggleTheme: () => void;
  progressStyle: ProgressStyle;
}

export function MapView({ progress, selection, onRecordRoute, undo, focusRequest, onFocusDone, fullscreen, onToggleFullscreen, resolvedTheme, onToggleTheme, progressStyle }: MapViewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoomReadoutRef = useRef<HTMLSpanElement | null>(null);
  const { markup, error: mapLoadError } = useReferenceMapSvg();
  const viewport = useMapViewport({ viewportRef, svgMarkup: markup, fullscreen });
  const [inspectedStationId, setInspectedStationId] = useState<string | null>(null);
  const { activeRoute, selectedStationIds } = selection;
  /** The selection before each of the last two station clicks, so a double click can leave it unchanged. */
  const recentActivationsRef = useRef<Array<{ stationId: string; selectionBefore: readonly string[] }>>([]);

  // The whole route is shown, including track already travelled, so it can be followed end to end.
  const routeLinkIds = useMemo(() => activeRoute?.links.map((link) => link.id) ?? [], [activeRoute]);

  const decorations = useMapDecorations({
    viewportRef,
    svgMarkup: markup,
    progress,
    selectedStationIds,
    previewLinkIds: routeLinkIds,
    progressStyle,
    resolvedTheme
  });

  const { cancelInteractions, ...gestureHandlers } = useMapGestures({
    onStationActivate: (stationId) => {
      recentActivationsRef.current = [...recentActivationsRef.current, { stationId, selectionBefore: selectedStationIds }].slice(-2);
      setInspectedStationId(null);
      selection.toggleStation(stationId);
    },
    onStationInspect: setInspectedStationId,
    onStationDoubleClick: (stationId) => {
      // Undo the two clicks that make up the double click, then show the station's details.
      const [first] = recentActivationsRef.current;
      if (first?.stationId === stationId) selection.restoreSelection(first.selectionBefore);
      setInspectedStationId(stationId);
    },
    onStationHover: decorations.setHoveredStation
  });

  useMapZoomGestures({
    viewportRef,
    svgMarkup: markup,
    getZoom: viewport.getZoom,
    onTouchPinchStart: cancelInteractions,
    onTouchPinchEnd: cancelInteractions,
    // Updated directly so a pinch does not re-render the map view every frame.
    onPreview: (zoom) => {
      if (zoomReadoutRef.current) zoomReadoutRef.current.textContent = formatMapZoom(zoom);
    },
    onCommit: viewport.commitZoom
  });

  useLayoutEffect(() => {
    if (focusRequest !== 'map') return;
    viewportRef.current?.focus({ preventScroll: true });
    onFocusDone();
  }, [focusRequest, onFocusDone]);

  const inspectedStation = inspectedStationId ? getStationById(inspectedStationId) : undefined;
  const canClear = selectedStationIds.length > 0 || inspectedStationId !== null;
  const handleClear = () => {
    selection.clearSelection();
    setInspectedStationId(null);
  };

  return (
    <main className={`map-main mx-auto max-w-6xl px-4 pb-10${fullscreen ? ' is-fullscreen' : ''}`}>
      <div className="map-card rounded-3xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <MapToolbar
          canClear={canClear}
          onClear={handleClear}
          zoom={viewport.zoom}
          zoomReadoutRef={zoomReadoutRef}
          canZoomIn={viewport.canZoomIn}
          canZoomOut={viewport.canZoomOut}
          onZoomIn={viewport.zoomIn}
          onZoomOut={viewport.zoomOut}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          resolvedTheme={resolvedTheme}
          onToggleTheme={onToggleTheme}
          progressStyle={progressStyle}
        />

        <div
          ref={viewportRef}
          className="tube-map-viewport overflow-auto rounded-2xl border border-slate-200 bg-(--tt-map-background) dark:border-slate-700"
          {...gestureHandlers}
          onScroll={viewport.handleScroll}
          role="region"
          aria-label="Interactive London transport map. Tap a start and an end station to choose a journey; drag to pan; pinch to zoom."
          // Focusable from script only: where focus goes when the undo bar under it is dismissed.
          tabIndex={-1}
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

        {activeRoute ? (
          <RouteActionBar
            selectedStationIds={selectedStationIds}
            routeOptions={selection.routeOptions}
            activeRoute={activeRoute}
            activeRouteIndex={selection.activeRouteIndex}
            chooserOpen={selection.chooserOpen}
            progress={progress}
            onRecord={() => onRecordRoute(activeRoute)}
            onClear={handleClear}
            onChooseRoute={selection.chooseRoute}
            onToggleChooser={selection.toggleChooser}
            focusOnMount={focusRequest === 'record'}
            onFocused={onFocusDone}
          />
        ) : (
          undo && <UndoBar {...undo} focusOnMount={focusRequest === 'undo'} onFocused={onFocusDone} />
        )}
      </div>
    </main>
  );
}
