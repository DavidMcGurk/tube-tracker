import type { NetworkLink, RouteChange, RouteLeg, RouteResult } from '../lib/types';
import type { LineService } from './line-services';
import { MinHeap } from './min-heap';
import type { TrackSection } from './track-section';
import type { WalkLink } from './walk-link';

/**
 * Journey planning tuned for "how would I ride this?" rather than strict shortest distance:
 * routes are ranked by number of changes first, then by distance (walking weighted as slower than riding).
 */
export interface RoutingOptions {
  /** Metres added per change while searching, so candidate generation favours fewer changes. */
  changePenalty: number;
  /** Walking metres count this many times when comparing route lengths. */
  walkFactor: number;
  /** Options must be no longer than max(shortest × ratio, shortest + slack)… */
  maxDistanceRatio: number;
  maxDistanceSlack: number;
  /** …and have at most this many more changes than the fewest-changes option. */
  maxExtraChanges: number;
  /** Candidate routes generated before filtering. */
  candidatePoolSize: number;
  /** Highest change count explored when looking for the fewest-changes route. */
  maxFrontierChanges: number;
  /** Alternatives that ride a leg on another line sharing the same track (e.g. Circle vs Metropolitan). */
  maxLineVariants: number;
  /** Through-services for lines whose branches do not all connect without changing (see line-services.ts). */
  lineServices: Readonly<Record<string, readonly LineService[]>>;
}

export const DEFAULT_ROUTING_OPTIONS: RoutingOptions = {
  changePenalty: 2500,
  walkFactor: 3,
  maxDistanceRatio: 1.35,
  maxDistanceSlack: 2000,
  maxExtraChanges: 2,
  candidatePoolSize: 40,
  maxFrontierChanges: 4,
  maxLineVariants: 3,
  lineServices: {}
};

/** Bound on generalised cost for Yen candidates, relative to the best found. */
const CANDIDATE_COST_RATIO = 1.5;
const CANDIDATE_COST_SLACK = 3000;
const EPSILON = 1e-6;

const MODE_START = 0;
const MODE_WALK = 1;
const FIRST_LINE_MODE = 2;

interface LinkOption {
  mode: number;
  link: NetworkLink;
  /** Distance used for comparisons: walking is weighted by walkFactor. */
  effective: number;
}

/** All ways of travelling between one pair of adjacent stations (lines sharing the track, or a walk). */
interface PhysicalEdge {
  a: number;
  b: number;
  options: LinkOption[];
}

interface PlannedRoute {
  stations: number[];
  edges: number[];
  options: LinkOption[];
  changes: number;
  effective: number;
}

interface SearchResult {
  stations: number[];
  edges: number[];
}

/** Change cost of taking `next` after arriving by `previous`; Infinity when not allowed (walk after walk). */
function changeIncrement(previous: number, next: number) {
  if (next === MODE_WALK) return previous === MODE_WALK ? Infinity : 1;
  if (previous === MODE_START || previous === MODE_WALK || previous === next) return 0;
  return 1;
}

export class RoutePlanner {
  private readonly stationIds: string[];
  private readonly stationIndex: Map<string, number>;
  private readonly edges: PhysicalEdge[] = [];
  private readonly adjacency: number[][];
  private readonly lineIdByMode: string[] = [];
  private readonly modeCount: number;
  private readonly options: RoutingOptions;

