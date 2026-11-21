import type { TrackSection } from '../data/track-section';
import type { InterchangeKind, WalkLink } from '../data/walk-link';

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
  /** Track sections travelled. */
  travelledSegmentIDs: string[];
  /** Walking interchanges used. */
  walkedLinkIDs: string[];
  /** Stations passed through the gates of: journey ends and both ends of out-of-station interchanges. */
  stationsEnteredOrExitedIDs: string[];
  /** Stations where a journey changed lines without leaving the station. */
  stationsChangedAtIDs: string[];
}

export type NetworkLink = TrackSection | WalkLink;

export type RouteLeg =
  | { type: 'ride'; lineId: string; from: string; to: string; sections: readonly TrackSection[] }
  | { type: 'walk'; from: string; to: string; link: WalkLink };

export type RouteChange =
  | { type: 'line'; at: string }
  | { type: 'walk'; from: string; to: string; kind: InterchangeKind };

export interface RouteResult {
  /** Unique identifier of this exact route (its links in order). */
  key: string;
  /** Stations visited in order; always one longer than `links`. */
  path: string[];
  links: readonly NetworkLink[];
  sections: readonly TrackSection[];
  walks: readonly WalkLink[];
  legs: readonly RouteLeg[];
  /** Each line change or walking interchange. Its length is the route's number of changes. */
  changes: readonly RouteChange[];
  trackDistance: number;
  walkDistance: number;
  /** Set when another option rides the same lines with the same changes: a station only this route passes. */
  via?: string;
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
