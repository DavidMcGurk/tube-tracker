import { sections } from '../data/network';
import {
  closestPointOnRoutePath,
  getRoutePathGeometries,
  maximumPathGap,
  type ClosestRoutePoint,
  type RoutePathGeometry,
  type RoutePathSample
} from './section-geometry';
import { getMarkerStation } from './station-binding';

/** Draws the given track sections as a highlight layer that follows the map's own line geometry. */
export function updateSectionHighlightLayer(
  svg: SVGSVGElement,
  layerId: string,
  className: string,
  sectionIds: readonly string[]
) {
  const routeGroup = svg.querySelector<SVGGElement>('#routes');
  if (!routeGroup) return;

  let layer = svg.querySelector<SVGGElement>(`#${layerId}`);
  if (!layer) {
    layer = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = layerId;
    layer.setAttribute('aria-hidden', 'true');
    const insertBefore = layerId === 'app-route-preview-sections'
      ? svg.querySelector('#app-travelled-sections') ?? routeGroup
      : routeGroup;
    routeGroup.parentNode?.insertBefore(layer, insertBefore);
  }
  layer.replaceChildren();
  const colorLayer = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.appendChild(colorLayer);

  const svgMatrix = svg.getScreenCTM();
  if (!svgMatrix || sectionIds.length === 0) return;

  const toSvgCoordinates = svgMatrix.inverse();
  const stationPositions = new Map<string, { x: number; y: number }[]>();
  const stationMarkers = [...svg.querySelectorAll<SVGElement>('#station_nodes use[id]')];
  for (const marker of stationMarkers) {
    const station = getMarkerStation(marker);
    if (!station) continue;

    const bounds = marker.getBoundingClientRect();
    const point = svg.createSVGPoint();
    point.x = bounds.left + bounds.width / 2;
    point.y = bounds.top + bounds.height / 2;
    const position = point.matrixTransform(toSvgCoordinates);
    const positions = stationPositions.get(station.id) ?? [];
    positions.push({ x: position.x, y: position.y });
    stationPositions.set(station.id, positions);
  }

  const requestedSections = sections.filter((section) => sectionIds.includes(section.id));
  const pathsByLine = getRoutePathGeometries(svg, requestedSections.map((section) => section.lineId));
  const maximumMarkerOffset = 32;

  for (const section of requestedSections) {
    if (section.lineId === 'interchange') {
      const interchangePath = pathsByLine.get(section.lineId)?.[0];
      if (!interchangePath || interchangePath.samples.length < 2) {
        console.warn(`Unable to show map geometry for interchange section "${section.id}"`);
        continue;
      }

      const pathData = interchangePath.samples.map((point, index) =>
        `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
      ).join(' ');
      const path = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', className);
      path.setAttribute('data-app-section-id', section.id);
      path.setAttribute('d', pathData);
      colorLayer.appendChild(path);
      continue;
    }

    const from = stationPositions.get(section.from);
    const to = stationPositions.get(section.to);
    if (!from?.length || !to?.length) {
      console.warn(`Unable to show section "${section.id}" because a station marker is missing`);
      continue;
    }

    let bestPath: RoutePathGeometry | null = null;
    let bestFrom: ClosestRoutePoint | null = null;
    let bestTo: ClosestRoutePoint | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const geometry of pathsByLine.get(section.lineId) ?? []) {
      let component: RoutePathSample[] = [];
      const components: RoutePathSample[][] = [];
      for (const sample of geometry.samples) {
        const previous = component.at(-1);
        if (previous && Math.hypot(sample.x - previous.x, sample.y - previous.y) > maximumPathGap) {
          components.push(component);
          component = [];
        }
        component.push(sample);
      }
      if (component.length > 0) components.push(component);

      for (const samples of components) {
        const continuousGeometry = { path: geometry.path, samples };
        const routeFrom = closestPointOnRoutePath(continuousGeometry, from);
        const routeTo = closestPointOnRoutePath(continuousGeometry, to);
        if (!routeFrom || !routeTo
          || routeFrom.distance > maximumMarkerOffset
          || routeTo.distance > maximumMarkerOffset) continue;

        const score = routeFrom.distance + routeTo.distance;
        if (score < bestScore) {
          bestScore = score;
          bestPath = continuousGeometry;
          bestFrom = routeFrom;
          bestTo = routeTo;
        }
      }
    }

    if (!bestPath || !bestFrom || !bestTo) {
      console.warn(`Unable to follow map line geometry for section "${section.id}"`);
      continue;
    }

    const startIndex = bestPath.samples.findIndex((sample) => sample.length === bestFrom.length);
    const endIndex = bestPath.samples.findIndex((sample) => sample.length === bestTo.length);
    const lowIndex = Math.min(startIndex, endIndex);
    const highIndex = Math.max(startIndex, endIndex);
    const tracedPoints = bestPath.samples.slice(lowIndex, highIndex + 1);
    if (tracedPoints.length < 2) continue;
    const pathData = tracedPoints.map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
    ).join(' ');

    const path = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', className);
    path.setAttribute('data-app-section-id', section.id);
    path.setAttribute('d', pathData);
    colorLayer.appendChild(path);
  }
}
