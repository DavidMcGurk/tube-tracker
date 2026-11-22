import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRoute, sections } from '../data/network';
import { getRouteItems, sanitizeProgress } from './progress';
import {
  applySyncResponse,
  beginBackup,
  db,
  endBackup,
  endUndoWindow,
  findLocalOnlyItems,
  loadTheme,
  newChangeId,
  readJourneyUndo,
  readSyncSummary,
  recordJourney,
  requeueHeldChanges,
  resetStoredProgress,
  shiftOutboxTimes,
  takeOutboxBatch,
  undoLastJourney,
  UNDO_WINDOW_MS,
  updateProgress,
  type OutboxRow
} from './storage';
import { applyChange, CHANGE_ID_PATTERN, emptyState, LIMITS, validateState, type Change, type SyncState } from './sync-model';
import type { Progress, RouteResult } from './types';

const T = 1_800_000_000_000;
const ACCOUNT = { token: 't1', userHandle: 'user-1', name: 'Tube Tracker · K3F9' };
const [S1, S2, S3, S4] = sections.map((section) => section.id) as [string, string, string, string];

function route(start: string, end: string): RouteResult {
  const found = findRoute(start, end);
  if (!found) throw new Error(`Expected a route from ${start} to ${end}`);
  return found;
}

const progressWith = (travelledSegmentIDs: string[], stationsEnteredOrExitedIDs: string[] = []): Progress =>
  ({ travelledSegmentIDs, walkedLinkIDs: [], stationsEnteredOrExitedIDs, stationsChangedAtIDs: [] });

async function storedProgress(): Promise<Progress> {
  return sanitizeProgress((await db.progress.get('current'))?.value);
}

async function storedState(): Promise<SyncState> {
  const record = await db.sync.get('state');
  return (record?.id === 'state' ? validateState(record.value) : null) ?? emptyState();
}

const outbox = () => db.outbox.orderBy('seq').toArray();
const signIn = (state: SyncState = emptyState(), add: 'all' | 'missing' | 'none' = 'none') =>
  beginBackup({ account: ACCOUNT, state, clockOffset: 0, add });
const sorted = (ids: readonly string[]) => [...ids].sort();
const stateWith = (resetAt: number, items: Record<string, number>): SyncState => {
  const state = emptyState();
  state.resetAt = resetAt;
  Object.assign(state.items.sections, items);
  return state;
};
const response = (state: SyncState, rejected: Array<{ id: string; code: string }> = [], clockOffset = 0) => ({ state, rejected, clockOffset });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T);
  await Dexie.delete('tube-tracker-db');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the version 2 upgrade', () => {
  it('keeps progress and settings stored by version 1, and adds the backup tables', async () => {
    db.close({ disableAutoOpen: false });
    const old = new Dexie('tube-tracker-db');
    old.version(1).stores({ progress: 'id', settings: 'id' });
    await old.table('progress').put({ id: 'current', value: progressWith([S1, S2], ['bank']) });
    await old.table('settings').put({ id: 'theme', value: 'dark' });
    old.close();

    expect(await loadTheme()).toBe('dark');
    expect(await storedProgress()).toEqual(progressWith([S1, S2], ['bank']));
    expect(db.verno).toBe(2);
    expect(await db.outbox.count()).toBe(0);
    expect(await readSyncSummary()).toMatchObject({ account: null, unsent: 0, held: 0 });
  });
});

