import { network } from '../data/network';
import type { TrackSection } from '../data/track-section';
import {
  LINE_SVG_CLASSES,
  closestPointOnComponent,
  joinTouchingComponents,
  polylineLength,
  sampleLineComponents,
  toPathData,
  type ClosestPoint,
  type PathComponent,
  type Point,
  type RankedComponent
} from './section-geometry';
import { measureStationAnchors } from './station-anchors';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A station marker further than this from a line's drawn path is not considered to be on it. */
const maximumMarkerOffset = 32;
/** Score handicap per class rank, so a line's primary path wins near-ties against its secondary paths. */
const classRankPenalty = 3;
/** A trace much longer than the straight line between its stations followed the wrong path, so it is rejected. */
const maximumTraceToDistanceRatio = 4;

export const TRAVELLED_LAYER_ID = 'app-travelled-sections';
export const PREVIEW_LAYER_ID = 'app-route-preview-sections';
const CASING_LAYER_ID = 'app-highlight-casing';
export const LINE_LABEL_BACKGROUND_LAYER_ID = 'app-line-label-backgrounds';

export type HighlightKind = 'travelled' | 'preview';

const HIGHLIGHT_LAYERS: Record<HighlightKind, { layerId: string; className: string }> = {
  travelled: { layerId: TRAVELLED_LAYER_ID, className: 'app-travelled-section' },
  preview: { layerId: PREVIEW_LAYER_ID, className: 'app-route-preview-section' }
};

/**
 * Geometry measured from one SVG document, in user units. It does not depend on zoom or scroll, so it is kept for the
 * lifetime of the page and reused when the map is re-mounted (e.g. after switching tabs).
 */
interface MapGeometry {
  documentKey: string;
  stationPositions: Map<string, Point[]> | null;
  lineComponents: Map<string, RankedComponent[]>;
}

let geometryCache: MapGeometry | null = null;
const warnedSectionIds = new Set<string>();

/*
 * Sampling the drawn lines is the slowest part of drawing highlights (getPointAtLength gets slower along long paths),
 * so the samples are also kept in localStorage, keyed by the map and the sampling settings. Only the first draw after
 * the map changes pays the cost.
 */
const STORED_GEOMETRY_PREFIX = 'tube-tracker-line-geometry:';
const STORED_GEOMETRY_VERSION = 1;
let storeTimer: ReturnType<typeof setTimeout> | null = null;

