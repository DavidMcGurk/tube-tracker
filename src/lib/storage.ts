import Dexie, { type Table } from 'dexie';
import { EMPTY_PROGRESS } from './progress';
import type { Progress } from './types';

interface ProgressRecord {
  id: 'current';
  value: Progress;
}

interface SettingRecord {
  id: 'theme';
  value: 'light' | 'dark' | 'system';
}

class TubeTrackerDB extends Dexie {
  progress!: Table<ProgressRecord, 'id'>;
  settings!: Table<SettingRecord, 'id'>;

  constructor() {
    super('tube-tracker-db');
    this.version(1).stores({
      progress: 'id',
      settings: 'id'
    });
  }
}

export const db = new TubeTrackerDB();

export async function loadProgress() {
  const record = await (db.progress as any).get('current');
  return record?.value ?? EMPTY_PROGRESS;
}

export async function saveProgress(progress: Progress) {
  await (db.progress as any).put({ id: 'current', value: progress });
}

export async function loadTheme() {
  const record = await (db.settings as any).get('theme');
  return record?.value ?? 'system';
}

export async function saveTheme(theme: 'light' | 'dark' | 'system') {
  await (db.settings as any).put({ id: 'theme', value: theme });
}