  constructor(stationIds: readonly string[], links: readonly NetworkLink[], options: Partial<RoutingOptions> = {}) {
    this.options = { ...DEFAULT_ROUTING_OPTIONS, ...options };
    this.stationIds = [...stationIds];
    this.stationIndex = new Map(this.stationIds.map((id, index) => [id, index]));
    this.adjacency = this.stationIds.map(() => []);

    const modeByService = new Map<string, number>();
    const modeFor = (lineId: string, service: string) => {
      const serviceKey = `${lineId}#${service}`;
      let mode = modeByService.get(serviceKey);
      if (mode === undefined) {
        mode = FIRST_LINE_MODE + modeByService.size;
        modeByService.set(serviceKey, mode);
        this.lineIdByMode[mode] = lineId;
      }
      return mode;
    };
    const servicePairs = new Map<string, Set<string>[]>();
    for (const [lineId, services] of Object.entries(this.options.lineServices)) {
      servicePairs.set(lineId, services.map((segments) => new Set(segments.flatMap((stops) =>
        stops.slice(1).flatMap((stop, index) => [`${stops[index]}~${stop}`, `${stop}~${stops[index]}`])))));
    }
    /** The modes a link can be travelled in: one per through-service covering it, or a single mode. */
    const modesOf = (link: NetworkLink): number[] => {
      if (link.type === 'walk') return [MODE_WALK];
      const services = servicePairs.get(link.lineId);
      if (!services) return [modeFor(link.lineId, 'all')];
      const serving = services.flatMap((pairs, service) => (pairs.has(`${link.from}~${link.to}`) ? [modeFor(link.lineId, String(service))] : []));
      return serving.length > 0 ? serving : [modeFor(link.lineId, 'unserviced')];
    };

    const edgeByPair = new Map<string, number>();
    for (const link of links) {
      const a = this.indexOf(link.from);
      const b = this.indexOf(link.to);
      const pairKey = a < b ? `${a}~${b}` : `${b}~${a}`;
      let edgeIndex = edgeByPair.get(pairKey);
      if (edgeIndex === undefined) {
        edgeIndex = this.edges.length;
        edgeByPair.set(pairKey, edgeIndex);
        this.edges.push({ a, b, options: [] });
        this.adjacency[a]!.push(edgeIndex);
        this.adjacency[b]!.push(edgeIndex);
      }
      const effective = link.type === 'walk' ? link.distance * this.options.walkFactor : link.distance;
      for (const mode of modesOf(link)) this.edges[edgeIndex]!.options.push({ mode, link, effective });
    }
    this.modeCount = FIRST_LINE_MODE + modeByService.size;
  }

  /** Route options from start to end, ordered by (changes, distance). */
  plan(startId: string, endId: string, maxRoutes: number): RouteResult[] {
    const start = this.stationIndex.get(startId);
    const end = this.stationIndex.get(endId);
    if (start === undefined || end === undefined) return [];
    if (start === end) return [this.toRouteResult({ stations: [start], edges: [], options: [], changes: 0, effective: 0 })];

    const lowerBounds = this.lowerBounds(end);
    const shortest = lowerBounds[start]!;
    if (!Number.isFinite(shortest)) return [];

    const { maxDistanceRatio, maxDistanceSlack, maxExtraChanges } = this.options;
    const distanceCap = Math.max(shortest * maxDistanceRatio, shortest + maxDistanceSlack) + EPSILON;
    let candidates = [...this.frontier(start, end, lowerBounds), ...this.yen(start, end, lowerBounds)]
      .filter((route) => route.effective <= distanceCap);
    const fewestChanges = Math.min(...candidates.map((route) => route.changes));
    candidates = candidates.filter((route) => route.changes <= fewestChanges + maxExtraChanges);
    candidates = [...candidates, ...candidates.flatMap((route) => this.lineVariants(route))];
    candidates.sort((x, y) => x.changes - y.changes || x.effective - y.effective);

    const unique = new Map<string, RouteResult>();
    for (const candidate of candidates) {
      const result = this.toRouteResult(candidate);
      if (!unique.has(result.key)) unique.set(result.key, result);
    }
    // Label before slicing so an option's label doesn't change with how many options are requested.
    return markDistinguishingStations([...unique.values()]).slice(0, maxRoutes);
  }

  private indexOf(stationId: string) {
    const index = this.stationIndex.get(stationId);
    if (index === undefined) throw new Error(`Link references unknown station "${stationId}"`);
    return index;
  }

  private otherEnd(edge: PhysicalEdge, station: number) {
    return edge.a === station ? edge.b : edge.a;
  }

  /** Shortest effective distance from every station to `target`, ignoring changes (an admissible A* heuristic). */
  private lowerBounds(target: number) {
    const bounds = new Float64Array(this.stationIds.length).fill(Infinity);
    bounds[target] = 0;
    const heap = new MinHeap();
    heap.push(0, target);
    while (heap.size > 0) {
      const station = heap.pop();
      for (const edgeIndex of this.adjacency[station]!) {
        const edge = this.edges[edgeIndex]!;
        const cheapest = Math.min(...edge.options.map((option) => option.effective));
        const next = this.otherEnd(edge, station);
        if (bounds[station]! + cheapest < bounds[next]!) {
          bounds[next] = bounds[station]! + cheapest;
          heap.push(bounds[next]!, next);
        }
      }
    }
    return bounds;
  }

