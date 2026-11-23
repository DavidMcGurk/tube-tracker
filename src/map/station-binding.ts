import { lines, stations } from '../data/network';
import { createStationLabelIndex, normalizeStationLabel } from '../lib/map-interactions';

/*
 * Heuristics that bind the reference map's SVG elements (marker ids such as "Kings_Cross_St_Pancras_victoria",
 * symbol hrefs such as "#stnorthern", and label text) to station ids in the network data.
 */

/** Interchange connectors in #station_nodes are drawn with these classes; they are not station markers. */
const CONNECTOR_CLASSES = ':not(.osi, .osib, .isi, .isib, .isit)';
export const STATION_MARKER_SELECTOR = `#station_nodes use[id]${CONNECTOR_CLASSES}`;
export const UNNAMED_MARKER_SELECTOR = `:scope > use:not([id])${CONNECTOR_CLASSES}`;

/**
 * Bank and Monument are drawn as one hub group; these are their centres in the hub's own coordinates. Bank's capsule
 * is centred 7.25 along its own axis, which the drawing rotates by 53.13° (the direction of the 20.25, 27 connector).
 */
export const BANK_MONUMENT_HUB_POINTS = [
  { label: 'bank', x: 4.35, y: 5.8 },
  { label: 'monument', x: 20.25, y: 27 }
] as const;

export const stationsByMapLabel = createStationLabelIndex(stations);
const stationMarkerLabelEntries = [...stationsByMapLabel.entries()].sort(([a], [b]) => b.length - a.length);
const stationMarkerAliases: Record<string, string> = {
  bankmonument: 'bank',
  heathrow4: 'heathrowterminal4',
  heathrow23: 'heathrowterminals23',
  heathrow5: 'heathrowterminal5'
};
const stationMarkerLineSuffixes = [
  ...new Map(lines.flatMap((line) => [
    [normalizeStationLabel(line.id), line.id],
    [normalizeStationLabel(line.name), line.id]
  ])).entries()
].sort(([a], [b]) => b.length - a.length);
const stationMarkerSuffixes = [
  'elizabethbase', 'deepbase', 'overground', 'surface', 'deep', 'tube', 'base', 'mid', 'top', 'nr', 'cr', 'osi', 'hnc'
].sort((a, b) => b.length - a.length);
const stationMarkerSuffixLineAliases: Record<string, string> = { hnc: 'hammersmith_city' };

function getMarkerSuffixLineIds(suffix: string) {
  const lineIds: string[] = [];
  let remaining = suffix;

  while (remaining) {
    const lineSuffix = stationMarkerLineSuffixes.find(([value]) => remaining.startsWith(value));
    if (lineSuffix) {
      lineIds.push(lineSuffix[1]);
      remaining = remaining.slice(lineSuffix[0].length);
      continue;
    }

    const otherSuffix = stationMarkerSuffixes.find((value) => remaining.startsWith(value));
    if (!otherSuffix) return null;
    const aliasedLineId = stationMarkerSuffixLineAliases[otherSuffix];
    if (aliasedLineId) lineIds.push(aliasedLineId);
    remaining = remaining.slice(otherSuffix.length);
  }

  return lineIds;
}

/** Resolves an SVG station marker (by element id and symbol href) to a network station. */
export function getMarkerStationById(markerId: string, href: string) {
  const normalizedId = normalizeStationLabel(markerId);
  const exactName = stationMarkerAliases[normalizedId] ?? normalizedId;
  const exactCandidates = stationsByMapLabel.get(exactName) ?? [];
  if (exactCandidates.length === 1) return exactCandidates[0];

  const symbolName = normalizeStationLabel(href.replace(/^#/, '').replace(/^st/, ''));
  const symbolLineId = lines.find((line) =>
    symbolName.endsWith(normalizeStationLabel(line.id))
    || symbolName.endsWith(normalizeStationLabel(line.name))
  )?.id;
  const matchingLabel = stationMarkerLabelEntries.find(([label]) => normalizedId.startsWith(label));
  if (matchingLabel) {
    const suffixLineIds = getMarkerSuffixLineIds(normalizedId.slice(matchingLabel[0].length));
    if (suffixLineIds) {
      const requiredLineIds = symbolLineId ? [...suffixLineIds, symbolLineId] : suffixLineIds;
      return matchingLabel[1].find((station) =>
        requiredLineIds.every((lineId) => station.lines.includes(lineId))
      );
    }
  }

  for (const [suffix, lineId] of stationMarkerLineSuffixes) {
    if (!normalizedId.endsWith(suffix)) continue;
    const markerName = normalizedId.slice(0, -suffix.length);
    const aliasName = stationMarkerAliases[markerName];
    if (!aliasName) continue;
    const candidates = stationsByMapLabel.get(aliasName) ?? [];
    if (candidates.length === 1) return candidates[0];
    return candidates.find((station) => station.lines.includes(lineId));
  }

  for (const suffix of stationMarkerSuffixes) {
    if (!normalizedId.endsWith(suffix)) continue;
    const markerName = normalizedId.slice(0, -suffix.length);
    const aliasName = stationMarkerAliases[markerName];
    const candidates = aliasName ? stationsByMapLabel.get(aliasName) ?? [] : [];
    if (candidates.length === 1) return candidates[0];
  }

  return undefined;
}

export function getClosestStationId(label: SVGTextElement, candidates: typeof stations, markers: SVGElement[]) {
  if (candidates.length === 1) return candidates[0]?.id;

  const labelBounds = label.getBoundingClientRect();
  const labelX = labelBounds.left + labelBounds.width / 2;
  const labelY = labelBounds.top + labelBounds.height / 2;
  let closestStationId: string | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const marker of markers) {
    const stationId = marker.getAttribute('data-app-station-id');
    if (!stationId || !candidates.some((station) => station.id === stationId)) continue;
    const markerBounds = marker.getBoundingClientRect();
    const dx = markerBounds.left + markerBounds.width / 2 - labelX;
    const dy = markerBounds.top + markerBounds.height / 2 - labelY;
    const distance = dx * dx + dy * dy;
    if (distance < closestDistance) {
      closestStationId = stationId;
      closestDistance = distance;
    }
  }

  return closestStationId;
}

export function getMarkerStation(marker: SVGElement) {
  const href = marker.getAttribute('href')
    ?? marker.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    ?? '';
  return getMarkerStationById(marker.id, href);
}
