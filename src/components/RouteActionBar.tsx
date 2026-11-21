import { useEffect, useRef } from 'react';
import { formatRouteEndpoints, getRouteKey } from '../lib/map-interactions';
import { routeIsAlreadyComplete } from '../lib/progress';
import { describeRouteChanges, describeRouteDistance, describeRouteTitle, getStationName } from '../lib/route-format';
import type { Progress, RouteResult } from '../lib/types';
import { PreviewSwatch } from './HighlightSwatches';

/** On phones the bar floats over the map; its height lets the map and page leave room for it (see styles.css). */
const ROUTE_BAR_HEIGHT_PROPERTY = '--tt-route-bar-height';

interface RouteActionBarProps {
  /** Whether the selected route includes track (or walks) not yet recorded, shown in the preview colour. */
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
  const endpoints = formatRouteEndpoints(startId && getStationName(startId), endId && getStationName(endId));
  const activeKey = getRouteKey(activeRoute);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    let frame = 0;
    // Applied on the next frame: the property changes other elements' layout, which must not re-enter this observer.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => root.style.setProperty(ROUTE_BAR_HEIGHT_PROPERTY, `${bar.offsetHeight}px`));
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      root.style.removeProperty(ROUTE_BAR_HEIGHT_PROPERTY);
    };
  }, []);
  // A walk-only journey's single change just repeats the endpoints, so it is not repeated.
  const changesText = activeRoute.legs.length > 1 ? describeRouteChanges(activeRoute) : '';

  return (
    <div ref={barRef} className={`route-action-bar mt-3 flex justify-end${chooserOpen ? ' has-options' : ''}`}>
      <div className="route-primary-action flex w-full flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium">
          <span className="mr-1.5 inline-flex align-[-0.1em]">
            <PreviewSwatch />
            <span className="sr-only">The route is shown on the map as an orange dashed line. </span>
          </span>
          Route {props.activeRouteIndex + 1}: {describeRouteTitle(activeRoute)}
          {endpoints && <span className="block text-xs font-normal text-slate-600 dark:text-slate-300">{endpoints}</span>}
          {changesText && <span className="block text-xs font-normal text-slate-600 dark:text-slate-300">{changesText}</span>}
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
            const optionChanges = describeRouteChanges(route, { capitalise: false });
            return (
              <button
                key={key}
                aria-pressed={isActive}
                className={`min-h-11 w-full rounded-xl border px-3 py-2 text-left text-sm ${isActive ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950' : 'border-slate-300 dark:border-slate-600'}`}
                onClick={() => props.onChooseRoute(route)}
              >
                <span className="block font-medium">Route {index + 1}: {describeRouteTitle(route)}</span>
                <span className="block text-xs opacity-75">
                  {describeRouteDistance(route)}
                  {optionChanges ? ` · ${optionChanges}` : ' · no changes'}
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
