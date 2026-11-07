import type { RouteResult } from '../lib/types';
import { Station, type StationRecord } from './station';
import { TrackSection, type TrackSectionRecord } from './track-section';

interface NetworkRoute extends RouteResult {
  segments: TrackSection[];
}

export class TransitNetwork {
  readonly stations: readonly Station[];
  readonly sections: readonly TrackSection[];
  private readonly stationById: ReadonlyMap<string, Station>;

  constructor(stationRecords: readonly StationRecord[], sectionRecords: readonly TrackSectionRecord[]) {
    const stationById = new Map<string, Station>();
    for (const record of stationRecords) {
      if (stationById.has(record.id)) {
        throw new Error(`Duplicate station ID "${record.id}"`);
      }
      stationById.set(record.id, new Station(record));
    }

    const sectionIds = new Set<string>();
    const sections = sectionRecords.map((record) => {
      if (sectionIds.has(record.id)) {
        throw new Error(`Duplicate section ID "${record.id}"`);
      }
      sectionIds.add(record.id);

      const section = new TrackSection(record);
      const from = stationById.get(section.from);
      const to = stationById.get(section.to);
      if (!from || !to) {
        throw new Error(`Section "${section.id}" references an unknown station`);
      }
      from.connect(section);
      to.connect(section);
      return section;
    });

    this.stationById = stationById;
    this.stations = Object.freeze([...stationById.values()]);
    this.sections = Object.freeze(sections);
  }

  getStation(stationId: string) {
    return this.stationById.get(stationId);
  }

  findRoute(startStationId: string, endStationId: string): RouteResult | null {
    return this.findRoutes(startStationId, endStationId, 1)[0] ?? null;
  }

  findRoutes(startStationId: string, endStationId: string, maxRoutes = 5, maxDistanceRatio = 1.2): RouteResult[] {
    if (!Number.isInteger(maxRoutes) || maxRoutes < 1) {
      throw new Error('Maximum route count must be a positive integer');
    }
    if (!Number.isFinite(maxDistanceRatio) || maxDistanceRatio < 1) {
      throw new Error('Maximum route distance ratio must be at least 1');
    }

    const start = this.stationById.get(startStationId);
    if (!start || !this.stationById.has(endStationId)) return [];
    if (startStationId === endStationId) {
      return [{ path: [startStationId], segments: [], transferStations: [] }];
    }

    const firstRoute = this.findShortestPath(startStationId, endStationId);
    if (!firstRoute) return [];

    const routes: NetworkRoute[] = [firstRoute];
    const candidates = new Map<string, NetworkRoute>();
    const distanceOf = (route: RouteResult) => route.segments.reduce((sum, section) => sum + section.distance, 0);
    const maxDistance = distanceOf(firstRoute) * maxDistanceRatio;
    const maxTransfers = firstRoute.transferStations.length + 1;

    for (let routeIndex = 1; routeIndex < maxRoutes; routeIndex += 1) {
      const previousRoute = routes[routeIndex - 1];
      if (!previousRoute) break;

      for (let spurIndex = 0; spurIndex < previousRoute.path.length - 1; spurIndex += 1) {
        const rootPath = previousRoute.path.slice(0, spurIndex + 1);
        const rootSections = previousRoute.segments.slice(0, spurIndex);
        const bannedSectionIds = new Set<string>();

        for (const route of routes) {
          const sharesRoot = rootSections.every((section, index) => route.segments[index]?.id === section.id);
          if (sharesRoot) {
            const nextSection = route.segments[spurIndex];
            if (nextSection) bannedSectionIds.add(nextSection.id);
          }
        }

        const bannedStationIds = new Set(rootPath.slice(0, -1));
        const spurRoute = this.findShortestPath(
          rootPath[rootPath.length - 1]!,
          endStationId,
          bannedStationIds,
          bannedSectionIds
        );
        if (!spurRoute) continue;

        const candidate = this.createRoute(
          [...rootPath.slice(0, -1), ...spurRoute.path],
          [...rootSections, ...spurRoute.segments]
        );
        if (distanceOf(candidate) > maxDistance || candidate.transferStations.length > maxTransfers) continue;

        const key = candidate.segments.map((section) => section.id).join('|');
        if (!routes.some((route) => route.segments.map((section) => section.id).join('|') === key)) {
          candidates.set(key, candidate);
        }
      }

      const next = [...candidates.entries()].sort(([, a], [, b]) =>
        distanceOf(a) - distanceOf(b)
        || a.transferStations.length - b.transferStations.length
        || a.segments.length - b.segments.length
        || a.segments.map((section) => section.id).join('|').localeCompare(b.segments.map((section) => section.id).join('|'))
      )[0];
      if (!next) break;
      candidates.delete(next[0]);
      routes.push(next[1]);
    }

    return routes;
  }

