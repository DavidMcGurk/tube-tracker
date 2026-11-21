import type { Point } from './section-geometry';
import {
  BANK_MONUMENT_HUB_POINTS,
  getMarkerStation,
  STATION_MARKER_SELECTOR,
  stationsByMapLabel,
  UNNAMED_MARKER_SELECTOR
} from './station-binding';

function centreOf(element: Element) {
  const bounds = element.getBoundingClientRect();
  return new DOMPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
}

/**
 * Measures where each station is drawn, in root SVG user units. Most stations have named `<use>` markers; Aldgate is
 * a group of unnamed markers, and Bank/Monument are drawn as a single hub group with known internal positions.
 * Returns null if the SVG is not laid out yet.
 */
export function measureStationAnchors(svg: SVGSVGElement): Map<string, Point[]> | null {
  const svgMatrix = svg.getScreenCTM();
  if (!svgMatrix) return null;
  const screenToSvg = svgMatrix.inverse();
  const anchors = new Map<string, Point[]>();
  const add = (stationId: string, screenPoint: DOMPoint) => {
    const point = screenPoint.matrixTransform(screenToSvg);
    const points = anchors.get(stationId) ?? [];
    points.push({ x: point.x, y: point.y });
    anchors.set(stationId, points);
  };

  for (const marker of svg.querySelectorAll<SVGElement>(STATION_MARKER_SELECTOR)) {
    const station = getMarkerStation(marker);
    if (station) add(station.id, centreOf(marker));
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