describe('recording while signed out and signed in', () => {
  const journey = route('paddington', 'waterloo');

  it('queues nothing while backup is off', async () => {
    const { progress, queued } = await recordJourney(journey);
    expect(queued).toBe(false);
    expect(progress.travelledSegmentIDs).toEqual(journey.sections.map((section) => section.id));
    expect(await storedProgress()).toEqual(progress);
    expect((await resetStoredProgress()).queued).toBe(false);
    expect(await db.outbox.count()).toBe(0);
  });

  it('queues every id the journey touches while backup is on', async () => {
    await signIn();
    const { queued } = await recordJourney(journey);
    expect(queued).toBe(true);
    const [row] = await outbox();
    const items = getRouteItems(journey);
    expect(row?.change).toMatchObject({ type: 'add', at: T, items: { sections: items.travelledSegmentIDs, entered: items.stationsEnteredOrExitedIDs } });
    expect(CHANGE_ID_PATTERN.test(row!.change.id)).toBe(true);
  });

  it('still queues a journey this device has already recorded, stamped after the last change', async () => {
    await recordJourney(journey);
    await signIn(emptyState(), 'all');
    const before = await storedProgress();
    const { progress, queued } = await recordJourney(journey);
    expect(queued).toBe(true);
    expect(progress).toEqual(before);
    await recordJourney(journey);
    const rows = await outbox();
    // The turn-on add, then one per recording.
    expect(rows).toHaveLength(3);
    expect(rows[2]!.change).toMatchObject({ type: 'add', items: { sections: journey.sections.map((section) => section.id) } });
    expect(rows[2]!.change.at).toBeGreaterThan(rows[1]!.change.at);
    expect(rows[1]!.change.at).toBeGreaterThan(rows[0]!.change.at);
  });

  it('queues a reset with the cleared progress, and stamps the next journey after it', async () => {
    await signIn();
    await recordJourney(journey);
    expect(await readSyncSummary()).toMatchObject({ unsent: 1, unsentReset: false });
    const { progress, queued } = await resetStoredProgress();
    expect(queued).toBe(true);
    expect(progress).toEqual(progressWith([]));
    expect(await storedProgress()).toEqual(progressWith([]));
    expect(await readSyncSummary()).toMatchObject({ unsent: 2, unsentReset: true });
    await recordJourney(journey);
    const [add1, reset, add2] = (await outbox()).map((row) => row.change);
    expect(reset?.type).toBe('reset');
    expect(reset!.at).toBeGreaterThan(add1!.at);
    expect(add2!.at).toBeGreaterThan(reset!.at);
  });

  it('writes progress and the queued change together or not at all', async () => {
    await signIn();
    vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new Error('disk full'));
    await expect(recordJourney(journey)).rejects.toThrow('disk full');
    expect(await storedProgress()).toEqual(progressWith([]));
    expect(await db.outbox.count()).toBe(0);
  });

  it('stamps adds after a reset the device has synced, even with a slow clock', async () => {
    await signIn(stateWith(T + 60_000, {}));
    await recordJourney(journey);
    expect((await outbox())[0]?.change.at).toBe(T + 60_001);
  });
});

describe('newChangeId', () => {
  it('makes valid ids without crypto.randomUUID (an insecure context)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array<ArrayBuffer>) => real.getRandomValues(array) });
    const id = newChangeId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(CHANGE_ID_PATTERN.test(id)).toBe(true);
    expect(newChangeId()).not.toBe(id);
  });
});

describe('turning backup on and restoring', () => {
  it('queues all local journeys for a new backup', async () => {
    await updateProgress(() => progressWith([S1, S2], ['bank']));
    await signIn(emptyState(), 'all');
    const [row] = await outbox();
    expect(row?.change).toMatchObject({ type: 'add', items: { sections: [S1, S2], entered: ['bank'] } });
    expect(await storedProgress()).toEqual(progressWith([S1, S2], ['bank']));
    expect((await readSyncSummary()).account).toMatchObject({ token: 't1', name: ACCOUNT.name, signedInAt: T });
  });

  it('“Add them” queues only what the backup lacks, after its reset', async () => {
    await updateProgress(() => progressWith([S1, S2]));
    const backup = stateWith(T - 1000, { [S2]: T - 500, [S3]: T - 400 });
    expect(await findLocalOnlyItems(backup)).toEqual({ sections: [S1] });
    await signIn(backup, 'missing');
    const [row] = await outbox();
    expect(row?.change).toMatchObject({ type: 'add', items: { sections: [S1] } });
    expect(row!.change.at).toBeGreaterThan(backup.resetAt);
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted([S1, S2, S3]));
  });

  it('“Don’t add them” makes this device show the backup’s journeys', async () => {
    await updateProgress(() => progressWith([S1, S2]));
    await signIn(stateWith(0, { [S3]: T - 400 }), 'none');
    expect(await db.outbox.count()).toBe(0);
    expect(await storedProgress()).toEqual(progressWith([S3]));
  });
});

