import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { findRoutes, getStationById, lines, stations } from './data/network';
import { addRouteToProgress, EMPTY_PROGRESS, getStationState, routeIsAlreadyComplete, summariseProgress } from './lib/progress';
import { loadProgress, loadTheme, saveProgress, saveTheme } from './lib/storage';
import {
  clampMapZoom,
  createStationLabelIndex,
  DEFAULT_MAP_ZOOM,
  formatRouteEndpoints,
  hasAlternativeRoutes,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  normalizeStationLabel,
  stepMapZoom,
  toggleStationSelection
} from './lib/map-interactions';
import type { Progress, RouteResult } from './lib/types';
import referenceMapUrl from './assets/reference-map-clean.svg?url';

const lineLookup = Object.fromEntries(lines.map((line) => [line.id, line]));
const interchangeName = 'Bank–Monument interchange';
function getRouteLineNames(route: RouteResult) {
  const lineIds = route.segments.reduce<string[]>((result, section) => {
    if (result.at(-1) !== section.lineId) result.push(section.lineId);
    return result;
  }, []);
  return lineIds.map((lineId) => lineId === 'interchange' ? interchangeName : lineLookup[lineId]?.name ?? lineId);
}

function getRouteTransferNames(route: RouteResult) {
  return route.transferStations.map((stationId) => getStationById(stationId)?.name ?? stationId);
}

const stationsByMapLabel = createStationLabelIndex(stations);
const stationMarkerLabelEntries = [...stationsByMapLabel.entries()].sort(([a], [b]) => b.length - a.length);
const stationMarkerAliases: Record<string, string> = {
  bankmonument: 'bank',
  heathrow4: 'heathrowterminal4',
  heathrow23: 'heathrowterminals23',
  heathrow5: 'heathrowterminal5'
};
const stationMarkerLineSuffixes = [
  ...new Map(lines.flatMap((line) => [
    [normalizeStationLabel(line.id), line.id],
    [normalizeStationLabel(line.name), line.id]
  ])).entries()
].sort(([a], [b]) => b.length - a.length);
const stationMarkerSuffixes = [
  'elizabethbase', 'deepbase', 'overground', 'surface', 'deep', 'tube', 'base', 'mid', 'top', 'nr', 'cr', 'osi', 'hnc'
].sort((a, b) => b.length - a.length);
const stationMarkerSuffixLineAliases: Record<string, string> = { hnc: 'hammersmith_city' };

