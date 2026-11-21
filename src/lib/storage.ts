import Dexie, { liveQuery, type Table } from 'dexie';
import { sanitizeInstallPromptState, type InstallPromptState } from './install-prompt';
import { sanitizeProgress } from './progress';
import type { Progress, Theme } from './types';

interface ProgressRecord {
  id: 'current';
  /** Validated on load: older or corrupted records may not match the current Progress shape. */
  value: unknown;
}

interface ThemeSettingRecord {
  id: 'theme';
  value: Theme;
}

interface InstallPromptSettingRecord {
  id: 'installPrompt';
  value: InstallPromptState;
}

type SettingRecord = ThemeSettingRecord | InstallPromptSettingRecord;

class TubeTrackerDB extends Dexie {
  progress!: Table<ProgressRecord, ProgressRecord['id']>;
  settings!: Table<SettingRecord, SettingRecord['id']>;

  constructor() {
    super('tube-tracker-db');
    this.version(1).stores({
      progress: 'id',
      settings: 'id'
    });
  }
}

const db = new TubeTrackerDB();

async function readProgress(): Promise<Progress> {
  const record = await db.progress.get('current');
  return sanitizeProgress(record?.value);
}

/**
 * Reports the stored progress now and after every change, including changes made by another open copy of the app
 * (another tab, or the installed app alongside a browser tab).
 */
export function observeProgress(onChange: (progress: Progress) => void, onError: (error: unknown) => void) {
  const subscription = liveQuery(readProgress).subscribe({ next: onChange, error: onError });
  return () => subscription.unsubscribe();
}

/** Applies a change to the stored progress in one transaction, so concurrent copies of the app never overwrite each other. */
export async function updateProgress(change: (current: Progress) => Progress): Promise<Progress> {
  return db.transaction('rw', db.progress, async () => {
    const next = change(await readProgress());
    await db.progress.put({ id: 'current', value: next });
    return next;
  });
}

/*
 * The theme is also mirrored in localStorage so index.html can apply it before the app loads (no flash of the
 * wrong theme); IndexedDB stays the source of truth.
 */
export const THEME_STORAGE_KEY = 'tube-tracker-theme';

export function readThemeSync(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : null;
  } catch {
    return null;
  }
}

export async function loadTheme(): Promise<Theme> {
  const record = await db.settings.get('theme');
  return record?.id === 'theme' ? record.value : 'system';
}

export async function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing can block localStorage; IndexedDB below still records the choice.
  }
  await db.settings.put({ id: 'theme', value: theme });
}

async function readInstallPromptState() {
  const record = await db.settings.get('installPrompt');
  return record?.id === 'installPrompt' ? sanitizeInstallPromptState(record.value) : {};
}

/** Reports the stored install-prompt state now and after every change, including changes made elsewhere. */
export function observeInstallPromptState(onChange: (state: InstallPromptState) => void, onError: (error: unknown) => void) {
  const subscription = liveQuery(readInstallPromptState).subscribe({ next: onChange, error: onError });
  return () => subscription.unsubscribe();
}

export async function updateInstallPromptState(changes: InstallPromptState) {
  await db.transaction('rw', db.settings, async () => {
    const current = await readInstallPromptState();
    await db.settings.put({ id: 'installPrompt', value: { ...current, ...changes } });
  });
}