describe('turning backup off', () => {
  it('forgets the session and queue but keeps journeys, unless asked to remove them', async () => {
    await signIn();
    await recordJourney(route('paddington', 'waterloo'));
    expect(await endBackup({ removeLocal: false })).toBe(true);
    expect(await readSyncSummary()).toMatchObject({ account: null, unsent: 0, lastSyncedAt: null, notice: null });
    expect(await db.sync.count()).toBe(0);
    expect((await storedProgress()).travelledSegmentIDs.length).toBeGreaterThan(0);

    await signIn();
    expect(await endBackup({ removeLocal: true })).toBe(true);
    expect(await storedProgress()).toEqual(progressWith([]));
    expect(await db.outbox.count()).toBe(0);
  });

  it('only signs out the session it was asked about, and records the notice', async () => {
    await signIn();
    expect(await endBackup({ token: 'stale', notice: true })).toBe(false);
    expect((await readSyncSummary()).account).not.toBeNull();
    expect(await endBackup({ token: 't1', notice: true })).toBe(true);
    expect((await readSyncSummary()).notice).toEqual({ kind: 'signed_out', accountName: ACCOUNT.name, at: T });
  });
});

describe('applying a sync response', () => {
  /** Records a journey and closes its undo window (as dismissing the undo bar does), so its add can be sent. */
  async function recordAndClose(journey: RouteResult) {
    await recordJourney(journey);
    await endUndoWindow();
  }

  async function sendAll() {
    const batch = await takeOutboxBatch({ maxRows: LIMITS.maxChangesPerRequest, maxBytes: 200 * 1024 });
    return batch!.rows;
  }

  /** What the server would hold after applying `rows` to `state`. */
  const serverAfter = (state: SyncState, rows: readonly OutboxRow[]) => rows.reduce((current, row) => applyChange(current, row.change), state);

  it('deletes sent rows, stores the merged state and status, and keeps progress', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const sent = await sendAll();
    const result = await applySyncResponse({ token: 't1', sent, response: response(serverAfter(emptyState(), sent), [], 1234) });
    expect(result).toEqual({ applied: true, unsent: 0 });
    expect(await db.outbox.count()).toBe(0);
    expect(Object.keys((await storedState()).items.sections)).toEqual(route('paddington', 'waterloo').sections.map((section) => section.id));
    expect(await db.sync.get('clock')).toMatchObject({ offset: 1234 });
    expect(await readSyncSummary()).toMatchObject({ lastSyncedAt: T, lastError: null });
  });

  it('ignores a response for a session that has since changed', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const sent = await sendAll();
    await endBackup({});
    await beginBackup({ account: { ...ACCOUNT, token: 't2' }, state: emptyState(), clockOffset: 0, add: 'none' });
    await recordAndClose(route('bank', 'stratford'));
    const rowsBefore = await outbox();
    const result = await applySyncResponse({ token: 't1', sent, response: response(stateWith(0, { [S4]: T })) });
    expect(result.applied).toBe(false);
    expect(await outbox()).toEqual(rowsBefore);
    expect(await storedState()).toEqual(emptyState());
  });

  it('holds refused rows, which still count locally', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const before = await storedProgress();
    const sent = await sendAll();
    const result = await applySyncResponse({ token: 't1', sent, response: response(emptyState(), [{ id: sent[0]!.change.id, code: 'backup_full' }]) });
    expect(result).toEqual({ applied: true, unsent: 0 });
    expect((await outbox())[0]?.held).toEqual({ code: 'backup_full', at: T });
    expect(await storedProgress()).toEqual(before);
    expect((await takeOutboxBatch({ maxRows: 200, maxBytes: 1e6 }))?.rows).toEqual([]);
    expect((await readSyncSummary()).held).toBe(1);
  });

  it('re-queues ids written outside the outbox (an old version-1 tab), and keeps them', async () => {
    await signIn();
    await applySyncResponse({ token: 't1', sent: [], response: response(stateWith(0, { [S1]: T - 10 })) });
    expect(await storedProgress()).toEqual(progressWith([S1]));

    const oldTab = new Dexie('tube-tracker-db');
    oldTab.version(1).stores({ progress: 'id', settings: 'id' });
    await oldTab.table('progress').put({ id: 'current', value: progressWith([S1, S2]) });
    oldTab.close();

    vi.setSystemTime(T + 5000);
    await applySyncResponse({ token: 't1', sent: [], response: response(stateWith(0, { [S1]: T - 10 })) });
    const [row] = await outbox();
    expect(row?.change).toMatchObject({ type: 'add', at: T + 5000, items: { sections: [S2] } });
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted([S1, S2]));
    expect((await sendAll()).map((sent) => sent.change.id)).toEqual([row!.change.id]);
  });

  it('applies a reset from another device, keeping journeys queued after it', async () => {
    await signIn();
    await applySyncResponse({ token: 't1', sent: [], response: response(stateWith(0, { [S1]: T - 100, [S2]: T - 90 })) });
    // Recorded here after the other device's reset (but before hearing of it): sent and kept.
    await recordAndClose(route('paddington', 'waterloo'));
    const sent = await sendAll();
    const remote = serverAfter(stateWith(T - 50, {}), sent);
    await applySyncResponse({ token: 't1', sent, response: response(remote) });
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(route('paddington', 'waterloo').sections.map((section) => section.id)));
    expect((await storedState()).resetAt).toBe(T - 50);
  });

  it('never goes backwards: re-queues what a rolled-back server lost, with the original times', async () => {
    await signIn();
    await applySyncResponse({ token: 't1', sent: [], response: response(stateWith(T - 1000, { [S1]: T - 100, [S2]: T - 90 })) });
    // The server comes back from a restore that predates the reset and S2.
    await applySyncResponse({ token: 't1', sent: [], response: response(stateWith(0, { [S1]: T - 100, [S3]: T - 2000 })) });
    const changes = (await outbox()).map((row) => row.change);
    expect(changes).toEqual([
      expect.objectContaining({ type: 'reset', at: T - 1000 }),
      expect.objectContaining({ type: 'add', at: T - 90, items: { sections: [S2] } })
    ]);
    expect(await storedState()).toEqual(stateWith(T - 1000, { [S1]: T - 100, [S2]: T - 90 }));
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted([S1, S2]));

    // The same answer again queues nothing more: the queue already covers it.
    await applySyncResponse({ token: 't1', sent: [], response: response(stateWith(0, { [S1]: T - 100 })) });
    expect(await db.outbox.count()).toBe(2);
  });

  it('doesn’t re-queue what a held row already covers', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const sent = await sendAll();
    await applySyncResponse({ token: 't1', sent, response: response(emptyState(), [{ id: sent[0]!.change.id, code: 'backup_full' }]) });
    await applySyncResponse({ token: 't1', sent: [], response: response(emptyState()) });
    await applySyncResponse({ token: 't1', sent: [], response: response(emptyState()) });
    expect(await db.outbox.count()).toBe(1);
  });
});

