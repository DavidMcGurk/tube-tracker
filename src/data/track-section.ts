export interface TrackSectionRecord {
  id: string;
  lineId: string;
  from: string;
  to: string;
  distance: number;
}

export class TrackSection {
  readonly id: string;
  readonly lineId: string;
  readonly from: string;
  readonly to: string;
  readonly distance: number;

  constructor(record: TrackSectionRecord) {
    if (record.from === record.to) {
      throw new Error(`Section "${record.id}" must connect two different stations`);
    }
    if (!Number.isFinite(record.distance) || record.distance <= 0) {
      throw new Error(`Section "${record.id}" must have a positive finite distance`);
    }

    this.id = record.id;
    this.lineId = record.lineId;
    this.from = record.from;
    this.to = record.to;
    this.distance = record.distance;
  }

  getOtherStationId(stationId: string) {
    if (stationId === this.from) return this.to;
    if (stationId === this.to) return this.from;
    throw new Error(`Station "${stationId}" is not connected by section "${this.id}"`);
  }
}
