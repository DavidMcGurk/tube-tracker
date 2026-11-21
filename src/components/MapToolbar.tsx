import type { ResolvedTheme } from '../lib/types';
import { EnterFullscreenIcon, ExitFullscreenIcon } from './icons';
import { ThemeToggleButton } from './ThemeToggleButton';

interface MapToolbarProps {
  onClear: () => void;
  zoom: number;
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

function LegendSwatch({ bar, dot }: { bar: string; dot: string }) {
  return (
    <span className="relative inline-flex h-4 w-6 items-center" aria-hidden="true">
      <span className={`absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded ${bar}`} />
      <span className={`absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white dark:bg-slate-900 ${dot}`} />
    </span>
  );
}

export function MapToolbar(props: MapToolbarProps) {
  const { fullscreen } = props;
  return (
    <div className="map-toolbar mb-3 flex flex-col gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-2">
        <button className={toolbarButton} onClick={props.onClear}>
          Clear
        </button>
        <button className={`${toolbarButton} min-w-11 flex-none`} onClick={props.onZoomOut} aria-label="Zoom out" disabled={!props.canZoomOut}>
          −
        </button>
        <span className="inline-flex w-12 flex-none items-center justify-center self-center text-xs tabular-nums text-slate-500" aria-label={`Map zoom: ${props.zoom}×`}>
          {props.zoom}×
        </span>
        <button className={`${toolbarButton} min-w-11 flex-none`} onClick={props.onZoomIn} aria-label="Zoom in" disabled={!props.canZoomIn}>
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
        <span className="inline-flex items-center gap-2 px-2 text-xs text-slate-600 dark:text-slate-300" aria-label="Yellow highlights show travelled sections and stations">
          <LegendSwatch bar="bg-yellow-400 dark:bg-yellow-300" dot="border-yellow-500 dark:border-yellow-300" />
          Travelled
        </span>
        {props.showNewRouteLegend && (
          <span className="inline-flex items-center gap-2 px-2 text-xs text-slate-600 dark:text-slate-300" aria-label="Orange highlights show new sections in the selected route">
            <LegendSwatch bar="bg-orange-500 dark:bg-orange-400" dot="border-orange-600 dark:border-orange-400" />
            New route
          </span>
        )}
      </div>
    </div>
  );
}
