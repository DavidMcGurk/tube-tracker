import type { Point } from './section-geometry';

/**
 * A station's drawn position. With `onLine`, a tick marker gives the point on its own line, plus that line and the
 * middle of the tick: a station whose only marker is another line's tick (e.g. Heathrow Terminals 2 & 3, a Piccadilly
 * tick, for the Elizabeth line) is better placed by the middle of the tick when tracing the other line.
 */
export interface StationAnchor extends Point {
  lineId?: string;
  centre?: Point;
}
import {
  BANK_MONUMENT_HUB_POINTS,
  getMarkerStation,
  STATION_MARKER_SELECTOR,
  stationsByMapLabel,
  UNNAMED_MARKER_SELECTOR
} from './station-binding';
import { getTickLineId } from './station-ticks';

function centreOf(element: Element) {
  const bounds = element.getBoundingClientRect();
  return new DOMPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
}

/** The point a tick or terminus marker is drawn from: on its line, where the tick starts. */
function lineOriginOf(marker: SVGUseElement) {
  const matrix = marker.getScreenCTM();
  // A marker is placed by its transform, its x and y, or both; its screen CTM covers only the transform.
  return matrix ? new DOMPoint(marker.x.baseVal.value, marker.y.baseVal.value).matrixTransform(matrix) : centreOf(marker);
}

function hrefOf(marker: SVGElement) {
  return marker.getAttribute('href') ?? marker.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
}

/**
 * Measures where each station is drawn, in root SVG user units. Most stations have named `<use>` markers; Aldgate is
 * a group of unnamed markers, and Bank/Monument are drawn as a single hub group with known internal positions.
 * With `onLine`, tick markers give the point on their line rather than the middle of the tick, which matters where a
 * tick reaches towards another line (e.g. between the Weaver line's two tracks at London Fields).
 * Returns null if the SVG is not laid out yet.
 */
export function measureStationAnchors(svg: SVGSVGElement, { onLine = false }: { onLine?: boolean } = {}): Map<string, StationAnchor[]> | null {
  const svgMatrix = svg.getScreenCTM();
  if (!svgMatrix) return null;
  const screenToSvg = svgMatrix.inverse();
  const anchors = new Map<string, StationAnchor[]>();
  const toSvg = (screenPoint: DOMPoint) => {
    const point = screenPoint.matrixTransform(screenToSvg);
    return { x: point.x, y: point.y };
  };
  const add = (stationId: string, screenPoint: DOMPoint, tick?: { lineId: string; centre: DOMPoint }) => {
    const points = anchors.get(stationId) ?? [];
    points.push(tick ? { ...toSvg(screenPoint), lineId: tick.lineId, centre: toSvg(tick.centre) } : toSvg(screenPoint));
    anchors.set(stationId, points);
  };

  for (const marker of svg.querySelectorAll<SVGElement>(STATION_MARKER_SELECTOR)) {
    const station = getMarkerStation(marker);
    if (!station) continue;
    const tickLineId = onLine && marker instanceof SVGUseElement ? getTickLineId(hrefOf(marker)) : null;
    if (tickLineId) add(station.id, lineOriginOf(marker as SVGUseElement), { lineId: tickLineId, centre: centreOf(marker) });
    else add(station.id, centreOf(marker));
  }

  for (const group of svg.querySelectorAll<SVGElement>('#station_nodes g[id]')) {
    const station = getMarkerStation(group);
    if (!station || anchors.has(station.id)) continue;
    for (const marker of group.querySelectorAll(UNNAMED_MARKER_SELECTOR)) add(station.id, centreOf(marker));
  }

  const hubMatrix = svg.querySelector<SVGGElement>('#Bank_Monument_hub')?.getScreenCTM();
  if (hubMatrix) {
    for (const point of BANK_MONUMENT_HUB_POINTS) {
      const station = stationsByMapLabel.get(point.label)?.[0];
      if (station && !anchors.has(station.id)) add(station.id, new DOMPoint(point.x, point.y).matrixTransform(hubMatrix));
    }
  }
  return anchors;
}
