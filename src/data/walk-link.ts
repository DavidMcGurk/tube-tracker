/**
 * `osi`: an out-of-station interchange — you leave one station's gates, walk, and enter another station.
 * `isi`: an in-station interchange — a walkway between stations behind the gates (e.g. Bank–Monument).
 */
export type InterchangeKind = 'osi' | 'isi';

export interface WalkLinkRecord {
  id: string;
  from: string;
  to: string;
  /** Approximate walking distance in metres. */
  distance: number;
  kind: InterchangeKind;
  /** SVG path data (root map user units) for the connector between the two stations, from `from` to `to`. */
  mapPath: string;
}

/** A walking connection between two stations. Walks are never counted as track. */
export class WalkLink {
  readonly type = 'walk';
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly distance: number;
  readonly kind: InterchangeKind;
  readonly mapPath: string;

  constructor(record: WalkLinkRecord) {
    if (record.from === record.to) {
      throw new Error(`Walk link "${record.id}" must connect two different stations`);
    }
    if (!Number.isFinite(record.distance) || record.distance <= 0) {
      throw new Error(`Walk link "${record.id}" must have a positive finite distance`);
    }
    this.id = record.id;
    this.from = record.from;
    this.to = record.to;
    this.distance = record.distance;
    this.kind = record.kind;
    this.mapPath = record.mapPath;
  }

  getOtherStationId(stationId: string) {
    if (stationId === this.from) return this.to;
    if (stationId === this.to) return this.from;
    throw new Error(`Station "${stationId}" is not connected by walk link "${this.id}"`);
  }
}
