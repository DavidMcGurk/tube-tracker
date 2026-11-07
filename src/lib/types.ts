export type TransportSystem = 'Underground' | 'Overground' | 'DLR' | 'Elizabeth line';

export interface Station {
  id: string;
  name: string;
  lines: string[];
  system: TransportSystem;
}

export interface TrackSection {
  id: string;
  lineId: string;
  from: string;
  to: string;
  distance: number;
}

export interface LineDefinition {
  id: string;
  name: string;
  color: string;
  system: TransportSystem;
}

export interface Progress {
  travelledSegmentIDs: string[];
  stationsEnteredOrExitedIDs: string[];
  stationsChangedAtIDs: string[];
}

export interface RouteResult {
  path: string[];
  segments: TrackSection[];
  transferStations: string[];
}

export interface NetworkSummary {
  totalDistance: number;
  travelledDistance: number;
  coverage: number;
  uniqueStations: number;
  completedLines: number;
  lineProgress: Array<{
    id: string;
    name: string;
    completion: number;
    travelledDistance: number;
    totalDistance: number;
    completedSections: number;
    totalSections: number;
    complete: boolean;
  }>;
}
