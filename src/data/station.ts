import type { TransportSystem } from '../lib/types';
import type { TrackSection } from './track-section';

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
  private readonly connections = new Map<string, TrackSection>();

  constructor(record: StationRecord) {
    this.id = record.id;
    this.name = record.name;
    this.lines = Object.freeze([...record.lines]);
    this.system = record.system;
  }

  hasLine(lineId: string) {
    return this.lines.includes(lineId);
  }

  connect(section: TrackSection) {
    if (section.from !== this.id && section.to !== this.id) {
      throw new Error(`Section "${section.id}" does not connect to station "${this.id}"`);
    }
    if (this.connections.has(section.id)) {
      throw new Error(`Section "${section.id}" is already connected to station "${this.id}"`);
    }
    this.connections.set(section.id, section);
  }

  getConnections(): readonly TrackSection[] {
    return [...this.connections.values()];
  }

  getNeighborIds(): string[] {
    return [...this.connections.values()].map((section) => section.getOtherStationId(this.id));
  }
}
