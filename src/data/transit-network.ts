import type { NetworkLink, RouteResult } from '../lib/types';
import { RoutePlanner, type RoutingOptions } from './route-planner';
import { Station, type StationRecord } from './station';
import { TrackSection, type TrackSectionRecord } from './track-section';
import { WalkLink, type WalkLinkRecord } from './walk-link';

export class TransitNetwork {
  readonly stations: readonly Station[];
  /** Track only: walking interchanges are kept separately and never count towards track statistics. */
  readonly sections: readonly TrackSection[];
  readonly walkLinks: readonly WalkLink[];
  private readonly stationById: ReadonlyMap<string, Station>;
  private readonly linkById: ReadonlyMap<string, NetworkLink>;
  private readonly planner: RoutePlanner;

  constructor(
    stationRecords: readonly StationRecord[],
    sectionRecords: readonly TrackSectionRecord[],
    walkLinkRecords: readonly WalkLinkRecord[] = [],
    routingOptions: Partial<RoutingOptions> = {}
  ) {
    const stationById = new Map<string, Station>();
    for (const record of stationRecords) {
      if (stationById.has(record.id)) throw new Error(`Duplicate station ID "${record.id}"`);
      stationById.set(record.id, new Station(record));
    }

    const linkById = new Map<string, NetworkLink>();
    const addLink = <T extends NetworkLink>(link: T) => {
      if (linkById.has(link.id)) throw new Error(`Duplicate link ID "${link.id}"`);
      const from = stationById.get(link.from);
      const to = stationById.get(link.to);
      if (!from || !to) throw new Error(`Link "${link.id}" references an unknown station`);
      from.connect(link);
      to.connect(link);
      linkById.set(link.id, link);
      return link;
    };
    const sections = sectionRecords.map((record) => addLink(new TrackSection(record)));
    const walkLinks = walkLinkRecords.map((record) => addLink(new WalkLink(record)));

    this.stationById = stationById;
    this.linkById = linkById;
    this.stations = Object.freeze([...stationById.values()]);
    this.sections = Object.freeze(sections);
    this.walkLinks = Object.freeze(walkLinks);
    this.planner = new RoutePlanner(this.stations.map((station) => station.id), [...sections, ...walkLinks], routingOptions);
  }

  getStation(stationId: string) {
    return this.stationById.get(stationId);
  }

  getLink(linkId: string) {
    return this.linkById.get(linkId);
  }

  getSection(sectionId: string) {
    const link = this.linkById.get(sectionId);
    return link?.type === 'track' ? link : undefined;
  }

  getWalkLink(linkId: string) {
    const link = this.linkById.get(linkId);
    return link?.type === 'walk' ? link : undefined;
  }

  findRoute(startStationId: string, endStationId: string): RouteResult | null {
    return this.findRoutes(startStationId, endStationId, 1)[0] ?? null;
  }

  /** Route options ordered by number of changes, then distance. */
  findRoutes(startStationId: string, endStationId: string, maxRoutes = 5): RouteResult[] {
    if (!Number.isInteger(maxRoutes) || maxRoutes < 1) {
      throw new Error('Maximum route count must be a positive integer');
    }
    return this.planner.plan(startStationId, endStationId, maxRoutes);
  }
}
