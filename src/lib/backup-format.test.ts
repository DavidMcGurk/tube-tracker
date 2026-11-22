import { describe, expect, it } from 'vitest';
import { describeMerge, describeMergeReset, describeStatus, describeUndoWait, formatDate, formatSince, formatTime } from './backup-format';
import type { SyncStatus } from './sync';

/** Midday, so the date is the same in any time zone the tests run in. */
const NOON = new Date(2027, 2, 3, 12, 0).getTime();
const MINUTE = 60_000;

const status = (overrides: Partial<SyncStatus>): SyncStatus => ({
  phase: 'idle',
  lastSyncedAt: NOON,
  unsent: false,
  awaitingUndo: false,
  unsentReset: false,
  heldCount: 0,
  error: null,
  pausedUntil: null,
  ...overrides
});

describe('dates and times', () => {
  it('formats dates and times the British way', () => {
    expect(formatDate(NOON)).toBe('3 March 2027');
    expect(formatTime(new Date(2027, 2, 4, 0, 0).getTime())).toBe('00:00');
    expect(formatTime(new Date(2027, 2, 3, 9, 5).getTime())).toBe('09:05');
  });

  it('says how long ago something happened', () => {
    expect(formatSince(NOON, NOON + 20_000)).toBe('just now');
    expect(formatSince(NOON, NOON + MINUTE)).toBe('1 minute ago');
    expect(formatSince(NOON, NOON + 2 * MINUTE + 59_000)).toBe('2 minutes ago');
    expect(formatSince(NOON, NOON + 3 * 60 * MINUTE)).toBe('3 hours ago');
    expect(formatSince(NOON, NOON + 25 * 60 * MINUTE)).toBe('yesterday');
    expect(formatSince(NOON, NOON + 72 * 60 * MINUTE)).toBe('3 days ago');
    // A clock that went backwards isn't "in 5 minutes".
    expect(formatSince(NOON, NOON - 5 * MINUTE)).toBe('just now');
  });
});

describe('the status line', () => {
  const describe_ = (overrides: Partial<SyncStatus>, online = true) => describeStatus(status(overrides), { now: NOON + 2 * MINUTE, online });

  it('reads as the design says for each phase', () => {
    expect(describe_({})).toBe('Backed up · 2 minutes ago');
    expect(describe_({ lastSyncedAt: null })).toBe('Backed up');
    expect(describe_({ phase: 'syncing' })).toBe('Backing up…');
    expect(describe_({ phase: 'waiting', unsent: true }, false)).toBe('Waiting for a connection · your latest journeys are saved on this device');
    expect(describe_({ phase: 'waiting', unsent: true, error: { code: 'offline', message: 'x' } })).toBe('Waiting for a connection · your latest journeys are saved on this device');
    expect(describe_({ phase: 'waiting', unsent: true, error: { code: 'unavailable', message: 'x' } })).toBe('Backup service unavailable · will retry');
    expect(describe_({ phase: 'paused', pausedUntil: new Date(2027, 2, 4, 0, 0).getTime() })).toBe('Backup is paused until 00:00. Your journeys are safe on this device.');
    expect(describe_({ phase: 'error', error: { code: 'invalid', message: 'x' } })).toBe('Couldn’t back up. Updating the app may fix this.');
  });

  it('doesn’t claim to be backed up while a change is waiting to be sent', () => {
    expect(describe_({ unsent: true })).toBe('Backing up…');
  });

  it('says the latest journey backs up once it can no longer be undone, only while backing up goes ahead', () => {
    const line = 'Your latest journey backs up once it can no longer be undone.';
    expect(describe_({ awaitingUndo: true })).toBe('Backed up · 2 minutes ago');
    expect(describeUndoWait(status({ awaitingUndo: true }))).toBe(line);
    expect(describeUndoWait(status({ phase: 'syncing', awaitingUndo: true }))).toBe(line);
    expect(describeUndoWait(status({ phase: 'waiting', unsent: true, awaitingUndo: true }))).toBe(line);
    expect(describeUndoWait(status({}))).toBeNull();
    // Stopped by an error, or paused: closing the window doesn't send it, so the line would be untrue.
    expect(describeUndoWait(status({ phase: 'error', awaitingUndo: true, error: { code: 'invalid', message: 'x' } }))).toBeNull();
    expect(describeUndoWait(status({ phase: 'paused', awaitingUndo: true, pausedUntil: NOON + 60 * MINUTE }))).toBeNull();
  });
});

describe('the restore summary', () => {
  const merge = { accountName: 'Tube Tracker · K3F9', resetAt: 0, sections: 12, walks: 0, stations: 3 };

  it('counts what this device has that the backup lacks', () => {
    expect(describeMerge(merge)).toBe('This device has 12 track sections and 3 stations that aren’t in Tube Tracker · K3F9.');
    expect(describeMerge({ ...merge, sections: 1, walks: 2, stations: 1 })).toBe('This device has 1 track section, 2 walks and 1 station that aren’t in Tube Tracker · K3F9.');
    expect(describeMerge({ ...merge, sections: 0, walks: 1 })).toBe('This device has 1 walk and 3 stations that aren’t in Tube Tracker · K3F9.');
    expect(describeMerge({ ...merge, sections: 0 })).toBe('This device has 3 stations that aren’t in Tube Tracker · K3F9.');
  });

  it('mentions when the backup was reset', () => {
    expect(describeMergeReset(NOON)).toBe('Your backup was reset on 3 March 2027, so some of these may be from before then.');
  });
});
