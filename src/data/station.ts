import type { NetworkLink, TransportSystem } from '../lib/types';

export interface StationRecord {
  id: string;
  name: string;
  lines: readonly string[];
  system: TransportSystem;
}

export class Station {
  readonly id: string;
  readonly name: string;
  readonly lines: readonly string[];
  readonly system: TransportSystem;
  private readonly connections = new Map<string, NetworkLink>();

  constructor(record: StationRecord) {
    this.id = record.id;
    this.name = record.name;
    this.lines = Object.freeze([...record.lines]);
    this.system = record.system;
  }

  connect(link: NetworkLink) {
    if (link.from !== this.id && link.to !== this.id) {
      throw new Error(`Link "${link.id}" does not connect to station "${this.id}"`);
    }
    if (this.connections.has(link.id)) {
      throw new Error(`Link "${link.id}" is already connected to station "${this.id}"`);
    }
    this.connections.set(link.id, link);
  }

  getConnections(): readonly NetworkLink[] {
    return [...this.connections.values()];
  }

  getNeighborIds(): string[] {
    return [...this.connections.values()].map((link) => link.getOtherStationId(this.id));
  }
}