  private findShortestPath(
    startStationId: string,
    endStationId: string,
    bannedStationIds = new Set<string>(),
    bannedSectionIds = new Set<string>()
  ): NetworkRoute | null {
    interface SearchState {
      stationId: string;
      lineId: string | null;
    }

    interface SearchCost {
      distance: number;
      transfers: number;
    }

    const stateKey = ({ stationId, lineId }: SearchState) => `${stationId}::${lineId ?? ''}`;
    const initialState = { stationId: startStationId, lineId: null };
    const initialKey = stateKey(initialState);
    const states = new Map<string, SearchState>([[initialKey, initialState]]);
    const costs = new Map<string, SearchCost>([[initialKey, { distance: 0, transfers: 0 }]]);
    const previous = new Map<string, { stateKey: string; section: TrackSection }>();
    const queue = new Set([initialKey]);

    while (queue.size > 0) {
      let currentKey: string | undefined;
      let currentCost: SearchCost | undefined;
      for (const key of queue) {
        const cost = costs.get(key);
        if (!cost) continue;
        if (
          !currentCost
          || cost.distance < currentCost.distance
          || (cost.distance === currentCost.distance && cost.transfers < currentCost.transfers)
        ) {
          currentKey = key;
          currentCost = cost;
        }
      }
      if (!currentKey || !currentCost) break;
      queue.delete(currentKey);
      const currentState = states.get(currentKey);
      if (!currentState) continue;
      if (currentState.stationId === endStationId) break;

      const current = this.stationById.get(currentState.stationId);
      if (!current) continue;
      for (const section of current.getConnections()) {
        if (bannedSectionIds.has(section.id)) continue;
        const nextId = section.getOtherStationId(currentState.stationId);
        if (bannedStationIds.has(nextId)) continue;
        const nextState = { stationId: nextId, lineId: section.lineId };
        const nextKey = stateKey(nextState);
        const nextCost = {
          distance: currentCost.distance + section.distance,
          transfers: currentCost.transfers + (currentState.lineId && currentState.lineId !== section.lineId ? 1 : 0)
        };
        const knownCost = costs.get(nextKey);
        if (
          knownCost
          && (
            nextCost.distance > knownCost.distance
            || (nextCost.distance === knownCost.distance && nextCost.transfers >= knownCost.transfers)
          )
        ) continue;
        states.set(nextKey, nextState);
        costs.set(nextKey, nextCost);
        previous.set(nextKey, { stateKey: currentKey, section });
        queue.add(nextKey);
      }
    }

    const endKey = [...costs.entries()]
      .filter(([key]) => states.get(key)?.stationId === endStationId)
      .sort(([, a], [, b]) => a.distance - b.distance || a.transfers - b.transfers)[0]?.[0];
    if (!endKey) return null;

    const path: string[] = [];
    const sections: TrackSection[] = [];
    let currentKey = endKey;
    while (currentKey !== initialKey) {
      const state = states.get(currentKey);
      if (!state) return null;
      path.unshift(state.stationId);
      const step = previous.get(currentKey);
      if (!step) return null;
      sections.unshift(step.section);
      currentKey = step.stateKey;
    }
    path.unshift(startStationId);
    return this.createRoute(path, sections);
  }

  private createRoute(path: string[], sections: TrackSection[]): NetworkRoute {
    const transferStations: string[] = [];
    for (let index = 1; index < sections.length; index += 1) {
      const previousSection = sections[index - 1];
      const section = sections[index];
      if (previousSection && section && previousSection.lineId !== section.lineId) {
        transferStations.push(path[index]!);
      }
    }
    return { path, segments: sections, transferStations };
  }
}
