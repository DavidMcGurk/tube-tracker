import type { RefObject } from 'react';
import { formatMapZoom } from '../lib/map-zoom';
import type { ProgressStyle, ResolvedTheme } from '../lib/types';
import { TravelledSwatch, UntravelledSwatch } from './HighlightSwatches';
import { EnterFullscreenIcon, ExitFullscreenIcon } from './icons';
import { ThemeToggleButton } from './ThemeToggleButton';

interface MapToolbarProps {
  /** Whether there is a selection or open station details to clear. */
  canClear: boolean;
  onClear: () => void;
  zoom: number;
  /** The zoom readout, which pinch gestures update directly while they run. */
  zoomReadoutRef: RefObject<HTMLSpanElement | null>;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  resolvedTheme: ResolvedTheme;
  onToggleTheme: () => void;
  progressStyle: ProgressStyle;
}

const toolbarButton = 'min-h-11 rounded-full border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700';
const zoomButton = `${toolbarButton} min-w-11 flex-none disabled:opacity-40`;
const clearButtonActive = 'border-slate-900 bg-slate-900 font-semibold text-white shadow-sm dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900';
const clearButtonIdle = 'border-slate-300 text-slate-400 dark:border-slate-700 dark:text-slate-500';

export function MapToolbar(props: MapToolbarProps) {
  const { fullscreen } = props;
  return (
    <div className="map-toolbar mb-3 flex flex-col gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-2">
        <button
          className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${props.canClear ? clearButtonActive : clearButtonIdle}`}
          onClick={props.onClear}
          disabled={!props.canClear}
          aria-label={props.canClear ? 'Clear selection' : 'Nothing to clear'}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-3.5 w-3.5">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
          Clear
        </button>
        <button className={zoomButton} onClick={props.onZoomOut} aria-label="Zoom out" disabled={!props.canZoomOut}>
          −
        </button>
        <span className="inline-flex w-12 flex-none items-center justify-center self-center text-xs tabular-nums text-slate-500 dark:text-slate-300">
          <span className="sr-only">Map zoom </span>
          {/* Pinch gestures write this span's text directly, so it must stay a single text node. */}
          <span ref={props.zoomReadoutRef} data-map-zoom-readout>{formatMapZoom(props.zoom)}</span>
        </span>
        <button className={zoomButton} onClick={props.onZoomIn} aria-label="Zoom in" disabled={!props.canZoomIn}>
          +
        </button>
        <button
          className={`${toolbarButton} min-w-11`}
          onClick={props.onToggleFullscreen}
          aria-label={fullscreen ? 'Exit full screen map' : 'View map full screen'}
          aria-pressed={fullscreen}
          title={fullscreen ? 'Exit full screen' : 'View full screen'}
        >
          {fullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
        </button>
        <ThemeToggleButton className="fullscreen-theme-control" resolvedTheme={props.resolvedTheme} onToggle={props.onToggleTheme} />
        {/* The legend never changes size, so the map doesn't move when a journey is selected. */}
        <div className="map-legend flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-slate-600 dark:text-slate-300">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <TravelledSwatch progressStyle={props.progressStyle} />
            Travelled
            <span className="sr-only">
              {props.progressStyle === 'band' ? ': travelled track is highlighted in yellow' : ': travelled track is drawn bold'}
            </span>
          </span>
          {/* In the bold-lines style, the legend shows both widths: the difference between them is what to look for. */}
          {props.progressStyle === 'lines' && (
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <UntravelledSwatch />
              Not yet<span className="sr-only">: track not yet travelled is drawn thin</span>
            </span>
          )}
          {/* Station names are coloured by journey state (the markers are not), so the legend shows coloured words too. */}
          <span className="font-semibold text-(--tt-label-entered)">
            Visited<span className="sr-only">: names of stations you entered or exited are green</span>
          </span>
          <span className="font-semibold text-(--tt-label-changed)">
            Changed<span className="sr-only">: names of stations where you changed lines are purple</span>
          </span>
        </div>
      </div>
    </div>
  );
}
