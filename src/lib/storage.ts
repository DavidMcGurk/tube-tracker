import Dexie, { type Table } from 'dexie';
import { EMPTY_PROGRESS } from './progress';
import type { Progress, Theme } from './types';

interface ProgressRecord {
  id: 'current';
  value: Progress;
}

interface ThemeSettingRecord {
  id: 'theme';
  value: Theme;
}

type SettingRecord = ThemeSettingRecord;

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
  return record?.value ?? EMPTY_PROGRESS;
}

export async function saveProgress(progress: Progress) {
  await db.progress.put({ id: 'current', value: progress });
}

export async function loadTheme(): Promise<Theme> {
  const record = await db.settings.get('theme');
  return record?.value ?? 'system';
}

export async function saveTheme(theme: Theme) {
  await db.settings.put({ id: 'theme', value: theme });
}
