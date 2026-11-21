import type { RefObject } from 'react';
import { formatMapZoom } from '../lib/map-zoom';
import type { ResolvedTheme } from '../lib/types';
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
  showNewRouteLegend: boolean;
}

const toolbarButton = 'min-h-11 rounded-full border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700';
const zoomButton = `${toolbarButton} min-w-11 flex-none disabled:opacity-40`;
const clearButtonActive = 'border-slate-900 bg-slate-900 font-semibold text-white shadow-sm dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900';
const clearButtonIdle = 'border-slate-300 text-slate-400 dark:border-slate-700 dark:text-slate-500';

/** A small picture of a highlighted line: the band, its casing strip, and the line itself. */
function HighlightSwatch({ band, opacity }: { band: string; opacity: string }) {
  return (
    <span className="relative inline-flex h-3 w-7 items-center" aria-hidden="true">
      <span className={`absolute inset-0 rounded-full ${band} ${opacity}`} />
      <span className="absolute inset-x-0.5 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-(--tt-highlight-casing)" />
      <span className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-slate-700 dark:bg-slate-200" />
    </span>
  );
}

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
        <span
          ref={props.zoomReadoutRef}
          className="inline-flex w-12 flex-none items-center justify-center self-center text-xs tabular-nums text-slate-500 dark:text-slate-300"
          aria-label={`Map zoom: ${formatMapZoom(props.zoom)}`}
        >
          {formatMapZoom(props.zoom)}
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
        <div className="map-legend flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-slate-600 dark:text-slate-300">
          <span className="inline-flex items-center gap-2" aria-label="Yellow highlights show travelled track">
            <HighlightSwatch band="bg-(--tt-travelled)" opacity="opacity-(--tt-travelled-opacity)" />
            Travelled
          </span>
          {props.showNewRouteLegend && (
            <span className="inline-flex items-center gap-2" aria-label="Orange highlights show new track in the selected route">
              <HighlightSwatch band="bg-(--tt-preview)" opacity="opacity-(--tt-preview-opacity)" />
              New route
            </span>
          )}
          <span className="inline-flex items-center gap-1.5" aria-label="Green stations are ones you have entered or exited">
            <span className="h-2.5 w-2.5 rounded-full bg-(--tt-station-entered)" aria-hidden="true" />
            Visited
          </span>
          <span className="inline-flex items-center gap-1.5" aria-label="Amber stations are ones where you changed lines">
            <span className="h-2.5 w-2.5 rounded-full bg-(--tt-station-changed)" aria-hidden="true" />
            Changed
          </span>
        </div>
      </div>
    </div>
  );
}
