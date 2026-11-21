import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react';
import { MOBILE_VIEWPORT_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { clampMapZoom, DEFAULT_MAP_ZOOM, DESKTOP_DEFAULT_MAP_ZOOM, MAX_MAP_ZOOM, MIN_MAP_ZOOM, stepMapZoom } from '../lib/map-interactions';
import { getScrollPositionToCenterBounds } from '../lib/map-view';

export interface MapViewState {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

const MAP_VIEW_STORAGE_KEY = 'tube-tracker-map-view-v2';
const ZOOM_STEP = 0.25;

/** The last view, kept in memory so it survives the map unmounting when switching tabs. */
let lastMapView: MapViewState | null = null;

function readStoredMapView(): MapViewState | null {
  try {
    const stored = sessionStorage.getItem(MAP_VIEW_STORAGE_KEY);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (
      typeof value === 'object'
      && value !== null
      && 'zoom' in value && typeof value.zoom === 'number' && Number.isFinite(value.zoom)
      && 'scrollLeft' in value && typeof value.scrollLeft === 'number' && Number.isFinite(value.scrollLeft)
      && 'scrollTop' in value && typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop)
    ) {
      return { zoom: clampMapZoom(value.zoom), scrollLeft: value.scrollLeft, scrollTop: value.scrollTop };
    }
    console.warn('Ignoring invalid saved map view state');
  } catch (error) {
    console.error('Unable to restore the saved map view', error);
  }
  return null;
}

function storeMapView(view: MapViewState) {
  try {
    sessionStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch (error) {
    console.error('Unable to save the current map view', error);
  }
}

function centreScroll(viewport: HTMLElement) {
  viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
  viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
}

interface MapViewportOptions {
  viewportRef: RefObject<HTMLDivElement | null>;
  svgMarkup: string;
  fullscreen: boolean;
}

/**
 * Owns map zoom (rendered as the SVG's width) and scroll position: the first view centres on Zone 1 on phones or on
 * the whole map on larger screens; afterwards the view is preserved across tab switches and page reloads.
 */
export function useMapViewport({ viewportRef, svgMarkup, fullscreen }: MapViewportOptions) {
  const isMobileViewport = useMediaQuery(MOBILE_VIEWPORT_QUERY);
  const [initialView] = useState(() => lastMapView ?? readStoredMapView());
  const [zoom, setZoom] = useState(() => initialView?.zoom
    ?? (window.matchMedia(MOBILE_VIEWPORT_QUERY).matches ? DEFAULT_MAP_ZOOM : DESKTOP_DEFAULT_MAP_ZOOM));
  const viewRef = useRef<MapViewState>(initialView ?? { zoom, scrollLeft: 0, scrollTop: 0 });
  const laidOutViewportRef = useRef<HTMLDivElement | null>(null);
  const hasInitialViewRef = useRef(initialView !== null);
  /** The map point at the centre of the viewport, as fractions of the map, kept so resizes can preserve it. */
  const centreRef = useRef<{ x: number; y: number } | null>(null);

  const recordCentre = useCallback((viewport: HTMLElement) => {
    if (viewport.scrollWidth === 0 || viewport.scrollHeight === 0) return;
    centreRef.current = {
      x: (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight
    };
  }, []);

  useEffect(() => {
    const saveView = () => storeMapView(viewRef.current);
    // iOS may discard a backgrounded page without firing pagehide, so also save when the page is hidden.
    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') saveView();
    };
    window.addEventListener('pagehide', saveView);
    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => {
      window.removeEventListener('pagehide', saveView);
      document.removeEventListener('visibilitychange', saveWhenHidden);
      lastMapView = viewRef.current;
      // Also persist on unmount, so reloading from another tab keeps the view.
      saveView();
    };
  }, []);

  // When the viewport's width changes (full screen, rotation, window resize) the map rescales with it, so keep the
  // same point in the centre instead of letting the scroll offset drift. Height-only changes (a panel opening) don't
  // rescale the map, so the map stays put rather than shifting under the pointer.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !svgMarkup) return;
    let lastWidth = viewport.clientWidth;
    const observer = new ResizeObserver(() => {
      if (viewport.clientWidth === lastWidth) return;
      lastWidth = viewport.clientWidth;
      const centre = centreRef.current;
      if (!centre) return;
      viewport.scrollLeft = centre.x * viewport.scrollWidth - viewport.clientWidth / 2;
      viewport.scrollTop = centre.y * viewport.scrollHeight - viewport.clientHeight / 2;
      viewRef.current = { zoom: viewRef.current.zoom, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    });
    // The border box ignores padding changes (e.g. room left for the phone route bar).
    observer.observe(viewport, { box: 'border-box' });
    return () => observer.disconnect();
  }, [viewportRef, svgMarkup]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const svg = viewport?.querySelector('svg');
    if (!viewport || !svg) return;

    svg.classList.add('tube-map__svg');
    svg.style.width = `${zoom * 100}%`;
    svg.style.height = 'auto';

    const previousView = viewRef.current;
    const isFirstLayout = laidOutViewportRef.current !== viewport;
    const shouldCentreDesktopMap = isFirstLayout && !hasInitialViewRef.current && !isMobileViewport;
    if (isFirstLayout) {
      if (hasInitialViewRef.current) {
        viewport.scrollLeft = previousView.scrollLeft;
        viewport.scrollTop = previousView.scrollTop;
      } else if (isMobileViewport) {
        const zoneOne = svg.querySelector<SVGGElement>('#bg .zone1-background');
        if (zoneOne) {
          const viewportBounds = viewport.getBoundingClientRect();
          const zoneOneBounds = zoneOne.getBoundingClientRect();
          const position = getScrollPositionToCenterBounds(
            { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop },
            { left: viewportBounds.left, top: viewportBounds.top, width: viewport.clientWidth, height: viewport.clientHeight },
            { left: zoneOneBounds.left, top: zoneOneBounds.top, width: zoneOneBounds.width, height: zoneOneBounds.height },
            { width: viewport.scrollWidth, height: viewport.scrollHeight }
          );
          viewport.scrollLeft = position.scrollLeft;
          viewport.scrollTop = position.scrollTop;
        } else {
          centreScroll(viewport);
        }
      } else {
        centreScroll(viewport);
      }
      laidOutViewportRef.current = viewport;
      hasInitialViewRef.current = true;
    } else if (previousView.zoom !== zoom) {
      // Keep the centre of the viewport fixed while zooming.
      const zoomRatio = zoom / previousView.zoom;
      viewport.scrollLeft = (previousView.scrollLeft + viewport.clientWidth / 2) * zoomRatio - viewport.clientWidth / 2;
      viewport.scrollTop = (previousView.scrollTop + viewport.clientHeight / 2) * zoomRatio - viewport.clientHeight / 2;
    }

    viewRef.current = { zoom, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    recordCentre(viewport);
    if (shouldCentreDesktopMap) {
      // The desktop layout settles after the first frame, so centre again once it has.
      window.requestAnimationFrame(() => {
        if (viewportRef.current !== viewport || viewRef.current.zoom !== zoom) return;
        centreScroll(viewport);
        viewRef.current = { zoom, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
        recordCentre(viewport);
      });
    }
  }, [viewportRef, fullscreen, zoom, svgMarkup, isMobileViewport, recordCentre]);

  /**
   * Applies a zoom chosen by a gesture, with the scroll offset that keeps its anchor in place. The view is recorded
   * before React re-renders so the layout effect sees no zoom change and does not re-anchor at the centre.
   */
  const commitZoom = useCallback((nextZoom: number, scrollLeft: number, scrollTop: number) => {
    const viewport = viewportRef.current;
    const svg = viewport?.querySelector('svg');
    if (!viewport || !svg) return;
    svg.style.width = `${nextZoom * 100}%`;
    viewport.scrollLeft = scrollLeft;
    viewport.scrollTop = scrollTop;
    viewRef.current = { zoom: nextZoom, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    recordCentre(viewport);
    setZoom(nextZoom);
  }, [viewportRef, recordCentre]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    viewRef.current = {
      zoom: viewRef.current.zoom,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop
    };
    recordCentre(event.currentTarget);
  }, [recordCentre]);

  return {
    zoom,
    canZoomIn: zoom < MAX_MAP_ZOOM,
    canZoomOut: zoom > MIN_MAP_ZOOM,
    zoomIn: useCallback(() => setZoom((current) => stepMapZoom(current, ZOOM_STEP)), []),
    zoomOut: useCallback(() => setZoom((current) => stepMapZoom(current, -ZOOM_STEP)), []),
    /** The zoom the SVG is currently laid out at. */
    getZoom: useCallback(() => viewRef.current.zoom, []),
    commitZoom,
    handleScroll
  };
}