describe('re-queuing held rows', () => {
  it('turns held adds into one fresh add of the ids still shown, and un-holds resets', async () => {
    await signIn();
    await db.outbox.bulkAdd([
      { change: { id: 'a1', type: 'add', at: T - 300, items: { sections: [S1] } }, held: { code: 'invalid', at: T } },
      { change: { id: 'r1', type: 'reset', at: T - 200 }, held: { code: 'invalid', at: T } },
      { change: { id: 'a2', type: 'add', at: T - 100, items: { sections: [S2, S3] } }, held: { code: 'backup_full', at: T } }
    ]);
    expect(await requeueHeldChanges()).toBe(true);
    const rows = await outbox();
    expect(rows.map((row) => [row.change.id, row.held])).toEqual([['r1', undefined], [expect.any(String), undefined]]);
    // S1 was added before the (held) reset, so it isn't shown and doesn't come back.
    expect(rows[1]!.change).toMatchObject({ type: 'add', items: { sections: [S2, S3] } });
    expect(rows[1]!.change.at).toBeGreaterThan(T - 100);
    expect(await requeueHeldChanges()).toBe(false);
  });
});

describe('correcting a skewed clock', () => {
  it('moves queued changes by the change in offset, keeping their order', async () => {
    await signIn();
    // This device's clock is ten minutes fast.
    vi.setSystemTime(T + 600_000);
    await recordJourney(route('paddington', 'waterloo'));
    await resetStoredProgress();
    await recordJourney(route('bank', 'stratford'));
    expect(await shiftOutboxTimes({ token: 't1', clockOffset: -600_000 })).toBe(true);
    const changes = (await outbox()).map((row) => row.change);
    expect(changes.map((change) => change.at)).toEqual([T, T + 1, T + 2]);
    expect(changes.map((change) => change.type)).toEqual(['add', 'reset', 'add']);
    expect(await db.sync.get('clock')).toEqual({ id: 'clock', offset: -600_000, lastStampedAt: T + 2 });
  });

  it('brings back changes stamped by a clock that has since been corrected', async () => {
    await signIn();
    const yearAhead = 365 * 24 * 3600_000;
    vi.setSystemTime(T + yearAhead);
    await recordJourney(route('paddington', 'waterloo'));
    vi.setSystemTime(T);
    // The offset didn't change, but the queued change is still a year ahead of the server.
    await shiftOutboxTimes({ token: 't1', clockOffset: 0 });
    expect((await outbox()).map((row) => row.change.at)).toEqual([T]);
    expect((await db.sync.get('clock'))).toMatchObject({ lastStampedAt: T });
  });

  it('ignores a stale session', async () => {
    await signIn();
    expect(await shiftOutboxTimes({ token: 'other', clockOffset: 5 })).toBe(false);
  });
});

