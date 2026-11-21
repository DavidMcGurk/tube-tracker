import type { LineDefinition } from '../lib/types';
import type { TrackSectionRecord } from './track-section';
import { continuousServiceLines, lineServices } from './line-services';
import { TransitNetwork } from './transit-network';
import { tflSectionRows, tflStationRows } from './tfl-network-data';
import { walkLinkRecords } from './walk-links';

export const lines: LineDefinition[] = [
  { id: 'bakerloo', name: 'Bakerloo', color: '#b36305', system: 'Underground' },
  { id: 'central', name: 'Central', color: '#e32017', system: 'Underground' },
  { id: 'circle', name: 'Circle', color: '#f7d03c', system: 'Underground' },
  { id: 'district', name: 'District', color: '#00782a', system: 'Underground' },
  { id: 'hammersmith_city', name: 'Hammersmith & City', color: '#f4a9c8', system: 'Underground' },
  { id: 'jubilee', name: 'Jubilee', color: '#7a7d82', system: 'Underground' },
  { id: 'metropolitan', name: 'Metropolitan', color: '#9b0058', system: 'Underground' },
  { id: 'northern', name: 'Northern', color: '#000000', system: 'Underground' },
  { id: 'piccadilly', name: 'Piccadilly', color: '#0019a8', system: 'Underground' },
  { id: 'victoria', name: 'Victoria', color: '#00a0d2', system: 'Underground' },
  { id: 'waterloo_city', name: 'Waterloo & City', color: '#76d0bd', system: 'Underground' },
  { id: 'lioness', name: 'Lioness', color: '#feb231', system: 'Overground' },
  { id: 'liberty', name: 'Liberty', color: '#5e6867', system: 'Overground' },
  { id: 'mildmay', name: 'Mildmay', color: '#3784c7', system: 'Overground' },
  { id: 'windrush', name: 'Windrush', color: '#ff4e5a', system: 'Overground' },
  { id: 'weaver', name: 'Weaver', color: '#9a2c62', system: 'Overground' },
  { id: 'suffragette', name: 'Suffragette', color: '#49c07d', system: 'Overground' },
  { id: 'dlr', name: 'DLR', color: '#00afaa', system: 'DLR' },
  { id: 'elizabeth', name: 'Elizabeth line', color: '#6950a1', system: 'Elizabeth line' }
];

const sectionRecords: TrackSectionRecord[] = tflSectionRows.map(([id, lineId, from, to, distance]) => ({ id, lineId, from, to, distance }));

export const network = new TransitNetwork(
  tflStationRows.map(([id, name, system, lineIds]) => ({ id, name, system, lines: lineIds })),
  sectionRecords,
  walkLinkRecords,
  { lineServices, continuousServiceLines }
);

export const stations = network.stations;
export const sections = network.sections;
export const walkLinks = network.walkLinks;

export function findRoute(startStationId: string, endStationId: string) {
  return network.findRoute(startStationId, endStationId);
}

export function findRoutes(startStationId: string, endStationId: string, maxRoutes?: number) {
  return network.findRoutes(startStationId, endStationId, maxRoutes);
}

export function getStationById(stationId: string) {
  return network.getStation(stationId);
}

export function getSectionById(sectionId: string) {
  return network.getSection(sectionId);
}

export function getWalkLinkById(linkId: string) {
  return network.getWalkLink(linkId);
}