  /** A* over (station, mode) states minimising effective distance plus a penalty per change. */
  private search(
    start: number,
    startMode: number,
    target: number,
    lowerBounds: Float64Array,
    bannedStations: Uint8Array | null,
    bannedEdges: ReadonlySet<number> | null
  ): SearchResult | null {
    const { modeCount } = this;
    const stateCount = this.stationIds.length * modeCount;
    const cost = new Float64Array(stateCount).fill(Infinity);
    const previousState = new Int32Array(stateCount).fill(-1);
    const previousEdge = new Int32Array(stateCount).fill(-1);
    const settled = new Uint8Array(stateCount);
    const initial = start * modeCount + startMode;
    cost[initial] = 0;
    const heap = new MinHeap();
    heap.push(lowerBounds[start]!, initial);

    while (heap.size > 0) {
      const state = heap.pop();
      if (settled[state]) continue;
      settled[state] = 1;
      const station = Math.floor(state / modeCount);
      const mode = state % modeCount;
      if (station === target) {
        const stations = [station];
        const edges: number[] = [];
        for (let current = state; current !== initial; current = previousState[current]!) {
          edges.push(previousEdge[current]!);
          stations.push(Math.floor(previousState[current]! / modeCount));
        }
        return { stations: stations.reverse(), edges: edges.reverse() };
      }
      for (const edgeIndex of this.adjacency[station]!) {
        if (bannedEdges?.has(edgeIndex) || edgeIndex === previousEdge[state]) continue;
        const edge = this.edges[edgeIndex]!;
        const next = this.otherEnd(edge, station);
        if (bannedStations?.[next]) continue;
        for (const option of edge.options) {
          const increment = changeIncrement(mode, option.mode);
          if (increment === Infinity) continue;
          const nextState = next * modeCount + option.mode;
          const nextCost = cost[state]! + option.effective + increment * this.options.changePenalty;
          if (nextCost < cost[nextState]!) {
            cost[nextState] = nextCost;
            previousState[nextState] = state;
            previousEdge[nextState] = edgeIndex;
            heap.push(nextCost + lowerBounds[next]!, nextState);
          }
        }
      }
    }
    return null;
  }

  /**
   * Chooses how to ride a fixed physical path: fewest changes, then shortest; on ties it stays on the current train,
   * so lines sharing track (e.g. Circle and Hammersmith & City) never add a change.
   */
  private relabel(stations: number[], edges: number[]): PlannedRoute {
    type Cost = { changes: number; effective: number };
    let costs = new Map<number, Cost>([[MODE_START, { changes: 0, effective: 0 }]]);
    const steps: Array<Map<number, { previousMode: number; option: LinkOption }>> = [];

    for (const edgeIndex of edges) {
      const nextCosts = new Map<number, Cost>();
      const step = new Map<number, { previousMode: number; option: LinkOption }>();
      for (const option of this.edges[edgeIndex]!.options) {
        for (const [previousMode, previous] of costs) {
          const increment = changeIncrement(previousMode, option.mode);
          if (increment === Infinity) continue;
          const candidate = { changes: previous.changes + increment, effective: previous.effective + option.effective };
          const current = nextCosts.get(option.mode);
          const better = !current
            || candidate.changes < current.changes
            || (candidate.changes === current.changes && (
              candidate.effective < current.effective - EPSILON
              || (Math.abs(candidate.effective - current.effective) < EPSILON && previousMode !== option.mode)
            ));
          if (better) {
            nextCosts.set(option.mode, candidate);
            step.set(option.mode, { previousMode, option });
          }
        }
      }
      steps.push(step);
      costs = nextCosts;
    }

    let bestMode = -1;
    let best: Cost = { changes: Infinity, effective: Infinity };
    for (const [mode, cost] of costs) {
      if (cost.changes < best.changes || (cost.changes === best.changes && cost.effective < best.effective)) {
        best = cost;
        bestMode = mode;
      }
    }
    const options: LinkOption[] = new Array(edges.length);
    for (let index = edges.length - 1, mode = bestMode; index >= 0; index -= 1) {
      const step = steps[index]!.get(mode)!;
      options[index] = step.option;
      mode = step.previousMode;
    }
    return { stations, edges, options, changes: best.changes, effective: best.effective };
  }

  private hasRepeatedStation(stations: readonly number[]) {
    return new Set(stations).size !== stations.length;
  }

