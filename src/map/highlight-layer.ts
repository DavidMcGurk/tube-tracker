import { network } from '../data/network';
import type { TrackSection } from '../data/track-section';
import {
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

function getGeometry(documentKey: string): MapGeometry {
  if (geometryCache?.documentKey !== documentKey) {
    geometryCache = { documentKey, stationPositions: null, lineComponents: new Map() };
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
  if (components) geometry.lineComponents.set(lineId, components);
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

/** Creates the highlight layers beneath the map's route lines: route preview below travelled sections. */
export function ensureHighlightLayers(svg: SVGSVGElement) {
  const routes = svg.querySelector('#routes');
  if (!routes) return;
  const travelled = ensureLayer(svg, TRAVELLED_LAYER_ID, routes);
  ensureLayer(svg, PREVIEW_LAYER_ID, travelled);
}

/**
 * Draws the given links into a highlight layer: track sections follow the map's own line geometry, and walking
 * interchanges follow their drawn connector. `documentKey` identifies the SVG document so measured geometry can be
 * reused across re-mounts.
 */
export function renderLinkHighlights(
  svg: SVGSVGElement,
  documentKey: string,
  layerId: string,
  className: string,
  linkIds: readonly string[]
) {
  const layer = svg.querySelector<SVGGElement>(`#${layerId}`);
  if (!layer) return;
  layer.replaceChildren();
  if (linkIds.length === 0) return;

  const geometry = getGeometry(documentKey);
  for (const linkId of new Set(linkIds)) {
    const link = network.getLink(linkId);
    if (!link) continue;
    const pathData = link.type === 'walk' ? link.mapPath : traceSection(svg, geometry, link);
    if (!pathData) continue;
    const path = svg.ownerDocument.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', link.type === 'walk' ? `${className} app-walk-link` : className);
    path.setAttribute('data-app-link-id', link.id);
    path.setAttribute('d', pathData);
    layer.appendChild(path);
  }
}