describe('batches', () => {
  it('leave out held rows and stop at the row and byte limits', async () => {
    await signIn();
    const add = (id: string, at: number): Change => ({ id, type: 'add', at, items: { sections: [S1] } });
    await db.outbox.bulkAdd([
      { change: add('h', T), held: { code: 'invalid', at: T } },
      ...Array.from({ length: 5 }, (_, index) => ({ change: add(`c${index}`, T + index) }))
    ]);
    expect((await takeOutboxBatch({ maxRows: 3, maxBytes: 1e6 }))?.rows.map((row) => row.change.id)).toEqual(['c0', 'c1', 'c2']);
    const size = JSON.stringify(add('c0', T)).length;
    expect((await takeOutboxBatch({ maxRows: 200, maxBytes: size * 2 }))?.rows).toHaveLength(2);
    expect((await takeOutboxBatch({ maxRows: 200, maxBytes: 1 }))?.rows).toHaveLength(1);
    await endBackup({});
    expect(await takeOutboxBatch({ maxRows: 200, maxBytes: 1e6 })).toBeNull();
  });
});

describe('timed undo', () => {
  const first = route('paddington', 'waterloo');
  // Further along the same line: it shares track and Paddington with the first, and adds the rest.
  const longer = route('paddington', 'elephant_castle');
  const ids = (journey: RouteResult) => journey.sections.map((section) => section.id);
  const batch = async () => (await takeOutboxBatch({ maxRows: 200, maxBytes: 1e6 }))?.rows.map((row) => row.change.id);

  /** Records a journey and closes its window, as if it was recorded long ago. */
  async function recordEarlier(journey: RouteResult) {
    await recordJourney(journey);
    await endUndoWindow();
  }

  it('the routes used here overlap', () => {
    expect(ids(longer).filter((id) => ids(first).includes(id)).length).toBeGreaterThan(0);
    expect(ids(longer).filter((id) => !ids(first).includes(id)).length).toBeGreaterThan(0);
  });

  it('holds a new journey’s add until its window closes', async () => {
    await signIn();
    const { queued, undo } = await recordJourney(first);
    expect(queued).toBe(true);
    expect(undo).toEqual({ recordedAt: T, expiresAt: T + UNDO_WINDOW_MS });
    expect(await readJourneyUndo()).toEqual(undo);
    const [row] = await outbox();
    expect(row).toMatchObject({ waitUntil: T + UNDO_WINDOW_MS, change: { type: 'add' } });
    expect(row?.held).toBeUndefined();
    // Not sent while it can be undone, but still counted as not backed up.
    expect(await batch()).toEqual([]);
    expect(await readSyncSummary()).toMatchObject({ unsent: 1, held: 0, undoWaits: [T + UNDO_WINDOW_MS] });

    vi.setSystemTime(T + UNDO_WINDOW_MS - 1);
    expect(await batch()).toEqual([]);
    vi.setSystemTime(T + UNDO_WINDOW_MS);
    expect(await batch()).toEqual([row!.change.id]);
    // Run out by the clock: nothing to undo, and nothing changes.
    const before = await storedProgress();
    expect((await undoLastJourney()).outcome).toBe('expired');
    expect(await storedProgress()).toEqual(before);
    expect(await db.outbox.count()).toBe(1);
  });

  it('undoing removes only what the journey added, and its add is never sent', async () => {
    await signIn();
    await recordEarlier(first);
    const before = await storedProgress();
    const rowsBefore = await outbox();
    await recordJourney(longer);
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted([...new Set([...ids(first), ...ids(longer)])]));

    vi.setSystemTime(T + UNDO_WINDOW_MS - 1);
    const { outcome, progress, undone } = await undoLastJourney();
    expect(outcome).toBe('undone');
    expect(undone).toEqual({ recordedAt: T, expiresAt: T + UNDO_WINDOW_MS });
    // Exactly as before, order included: shared track and Paddington stay.
    expect(progress).toEqual(before);
    expect(await storedProgress()).toEqual(before);
    expect(await outbox()).toEqual(rowsBefore);
    expect(await readJourneyUndo()).toBeNull();
    expect((await undoLastJourney()).outcome).toBe('expired');
  });

  it('works the same while backup is off', async () => {
    await recordJourney(first);
    expect(await db.sync.get('undo')).toMatchObject({ outboxSeq: null, added: { sections: ids(first) } });
    expect((await undoLastJourney()).outcome).toBe('undone');
    expect(await storedProgress()).toEqual(progressWith([]));
    expect(await db.outbox.count()).toBe(0);
  });

  it('is too late once the add has gone anyway (an older copy of the app sent it), and then changes nothing', async () => {
    await signIn();
    await recordJourney(first);
    const before = await storedProgress();
    await db.outbox.clear();
    expect((await undoLastJourney()).outcome).toBe('too_late');
    expect(await storedProgress()).toEqual(before);
    expect(await readJourneyUndo()).not.toBeNull();
  });

  it('keeps ids that another device’s journey has brought here since', async () => {
    await signIn();
    await recordJourney(first);
    const [shared, ...rest] = ids(first);
    // Another device recorded the first section too, and this device synced (its own journey still waiting).
    const sent = await takeOutboxBatch({ maxRows: 200, maxBytes: 1e6 });
    await applySyncResponse({ token: 't1', sent: sent!.rows, response: response(stateWith(0, { [shared!]: T - 10 })) });
    expect((await outbox())[0]).toMatchObject({ waitUntil: T + UNDO_WINDOW_MS });
    expect((await undoLastJourney()).outcome).toBe('undone');
    const after = (await storedProgress()).travelledSegmentIDs;
    expect(after).toEqual([shared]);
    expect(rest.length).toBeGreaterThan(0);
  });

  describe('the window ends early', () => {
    async function expectClosed() {
      expect(await readJourneyUndo()).toBeNull();
      expect((await outbox()).every((row) => row.waitUntil === undefined)).toBe(true);
      expect((await undoLastJourney()).outcome).toBe('expired');
    }

    it('when another journey is recorded, which opens its own', async () => {
      await signIn();
      await recordJourney(first);
      await recordJourney(route('bank', 'stratford'));
      const [firstRow, secondRow] = await outbox();
      expect(firstRow?.waitUntil).toBeUndefined();
      expect(secondRow?.waitUntil).toBe(T + UNDO_WINDOW_MS);
      expect(await batch()).toEqual([firstRow!.change.id]);
      expect((await undoLastJourney()).outcome).toBe('undone');
      expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(ids(first)));
    });

    it('when an already-explored journey is recorded, which offers no undo and isn’t delayed', async () => {
      await signIn();
      await recordJourney(first);
      const again = await recordJourney(first);
      expect(again).toMatchObject({ queued: true, undo: null });
      expect(await outbox()).toHaveLength(2);
      await expectClosed();
      expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(ids(first)));
    });

    it('on a reset', async () => {
      await signIn();
      await recordJourney(first);
      await resetStoredProgress();
      await expectClosed();
    });

    it('when the undo bar is dismissed (or on “Back up now”), keeping the journey', async () => {
      await signIn();
      await recordJourney(first);
      expect(await endUndoWindow()).toBe(true);
      await expectClosed();
      expect(await batch()).toHaveLength(1);
      expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(ids(first)));
      // Nothing was waiting the second time, or while backup is off.
      expect(await endUndoWindow()).toBe(false);
    });

    it('when backup is turned on or a backup restored', async () => {
      await recordJourney(first);
      await signIn(emptyState(), 'all');
      await expectClosed();
      expect(await outbox()).toEqual([expect.objectContaining({ change: expect.objectContaining({ items: expect.objectContaining({ sections: ids(first) }) }) })]);
    });

    it('when backup is turned off or deleted, or this device is signed out', async () => {
      await signIn();
      await recordJourney(first);
      await endBackup({ token: 't1', notice: true });
      await expectClosed();
      expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(ids(first)));
    });
  });

  it('a waiting add keeps waiting through a clock correction', async () => {
    await signIn();
    await recordJourney(first);
    await shiftOutboxTimes({ token: 't1', clockOffset: -1000 });
    expect((await outbox())[0]).toMatchObject({ waitUntil: T + UNDO_WINDOW_MS, change: { at: T - 1000 } });
  });

  it('records the journey, the waiting add and the window together or not at all', async () => {
    await signIn();
    const { undo } = await recordJourney(first);
    const before = await outbox();
    vi.setSystemTime(T + 1000);
    vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new Error('disk full'));
    await expect(recordJourney(longer)).rejects.toThrow('disk full');
    // The first journey's window is still open, its add still waiting.
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(ids(first)));
    expect(await outbox()).toEqual(before);
    expect(before[0]?.waitUntil).toBe(T + UNDO_WINDOW_MS);
    expect(await readJourneyUndo()).toEqual(undo);
  });
});
