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

/**
 * A component plus the rank of the SVG class it came from (0 = the line's primary class), and whether the map marks
 * its path as a part-time service with white dashes (a `.branch` overlay, e.g. the District line's Olympia branch).
 */
export interface RankedComponent {
  points: PathComponent;
  classRank: number;
  partTime?: boolean;
}

export interface ClosestPoint {
  index: number;
  distance: number;
}

/**
 * SVG route classes (`.s<class>`) for each line id where they differ from the id itself. The Northern line's
 * Edgware, Charing Cross and Battersea branches are drawn as a separate `sedgware` path.
 */
export const LINE_SVG_CLASSES: Record<string, readonly string[]> = {
  hammersmith_city: ['hnc'],
  waterloo_city: ['wnc'],
  northern: ['northern', 'edgware']
};

export function getLineSvgClasses(lineId: string): readonly string[] {
  return LINE_SVG_CLASSES[lineId] ?? [lineId];
}

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
export function sampleLineComponents(svg: SVGSVGElement, lineId: string): RankedComponent[] | null {
  const svgMatrix = svg.getScreenCTM();
  if (!svgMatrix) return null;
  const screenToSvg = svgMatrix.inverse();

  const partTimePathIds = new Set([...svg.querySelectorAll('#routes use.branch')].map((overlay) =>
    (overlay.getAttribute('href') ?? overlay.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '').replace(/^#/, '')));
  const components: RankedComponent[] = [];
  getLineSvgClasses(lineId).forEach((pathClass, classRank) => {
    for (const path of svg.querySelectorAll<SVGPathElement>(`#routes .s${pathClass} path, #routes path.s${pathClass}`)) {
      const samples = samplePath(path, screenToSvg);
      if (!samples) continue;
      const partTime = partTimePathIds.has(path.id);
      for (const points of splitIntoComponents(samples)) components.push({ points, classRank, ...(partTime ? { partTime } : {}) });
    }
  });
  return components;
}

/**
 * Joins two components whose ends touch (within the path gap), orienting them so the touching ends meet.
 * Used as a fallback when a section's stations sit on two separately drawn paths.
 */
export function joinTouchingComponents(a: PathComponent, b: PathComponent): Point[] | null {
  const orientations: Array<[PathComponent, PathComponent]> = [
    [a, b],
    [a, [...b].reverse()],
    [[...a].reverse(), b],
    [[...a].reverse(), [...b].reverse()]
  ];
  for (const [first, second] of orientations) {
    const end = first.at(-1);
    const start = second[0];
    if (end && start && Math.hypot(end.x - start.x, end.y - start.y) <= maximumPathGap) return [...first, ...second];
  }
  return null;
}

export function polylineLength(points: readonly Point[]) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
  }
  return length;
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
