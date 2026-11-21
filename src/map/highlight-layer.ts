import { network } from '../data/network';
import type { TrackSection } from '../data/track-section';
import {
  LINE_SVG_CLASSES,
  getLineSvgClasses,
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
/**
 * Some track is drawn twice side by side, once per service (e.g. the Weaver line's two tracks into Liverpool Street,
 * 10 units apart, with station ticks bridging both). Another drawing of the same line that stays this close to a
 * section's trace all the way shows the same section.
 */
const parallelTrackTolerance = 12;
/** Below this average offset, another drawing is the same track drawn twice (e.g. overlapping branches), not a parallel one. */
const sameTrackOffset = 2;

export const TRAVELLED_LAYER_ID = 'app-travelled-sections';
export const PREVIEW_LAYER_ID = 'app-route-preview-sections';
const CASING_LAYER_ID = 'app-highlight-casing';
export const LINE_LABEL_BACKGROUND_LAYER_ID = 'app-line-label-backgrounds';
/** Travelled track drawn over the map's lines in each line's own colour (the "bold lines" progress style). */
export const TRAVELLED_LINES_ID = 'app-travelled-lines';

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
const STORED_GEOMETRY_VERSION = 2;
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

type StoredLines = Record<string, Array<[classRank: number, coordinates: number[], partTime?: 1]>>;

function loadStoredLines(documentKey: string): Map<string, RankedComponent[]> {
  try {
    const stored = localStorage.getItem(storedGeometryKey(documentKey));
    if (!stored) return new Map();
    const lines = JSON.parse(stored) as StoredLines;
    return new Map(Object.entries(lines).map(([lineId, components]) => [lineId, components.map(([classRank, coordinates, partTime]) => ({
      classRank,
      points: Array.from({ length: coordinates.length / 2 }, (_, index) => ({ x: coordinates[index * 2]!, y: coordinates[index * 2 + 1]! })),
      ...(partTime ? { partTime: true } : {})
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
      components.map(({ classRank, points, partTime }) => {
        const coordinates = points.flatMap((point) => [round(point.x), round(point.y)]);
        return partTime ? [classRank, coordinates, 1] : [classRank, coordinates];
      })
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

interface Trace {
  pathData: string;
  /** Drawn on a path the map marks as a part-time service. */
  partTime: boolean;
}

/**
 * Follows a section along the map's drawing of its line. The first trace is the best fit; any further traces are
 * parallel drawings of the same track (see parallelTrackTolerance).
 */
function traceSection(svg: SVGSVGElement, geometry: MapGeometry, section: TrackSection): Trace[] {
  const stationPositions = getStationPositions(svg, geometry);
  const from = stationPositions?.get(section.from);
  const to = stationPositions?.get(section.to);
  if (!from?.length || !to?.length) {
    warnOnce(section.id, `Unable to show section "${section.id}" because a station marker is missing`);
    return [];
  }

  const components = getLineComponents(svg, geometry, section.lineId);
  const fits = fitEachComponent(components, from, to);
  const best = fits[0] ?? fitJoinedComponents(components, from, to);
  if (!best) {
    warnOnce(section.id, `Unable to follow map line geometry for section "${section.id}"`);
    return [];
  }

  const bestPoints = tracedPoints(best);
  if (bestPoints.length < 2) return [];
  if (polylineLength(bestPoints) > maximumTraceToDistanceRatio * closestDistance(from, to)) {
    warnOnce(section.id, `Rejected an implausibly long map trace for section "${section.id}"`);
    return [];
  }
  const traces = [{ points: bestPoints, partTime: best.partTime }];
  for (const fit of fits.slice(1)) {
    if (fit.points === best.points || fit.classRank !== best.classRank) continue;
    const points = tracedPoints(fit);
    if (points.length < 2 || !staysAlongside(points, bestPoints) || !staysAlongside(bestPoints, points)) continue;
    if (traces.every((trace) => averageOffset(points, trace.points) > sameTrackOffset)) traces.push({ points, partTime: fit.partTime });
  }
  return traces.map(({ points, partTime }) => ({ pathData: toPathData(points), partTime }));
}

function tracedPoints(fit: ComponentFit) {
  const low = Math.min(fit.from.index, fit.to.index);
  const high = Math.max(fit.from.index, fit.to.index);
  return fit.points.slice(low, high + 1);
}

function distanceToTrace(point: Point, trace: readonly Point[]) {
  let closest = Infinity;
  for (const near of trace) closest = Math.min(closest, Math.hypot(near.x - point.x, near.y - point.y));
  return closest;
}

function averageOffset(points: readonly Point[], trace: readonly Point[]) {
  return points.reduce((total, point) => total + distanceToTrace(point, trace), 0) / points.length;
}

/** Whether every point of a trace is within parallelTrackTolerance of the other trace. */
function staysAlongside(points: readonly Point[], other: readonly Point[]) {
  return points.every((point) => distanceToTrace(point, other) <= parallelTrackTolerance);
}

interface ComponentFit {
  points: PathComponent;
  classRank: number;
  partTime: boolean;
  from: ClosestPoint;
  to: ClosestPoint;
  score: number;
}

function fitComponent({ points, classRank, partTime = false }: RankedComponent, from: readonly Point[], to: readonly Point[]): ComponentFit | null {
  const routeFrom = closestPointOnComponent(points, from);
  const routeTo = closestPointOnComponent(points, to);
  if (!routeFrom || !routeTo || routeFrom.distance > maximumMarkerOffset || routeTo.distance > maximumMarkerOffset) return null;
  return { points, classRank, partTime, from: routeFrom, to: routeTo, score: routeFrom.distance + routeTo.distance + classRank * classRankPenalty };
}

/** Every drawn component of the line that passes both stations, best fit first. */
function fitEachComponent(components: readonly RankedComponent[], from: readonly Point[], to: readonly Point[]) {
  return components
    .map((component) => fitComponent(component, from, to))
    .filter((fit): fit is ComponentFit => fit !== null)
    .sort((a, b) => a.score - b.score);
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
      const component = joined && { points: joined, classRank: Math.max(a.classRank, b.classRank), partTime: Boolean(a.partTime && b.partTime) };
      const fit = component && fitComponent(component, from, to);
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

function createLayerWithParts(svg: SVGSVGElement, layerId: string, parts: readonly string[]) {
  const layer = svg.ownerDocument.createElementNS(SVG_NS, 'g');
  layer.id = layerId;
  layer.setAttribute('aria-hidden', 'true');
  for (const part of parts) {
    const group = svg.ownerDocument.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-part', part);
    layer.appendChild(group);
  }
  return layer;
}

/**
 * White details the map draws over its lines: the Piccadilly line's one-way arrows and the dividers that keep side-by-
 * side lines apart (around the Heathrow loop, and between Uxbridge and Rayners Lane). They are copied above travelled
 * track so it doesn't hide them. (The part-time service dashes are redrawn per section instead.)
 */
const MAP_OVERLAY_SELECTOR = '#routes use[*|href="#STRg"], #Piccadilly_Heathrow_divider, #Uxbridge-Rayner_Lane_divider';

/**
 * Creates the app's layers around the map's route lines, bottom to top:
 * - beneath the lines: the yellow travelled band, its casing strip and the line-name label backgrounds;
 * - the map's own lines (#routes), shown thin when the "bold lines" progress style is on (see styles.css);
 * - travelled track in each line's own colour (the "bold lines" style): casings beneath all lines, then the lines, then
 *   the white part-time dashes and other white details the map draws over its lines;
 * - the selected route, drawn on top as a dashed path.
 * Station markers and names stay above all of these.
 */
export function ensureHighlightLayers(svg: SVGSVGElement) {
  const routes = svg.querySelector('#routes');
  if (!routes || svg.querySelector(`#${PREVIEW_LAYER_ID}`)) return;
  const labelBackgrounds = ensureLayer(svg, LINE_LABEL_BACKGROUND_LAYER_ID, routes);
  const casing = ensureLayer(svg, CASING_LAYER_ID, labelBackgrounds);
  ensureLayer(svg, TRAVELLED_LAYER_ID, casing);
  const travelledLines = createLayerWithParts(svg, TRAVELLED_LINES_ID, ['casing', 'line', 'part-time', 'map-overlays']);
  const mapOverlays = travelledLines.querySelector('[data-part="map-overlays"]')!;
  for (const overlay of svg.querySelectorAll(MAP_OVERLAY_SELECTOR)) {
    const copy = overlay.cloneNode(true) as Element;
    copy.removeAttribute('id');
    mapOverlays.appendChild(copy);
  }
  routes.after(travelledLines);
  travelledLines.after(createLayerWithParts(svg, PREVIEW_LAYER_ID, ['casing', 'route']));
}

/** How the map draws a line: its colour class, whether it has a darker casing, and its place in the map's drawing order. */
interface LineArtwork {
  svgClass: string;
  casing: boolean;
  order: number;
}

const lineArtworkCache = new WeakMap<SVGSVGElement, Map<string, LineArtwork>>();

function getLineArtwork(svg: SVGSVGElement, lineId: string): LineArtwork {
  let byLine = lineArtworkCache.get(svg);
  if (!byLine) {
    byLine = new Map();
    lineArtworkCache.set(svg, byLine);
  }
  let artwork = byLine.get(lineId);
  if (!artwork) {
    const svgClass = getLineSvgClasses(lineId)[0] ?? lineId;
    const order = [...svg.querySelectorAll('#routes .me')].findIndex((element) => element.classList.contains(`s${svgClass}`));
    artwork = {
      svgClass,
      casing: svg.querySelector(`#routes .meb.b${svgClass}`) !== null,
      order: order === -1 ? Infinity : order
    };
    byLine.set(lineId, artwork);
  }
  return artwork;
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

/** Travelled sections in the order the map draws their lines, so overlapping travelled lines stack as on the map. */
function inMapOrder(svg: SVGSVGElement, linkIds: readonly string[]) {
  const order = (linkId: string) => {
    const link = network.getLink(linkId);
    return link?.type === 'track' ? getLineArtwork(svg, link.lineId).order : -1;
  };
  return [...new Set(linkIds)].sort((a, b) => order(a) - order(b));
}

/**
 * Draws the given links. Travelled track is drawn both as the yellow band (with its casing) and as lines in their own
 * colours; CSS shows whichever progress style is chosen. The selected route is a dashed path with an edge. Track
 * follows the map's own line geometry; walks follow their drawn connector.
 * `documentKey` identifies the SVG document so measured geometry can be reused across re-mounts.
 */
export function renderLinkHighlights(svg: SVGSVGElement, documentKey: string, kind: HighlightKind, linkIds: readonly string[]) {
  const part = (selector: string) => svg.querySelector<SVGGElement>(selector);
  const targets = kind === 'travelled'
    ? {
      main: part(`#${TRAVELLED_LAYER_ID}`),
      casing: part(`#${CASING_LAYER_ID}`),
      lineCasing: part(`#${TRAVELLED_LINES_ID} [data-part="casing"]`),
      line: part(`#${TRAVELLED_LINES_ID} [data-part="line"]`),
      linePartTime: part(`#${TRAVELLED_LINES_ID} [data-part="part-time"]`)
    }
    : {
      main: part(`#${PREVIEW_LAYER_ID} [data-part="route"]`),
      casing: part(`#${PREVIEW_LAYER_ID} [data-part="casing"]`),
      lineCasing: null,
      line: null,
      linePartTime: null
    };
  if (!targets.main || !targets.casing) return;
  for (const target of Object.values(targets)) target?.replaceChildren();
  if (linkIds.length === 0) return;

  const className = kind === 'travelled' ? 'app-travelled-section' : 'app-route-preview-section';
  const casingClassName = kind === 'travelled' ? 'app-highlight-casing' : 'app-route-preview-casing';
  const document = svg.ownerDocument;
  const geometry = getGeometry(documentKey);
  for (const linkId of kind === 'travelled' ? inMapOrder(svg, linkIds) : new Set(linkIds)) {
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
    // Travelled track covers every parallel drawing of a section; the selected route follows just one.
    const traces = traceSection(svg, geometry, link);
    for (const { pathData, partTime } of kind === 'travelled' ? traces : traces.slice(0, 1)) {
      targets.main.appendChild(createPath(document, className, link.id, pathData));
      targets.casing.appendChild(createPath(document, casingClassName, link.id, pathData));
      if (!targets.line) continue;
      // The map's own colour classes (e.g. .scentral) colour these paths, so they match the map in every theme.
      const artwork = getLineArtwork(svg, link.lineId);
      targets.line.appendChild(createPath(document, `app-travelled-line s${artwork.svgClass}`, link.id, pathData));
      if (artwork.casing) targets.lineCasing?.appendChild(createPath(document, `app-travelled-line-casing b${artwork.svgClass}`, link.id, pathData));
      if (partTime) targets.linePartTime?.appendChild(createPath(document, 'app-travelled-line-part-time', link.id, pathData));
    }
  }
}
