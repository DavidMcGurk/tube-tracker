import { lines, network } from '../data/network';
import { LINE_SVG_CLASSES } from './section-geometry';
import { getMarkerStation } from './station-binding';

/** A station's tick (or terminus bar) on one line. */
interface StationTick {
  element: SVGElement;
  stationId: string;
  lineId: string;
  /** The marker's own transform, before any thinning. */
  transform: string;
  /** Where the marker places the tick symbol's origin, within its transform. */
  x: number;
  y: number;
}

/** The map's lines and ticks are 5 units wide. */
const MAP_LINE_WIDTH = 5;

/** The map's tick symbols are named after their line, some with a variant suffix: #stcentral, #stpiccadilly2, #stpiccadillye, #termmildmay. */
const TICK_SYMBOL = /^#(?:st|term)([a-z]+)2?$/;
const knownLineIds = new Set(lines.map((line) => line.id));
const lineIdBySvgClass = new Map(Object.entries(LINE_SVG_CLASSES).flatMap(([lineId, classes]) => classes.map((svgClass) => [svgClass, lineId] as const)));
const tickCache = new WeakMap<SVGSVGElement, StationTick[]>();

/** The line a tick symbol belongs to. The full name is tried first, as many line names end in "e". */
export function getTickLineId(href: string) {
  const name = TICK_SYMBOL.exec(href)?.[1];
  if (!name) return null;
  for (const candidate of [name, name.replace(/e$/, '')]) {
    const lineId = lineIdBySvgClass.get(candidate) ?? candidate;
    if (knownLineIds.has(lineId)) return lineId;
  }
  return null;
}

function indexStationTicks(svg: SVGSVGElement): StationTick[] {
  const cached = tickCache.get(svg);
  if (cached) return cached;
  const ticks: StationTick[] = [];
  for (const element of svg.querySelectorAll<SVGUseElement>('#station_nodes use[id]')) {
    const href = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
    const lineId = getTickLineId(href);
    const stationId = lineId ? getMarkerStation(element)?.id : undefined;
    if (lineId && stationId) {
      ticks.push({ element, stationId, lineId, transform: element.getAttribute('transform') ?? '', x: element.x.baseVal.value, y: element.y.baseVal.value });
    }
  }
  tickCache.set(svg, ticks);
  return ticks;
}

/**
 * How much to thin untravelled ticks so they match untravelled lines, whose width styles.css sets in
 * --tt-untravelled-line-width; null leaves every tick at its normal width.
 */
export function getUntravelledTickScale(svg: SVGSVGElement): number | null {
  const width = Number.parseFloat(getComputedStyle(svg).getPropertyValue('--tt-untravelled-line-width'));
  return Number.isFinite(width) && width > 0 && width < MAP_LINE_WIDTH ? width / MAP_LINE_WIDTH : null;
}

/**
 * Marks the ticks of stations on travelled track, and thins the others by `thinScale` (null leaves them alone), so in
 * the "bold lines" progress style they are as thin as their untravelled lines. A tick counts as travelled when a
 * travelled section of its line ends at its station.
 *
 * Ticks are thinned by scaling the marker across the tick: the tick symbol is shared by every station, and its width
 * can't be styled per station.
 */
export function applyTickProgress(svg: SVGSVGElement, travelledSectionIds: readonly string[], thinScale: number | null) {
  const travelled = new Set<string>();
  for (const sectionId of travelledSectionIds) {
    const section = network.getSection(sectionId);
    if (!section) continue;
    travelled.add(`${section.from}|${section.lineId}`);
    travelled.add(`${section.to}|${section.lineId}`);
  }
  for (const { element, stationId, lineId, transform, x, y } of indexStationTicks(svg)) {
    const isTravelled = travelled.has(`${stationId}|${lineId}`);
    element.toggleAttribute('data-app-tick-travelled', isTravelled);
    if (thinScale === null || isTravelled) {
      element.setAttribute('transform', transform);
      continue;
    }
    // Scale about the tick's origin, which the marker's x and y place after its transform.
    const scale = `scale(1 ${thinScale.toFixed(3)})`;
    const thinning = x || y ? `translate(${x} ${y}) ${scale} translate(${-x} ${-y})` : scale;
    element.setAttribute('transform', `${transform} ${thinning}`.trim());
  }
}
