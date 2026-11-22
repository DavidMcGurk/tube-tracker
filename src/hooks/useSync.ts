import { useMemo, useSyncExternalStore } from 'react';
import { getSyncActions, getSyncSnapshot, subscribeSync, type SyncActions, type SyncSnapshot } from '../lib/sync';

export type { Outcome, RestoreMerge, SyncAccount, SyncPhase, SyncStatus } from '../lib/sync';

export type SyncController = SyncSnapshot & SyncActions;

/**
 * Backup & sync: its state and actions. Subscribe-only: the engine started in main.tsx owns every timer, listener
 * and request, so any number of components can use this without syncing more often.
 */
export function useSync(): SyncController {
  const snapshot = useSyncExternalStore(subscribeSync, getSyncSnapshot, getSyncSnapshot);
  return useMemo(() => ({ ...snapshot, ...getSyncActions() }), [snapshot]);
}
