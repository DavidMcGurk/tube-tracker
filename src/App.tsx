import { useCallback, useEffect, useRef, useState } from 'react';
import { AppLogo } from './components/AppLogo';
import { BACKUP_HEADING_ID } from './components/BackupSection';
import { InstallPrompt } from './components/InstallPrompt';
import { MapView, type MapFocusRequest } from './components/MapView';
import { ResetDialog } from './components/ResetDialog';
import { SettingsView } from './components/SettingsView';
import { StatsView } from './components/StatsView';
import { SyncNotice } from './components/SyncNotice';
import { ThemeToggleButton } from './components/ThemeToggleButton';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { useOnline } from './hooks/useOnline';
import { useProgress } from './hooks/useProgress';
import { useProgressStyle } from './hooks/useProgressStyle';
import { useRouteSelection } from './hooks/useRouteSelection';
import { useSync } from './hooks/useSync';
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
  /** The reset confirmation, while open, and the button that opened it (focus goes back to it). */
  const [resetDialog, setResetDialog] = useState<{ opener: HTMLElement | null } | null>(null);
  const resetConfirmationOpen = resetDialog !== null;
  const { resolvedTheme, toggleTheme } = useTheme();
  const { progressStyle, setProgressStyle } = useProgressStyle();
  const { progress, error: progressError, errorKind, dismissError, recordRoute, resetProgress, undo, undoJourney, dismissUndo } = useProgress();
  const selection = useRouteSelection();
  const { clearSelection, closeChooser, restoreSelection } = selection;
  const install = useInstallPrompt();
  const sync = useSync();
  const online = useOnline();
  const [focusBackupHeading, setFocusBackupHeading] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const undoBusyRef = useRef(false);
  /** The journey (by recordedAt) whose Undo came too late: its bar says so until it's dismissed or runs out. */
  const [tooLateFor, setTooLateFor] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; id: number } | null>(null);
  const [mapFocus, setMapFocus] = useState<MapFocusRequest | null>(null);
  const clearMapFocus = useCallback(() => setMapFocus(null), []);
  const routeActionsShowing = activeTab === 'map' && selection.activeRoute !== null;
  // The undo bar takes the route actions' place on the map, so the two never show together.
  const undoShowing = activeTab === 'map' && selection.activeRoute === null && undo !== null;
  const bottomBarShowing = routeActionsShowing || undoShowing;
  const hasProgress = progress.travelledSegmentIDs.length > 0 || progress.walkedLinkIDs.length > 0 || progress.stationsEnteredOrExitedIDs.length > 0;

  const announce = useCallback((text: string) => setAnnouncement((current) => ({ text, id: (current?.id ?? 0) + 1 })), []);

  const handleRecordRoute = useCallback(async (route: RouteResult) => {
    const outcome = await recordRoute(route);
    if (outcome === 'recorded') {
      clearSelection();
      // The undo bar takes the route actions' place, and "Record route" goes with them: focus Undo instead.
      setMapFocus('undo');
      announce('Journey recorded');
    } else if (outcome === 'unchanged') {
      closeChooser();
    }
  }, [recordRoute, clearSelection, closeChooser, announce]);

  const handleUndo = useCallback(async () => {
    if (undoBusyRef.current) return;
    undoBusyRef.current = true;
    setUndoBusy(true);
    const recordedAt = undo?.recordedAt ?? null;
    try {
      const { outcome, stationIds } = await undoJourney();
      if (outcome === 'undone') {
        announce('Journey removed');
        // Back to the journey's start and end, so the right route can be picked straight away (and recorded again).
        if (stationIds) restoreSelection(stationIds);
        setMapFocus(stationIds ? 'record' : 'map');
      } else if (outcome === 'too_late') {
        setTooLateFor(recordedAt);
        announce('This journey has already been backed up, so it can’t be undone.');
      } else if (outcome === 'expired') {
        announce('This journey can no longer be undone.');
        setMapFocus('map');
      }
    } finally {
      undoBusyRef.current = false;
      setUndoBusy(false);
    }
  }, [undo, undoJourney, announce, restoreSelection]);

  /** Keeps the journey: the bar goes, so focus moves to the map it was under. */
  const handleDismissUndo = useCallback(() => {
    dismissUndo();
    setMapFocus('map');
  }, [dismissUndo]);

  const handleConfirmReset = useCallback(async () => {
    if (await resetProgress()) clearSelection();
    setResetDialog(null);
  }, [resetProgress, clearSelection]);

  const handleCancelReset = useCallback(() => setResetDialog(null), []);

  const openTab = useCallback((tab: TabName) => {
    setActiveTab(tab);
    setMapFocus(null);
  }, []);

  /** "Backup settings" on the signed-out notice: Settings, at the Backup & sync section. */
  const openBackupSettings = useCallback(() => {
    openTab('settings');
    setFocusBackupHeading(true);
  }, [openTab]);

  useEffect(() => {
    if (!focusBackupHeading || activeTab !== 'settings') return;
    setFocusBackupHeading(false);
    const heading = document.getElementById(BACKUP_HEADING_ID);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }, [focusBackupHeading, activeTab]);

  // Backup & sync changes some wording elsewhere, but only where this build and browser can use it.
  const backup = sync.available ? (sync.account ? 'on' : 'off') : null;

  return (
    <div className="app-shell min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100" data-active-tab={activeTab} data-map-fullscreen={mapFullscreen} data-route-bar={bottomBarShowing} data-progress-style={progressStyle}>
      <header className="border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        {/*
          The nav and the map sit in a max-w-6xl box with 1rem of padding inside it; this content box is that same width
          (72rem − 2 × 1rem), so the title and the theme button line up with the edges of the tabs and the map.
        */}
        <div className="mx-auto flex max-w-[70rem] items-center justify-between">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold">
            <AppLogo className="app-logo h-5 w-10 shrink-0" />
            Tube Tracker
          </h1>
          <div className="flex items-center gap-2">
            <ThemeToggleButton resolvedTheme={resolvedTheme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      <nav className="mx-auto flex w-full max-w-6xl gap-2 px-4 py-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => openTab(tab.id)}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            className={`min-h-11 flex-1 rounded-xl px-4 py-2 text-sm font-medium ${activeTab === tab.id ? 'bg-slate-900 text-white dark:bg-slate-700 dark:text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/*
        In the page's flow, between the tabs and the view, so it never covers them; Settings shows the same line in its
        Backup & sync section instead.
      */}
      {sync.notice && activeTab !== 'settings' && (
        <div className="sync-notice-slot mx-auto w-full max-w-6xl px-4 pb-3">
          <SyncNotice accountName={sync.notice.accountName} onOpenSettings={openBackupSettings} onDismiss={sync.dismissNotice} />
        </div>
      )}

      {progressError && (
        <div role="alert" className="app-alert flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 shadow-lg dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <span>{progressError}</span>
          <div className="flex shrink-0 gap-1">
            {/* There is no browser reload button in the installed app, so offer one. */}
            {errorKind === 'load' && (
              <button className="min-h-11 rounded-full px-3 font-medium underline" onClick={() => window.location.reload()}>Reload</button>
            )}
            <button className="min-h-11 rounded-full px-3 font-medium underline" onClick={dismissError}>Dismiss</button>
          </div>
        </div>
      )}

      {activeTab === 'map' && (
        <MapView
          progress={progress}
          selection={selection}
          onRecordRoute={(route) => void handleRecordRoute(route)}
          undo={undo && { tooLate: undo.recordedAt === tooLateFor, busy: undoBusy, onUndo: () => void handleUndo(), onDismiss: handleDismissUndo }}
          focusRequest={mapFocus}
          onFocusDone={clearMapFocus}
          fullscreen={mapFullscreen}
          onToggleFullscreen={() => setMapFullscreen((fullscreen) => !fullscreen)}
          resolvedTheme={resolvedTheme}
          onToggleTheme={toggleTheme}
          progressStyle={progressStyle}
        />
      )}
      {activeTab === 'stats' && <StatsView progress={progress} />}
      {activeTab === 'settings' && (
        <SettingsView
          onResetRequest={(opener) => setResetDialog({ opener })}
          install={install}
          hasProgress={hasProgress}
          progressStyle={progressStyle}
          onProgressStyleChange={setProgressStyle}
          backupAvailable={sync.available}
          backedUp={sync.account !== null}
        />
      )}
      {resetDialog && (
        <ResetDialog
          returnFocusTo={resetDialog.opener}
          onCancel={handleCancelReset}
          onConfirm={() => void handleConfirmReset()}
          backupName={sync.account?.name ?? null}
          offline={!online}
        />
      )}
      <InstallPrompt install={install} hasProgress={hasProgress} suppressed={bottomBarShowing || resetConfirmationOpen} backup={backup} />
      {/* Announces journeys recorded and removed (the undo bar itself isn't a live region). */}
      <div role="status" className="sr-only" data-app-announcements>
        {announcement && <p key={announcement.id}>{announcement.text}</p>}
      </div>
    </div>
  );
}

export default App;