function hashText(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function storedGeometryKey(documentKey: string) {
  return `${STORED_GEOMETRY_PREFIX}${hashText(`${STORED_GEOMETRY_VERSION}|${JSON.stringify(LINE_SVG_CLASSES)}|${documentKey}`)}`;
}

type StoredLines = Record<string, Array<[classRank: number, coordinates: number[]]>>;

function loadStoredLines(documentKey: string): Map<string, RankedComponent[]> {
  try {
    const stored = localStorage.getItem(storedGeometryKey(documentKey));
    if (!stored) return new Map();
    const lines = JSON.parse(stored) as StoredLines;
    return new Map(Object.entries(lines).map(([lineId, components]) => [lineId, components.map(([classRank, coordinates]) => ({
      classRank,
      points: Array.from({ length: coordinates.length / 2 }, (_, index) => ({ x: coordinates[index * 2]!, y: coordinates[index * 2 + 1]! }))
    }))]));
  } catch (error) {
    console.warn('Ignoring unreadable stored map geometry', error);
    return new Map();
  }
}

function scheduleStoreLines(geometry: MapGeometry) {
  if (storeTimer) clearTimeout(storeTimer);
  storeTimer = setTimeout(() => {
    storeTimer = null;
    const round = (value: number) => Math.round(value * 100) / 100;
    const lines: StoredLines = Object.fromEntries([...geometry.lineComponents].map(([lineId, components]) => [
      lineId,
      components.map(({ classRank, points }) => [classRank, points.flatMap((point) => [round(point.x), round(point.y)])])
    ]));
    try {
      const key = storedGeometryKey(geometry.documentKey);
      for (const existing of Object.keys(localStorage)) {
        if (existing.startsWith(STORED_GEOMETRY_PREFIX) && existing !== key) localStorage.removeItem(existing);
      }
      localStorage.setItem(key, JSON.stringify(lines));
    } catch (error) {
      console.warn('Unable to store map geometry', error);
    }
  }, 1000);
}

function getGeometry(documentKey: string): MapGeometry {
  if (geometryCache?.documentKey !== documentKey) {
    geometryCache = { documentKey, stationPositions: null, lineComponents: loadStoredLines(documentKey) };
  }
  return geometryCache;
}

function getStationPositions(svg: SVGSVGElement, geometry: MapGeometry) {
  geometry.stationPositions ??= measureStationAnchors(svg);
  return geometry.stationPositions;
}

function getLineComponents(svg: SVGSVGElement, geometry: MapGeometry, lineId: string) {
  const cached = geometry.lineComponents.get(lineId);
  if (cached) return cached;
  const components = sampleLineComponents(svg, lineId);
  if (components) {
    geometry.lineComponents.set(lineId, components);
    scheduleStoreLines(geometry);
  }
  return components ?? [];
}

function warnOnce(sectionId: string, message: string) {
  if (warnedSectionIds.has(sectionId)) return;
  warnedSectionIds.add(sectionId);
  console.warn(message);
}

function traceSection(svg: SVGSVGElement, geometry: MapGeometry, section: TrackSection): string | null {
  const stationPositions = getStationPositions(svg, geometry);
  const from = stationPositions?.get(section.from);
  const to = stationPositions?.get(section.to);
  if (!from?.length || !to?.length) {
    warnOnce(section.id, `Unable to show section "${section.id}" because a station marker is missing`);
    return null;
  }

  const components = getLineComponents(svg, geometry, section.lineId);
  const fit = fitSingleComponent(components, from, to) ?? fitJoinedComponents(components, from, to);
  if (!fit) {
    warnOnce(section.id, `Unable to follow map line geometry for section "${section.id}"`);
    return null;
  }

  const low = Math.min(fit.from.index, fit.to.index);
  const high = Math.max(fit.from.index, fit.to.index);
  const tracedPoints = fit.points.slice(low, high + 1);
  if (tracedPoints.length < 2) return null;
  if (polylineLength(tracedPoints) > maximumTraceToDistanceRatio * closestDistance(from, to)) {
    warnOnce(section.id, `Rejected an implausibly long map trace for section "${section.id}"`);
    return null;
  }
  return toPathData(tracedPoints);
}

interface ComponentFit {
  points: PathComponent;
  from: ClosestPoint;
  to: ClosestPoint;
  score: number;
}

function fitComponent(points: PathComponent, from: readonly Point[], to: readonly Point[], penalty: number): ComponentFit | null {
  const routeFrom = closestPointOnComponent(points, from);
  const routeTo = closestPointOnComponent(points, to);
  if (!routeFrom || !routeTo || routeFrom.distance > maximumMarkerOffset || routeTo.distance > maximumMarkerOffset) return null;
  return { points, from: routeFrom, to: routeTo, score: routeFrom.distance + routeTo.distance + penalty };
}

function fitSingleComponent(components: readonly RankedComponent[], from: readonly Point[], to: readonly Point[]) {
  let best: ComponentFit | null = null;
  for (const { points, classRank } of components) {
    const fit = fitComponent(points, from, to, classRank * classRankPenalty);
    if (fit && (!best || fit.score < best.score)) best = fit;
  }
  return best;
}

/** Fallback for sections whose stations sit on two drawn paths that meet end to end. */
function fitJoinedComponents(components: readonly RankedComponent[], from: readonly Point[], to: readonly Point[]) {
  const near = (points: PathComponent, positions: readonly Point[]) =>
    (closestPointOnComponent(points, positions)?.distance ?? Infinity) <= maximumMarkerOffset;
  const fromCandidates = components.filter(({ points }) => near(points, from));
  const toCandidates = components.filter(({ points }) => near(points, to));

  let best: ComponentFit | null = null;
  for (const a of fromCandidates) {
    for (const b of toCandidates) {
      if (a === b) continue;
      const joined = joinTouchingComponents(a.points, b.points);
      const fit = joined && fitComponent(joined, from, to, Math.max(a.classRank, b.classRank) * classRankPenalty);
      if (fit && (!best || fit.score < best.score)) best = fit;
    }
  }
  return best;
}

function closestDistance(from: readonly Point[], to: readonly Point[]) {
  let closest = Infinity;
  for (const a of from) for (const b of to) closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
  return closest;
}

function ensureLayer(svg: SVGSVGElement, layerId: string, before: Element) {
  let layer = svg.querySelector<SVGGElement>(`#${layerId}`);
  if (!layer) {
    layer = svg.ownerDocument.createElementNS(SVG_NS, 'g');
    layer.id = layerId;
    layer.setAttribute('aria-hidden', 'true');
    before.parentNode?.insertBefore(layer, before);
  }
  return layer;
}

/**
 * Creates the app's layers beneath the map's route lines, bottom to top: route preview, travelled sections, a casing
 * strip that separates every highlight from the line drawn over it (so yellow lines stay visible on the yellow band),
 * and the backgrounds behind line-name labels.
 */
export function ensureHighlightLayers(svg: SVGSVGElement) {
  const routes = svg.querySelector('#routes');
  if (!routes) return;
  const labelBackgrounds = ensureLayer(svg, LINE_LABEL_BACKGROUND_LAYER_ID, routes);
  const casing = ensureLayer(svg, CASING_LAYER_ID, labelBackgrounds);
  const travelled = ensureLayer(svg, TRAVELLED_LAYER_ID, casing);
  ensureLayer(svg, PREVIEW_LAYER_ID, travelled);
  for (const kind of Object.keys(HIGHLIGHT_LAYERS) as HighlightKind[]) {
    if (casing.querySelector(`[data-source="${kind}"]`)) continue;
    const group = svg.ownerDocument.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-source', kind);
    casing.appendChild(group);
  }
}

function createPath(document: Document, className: string, linkId: string, pathData: string) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', className);
  path.setAttribute('data-app-link-id', linkId);
  path.setAttribute('d', pathData);
  return path;
}

