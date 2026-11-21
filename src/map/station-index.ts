import { getStationById } from '../data/network';
import { getStationState } from '../lib/progress';
import { normalizeStationLabel } from '../lib/map-interactions';
import type { Progress } from '../lib/types';
import { measureStationAnchors } from './station-anchors';
import { getClosestStationId, getMarkerStation, STATION_MARKER_SELECTOR, stationsByMapLabel } from './station-binding';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Tap targets are this generous, but never overlap a neighbouring station's (so a near miss can't pick the wrong one). */
const MAX_HIT_AREA_RADIUS = 18;
const MIN_HIT_AREA_RADIUS = 6;

export type StationFlag = 'data-app-selected' | 'data-app-hovered';

/** The interactive SVG elements (markers, marker groups and name labels) for each station. */
export interface StationIndex {
  elementsByStation: ReadonlyMap<string, readonly SVGElement[]>;
}

const stationIndexCache = new WeakMap<SVGSVGElement, StationIndex>();

function createHitArea(document: Document, x: number, y: number, radius: number, stationId: string) {
  const hitArea = document.createElementNS(SVG_NS, 'circle');
  hitArea.setAttribute('class', 'app-station-hit-area');
  hitArea.setAttribute('cx', String(x));
  hitArea.setAttribute('cy', String(y));
  hitArea.setAttribute('r', String(radius));
  hitArea.setAttribute('data-app-station-id', stationId);
  return hitArea;
}

/** Adds generous transparent tap targets around every drawn station position. */
function addHitAreas(svg: SVGSVGElement) {
  const stationNodes = svg.querySelector<SVGGElement>('#station_nodes');
  if (!stationNodes || svg.querySelector('#app-station-hit-areas')) return;

  const hitAreaGroup = svg.ownerDocument.createElementNS(SVG_NS, 'g');
  hitAreaGroup.id = 'app-station-hit-areas';
  hitAreaGroup.setAttribute('aria-hidden', 'true');
  stationNodes.insertBefore(hitAreaGroup, stationNodes.firstChild);

  const anchors = measureStationAnchors(svg);
  const svgMatrix = svg.getScreenCTM();
  const stationNodesMatrix = stationNodes.getScreenCTM();
  if (!anchors || !svgMatrix || !stationNodesMatrix) return;
  const svgToStationNodes = stationNodesMatrix.inverse().multiply(svgMatrix);
  const allPoints = [...anchors].flatMap(([stationId, points]) => points.map((point) => ({ stationId, point })));
  for (const { stationId, point } of allPoints) {
    let nearestOther = Infinity;
    for (const other of allPoints) {
      if (other.stationId !== stationId) nearestOther = Math.min(nearestOther, Math.hypot(other.point.x - point.x, other.point.y - point.y));
    }
    const radius = Math.max(MIN_HIT_AREA_RADIUS, Math.min(MAX_HIT_AREA_RADIUS, nearestOther / 2));
    const local = new DOMPoint(point.x, point.y).matrixTransform(svgToStationNodes);
    hitAreaGroup.appendChild(createHitArea(svg.ownerDocument, local.x, local.y, radius, stationId));
  }
}

function buildStationIndex(svg: SVGSVGElement): StationIndex {
  const elementsByStation = new Map<string, SVGElement[]>();
  /**
   * Markers are decorative and clickable; each station's name label is its single focusable control (one tab stop
   * per station, with its selection exposed through aria-pressed).
   */
  const bind = (element: SVGElement, stationId: string, kind: 'marker' | 'label') => {
    const station = getStationById(stationId);
    if (!station) return;
    element.setAttribute('data-app-station-id', stationId);
    element.setAttribute('data-app-selected', 'false');
    element.setAttribute('data-app-hovered', 'false');
    if (kind === 'label') {
      element.setAttribute('role', 'button');
      element.setAttribute('tabindex', '0');
      element.setAttribute('aria-label', `Select station ${station.name}`);
      element.setAttribute('aria-pressed', 'false');
    } else {
      element.setAttribute('aria-hidden', 'true');
    }
    const elements = elementsByStation.get(stationId) ?? [];
    elements.push(element);
    elementsByStation.set(stationId, elements);
  };

  const markers = [...svg.querySelectorAll<SVGElement>(STATION_MARKER_SELECTOR)];
  addHitAreas(svg);
  for (const marker of markers) {
    const station = getMarkerStation(marker);
    if (station) bind(marker, station.id, 'marker');
  }
  for (const group of svg.querySelectorAll<SVGElement>('#station_nodes g[id]')) {
    const station = getMarkerStation(group);
    if (station) bind(group, station.id, 'marker');
  }
  // Bank and Monument share one hub drawing: the capsule outline is Bank, the circle outline is Monument.
  const hub = svg.querySelector('#Bank_Monument_hub');
  for (const [label, selector] of [['bank', 'rect[style*="stroke:#000"]'], ['monument', 'circle[style*="stroke:#000"]']] as const) {
    const station = stationsByMapLabel.get(label)?.[0];
    const outline = hub?.querySelector<SVGElement>(selector);
    if (station && outline) bind(outline, station.id, 'marker');
  }
  // Labels are matched by text; ambiguous names (e.g. two "Edgware Road" stations) go to the nearest bound marker.
  for (const label of svg.querySelectorAll<SVGTextElement>('#text text')) {
    const candidates = stationsByMapLabel.get(normalizeStationLabel(label.textContent ?? ''));
    if (!candidates?.length) continue;
    const stationId = getClosestStationId(label, candidates, markers);
    if (stationId) bind(label, stationId, 'label');
  }

  return { elementsByStation };
}

/** Binds the SVG's station elements once per SVG element and returns the index (cached). */
export function getStationIndex(svg: SVGSVGElement): StationIndex {
  let index = stationIndexCache.get(svg);
  if (!index) {
    index = buildStationIndex(svg);
    stationIndexCache.set(svg, index);
  }
  return index;
}

export function applyStationStates(index: StationIndex, progress: Progress) {
  for (const [stationId, elements] of index.elementsByStation) {
    const state = getStationState(stationId, progress);
    for (const element of elements) {
      if (element.getAttribute('data-app-state') !== state) element.setAttribute('data-app-state', state);
    }
  }
}

export function setStationFlag(index: StationIndex, stationId: string, flag: StationFlag, value: boolean) {
  for (const element of index.elementsByStation.get(stationId) ?? []) {
    element.setAttribute(flag, String(value));
    if (flag === 'data-app-selected' && element.hasAttribute('aria-pressed')) element.setAttribute('aria-pressed', String(value));
  }
}
