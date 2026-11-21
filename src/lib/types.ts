import type { TrackSection } from '../data/track-section';

export type TransportSystem = 'Underground' | 'Overground' | 'DLR' | 'Elizabeth line';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = Exclude<Theme, 'system'>;

export interface LineDefinition {
  id: string;
  name: string;
  color: string;
  system: TransportSystem;
}

/** Persisted progress. Field names are part of the stored IndexedDB record. */
export interface Progress {
  travelledSegmentIDs: string[];
  stationsEnteredOrExitedIDs: string[];
  stationsChangedAtIDs: string[];
}

export interface RouteResult {
  path: string[];
  sections: readonly TrackSection[];
  transferStations: string[];
}

export type StationState = 'entered' | 'changed' | 'visited' | 'neutral';

export interface LineProgress {
  id: string;
  name: string;
  completion: number;
  stationCompletion: number;
  travelledDistance: number;
  totalDistance: number;
  visitedStations: number;
  totalStations: number;
  complete: boolean;
}

export interface NetworkSummary {
  totalDistance: number;
  travelledDistance: number;
  coverage: number;
  uniqueStations: number;
  completedLines: number;
  lineProgress: LineProgress[];
}