  /** The shortest route for each achievable change count, from most changes down to the fewest (≤ maxFrontierChanges). */
  private frontier(start: number, end: number, lowerBounds: Float64Array): PlannedRoute[] {
    const { modeCount } = this;
    const changeLevels = this.options.maxFrontierChanges + 1;
    const stateCount = this.stationIds.length * modeCount * changeLevels;
    const stateOf = (station: number, mode: number, changes: number) => (station * modeCount + mode) * changeLevels + changes;
    const cost = new Float64Array(stateCount).fill(Infinity);
    const previousState = new Int32Array(stateCount).fill(-1);
    const previousEdge = new Int32Array(stateCount).fill(-1);
    const settled = new Uint8Array(stateCount);
    const initial = stateOf(start, MODE_START, 0);
    cost[initial] = 0;
    const heap = new MinHeap();
    heap.push(lowerBounds[start]!, initial);

    const routes: PlannedRoute[] = [];
    let fewestChanges = Infinity;
    while (heap.size > 0) {
      const state = heap.pop();
      if (settled[state]) continue;
      settled[state] = 1;
      const changes = state % changeLevels;
      const stationMode = Math.floor(state / changeLevels);
      const mode = stationMode % modeCount;
      const station = Math.floor(stationMode / modeCount);

      if (station === end) {
        if (changes < fewestChanges) {
          fewestChanges = changes;
          const stations = [station];
          const edges: number[] = [];
          for (let current = state; current !== initial; current = previousState[current]!) {
            edges.push(previousEdge[current]!);
            stations.push(Math.floor(Math.floor(previousState[current]! / changeLevels) / modeCount));
          }
          stations.reverse();
          edges.reverse();
          if (!this.hasRepeatedStation(stations)) routes.push(this.relabel(stations, edges));
        }
        if (fewestChanges === 0) break;
        continue;
      }
      // Anything with at least as many changes as a route already found is dominated by it.
      if (changes >= fewestChanges) continue;

      for (const edgeIndex of this.adjacency[station]!) {
        if (edgeIndex === previousEdge[state]) continue;
        const edge = this.edges[edgeIndex]!;
        const next = this.otherEnd(edge, station);
        for (const option of edge.options) {
          const increment = changeIncrement(mode, option.mode);
          if (increment === Infinity || changes + increment >= changeLevels) continue;
          const nextState = stateOf(next, option.mode, changes + increment);
          const nextCost = cost[state]! + option.effective;
          if (nextCost < cost[nextState]!) {
            cost[nextState] = nextCost;
            previousState[nextState] = state;
            previousEdge[nextState] = edgeIndex;
            heap.push(nextCost + lowerBounds[next]!, nextState);
          }
        }
      }
    }
    return routes;
  }

