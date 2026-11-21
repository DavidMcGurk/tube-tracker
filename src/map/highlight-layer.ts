import { sections } from '../data/network';
import type { TrackSection } from '../data/track-section';
import {
  closestPointOnComponent,
  sampleInterchangePath,
  sampleLineComponents,
  toPathData,
  type ClosestPoint,
  type PathComponent,
  type Point
} from './section-geometry';
import { getMarkerStation } from './station-binding';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A station marker further than this from a line's drawn path is not considered to be on it. */
const maximumMarkerOffset = 32;

export const TRAVELLED_LAYER_ID = 'app-travelled-sections';
export const PREVIEW_LAYER_ID = 'app-route-preview-sections';

/**
 * Geometry measured from one SVG document, in user units. It does not depend on zoom or scroll, so it is kept for the
 * lifetime of the page and reused when the map is re-mounted (e.g. after switching tabs).
 */
interface MapGeometry {
  documentKey: string;
  stationPositions: Map<string, Point[]> | null;
  lineComponents: Map<string, PathComponent[]>;
  interchangePath: Point[] | null;
}

let geometryCache: MapGeometry | null = null;
const warnedSectionIds = new Set<string>();

function getGeometry(documentKey: string): MapGeometry {
  if (geometryCache?.documentKey !== documentKey) {
    geometryCache = { documentKey, stationPositions: null, lineComponents: new Map(), interchangePath: null };
  }
  return geometryCache;
}

function measureStationPositions(svg: SVGSVGElement): Map<string, Point[]> | null {
  const svgMatrix = svg.getScreenCTM();
  if (!svgMatrix) return null;
  const toSvgCoordinates = svgMatrix.inverse();
  const positions = new Map<string, Point[]>();
  for (const marker of svg.querySelectorAll<SVGElement>('#station_nodes use[id]')) {
    const station = getMarkerStation(marker);
    if (!station) continue;
    const bounds = marker.getBoundingClientRect();
    const point = new DOMPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2).matrixTransform(toSvgCoordinates);
    const stationPositions = positions.get(station.id) ?? [];
    stationPositions.push({ x: point.x, y: point.y });
    positions.set(station.id, stationPositions);
  }
  return positions;
}

function getStationPositions(svg: SVGSVGElement, geometry: MapGeometry) {
  geometry.stationPositions ??= measureStationPositions(svg);
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
  if (section.lineId === 'interchange') {
    const interchangePath = (geometry.interchangePath ??= sampleInterchangePath(svg));
    if (!interchangePath || interchangePath.length < 2) {
      warnOnce(section.id, `Unable to show map geometry for interchange section "${section.id}"`);
      return null;
    }
    return toPathData(interchangePath);
  }

  const stationPositions = getStationPositions(svg, geometry);
  const from = stationPositions?.get(section.from);
  const to = stationPositions?.get(section.to);
  if (!from?.length || !to?.length) {
    warnOnce(section.id, `Unable to show section "${section.id}" because a station marker is missing`);
    return null;
  }

  let best: { component: PathComponent; from: ClosestPoint; to: ClosestPoint; score: number } | null = null;
  for (const component of getLineComponents(svg, geometry, section.lineId)) {
    const routeFrom = closestPointOnComponent(component, from);
    const routeTo = closestPointOnComponent(component, to);
    if (!routeFrom || !routeTo || routeFrom.distance > maximumMarkerOffset || routeTo.distance > maximumMarkerOffset) continue;
    const score = routeFrom.distance + routeTo.distance;
    if (!best || score < best.score) best = { component, from: routeFrom, to: routeTo, score };
  }

  if (!best) {
    warnOnce(section.id, `Unable to follow map line geometry for section "${section.id}"`);
    return null;
  }

  const low = Math.min(best.from.index, best.to.index);
  const high = Math.max(best.from.index, best.to.index);
  const tracedPoints = best.component.slice(low, high + 1);
  return tracedPoints.length >= 2 ? toPathData(tracedPoints) : null;
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
 * Draws the given track sections into a highlight layer, following the map's own line geometry.
 * `documentKey` identifies the SVG document so measured geometry can be reused across re-mounts.
 */
export function renderSectionHighlights(
  svg: SVGSVGElement,
  documentKey: string,
  layerId: string,
  className: string,
  sectionIds: readonly string[]
) {
  const layer = svg.querySelector<SVGGElement>(`#${layerId}`);
  if (!layer) return;
  layer.replaceChildren();
  if (sectionIds.length === 0) return;

  const geometry = getGeometry(documentKey);
  const requested = new Set(sectionIds);
  for (const section of sections) {
    if (!requested.has(section.id)) continue;
    const pathData = traceSection(svg, geometry, section);
    if (!pathData) continue;
    const path = svg.ownerDocument.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', className);
    path.setAttribute('data-app-section-id', section.id);
    path.setAttribute('d', pathData);
    layer.appendChild(path);
  }
}
