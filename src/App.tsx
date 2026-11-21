import { useCallback, useState } from 'react';
import { MapView } from './components/MapView';
import { ResetDialog } from './components/ResetDialog';
import { SettingsView } from './components/SettingsView';
import { StatsView } from './components/StatsView';
import { ThemeToggleButton } from './components/ThemeToggleButton';
import { useProgress } from './hooks/useProgress';
import { useRouteSelection } from './hooks/useRouteSelection';
import { useTheme } from './hooks/useTheme';
import type { RouteResult } from './lib/types';

type TabName = 'map' | 'stats' | 'settings';
const TABS: ReadonlyArray<{ id: TabName; label: string }> = [
  { id: 'map', label: 'Map' },
  { id: 'stats', label: 'Statistics' },
  { id: 'settings', label: 'Settings' }
];

function App() {
  const [activeTab, setActiveTab] = useState<TabName>('map');
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const { resolvedTheme, toggleTheme } = useTheme();
  const { progress, error: progressError, dismissError, recordRoute, resetProgress } = useProgress();
  const selection = useRouteSelection();
  const { selectedStationIds, clearSelection, closeChooser } = selection;

  const handleRecordRoute = useCallback(async (route: RouteResult) => {
    const [startId, endId] = selectedStationIds;
    if (!startId || !endId) return;
    const outcome = await recordRoute(route, startId, endId);
    if (outcome === 'recorded') clearSelection();
    else if (outcome === 'unchanged') closeChooser();
  }, [selectedStationIds, recordRoute, clearSelection, closeChooser]);

  const handleConfirmReset = useCallback(async () => {
    if (await resetProgress()) clearSelection();
    setResetConfirmationOpen(false);
  }, [resetProgress, clearSelection]);

  const handleCancelReset = useCallback(() => setResetConfirmationOpen(false), []);

  return (
    <div className="app-shell min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100" data-active-tab={activeTab} data-map-fullscreen={mapFullscreen}>
      <header className="border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <h1 className="text-xl font-semibold">Tube Tracker</h1>
          <div className="flex items-center gap-2">
            <ThemeToggleButton resolvedTheme={resolvedTheme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      <nav className="mx-auto flex w-full max-w-6xl gap-2 px-4 py-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`min-h-11 flex-1 rounded-xl px-4 py-2 text-sm font-medium ${activeTab === tab.id ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {progressError && (
        <div role="alert" className="app-alert flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 shadow-lg dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <span>{progressError}</span>
          <button className="min-h-11 rounded-full px-3 font-medium underline" onClick={dismissError}>Dismiss</button>
        </div>
      )}

      {activeTab === 'map' && (
        <MapView
          progress={progress}
          selection={selection}
          onRecordRoute={(route) => void handleRecordRoute(route)}
          fullscreen={mapFullscreen}
          onToggleFullscreen={() => setMapFullscreen((fullscreen) => !fullscreen)}
          resolvedTheme={resolvedTheme}
          onToggleTheme={toggleTheme}
        />
      )}
      {activeTab === 'stats' && <StatsView progress={progress} />}
      {activeTab === 'settings' && <SettingsView onResetRequest={() => setResetConfirmationOpen(true)} />}
      {resetConfirmationOpen && <ResetDialog onCancel={handleCancelReset} onConfirm={() => void handleConfirmReset()} />}
    </div>
  );
}

export default App;