  /** Yen's k-shortest paths over physical edges, ranked by generalised cost (distance + change penalty). */
  private yen(start: number, end: number, lowerBounds: Float64Array): PlannedRoute[] {
    const generalisedCost = (route: PlannedRoute) => route.effective + this.options.changePenalty * route.changes;
    const first = this.search(start, MODE_START, end, lowerBounds, null, null);
    if (!first) return [];

    const accepted = [this.relabel(first.stations, first.edges)];
    const seen = new Set([accepted[0]!.edges.join(',')]);
    const costBound = generalisedCost(accepted[0]!) * CANDIDATE_COST_RATIO + CANDIDATE_COST_SLACK;
    const pending: PlannedRoute[] = [];

    while (accepted.length < this.options.candidatePoolSize) {
      const previous = accepted.at(-1)!;
      for (let spurIndex = 0; spurIndex < previous.edges.length; spurIndex += 1) {
        const rootEdges = previous.edges.slice(0, spurIndex);
        const bannedEdges = new Set<number>();
        for (const route of accepted) {
          if (route.edges.length > spurIndex && rootEdges.every((edge, index) => route.edges[index] === edge)) {
            bannedEdges.add(route.edges[spurIndex]!);
          }
        }
        const bannedStations = new Uint8Array(this.stationIds.length);
        for (let index = 0; index < spurIndex; index += 1) bannedStations[previous.stations[index]!] = 1;

        const spurMode = spurIndex === 0 ? MODE_START : previous.options[spurIndex - 1]!.mode;
        const spur = this.search(previous.stations[spurIndex]!, spurMode, end, lowerBounds, bannedStations, bannedEdges);
        if (!spur) continue;

        const stations = [...previous.stations.slice(0, spurIndex), ...spur.stations];
        const edges = [...rootEdges, ...spur.edges];
        const key = edges.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.hasRepeatedStation(stations)) continue;
        const candidate = this.relabel(stations, edges);
        if (generalisedCost(candidate) <= costBound) pending.push(candidate);
      }
      if (pending.length === 0) break;
      let bestIndex = 0;
      for (let index = 1; index < pending.length; index += 1) {
        if (generalisedCost(pending[index]!) < generalisedCost(pending[bestIndex]!)) bestIndex = index;
      }
      accepted.push(pending.splice(bestIndex, 1)[0]!);
    }
    return accepted;
  }

  /** The same physical route with one leg ridden on another line that shares all of that leg's track. */
  private lineVariants(route: PlannedRoute): PlannedRoute[] {
    const variants: PlannedRoute[] = [];
    let legStart = 0;
    while (legStart < route.options.length) {
      const mode = route.options[legStart]!.mode;
      let legEnd = legStart;
      while (legEnd + 1 < route.options.length && route.options[legEnd + 1]!.mode === mode) legEnd += 1;

      if (mode !== MODE_WALK) {
        const legEdges = route.edges.slice(legStart, legEnd + 1);
        const lineId = this.lineIdByMode[mode];
        const sharedModes = this.edges[route.edges[legStart]!]!.options
          .map((option) => option.mode)
          .filter((other) => other !== MODE_WALK && this.lineIdByMode[other] !== lineId
            && legEdges.every((edge) => this.edges[edge]!.options.some((option) => option.mode === other)));
        for (const other of sharedModes) {
          if (variants.length >= this.options.maxLineVariants) return variants;
          const options = route.options.map((option, index) => (index >= legStart && index <= legEnd
            ? this.edges[route.edges[index]!]!.options.find((candidate) => candidate.mode === other)!
            : option));
          variants.push({ ...route, options, effective: options.reduce((sum, option) => sum + option.effective, 0) });
        }
      }
      legStart = legEnd + 1;
    }
    return variants;
  }

  private toRouteResult(route: PlannedRoute): RouteResult {
    const path = route.stations.map((index) => this.stationIds[index]!);
    const links = route.options.map((option) => option.link);
    const legs: RouteLeg[] = [];
    route.options.forEach(({ link, mode }, index) => {
      const from = path[index]!;
      const to = path[index + 1]!;
      if (link.type === 'walk') {
        legs.push({ type: 'walk', from, to, link });
        return;
      }
      const lastLeg = legs.at(-1);
      // Consecutive sections form one leg only when ridden on the same train (same line and service).
      if (lastLeg?.type === 'ride' && route.options[index - 1]?.mode === mode) {
        legs[legs.length - 1] = { ...lastLeg, to, sections: [...lastLeg.sections, link] };
      } else {
        legs.push({ type: 'ride', lineId: link.lineId, from, to, sections: [link] });
      }
    });

    const changes: RouteChange[] = [];
    legs.forEach((leg, index) => {
      if (leg.type === 'walk') changes.push({ type: 'walk', from: leg.from, to: leg.to, kind: leg.link.kind });
      else if (legs[index - 1]?.type === 'ride') changes.push({ type: 'line', at: leg.from });
    });

    const sections = links.filter((link): link is TrackSection => link.type === 'track');
    const walks = links.filter((link): link is WalkLink => link.type === 'walk');
    return {
      key: links.length > 0 ? links.map((link) => link.id).join('|') : path.join('|'),
      path,
      links,
      sections,
      walks,
      legs,
      changes,
      trackDistance: sections.reduce((sum, section) => sum + section.distance, 0),
      walkDistance: walks.reduce((sum, walk) => sum + walk.distance, 0)
    };
  }
}

/** For options that ride the same lines with the same changes, records a station that tells them apart. */
function markDistinguishingStations(routes: RouteResult[]): RouteResult[] {
  const legSignature = (route: RouteResult) => route.legs
    .map((leg) => `${leg.type === 'walk' ? 'walk' : leg.lineId}:${leg.from}>${leg.to}`)
    .join('|');
  const groups = new Map<string, RouteResult[]>();
  for (const route of routes) {
    const signature = legSignature(route);
    groups.set(signature, [...(groups.get(signature) ?? []), route]);
  }
  return routes.map((route) => {
    const group = groups.get(legSignature(route))!;
    if (group.length < 2) return route;
    const reference = group[0] === route ? group[1]! : group[0]!;
    const via = route.path.slice(1, -1).find((stationId) => !reference.path.includes(stationId));
    return via ? { ...route, via } : route;
  });
}
