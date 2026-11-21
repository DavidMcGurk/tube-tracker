import Dexie, { liveQuery, type Table } from 'dexie';
import { sanitizeInstallPromptState, type InstallPromptState } from './install-prompt';
import { sanitizeProgress } from './progress';
import type { Progress, ProgressStyle, Theme } from './types';

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

interface ProgressStyleSettingRecord {
  id: 'progressStyle';
  value: ProgressStyle;
}

type SettingRecord = ThemeSettingRecord | InstallPromptSettingRecord | ProgressStyleSettingRecord;

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
 * Display settings are also mirrored in localStorage so they can be applied before IndexedDB answers (index.html
 * applies the theme before the app loads, so there's no flash of the wrong theme); IndexedDB stays the source of truth.
 */
export const THEME_STORAGE_KEY = 'tube-tracker-theme';
const PROGRESS_STYLE_STORAGE_KEY = 'tube-tracker-progress-style';

function readMirror<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const stored = localStorage.getItem(key);
    return allowed.find((value) => value === stored) ?? null;
  } catch {
    return null;
  }
}

function writeMirror(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing can block localStorage; IndexedDB still records the choice.
  }
}

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
const PROGRESS_STYLES: readonly ProgressStyle[] = ['lines', 'band'];

export function readThemeSync(): Theme | null {
  return readMirror(THEME_STORAGE_KEY, THEMES);
}

export async function loadTheme(): Promise<Theme> {
  const record = await db.settings.get('theme');
  return record?.id === 'theme' && THEMES.includes(record.value) ? record.value : 'system';
}

export async function saveTheme(theme: Theme) {
  writeMirror(THEME_STORAGE_KEY, theme);
  await db.settings.put({ id: 'theme', value: theme });
}

export function readProgressStyleSync(): ProgressStyle | null {
  return readMirror(PROGRESS_STYLE_STORAGE_KEY, PROGRESS_STYLES);
}

export async function loadProgressStyle(): Promise<ProgressStyle | null> {
  const record = await db.settings.get('progressStyle');
  return record?.id === 'progressStyle' && PROGRESS_STYLES.includes(record.value) ? record.value : null;
}

export async function saveProgressStyle(style: ProgressStyle) {
  writeMirror(PROGRESS_STYLE_STORAGE_KEY, style);
  await db.settings.put({ id: 'progressStyle', value: style });
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
