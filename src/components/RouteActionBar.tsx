import { getStationById } from '../data/network';
import { formatRouteEndpoints, getRouteKey } from '../lib/map-interactions';
import { routeIsAlreadyComplete } from '../lib/progress';
import { formatDistance, getRouteDistance, getRouteLineNames, getRouteTransferNames } from '../lib/route-format';
import type { Progress, RouteResult } from '../lib/types';

interface RouteActionBarProps {
  selectedStationIds: readonly string[];
  routeOptions: readonly RouteResult[];
  activeRoute: RouteResult;
  activeRouteIndex: number;
  chooserOpen: boolean;
  progress: Progress;
  onRecord: () => void;
  onClear: () => void;
  onChooseRoute: (route: RouteResult) => void;
  onToggleChooser: () => void;
}

export function RouteActionBar(props: RouteActionBarProps) {
  const { activeRoute, routeOptions, chooserOpen, progress } = props;
  const [startId, endId] = props.selectedStationIds;
  const endpoints = formatRouteEndpoints(
    startId ? getStationById(startId)?.name : undefined,
    endId ? getStationById(endId)?.name : undefined
  );
  const activeKey = getRouteKey(activeRoute);
  const transferNames = getRouteTransferNames(activeRoute);

  return (
    <div className={`route-action-bar mt-3 flex justify-end${chooserOpen ? ' has-options' : ''}`}>
      <div className="route-primary-action flex w-full flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium">
          Route {props.activeRouteIndex + 1}: {getRouteLineNames(activeRoute).join(' → ')}
          {endpoints && <span className="block text-xs font-normal text-slate-600 dark:text-slate-300">{endpoints}</span>}
          {transferNames.length > 0 && (
            <span className="block text-xs font-normal text-slate-600 dark:text-slate-300">Change at {transferNames.join(', ')}</span>
          )}
        </p>
        <div className="route-buttons flex flex-wrap gap-2">
          <button onClick={props.onClear} className="min-h-11 rounded-full border border-slate-300 px-4 py-2 text-sm dark:border-slate-600">
            Clear selection
          </button>
          <button onClick={props.onRecord} className="min-h-11 rounded-full bg-emerald-600 px-4 py-2 text-sm text-white">
            {routeIsAlreadyComplete(progress, activeRoute) ? 'Already explored' : 'Record route'}
          </button>
        </div>
      </div>
      {chooserOpen && routeOptions.length > 1 && (
        <div className="route-options space-y-2" role="group" aria-label="Choose the route you travelled">
          {routeOptions.map((route, index) => {
            const key = getRouteKey(route);
            const isActive = key === activeKey;
            const optionTransfers = getRouteTransferNames(route);
            return (
              <button
                key={key}
                aria-pressed={isActive}
                className={`min-h-14 w-full rounded-xl border px-3 py-2 text-left text-sm dark:border-slate-600 ${isActive ? 'border-blue-600 bg-blue-50 dark:bg-blue-950' : 'border-slate-300'}`}
                onClick={() => props.onChooseRoute(route)}
              >
                <span className="block font-medium">Route {index + 1}: {getRouteLineNames(route).join(' → ')}</span>
                <span className="block text-xs font-normal opacity-75">{endpoints}</span>
                <span className="block text-xs opacity-75">
                  {formatDistance(getRouteDistance(route))}
                  {optionTransfers.length > 0 ? ` · change at ${optionTransfers.join(', ')}` : ' · no changes'}
                  {routeIsAlreadyComplete(progress, route) ? ' · already explored' : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {routeOptions.length > 1 && (
        <button
          className="route-alternatives-toggle min-h-11 w-full rounded-full border border-slate-300 px-4 py-2 text-sm dark:border-slate-600"
          onClick={props.onToggleChooser}
          aria-expanded={chooserOpen}
        >
          {chooserOpen ? 'Hide alternative routes' : 'Show alternative routes'}
        </button>
      )}
    </div>
  );
}
