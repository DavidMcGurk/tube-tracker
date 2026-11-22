/** Wording for the Backup & sync section (docs/sync-design.md, "UI"): dates, the status line and the restore summary. */
import type { RestoreMerge, SyncStatus } from './sync';

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const RELATIVE_FORMAT = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 March 2027" */
export function formatDate(ms: number): string {
  return DATE_FORMAT.format(ms);
}

/** "00:00", on this device's clock. */
export function formatTime(ms: number): string {
  return TIME_FORMAT.format(ms);
}

/** "just now", "2 minutes ago", "3 hours ago", "yesterday". */
export function formatSince(ms: number, now: number): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return RELATIVE_FORMAT.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return RELATIVE_FORMAT.format(-Math.floor(elapsed / HOUR), 'hour');
  return RELATIVE_FORMAT.format(-Math.floor(elapsed / DAY), 'day');
}

/**
 * The status line while backup is on. A change waiting out the short delay before it's sent already reads "Backing
 * up…". A journey that can still be undone is the exception: it isn't due yet, so the line stays "Backed up", and
 * describeUndoWait gives the second line saying it backs up once its undo window ends.
 */
export function describeStatus(status: SyncStatus, { now, online }: { now: number; online: boolean }): string {
  switch (status.phase) {
    case 'syncing':
      return 'Backing up…';
    case 'paused':
      return `Backup is paused until ${formatTime(status.pausedUntil ?? now)}. Your journeys are safe on this device.`;
    case 'error':
      return 'Couldn’t back up. Updating the app may fix this.';
    case 'waiting':
      return !online || status.error?.code === 'offline'
        ? 'Waiting for a connection · your latest journeys are saved on this device'
        : 'Backup service unavailable · will retry';
    default:
      if (status.unsent) return 'Backing up…';
      return status.lastSyncedAt === null ? 'Backed up' : `Backed up · ${formatSince(status.lastSyncedAt, now)}`;
  }
}

/**
 * The second line while the latest journey waits out its undo window, or null. Not while backing up is paused or has
 * stopped with an error: then the journey isn't sent when its window ends either, so the line would mislead.
 */
export function describeUndoWait(status: SyncStatus): string | null {
  if (!status.awaitingUndo || status.phase === 'paused' || status.phase === 'error') return null;
  return 'Your latest journey backs up once it can no longer be undone.';
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "This device has 12 track sections and 3 stations that aren’t in Tube Tracker · K3F9." */
export function describeMerge(merge: RestoreMerge): string {
  const parts = [
    merge.sections > 0 ? count(merge.sections, 'track section', 'track sections') : null,
    merge.walks > 0 ? count(merge.walks, 'walk', 'walks') : null,
    merge.stations > 0 ? count(merge.stations, 'station', 'stations') : null
  ].filter((part): part is string => part !== null);
  return `This device has ${joinList(parts)} that aren’t in ${merge.accountName}.`;
}

/** Only when the backup has been reset (resetAt > 0). */
export function describeMergeReset(resetAt: number): string {
  return `Your backup was reset on ${formatDate(resetAt)}, so some of these may be from before then.`;
}
