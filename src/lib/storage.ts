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

export async function loadProgress(): Promise<Progress> {
  const record = await db.progress.get('current');
  return sanitizeProgress(record?.value);
}

export async function saveProgress(progress: Progress) {
  await db.progress.put({ id: 'current', value: progress });
}

export async function loadTheme(): Promise<Theme> {
  const record = await db.settings.get('theme');
  return record?.id === 'theme' ? record.value : 'system';
}

export async function saveTheme(theme: Theme) {
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
