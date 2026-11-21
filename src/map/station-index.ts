import { getStationById } from '../data/network';
import { getStationState } from '../lib/progress';
import { normalizeStationLabel } from '../lib/map-interactions';
import type { Progress } from '../lib/types';
import { getClosestStationId, getMarkerStation, stationsByMapLabel } from './station-binding';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HIT_AREA_RADIUS = 18;
/** Bank and Monument are drawn as one hub group; these are their centres in the hub's own coordinates. */
const BANK_MONUMENT_HUB_POINTS = [
  { label: 'bank', x: 7.25, y: 0 },
  { label: 'monument', x: 20.25, y: 27 }
] as const;

export type StationFlag = 'data-app-selected' | 'data-app-hovered';

/** The interactive SVG elements (markers, marker groups and name labels) for each station. */
export interface StationIndex {
  elementsByStation: ReadonlyMap<string, readonly SVGElement[]>;
}

const stationIndexCache = new WeakMap<SVGSVGElement, StationIndex>();

function createHitArea(document: Document, x: number, y: number, stationId: string, source: string) {
  const hitArea = document.createElementNS(SVG_NS, 'circle');
  hitArea.setAttribute('class', 'app-station-hit-area');
  hitArea.setAttribute('cx', String(x));
  hitArea.setAttribute('cy', String(y));
  hitArea.setAttribute('r', String(HIT_AREA_RADIUS));
  hitArea.setAttribute('data-app-station-id', stationId);
  hitArea.setAttribute('data-app-station-hit-area', source);
  return hitArea;
}

/** Adds generous transparent tap targets around each station marker. */
function addHitAreas(svg: SVGSVGElement, markers: readonly SVGElement[]) {
  const stationNodes = svg.querySelector<SVGGElement>('#station_nodes');
  if (!stationNodes || svg.querySelector('#app-station-hit-areas')) return;

  const hitAreaGroup = svg.ownerDocument.createElementNS(SVG_NS, 'g');
  hitAreaGroup.id = 'app-station-hit-areas';
  hitAreaGroup.setAttribute('aria-hidden', 'true');
  stationNodes.insertBefore(hitAreaGroup, stationNodes.firstChild);

  const stationNodesMatrix = stationNodes.getScreenCTM();
  if (stationNodesMatrix) {
    const toStationNodes = stationNodesMatrix.inverse();
    for (const marker of markers) {
      const station = getMarkerStation(marker);
      if (!station) continue;
      const bounds = marker.getBoundingClientRect();
      const centre = new DOMPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2).matrixTransform(toStationNodes);
      hitAreaGroup.appendChild(createHitArea(svg.ownerDocument, centre.x, centre.y, station.id, marker.id));
    }
  }

  const hub = svg.querySelector<SVGGElement>('#Bank_Monument_hub');
  if (!hub) return;
  for (const point of BANK_MONUMENT_HUB_POINTS) {
    const station = stationsByMapLabel.get(point.label)?.[0];
    if (station) hub.appendChild(createHitArea(svg.ownerDocument, point.x, point.y, station.id, `Bank_Monument_${station.id}`));
  }
}

function buildStationIndex(svg: SVGSVGElement): StationIndex {
  const elementsByStation = new Map<string, SVGElement[]>();
  const bind = (element: SVGElement, stationId: string) => {
    const station = getStationById(stationId);
    if (!station) return;
    element.setAttribute('data-app-station-id', stationId);
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.setAttribute('aria-label', `Select station ${station.name}`);
    element.setAttribute('data-app-selected', 'false');
    element.setAttribute('data-app-hovered', 'false');
    const elements = elementsByStation.get(stationId) ?? [];
    elements.push(element);
    elementsByStation.set(stationId, elements);
  };

  const markers = [...svg.querySelectorAll<SVGElement>('#station_nodes use[id]')];
  addHitAreas(svg, markers);
  for (const marker of markers) {
    const station = getMarkerStation(marker);
    if (station) bind(marker, station.id);
  }
  for (const group of svg.querySelectorAll<SVGElement>('#station_nodes g[id]')) {
    const station = getMarkerStation(group);
    if (station) bind(group, station.id);
  }
  // Labels are matched by text; ambiguous names (e.g. two "Edgware Road" stations) go to the nearest bound marker.
  for (const label of svg.querySelectorAll<SVGTextElement>('#text text')) {
    const candidates = stationsByMapLabel.get(normalizeStationLabel(label.textContent ?? ''));
    if (!candidates?.length) continue;
    const stationId = getClosestStationId(label, candidates, markers);
    if (stationId) bind(label, stationId);
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
  for (const element of index.elementsByStation.get(stationId) ?? []) element.setAttribute(flag, String(value));
}
