/* Sampling of the reference map's route paths so track sections can be traced along the drawn lines. */

export interface RoutePathSample {
  length: number;
  x: number;
  y: number;
}

export interface RoutePathGeometry {
  path: SVGPathElement;
  samples: RoutePathSample[];
}

export interface ClosestRoutePoint extends RoutePathSample {
  distance: number;
}

export const routePathClassAliases: Record<string, string> = {
  hammersmith_city: 'hnc',
  waterloo_city: 'wnc'
};
export const maximumPathGap = 12;

export function getRoutePathGeometries(svg: SVGSVGElement, lineIds: readonly string[]) {
  const geometries = new Map<string, RoutePathGeometry[]>();
  const svgMatrix = svg.getScreenCTM();
  if (!svgMatrix) return geometries;
  const screenToSvg = svgMatrix.inverse();

  for (const lineId of new Set(lineIds)) {
    const pathClass = routePathClassAliases[lineId] ?? lineId;
    const paths = lineId === 'interchange'
      ? svg.querySelectorAll<SVGPathElement>('#station_nodes #Bank_Monument_hub path')
      : svg.querySelectorAll<SVGPathElement>(
        `#routes .s${pathClass} path, #routes path.s${pathClass}`
      );
    const pathGeometries: RoutePathGeometry[] = [];

    paths.forEach((path) => {
      const totalLength = path.getTotalLength();
      if (totalLength <= 0) return;
      const pathToScreen = path.getScreenCTM();
      if (!pathToScreen) return;

      const samples: RoutePathSample[] = [];
      const sampleStep = 2.5;
      for (let length = 0; length < totalLength; length += sampleStep) {
        const point = path.getPointAtLength(length).matrixTransform(pathToScreen).matrixTransform(screenToSvg);
        samples.push({ length, x: point.x, y: point.y });
      }
      const finalPoint = path.getPointAtLength(totalLength).matrixTransform(pathToScreen).matrixTransform(screenToSvg);
      samples.push({ length: totalLength, x: finalPoint.x, y: finalPoint.y });
      pathGeometries.push({ path, samples });
    });

    geometries.set(lineId, pathGeometries);
  }
  return geometries;
}

export function closestPointOnRoutePath(geometry: RoutePathGeometry, positions: readonly { x: number; y: number }[]) {
  let closest: ClosestRoutePoint | null = null;
  for (const sample of geometry.samples) {
    for (const position of positions) {
      const distance = Math.hypot(sample.x - position.x, sample.y - position.y);
      if (!closest || distance < closest.distance) closest = { ...sample, distance };
    }
  }
  return closest;
}
