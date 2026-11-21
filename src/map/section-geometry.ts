/*
 * Sampling of the reference map's drawn route paths, in root SVG user units, so that track sections can be traced
 * along the lines as drawn. User units do not change with zoom or scroll, so samples can be cached per SVG document.
 */

export interface Point {
  x: number;
  y: number;
}

/** A continuous run of samples along one drawn path (paths are split wherever consecutive samples jump apart). */
export type PathComponent = readonly Point[];

export interface ClosestPoint {
  index: number;
  distance: number;
}

/** SVG route class for each line id where it differs from the id itself. */
export const routePathClassAliases: Record<string, string> = {
  hammersmith_city: 'hnc',
  waterloo_city: 'wnc'
};

/** Consecutive samples further apart than this belong to different components (e.g. a path's separate subpaths). */
export const maximumPathGap = 12;
const sampleStep = 2.5;

function samplePath(path: SVGGeometryElement, screenToSvg: DOMMatrix): Point[] | null {
  const totalLength = path.getTotalLength();
  if (totalLength <= 0) return null;
  const pathToScreen = path.getScreenCTM();
  if (!pathToScreen) return null;
  const toSvg = screenToSvg.multiply(pathToScreen);

  const samples: Point[] = [];
  const addSample = (length: number) => {
    const point = path.getPointAtLength(length).matrixTransform(toSvg);
    samples.push({ x: point.x, y: point.y });
  };
  for (let length = 0; length < totalLength; length += sampleStep) addSample(length);
  addSample(totalLength);
  return samples;
}

function splitIntoComponents(samples: readonly Point[]): Point[][] {
  const components: Point[][] = [];
  let component: Point[] = [];
  for (const sample of samples) {
    const previous = component.at(-1);
    if (previous && Math.hypot(sample.x - previous.x, sample.y - previous.y) > maximumPathGap) {
      components.push(component);
      component = [];
    }
    component.push(sample);
  }
  if (component.length > 0) components.push(component);
  return components;
}

/** Returns null when the SVG is not laid out yet (so the result must not be cached). */
export function sampleLineComponents(svg: SVGSVGElement, lineId: string): Point[][] | null {
  const svgMatrix = svg.getScreenCTM();
  if (!svgMatrix) return null;
  const screenToSvg = svgMatrix.inverse();
  const pathClass = routePathClassAliases[lineId] ?? lineId;
  const paths = svg.querySelectorAll<SVGPathElement>(`#routes .s${pathClass} path, #routes path.s${pathClass}`);

  const components: Point[][] = [];
  for (const path of paths) {
    const samples = samplePath(path, screenToSvg);
    if (samples) components.push(...splitIntoComponents(samples));
  }
  return components;
}

/** Samples the Bank–Monument interchange connector drawn inside the station hub. */
export function sampleInterchangePath(svg: SVGSVGElement): Point[] | null {
  const svgMatrix = svg.getScreenCTM();
  const path = svg.querySelector<SVGPathElement>('#station_nodes #Bank_Monument_hub path');
  if (!svgMatrix || !path) return null;
  return samplePath(path, svgMatrix.inverse());
}

export function closestPointOnComponent(component: PathComponent, positions: readonly Point[]): ClosestPoint | null {
  let closest: ClosestPoint | null = null;
  component.forEach((sample, index) => {
    for (const position of positions) {
      const distance = Math.hypot(sample.x - position.x, sample.y - position.y);
      if (!closest || distance < closest.distance) closest = { index, distance };
    }
  });
  return closest;
}

export function toPathData(points: readonly Point[]) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}