type TabName = 'map' | 'stats' | 'settings';
interface MapViewState {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

interface MapInspection {
  title: string;
  details: string;
}

const mapViewStorageKey = 'tube-tracker-map-view';

function readMapViewState(): MapViewState | null {
  try {
    const stored = sessionStorage.getItem(mapViewStorageKey);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (
      typeof value === 'object'
      && value !== null
      && 'zoom' in value
      && typeof value.zoom === 'number'
      && Number.isFinite(value.zoom)
      && 'scrollLeft' in value
      && typeof value.scrollLeft === 'number'
      && Number.isFinite(value.scrollLeft)
      && 'scrollTop' in value
      && typeof value.scrollTop === 'number'
      && Number.isFinite(value.scrollTop)
    ) {
      return {
        zoom: clampMapZoom(value.zoom),
        scrollLeft: value.scrollLeft,
        scrollTop: value.scrollTop
      };
    }
    console.warn('Ignoring invalid saved map view state');
  } catch (error) {
    console.error('Unable to restore the saved map view', error);
  }
  return null;
}

function getMarkerSuffixLineIds(suffix: string) {
  const lineIds: string[] = [];
  let remaining = suffix;

  while (remaining) {
    const lineSuffix = stationMarkerLineSuffixes.find(([value]) => remaining.startsWith(value));
    if (lineSuffix) {
      lineIds.push(lineSuffix[1]);
      remaining = remaining.slice(lineSuffix[0].length);
      continue;
    }

    const otherSuffix = stationMarkerSuffixes.find((value) => remaining.startsWith(value));
    if (!otherSuffix) return null;
    const aliasedLineId = stationMarkerSuffixLineAliases[otherSuffix];
    if (aliasedLineId) lineIds.push(aliasedLineId);
    remaining = remaining.slice(otherSuffix.length);
  }

  return lineIds;
}

function getMarkerStation(marker: SVGElement) {
  const normalizedId = normalizeStationLabel(marker.id);
  const exactName = stationMarkerAliases[normalizedId] ?? normalizedId;
  const exactCandidates = stationsByMapLabel.get(exactName) ?? [];
  if (exactCandidates.length === 1) return exactCandidates[0];

  const href = marker.getAttribute('href')
    ?? marker.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    ?? '';
  const symbolName = normalizeStationLabel(href.replace(/^#/, '').replace(/^st/, ''));
  const symbolLineId = lines.find((line) =>
    symbolName.endsWith(normalizeStationLabel(line.id))
    || symbolName.endsWith(normalizeStationLabel(line.name))
  )?.id;
  const matchingLabel = stationMarkerLabelEntries.find(([label]) => normalizedId.startsWith(label));
  if (matchingLabel) {
    const suffixLineIds = getMarkerSuffixLineIds(normalizedId.slice(matchingLabel[0].length));
    if (suffixLineIds) {
      const requiredLineIds = symbolLineId ? [...suffixLineIds, symbolLineId] : suffixLineIds;
      return matchingLabel[1].find((station) =>
        requiredLineIds.every((lineId) => station.lines.includes(lineId))
      );
    }
  }

  for (const [suffix, lineId] of stationMarkerLineSuffixes) {
    if (!normalizedId.endsWith(suffix)) continue;
    const markerName = normalizedId.slice(0, -suffix.length);
    const aliasName = stationMarkerAliases[markerName];
    if (!aliasName) continue;
    const candidates = stationsByMapLabel.get(aliasName) ?? [];
    if (candidates.length === 1) return candidates[0];
    return candidates.find((station) => station.lines.includes(lineId));
  }

  for (const suffix of stationMarkerSuffixes) {
    if (!normalizedId.endsWith(suffix)) continue;
    const markerName = normalizedId.slice(0, -suffix.length);
    const aliasName = stationMarkerAliases[markerName];
    const candidates = aliasName ? stationsByMapLabel.get(aliasName) ?? [] : [];
    if (candidates.length === 1) return candidates[0];
  }

  return undefined;
}

function getClosestStationId(label: SVGTextElement, candidates: typeof stations, markers: SVGElement[]) {
  if (candidates.length === 1) return candidates[0].id;

  const labelBounds = label.getBoundingClientRect();
  const labelX = labelBounds.left + labelBounds.width / 2;
  const labelY = labelBounds.top + labelBounds.height / 2;
  let closestStationId: string | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const marker of markers) {
    const stationId = marker.getAttribute('data-app-station-id');
    if (!stationId || !candidates.some((station) => station.id === stationId)) continue;
    const markerBounds = marker.getBoundingClientRect();
    const dx = markerBounds.left + markerBounds.width / 2 - labelX;
    const dy = markerBounds.top + markerBounds.height / 2 - labelY;
    const distance = dx * dx + dy * dy;
    if (distance < closestDistance) {
      closestStationId = stationId;
      closestDistance = distance;
    }
  }

  return closestStationId;
}

function ThemeIcon({ resolvedTheme }: { resolvedTheme: 'light' | 'dark' }) {
  return resolvedTheme === 'dark' ? (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-5 w-5">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-5 w-5">
      <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />
    </svg>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<TabName>('map');
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  const [savedMapView] = useState(readMapViewState);
  const initialMapZoom = savedMapView?.zoom ?? DEFAULT_MAP_ZOOM;
  const [mapZoom, setMapZoom] = useState(initialMapZoom);
  const [hoveredStationId, setHoveredStationId] = useState<string | null>(null);
  const [mapInspection, setMapInspection] = useState<MapInspection | null>(null);
  const [routeChooserOpen, setRouteChooserOpen] = useState(false);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [referenceMapSvg, setReferenceMapSvg] = useState('');
  const [mapLoadError, setMapLoadError] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapViewRef = useRef<MapViewState>(savedMapView ?? { zoom: initialMapZoom, scrollLeft: 0, scrollTop: 0 });
  const mapViewportRef = useRef<HTMLDivElement | null>(null);
  const hasInitialMapViewRef = useRef(savedMapView !== null);
  const panRef = useRef<{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const stationDragRef = useRef<{
    pointerId: number;
    stationId: string;
    x: number;
    y: number;
    dragged: boolean;
  } | null>(null);
  const pressRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const boot = async () => {
      const [storedProgress, storedTheme] = await Promise.all([loadProgress(), loadTheme()]);
      setProgress(storedProgress);
      setTheme(storedTheme);
    };
    void boot();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const nextTheme = theme === 'system' ? (mediaQuery.matches ? 'dark' : 'light') : theme;
      root.dataset.theme = nextTheme;
      setResolvedTheme(nextTheme);
    };

    applyTheme();
    void saveTheme(theme);
    if (theme === 'system') {
      mediaQuery.addEventListener('change', applyTheme);
      return () => mediaQuery.removeEventListener('change', applyTheme);
    }
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(referenceMapUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Map request failed with status ${response.status}`);
        return response.text();
      })
      .then((svg) => {
        if (!svg.includes('<svg')) throw new Error('The map asset did not contain an SVG document');
        setReferenceMapSvg(svg);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMapLoadError(error instanceof Error ? error.message : 'Unable to load the map');
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const saveMapView = () => {
      try {
        sessionStorage.setItem(mapViewStorageKey, JSON.stringify(mapViewRef.current));
      } catch (error) {
        console.error('Unable to save the current map view', error);
      }
    };
    window.addEventListener('pagehide', saveMapView);
    return () => window.removeEventListener('pagehide', saveMapView);
  }, []);

  useEffect(() => {
    if (!resetConfirmationOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setResetConfirmationOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [resetConfirmationOpen]);

  useLayoutEffect(() => {
    const viewport = mapRef.current;
    const svg = viewport?.querySelector('svg');
    if (activeTab !== 'map' || !viewport || !svg) return;

    svg.classList.add('tube-map__svg');
    svg.style.width = `${mapZoom * 100}%`;
    svg.style.height = 'auto';

    const previousView = mapViewRef.current;
    if (mapViewportRef.current !== viewport) {
      if (!hasInitialMapViewRef.current && window.matchMedia('(max-width: 640px)').matches) {
        viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
        viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
      } else {
        viewport.scrollLeft = previousView.scrollLeft;
        viewport.scrollTop = previousView.scrollTop;
      }
      mapViewportRef.current = viewport;
      hasInitialMapViewRef.current = true;
    } else if (previousView.zoom !== mapZoom) {
      const zoomRatio = mapZoom / previousView.zoom;
      viewport.scrollLeft = (previousView.scrollLeft + viewport.clientWidth / 2) * zoomRatio - viewport.clientWidth / 2;
      viewport.scrollTop = (previousView.scrollTop + viewport.clientHeight / 2) * zoomRatio - viewport.clientHeight / 2;
    }

    mapViewRef.current = { zoom: mapZoom, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
  }, [activeTab, mapFullscreen, mapZoom, referenceMapSvg]);

  useEffect(() => {
    const svg = mapRef.current?.querySelector('svg');
    if (!svg) return;

    const attachStationInteraction = (element: SVGElement, stationId: string) => {
      const station = getStationById(stationId);
      if (!station) return;

      element.setAttribute('data-app-station-id', stationId);
      element.setAttribute('role', 'button');
      element.setAttribute('tabindex', '0');
      element.setAttribute('aria-label', `Select station ${station.name}`);
      element.setAttribute('data-app-selected', String(selectedStationIds.includes(stationId)));
      element.setAttribute('data-app-hovered', String(hoveredStationId === stationId));
      element.setAttribute('data-app-state', getStationState(stationId, progress));
    };

    const stationMarkers = [...svg.querySelectorAll<SVGElement>('#station_nodes use[id]')];
    let hitAreaGroup = svg.querySelector<SVGGElement>('#app-station-hit-areas');
    const stationNodes = svg.querySelector<SVGGElement>('#station_nodes');
    if (!hitAreaGroup && stationNodes) {
      hitAreaGroup = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      hitAreaGroup.id = 'app-station-hit-areas';
      hitAreaGroup.setAttribute('aria-hidden', 'true');
      stationNodes.insertBefore(hitAreaGroup, stationNodes.firstChild);
      const stationNodesMatrix = stationNodes.getScreenCTM();
      if (stationNodesMatrix) {
        for (const marker of stationMarkers) {
          const station = getMarkerStation(marker);
          if (!station) continue;

          const bounds = marker.getBoundingClientRect();
          const center = svg.createSVGPoint();
          center.x = bounds.left + bounds.width / 2;
          center.y = bounds.top + bounds.height / 2;
          const position = center.matrixTransform(stationNodesMatrix.inverse());
          const hitArea = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
          hitArea.setAttribute('class', 'app-station-hit-area');
          hitArea.setAttribute('cx', String(position.x));
          hitArea.setAttribute('cy', String(position.y));
          hitArea.setAttribute('r', '18');
          hitArea.setAttribute('data-app-station-id', station.id);
          hitArea.setAttribute('data-app-station-hit-area', marker.id);
          hitAreaGroup.appendChild(hitArea);
        }
      }

      const bankStation = stationsByMapLabel.get('bank')?.[0];
      const monumentStation = stationsByMapLabel.get('monument')?.[0];
      const bankMonumentHub = svg.querySelector<SVGGElement>('#Bank_Monument_hub');
      if (bankStation && monumentStation && bankMonumentHub) {
        for (const target of [
          { station: bankStation, x: 7.25, y: 0 },
          { station: monumentStation, x: 20.25, y: 27 }
        ]) {
          const hitArea = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
          hitArea.setAttribute('class', 'app-station-hit-area');
          hitArea.setAttribute('cx', String(target.x));
          hitArea.setAttribute('cy', String(target.y));
          hitArea.setAttribute('r', '18');
          hitArea.setAttribute('data-app-station-id', target.station.id);
          hitArea.setAttribute('data-app-station-hit-area', `Bank_Monument_${target.station.id}`);
          bankMonumentHub.appendChild(hitArea);
        }
      }
    }

    for (const marker of stationMarkers) {
      const station = getMarkerStation(marker);
      if (station) attachStationInteraction(marker, station.id);
    }
    svg.querySelectorAll<SVGElement>('#station_nodes g[id]').forEach((marker) => {
      const station = getMarkerStation(marker);
      if (station) attachStationInteraction(marker, station.id);
    });

    svg.querySelectorAll<SVGTextElement>('#text text').forEach((label) => {
      const candidates = stationsByMapLabel.get(normalizeStationLabel(label.textContent ?? ''));
      if (!candidates?.length) return;
      const stationId = getClosestStationId(label, candidates, stationMarkers);
      if (stationId) attachStationInteraction(label, stationId);
    });
  }, [activeTab, hoveredStationId, mapZoom, progress, referenceMapSvg, selectedStationIds]);

  useEffect(() => () => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    if (suppressClickTimeoutRef.current) clearTimeout(suppressClickTimeoutRef.current);
  }, []);

  const routePreview = useMemo<RouteResult | null>(() => {
    if (selectedStationIds.length < 2) return null;
    const [startId, endId] = selectedStationIds;
    if (!startId || !endId) return null;
    return findRoutes(startId, endId, 1)[0] ?? null;
  }, [selectedStationIds]);
  const routeOptions = useMemo<RouteResult[]>(() => {
    if (selectedStationIds.length < 2) return [];
    const [startId, endId] = selectedStationIds;
    if (!startId || !endId) return [];
    return findRoutes(startId, endId, routeChooserOpen ? 30 : 2);
  }, [routeChooserOpen, selectedStationIds]);
  const routeEndpoints = useMemo(() => {
    const [startId, endId] = selectedStationIds;
    if (!startId || !endId) return '';
    const startName = getStationById(startId)?.name;
    const endName = getStationById(endId)?.name;
    return formatRouteEndpoints(startName, endName);
  }, [selectedStationIds]);

  const stats = useMemo(() => summariseProgress(progress), [progress]);
  const sortedLineProgress = useMemo(
    () => [...stats.lineProgress].sort((a, b) => b.completion - a.completion || a.name.localeCompare(b.name)),
    [stats.lineProgress]
  );

  const commitRoute = async (route: RouteResult) => {
    if (selectedStationIds.length < 2) return;
    const [startId, endId] = selectedStationIds;
    const nextProgress = addRouteToProgress(progress, route, startId, endId);
    if (JSON.stringify(progress) === JSON.stringify(nextProgress)) {
      setRouteChooserOpen(false);
      return;
    }
    setProgress(nextProgress);
    await saveProgress(nextProgress);
    setSelectedStationIds([]);
    setRouteChooserOpen(false);
  };

  const handleRecordRoute = () => {
    if (routePreview) void commitRoute(routePreview);
  };

  const resetProgress = async () => {
    setProgress(EMPTY_PROGRESS);
    await saveProgress(EMPTY_PROGRESS);
    setSelectedStationIds([]);
    setRouteChooserOpen(false);
    setResetConfirmationOpen(false);
  };

  const handleStationClick = (stationId: string) => {
    setMapInspection(null);
    setRouteChooserOpen(false);
    setSelectedStationIds((current) => toggleStationSelection(current, stationId));
  };

  const handleMapClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      if (suppressClickTimeoutRef.current) clearTimeout(suppressClickTimeoutRef.current);
      suppressClickTimeoutRef.current = null;
      return;
    }
    const stationId = event.target.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id') ?? null;
    if (stationId) {
      handleStationClick(stationId);
    }
  };

  const inspectMapTarget = (target: Element) => {
    const stationId = target.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id');
    const station = stationId ? getStationById(stationId) : undefined;
    if (!station) return false;
    setMapInspection({
      title: station.name,
      details: station.lines.map((lineId) => lineLookup[lineId]?.name ?? lineId).join(' · ')
    });
    return true;
  };

  const handleMapDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    if (!inspectMapTarget(event.target)) return;
    event.preventDefault();
    setSelectedStationIds([]);
    setRouteChooserOpen(false);
  };

  const handleMapPointerOver = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const stationId = event.target.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id') ?? null;
    setHoveredStationId(stationId);
  };

  const handleMapPointerOut = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Element)) {
      setHoveredStationId(null);
      return;
    }
    const stationId = event.relatedTarget.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id') ?? null;
    setHoveredStationId(stationId);
  };

  const handleMapKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof Element)) return;
    const stationId = event.target.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id');
    if (!stationId) return;
    event.preventDefault();
    handleStationClick(stationId);
  };

  const handlePanStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const stationTarget = event.target.closest<SVGElement>('[data-app-station-id]');
    const stationId = stationTarget?.getAttribute('data-app-station-id');
    if (event.button === 0 && stationTarget && stationId) {
      const timer = setTimeout(() => {
        suppressClickRef.current = true;
        suppressClickTimeoutRef.current = setTimeout(() => {
          suppressClickRef.current = false;
          suppressClickTimeoutRef.current = null;
        }, 1000);
        inspectMapTarget(stationTarget);
      }, 550);
      pressRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer
      };
      stationDragRef.current = {
        pointerId: event.pointerId,
        stationId,
        x: event.clientX,
        y: event.clientY,
        dragged: false
      };
      return;
    }
    if (event.button !== 0) return;
    const viewport = event.currentTarget;
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
    event.preventDefault();
  };

  const handlePanMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const stationDrag = stationDragRef.current;
    if (stationDrag?.pointerId === event.pointerId && Math.hypot(event.clientX - stationDrag.x, event.clientY - stationDrag.y) > 10) {
      if (!stationDrag.dragged) {
        stationDrag.dragged = true;
        if (pressRef.current?.pointerId === event.pointerId) {
          clearTimeout(pressRef.current.timer);
          pressRef.current = null;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      const target = document.elementFromPoint(event.clientX, event.clientY);
      const destinationId = target?.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id') ?? null;
      setHoveredStationId(destinationId);
      event.preventDefault();
      return;
    }

    const press = pressRef.current;
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
      clearTimeout(press.timer);
      pressRef.current = null;
    }
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.y);
  };

  const handlePanEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const stationDrag = stationDragRef.current;
    if (stationDrag?.pointerId === event.pointerId) {
      stationDragRef.current = null;
      if (stationDrag.dragged) {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const destinationId = target?.closest<SVGElement>('[data-app-station-id]')?.getAttribute('data-app-station-id');
        if (destinationId && destinationId !== stationDrag.stationId) {
          setSelectedStationIds([stationDrag.stationId, destinationId]);
          setMapInspection(null);
          setRouteChooserOpen(false);
        }
        suppressClickRef.current = true;
        suppressClickTimeoutRef.current = setTimeout(() => {
          suppressClickRef.current = false;
          suppressClickTimeoutRef.current = null;
        }, 1000);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        return;
      }
    }

    if (pressRef.current?.pointerId === event.pointerId) {
      clearTimeout(pressRef.current.timer);
      pressRef.current = null;
    }
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    event.currentTarget.classList.remove('is-panning');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleMapScroll = (event: React.UIEvent<HTMLDivElement>) => {
    mapViewRef.current = {
      zoom: mapZoom,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop
    };
  };

  return (
    <div className="app-shell min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100" data-map-fullscreen={mapFullscreen}>
      <header className="border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <h1 className="text-xl font-semibold">Tube Tracker</h1>
          <div className="flex items-center gap-2">
            <button
              className="min-h-11 min-w-11 rounded-full border border-slate-300 p-2 dark:border-slate-700"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            >
              <ThemeIcon resolvedTheme={resolvedTheme} />
            </button>
          </div>
        </div>
      </header>

      <nav className="mx-auto flex max-w-6xl gap-2 px-4 py-4">
        {(['map', 'stats', 'settings'] as TabName[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`min-h-11 flex-1 rounded-xl px-4 py-2 text-sm font-medium ${activeTab === tab ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}
          >
            {tab === 'map' ? 'Map' : tab === 'stats' ? 'Statistics' : 'Settings'}
          </button>
        ))}
      </nav>

      {activeTab === 'map' && (
        <main className={`map-main mx-auto max-w-6xl px-4 pb-10${mapFullscreen ? ' is-fullscreen' : ''}`}>
          <div className="map-card rounded-3xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex flex-col gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2">
                <button className="min-h-11 rounded-full border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700" onClick={() => setSelectedStationIds([])}>
                  Clear
                </button>
                <button
                  className="min-h-11 min-w-11 flex-none rounded-full border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
                  onClick={() => setMapZoom((zoom) => stepMapZoom(zoom, -0.25))}
                  aria-label="Zoom out"
                  disabled={mapZoom <= MIN_MAP_ZOOM}
                >
                  −
                </button>
                <span className="inline-flex w-12 flex-none items-center justify-center self-center text-xs tabular-nums text-slate-500" aria-label={`Map zoom: ${mapZoom}×`}>
                  {mapZoom}×
                </span>
                <button
                  className="min-h-11 min-w-11 flex-none rounded-full border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
                  onClick={() => setMapZoom((zoom) => stepMapZoom(zoom, 0.25))}
                  aria-label="Zoom in"
                  disabled={mapZoom >= MAX_MAP_ZOOM}
                >
                  +
                </button>
                <button
                  className="min-h-11 min-w-11 rounded-full border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
                  onClick={() => setMapFullscreen((fullscreen) => !fullscreen)}
                  aria-label={mapFullscreen ? 'Exit full screen map' : 'View map full screen'}
                  aria-pressed={mapFullscreen}
                  title={mapFullscreen ? 'Exit full screen' : 'View full screen'}
                >
                  {mapFullscreen ? (
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-5 w-5">
                      <path d="M8 3v5H3m13-5v5h5M3 16h5v5m13-5h-5v5" />
                    </svg>
                  ) : (
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-5 w-5">
                      <path d="M3 8V3h5m8 0h5v5M21 16v5h-5M8 21H3v-5" />
                    </svg>
                  )}
                </button>
                <button
                  className="fullscreen-theme-control min-h-11 min-w-11 rounded-full border border-slate-300 p-2 dark:border-slate-700"
                  onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                  aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
                  title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
                >
                  <ThemeIcon resolvedTheme={resolvedTheme} />
                </button>
              </div>
            </div>

            <div
              ref={mapRef}
              className="tube-map-viewport overflow-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-700"
              onClick={handleMapClick}
              onDoubleClick={handleMapDoubleClick}
              onKeyDown={handleMapKeyDown}
              onPointerDown={handlePanStart}
              onPointerMove={handlePanMove}
              onPointerUp={handlePanEnd}
              onPointerCancel={handlePanEnd}
              onPointerOver={handleMapPointerOver}
              onPointerOut={handleMapPointerOut}
              onScroll={handleMapScroll}
              aria-label="Interactive London transport map. Tap station names or markers to select; drag empty space to pan."
              dangerouslySetInnerHTML={{ __html: referenceMapSvg }}
            >
            </div>
            {mapInspection && (
              <div role="status" className="map-inspection-panel mt-3 flex items-center justify-between gap-3 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800">
                <div>
                  <p className="font-semibold">{mapInspection.title}</p>
                  {mapInspection.details && <p className="text-slate-600 dark:text-slate-300">{mapInspection.details}</p>}
                </div>
                <button
                  className="min-h-11 min-w-11 rounded-full border border-slate-300 dark:border-slate-600"
                  onClick={() => setMapInspection(null)}
                  aria-label="Close map details"
                >
                  ×
                </button>
              </div>
            )}
            {!referenceMapSvg && !mapLoadError && (
              <p role="status" className="mt-3 text-sm text-slate-500">Loading network map...</p>
            )}
            {mapLoadError && (
              <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
                Unable to load the network map: {mapLoadError}
              </p>
            )}

            {routePreview && (
              <div className={`route-action-bar mt-3 flex justify-end${routeChooserOpen ? ' has-options' : ''}`}>
                <div className="route-primary-action flex w-full flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 flex-1 text-sm font-medium">
                    Route 1: {getRouteLineNames(routePreview).join(' → ')}
                    {routeEndpoints && (
                      <span className="block text-xs font-normal text-slate-600 dark:text-slate-300">{routeEndpoints}</span>
                    )}
                    {routePreview.transferStations.length > 0 && (
                      <span className="block text-xs font-normal text-slate-600 dark:text-slate-300">
                        Change at {getRouteTransferNames(routePreview).join(', ')}
                      </span>
                    )}
                  </p>
                  <button onClick={handleRecordRoute} className="min-h-11 rounded-full bg-emerald-600 px-4 py-2 text-sm text-white">
                    {routeIsAlreadyComplete(progress, routePreview) ? 'Already explored' : 'Record route'}
                  </button>
                </div>
                {routeChooserOpen && routeOptions.length > 1 && (
                  <div className="route-options space-y-2" role="group" aria-label="Choose the route you travelled">
                    {routeOptions.map((route, index) => {
                      const lineNames = getRouteLineNames(route);
                      const transferNames = getRouteTransferNames(route);
                      const distance = route.segments.reduce((total, section) => total + section.distance, 0);
                      return (
                        <button
                          key={route.segments.map((section) => section.id).join('|')}
                          className="min-h-14 w-full rounded-xl border border-slate-300 px-3 py-2 text-left text-sm dark:border-slate-600"
                          onClick={() => void commitRoute(route)}
                        >
                          <span className="block font-medium">
                            Route {index + 1}: {lineNames.join(' → ')}
                          </span>
                          <span className="block text-xs font-normal opacity-75">{routeEndpoints}</span>
                          <span className="block text-xs opacity-75">
                            {distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`}
                            {transferNames.length > 0 ? ` · change at ${transferNames.join(', ')}` : ' · no changes'}
                            {routeIsAlreadyComplete(progress, route) ? ' · already explored' : ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {hasAlternativeRoutes(routeOptions) && (
                  <button
                    className="route-alternatives-toggle min-h-11 w-full rounded-full border border-slate-300 px-4 py-2 text-sm dark:border-slate-600"
                    onClick={() => setRouteChooserOpen((open) => !open)}
                    aria-expanded={routeChooserOpen}
                  >
                    {routeChooserOpen ? 'Hide alternative routes' : 'Show alternative routes'}
                  </button>
                )}
              </div>
            )}
          </div>
        </main>
      )}

      {activeTab === 'stats' && (
        <main className="mx-auto max-w-6xl px-4 pb-10">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm text-slate-500">Travelled distance</p>
              <p className="mt-2 text-3xl font-semibold">{(stats.travelledDistance / 1000).toFixed(1)} km</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm text-slate-500">Network coverage</p>
              <p className="mt-2 text-3xl font-semibold">{stats.coverage.toFixed(1)}%</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm text-slate-500">Stations visited</p>
              <p className="mt-2 text-3xl font-semibold">{stats.uniqueStations}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm text-slate-500">Completed lines</p>
              <p className="mt-2 text-3xl font-semibold">{stats.completedLines}</p>
            </div>
          </div>

          <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-4 text-lg font-semibold">Line progress</h3>
            <div className="space-y-3">
              {sortedLineProgress.map((line) => (
                <div key={line.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: lineLookup[line.id]?.color ?? '#94a3b8' }} />
                      <span className="font-medium">{lineLookup[line.id]?.name ?? line.id}</span>
                    </div>
                    <span className="text-sm text-slate-500">{line.completedSections}/{line.totalSections} sections</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, line.completion)}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{line.completion.toFixed(0)}% complete</span>
                    <span>{(line.travelledDistance / 1000).toFixed(1)} / {(line.totalDistance / 1000).toFixed(1)} km</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      )}

      {activeTab === 'settings' && (
        <main className="mx-auto max-w-3xl px-4 pb-10">
          <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <h3 className="text-lg font-semibold">Progress</h3>
              <div className="mt-3 flex flex-wrap gap-3">
                <button onClick={() => setResetConfirmationOpen(true)} className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white">Reset progress</button>
              </div>
            </div>

            <div>
              <h3 className="text-lg font-semibold">About</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                Tube Tracker uses a local graph model of London transport stations and sections. It stores progress in IndexedDB, remains available offline after first successful load, and keeps a cloud-backup interface ready for future deployment.
              </p>
            </div>

            <div>
              <h3 className="text-lg font-semibold">Data sources</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
                <li>
                  Map SVG based on work by <a className="underline" href="https://commons.wikimedia.org/wiki/User:Sameboat" target="_blank" rel="noreferrer">Sameboat</a>,
                  adapted for this app and licensed under <a className="underline" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>.
                </li>
                <li>
                  Station and network data from the <a className="underline" href="https://api.tfl.gov.uk/" target="_blank" rel="noreferrer">TfL Unified API</a>,
                  licensed under the <a className="underline" href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noreferrer">Open Government Licence v3.0</a>.
                </li>
                <li>Reference project: <a className="underline" href="https://github.com/Demianeen/tube-map" target="_blank" rel="noreferrer">Demianeen/tube-map</a>.</li>
                <li>This is not an official TfL service. See the <a className="underline" href={`${import.meta.env.BASE_URL}licenses/reference-map-LICENCE.txt`} target="_blank" rel="noreferrer">full attribution and licence notice</a>.</li>
              </ul>
            </div>
          </div>
        </main>
      )}
      {resetConfirmationOpen && (
        <div className="reset-confirmation-backdrop">
          <section
            aria-labelledby="reset-confirmation-title"
            aria-modal="true"
            className="reset-confirmation-dialog rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
            role="dialog"
          >
            <h2 className="text-lg font-semibold" id="reset-confirmation-title">Reset all progress?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This permanently clears your recorded routes and cannot be undone. Are you sure?
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                autoFocus
                className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm dark:border-slate-600"
                onClick={() => setResetConfirmationOpen(false)}
              >
                Cancel
              </button>
              <button
                className="min-h-11 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white"
                onClick={() => void resetProgress()}
              >
                Reset progress
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