/**
 * Draws the given links as travelled or preview highlights: track sections follow the map's own line geometry (with
 * a casing copy), and walking interchanges follow their drawn connector. `documentKey` identifies the SVG document
 * so measured geometry can be reused across re-mounts.
 */
export function renderLinkHighlights(svg: SVGSVGElement, documentKey: string, kind: HighlightKind, linkIds: readonly string[]) {
  const { layerId, className } = HIGHLIGHT_LAYERS[kind];
  const layer = svg.querySelector<SVGGElement>(`#${layerId}`);
  const casing = svg.querySelector<SVGGElement>(`#${CASING_LAYER_ID} [data-source="${kind}"]`);
  if (!layer || !casing) return;
  layer.replaceChildren();
  casing.replaceChildren();
  if (linkIds.length === 0) return;

  const geometry = getGeometry(documentKey);
  for (const linkId of new Set(linkIds)) {
    const link = network.getLink(linkId);
    if (!link) continue;
    if (link.type === 'walk') {
      layer.appendChild(createPath(svg.ownerDocument, `${className} app-walk-link`, link.id, link.mapPath));
      continue;
    }
    const pathData = traceSection(svg, geometry, link);
    if (!pathData) continue;
    layer.appendChild(createPath(svg.ownerDocument, className, link.id, pathData));
    casing.appendChild(createPath(svg.ownerDocument, 'app-highlight-casing', link.id, pathData));
  }
}
