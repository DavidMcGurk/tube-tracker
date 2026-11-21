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
/** A copy of the map's own route artwork, masked to the travelled track (the "bold lines" progress style). */
export const TRAVELLED_ROUTES_ID = 'app-travelled-routes';
const TRAVELLED_MASK_ID = 'app-travelled-mask';
/**
 * Covers a line (5 units wide, 5.5 with the Circle and H&C casing) without revealing more than a hairline of the
 * line running alongside it (5 units away, centre to centre).
 */
const TRAVELLED_MASK_WIDTH = 5.5;

export type HighlightKind = 'travelled' | 'preview';

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
 * Creates the app's layers around the map's route lines, bottom to top:
 * - beneath the lines: the yellow travelled band, its casing strip and the line-name label backgrounds;
 * - the map's own lines (#routes), shown thin when the "bold lines" progress style is on (see styles.css);
 * - a full-strength copy of the lines masked to the travelled track (the "bold lines" style);
 * - the selected route, drawn on top as a dashed path.
 * Station markers and names stay above all of these.
 */
export function ensureHighlightLayers(svg: SVGSVGElement) {
  const routes = svg.querySelector('#routes');
  if (!routes || svg.querySelector(`#${PREVIEW_LAYER_ID}`)) return;
  const labelBackgrounds = ensureLayer(svg, LINE_LABEL_BACKGROUND_LAYER_ID, routes);
  const casing = ensureLayer(svg, CASING_LAYER_ID, labelBackgrounds);
  ensureLayer(svg, TRAVELLED_LAYER_ID, casing);

  // The travelled copy: ids are removed so they stay unique (its <use> elements still point at the originals).
  const travelledRoutes = routes.cloneNode(true) as SVGGElement;
  travelledRoutes.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  travelledRoutes.id = TRAVELLED_ROUTES_ID;
  travelledRoutes.setAttribute('aria-hidden', 'true');
  travelledRoutes.setAttribute('mask', `url(#${TRAVELLED_MASK_ID})`);
  routes.after(travelledRoutes);

  const mask = svg.ownerDocument.createElementNS(SVG_NS, 'mask');
  mask.id = TRAVELLED_MASK_ID;
  const { x, y, width, height } = svg.viewBox.baseVal;
  for (const [name, value] of Object.entries({ maskUnits: 'userSpaceOnUse', x: x - 100, y: y - 100, width: width + 200, height: height + 200 })) {
    mask.setAttribute(name, String(value));
  }
  travelledRoutes.before(mask);

  const preview = svg.ownerDocument.createElementNS(SVG_NS, 'g');
  preview.id = PREVIEW_LAYER_ID;
  preview.setAttribute('aria-hidden', 'true');
  for (const part of ['casing', 'route']) {
    const group = svg.ownerDocument.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-part', part);
    preview.appendChild(group);
  }
  travelledRoutes.after(preview);
}

/** Target spacing of the dots along a drawn walk, in map units. */
const WALK_DOT_SPACING = 12;
const walkLengths = new Map<string, number>();

/**
 * Spaces a walk's dots evenly from end to end, with at least one dot between the ends: many walks are shorter than
 * a fixed spacing, which would leave their only dots hidden under the station markers.
 */
function spaceWalkDots(path: SVGPathElement, linkId: string) {
  let length = walkLengths.get(linkId);
  if (length === undefined) {
    length = path.getTotalLength();
    walkLengths.set(linkId, length);
  }
  const gaps = Math.max(2, Math.round(length / WALK_DOT_SPACING));
  path.style.strokeDasharray = `0 ${(length / gaps).toFixed(2)}`;
}

function createPath(document: Document, className: string, linkId: string, pathData: string) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', className);
  path.setAttribute('data-app-link-id', linkId);
  path.setAttribute('d', pathData);
  return path;
}

/**
 * Draws the given links. Travelled track is drawn both as the yellow band (with its casing) and into the mask that
 * reveals the full-strength copy of the lines; CSS shows whichever progress style is chosen. The selected route is a
 * dashed path with a white edge. Track follows the map's own line geometry; walks follow their drawn connector.
 * `documentKey` identifies the SVG document so measured geometry can be reused across re-mounts.
 */
export function renderLinkHighlights(svg: SVGSVGElement, documentKey: string, kind: HighlightKind, linkIds: readonly string[]) {
  const targets = kind === 'travelled'
    ? {
      main: svg.querySelector<SVGGElement>(`#${TRAVELLED_LAYER_ID}`),
      casing: svg.querySelector<SVGGElement>(`#${CASING_LAYER_ID}`),
      mask: svg.querySelector<SVGMaskElement>(`#${TRAVELLED_MASK_ID}`)
    }
    : {
      main: svg.querySelector<SVGGElement>(`#${PREVIEW_LAYER_ID} [data-part="route"]`),
      casing: svg.querySelector<SVGGElement>(`#${PREVIEW_LAYER_ID} [data-part="casing"]`),
      mask: null
    };
  if (!targets.main || !targets.casing) return;
  for (const target of [targets.main, targets.casing, targets.mask]) target?.replaceChildren();
  if (linkIds.length === 0) return;

  const className = kind === 'travelled' ? 'app-travelled-section' : 'app-route-preview-section';
  const casingClassName = kind === 'travelled' ? 'app-highlight-casing' : 'app-route-preview-casing';
  const document = svg.ownerDocument;
  const geometry = getGeometry(documentKey);
  for (const linkId of new Set(linkIds)) {
    const link = network.getLink(linkId);
    if (!link) continue;
    if (link.type === 'walk') {
      const walk = targets.main.appendChild(createPath(document, `${className} app-walk-link`, link.id, link.mapPath));
      spaceWalkDots(walk, link.id);
      // The selected route's walks get an edge too, like its track.
      if (kind === 'preview') {
        const edge = targets.casing.appendChild(createPath(document, `${casingClassName} app-walk-link`, link.id, link.mapPath));
        edge.style.strokeDasharray = walk.style.strokeDasharray;
      }
      continue;
    }
    const pathData = traceSection(svg, geometry, link);
    if (!pathData) continue;
    targets.main.appendChild(createPath(document, className, link.id, pathData));
    targets.casing.appendChild(createPath(document, casingClassName, link.id, pathData));
    if (targets.mask) {
      const reveal = createPath(document, 'app-travelled-mask-path', link.id, pathData);
      for (const [name, value] of Object.entries({ fill: 'none', stroke: '#fff', 'stroke-width': TRAVELLED_MASK_WIDTH, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
        reveal.setAttribute(name, String(value));
      }
      targets.mask.appendChild(reveal);
    }
  }
}
