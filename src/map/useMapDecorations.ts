import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Progress } from '../lib/types';
import { ensureHighlightLayers, renderLinkHighlights } from './highlight-layer';
import { addLineLabelBackgrounds } from './line-label-backgrounds';
import { applyStationStates, getStationIndex, setStationFlag, type StationIndex } from './station-index';

interface MapDecorationOptions {
  viewportRef: RefObject<HTMLDivElement | null>;
  svgMarkup: string;
  progress: Progress;
  selectedStationIds: readonly string[];
  /** Links of the selected route not yet travelled. */
  previewLinkIds: readonly string[];
}

/**
 * Keeps the inline SVG in sync with app state. Each concern updates independently so that cheap interactions
 * (hover, selection) never redo expensive work (station binding, highlight geometry).
 */
export function useMapDecorations({ viewportRef, svgMarkup, progress, selectedStationIds, previewLinkIds }: MapDecorationOptions) {
  const indexRef = useRef<StationIndex | null>(null);
  const appliedSelectionRef = useRef<ReadonlySet<string>>(new Set());
  const hoveredStationRef = useRef<string | null>(null);

  const getSvg = useCallback(() => viewportRef.current?.querySelector('svg') ?? null, [viewportRef]);

  useEffect(() => {
    const svg = getSvg();
    indexRef.current = svg && svgMarkup ? getStationIndex(svg) : null;
    appliedSelectionRef.current = new Set();
    hoveredStationRef.current = null;
    if (svg && svgMarkup) {
      ensureHighlightLayers(svg);
      addLineLabelBackgrounds(svg);
    }
  }, [getSvg, svgMarkup]);

  useEffect(() => {
    const svg = getSvg();
    const index = indexRef.current;
    if (!svg || !index) return;
    applyStationStates(index, progress);
    renderLinkHighlights(svg, svgMarkup, 'travelled', [...progress.travelledSegmentIDs, ...progress.walkedLinkIDs]);
  }, [getSvg, svgMarkup, progress]);

  useEffect(() => {
    const index = indexRef.current;
    if (!index) return;
    const next = new Set(selectedStationIds);
    for (const stationId of appliedSelectionRef.current) {
      if (!next.has(stationId)) setStationFlag(index, stationId, 'data-app-selected', false);
    }
    for (const stationId of next) {
      if (!appliedSelectionRef.current.has(stationId)) setStationFlag(index, stationId, 'data-app-selected', true);
    }
    appliedSelectionRef.current = next;
  }, [svgMarkup, selectedStationIds]);

  const previewKey = previewLinkIds.join('|');
  useEffect(() => {
    const svg = getSvg();
    if (!svg || !indexRef.current) return;
    renderLinkHighlights(svg, svgMarkup, 'preview', previewKey ? previewKey.split('|') : []);
  }, [getSvg, svgMarkup, previewKey]);

  /** Imperative so that pointer movement never re-renders React. */
  const setHoveredStation = useCallback((stationId: string | null) => {
    const index = indexRef.current;
    if (!index || hoveredStationRef.current === stationId) return;
    if (hoveredStationRef.current) setStationFlag(index, hoveredStationRef.current, 'data-app-hovered', false);
    if (stationId) setStationFlag(index, stationId, 'data-app-hovered', true);
    hoveredStationRef.current = stationId;
  }, []);

  return { setHoveredStation };
}
