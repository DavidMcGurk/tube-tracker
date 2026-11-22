import Dexie, { liveQuery, type EntityTable, type Table } from 'dexie';
import { sanitizeInstallPromptState, type InstallPromptState } from './install-prompt';
import { addRouteToProgress, EMPTY_PROGRESS, getRouteItems, sanitizeProgress } from './progress';
import {
  applyAll,
  changesToRestore,
  countItemIds,
  emptyState,
  isValidItemId,
  ITEM_KINDS,
  itemsMissingFrom,
  knownResetAt,
  LIMITS,
  mergeStates,
  PROGRESS_FIELDS,
  progressToItems,
  shiftPendingTimes,
  stampAt,
  toProgress,
  validateChange,
  validateState,
  type Change,
  type ChangeItems,
  type ItemKind,
  type SyncState
} from './sync-model';
import type { Progress, ProgressStyle, RouteResult, Theme } from './types';

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

/**
 * A change waiting to be backed up. A held row was refused by the server: it isn't sent again automatically, but it
 * still counts towards this device's progress, so a refusal never removes a journey. A row with `waitUntil` is the
 * latest journey, which can still be undone until then: it isn't sent before, so undoing it never needs a "remove" in
 * the backup (docs/sync-design.md, "Timed undo").
 */
export interface OutboxRow {
  seq: number;
  change: Change;
  held?: { code: string; at: number };
  waitUntil?: number;
}

/** The signed-in backup. Its presence, read inside each transaction, is what decides whether changes are queued. */
export interface SyncAccountRecord {
  id: 'account';
  token: string;
  userHandle: string;
  name: string;
  signedInAt: number;
}

interface SyncStateRecord {
  id: 'state';
  /** The last state the server confirmed, merged so it never goes backwards. Validated on load. */
  value: unknown;
}

interface SyncClockRecord {
  id: 'clock';
  /** Server clock minus this device's clock (ms). */
  offset: number;
  lastStampedAt: number;
}

/**
 * Why the last backup attempt failed. Shared through IndexedDB so every open copy of the app can show the same
 * status: `retryable` failures (offline, server unavailable) only mean "waiting"; `retryAt` is set while the server
 * has asked for a pause (Retry-After), so no copy of the app sends before then.
 */
export interface SyncError {
  code: string;
  message: string;
  retryable: boolean;
  retryAt: number | null;
}

interface SyncStatusRecord {
  id: 'status';
  lastSyncedAt: number | null;
  lastError: SyncError | null;
}

export interface SyncNotice {
  kind: 'signed_out';
  accountName: string;
  at: number;
}

/** Survives sign-out, so the app can explain why backup stopped; cleared when dismissed or on signing in again. */
interface SyncNoticeRecord extends SyncNotice {
  id: 'notice';
}

/**
 * The latest journey, while it can still be undone (signed in or not). Kept with the backup records so the same
 * transactions that queue changes can end its window.
 */
interface SyncUndoRecord {
  id: 'undo';
  recordedAt: number;
  expiresAt: number;
  /** The ids this journey newly added on this device: exactly what undoing it removes. Validated on load. */
  added: ChangeItems;
  /** Its queued `add` (signed in), which waits until expiresAt; null when backup was off. */
  outboxSeq: number | null;
}

type SyncRecord = SyncAccountRecord | SyncStateRecord | SyncClockRecord | SyncStatusRecord | SyncNoticeRecord | SyncUndoRecord;

class TubeTrackerDB extends Dexie {
  progress!: Table<ProgressRecord, ProgressRecord['id']>;
  settings!: Table<SettingRecord, SettingRecord['id']>;
  outbox!: EntityTable<OutboxRow, 'seq'>;
  sync!: Table<SyncRecord, SyncRecord['id']>;

  constructor() {
    super('tube-tracker-db');
    this.version(1).stores({
      progress: 'id',
      settings: 'id'
    });
    // Backup & sync. Only adds tables, so the upgrade keeps everything already stored.
    this.version(2).stores({
      outbox: '++seq',
      sync: 'id'
    });
    /*
     * Another copy of the app is upgrading the database to a newer version. Close and reload so this page runs the
     * new code, instead of carrying on with the old schema (or Dexie quietly reopening it) and writing behind the
     * newer version's back. A deletion (newVersion null) keeps Dexie's default: close, and reopen on next use.
     */
    this.on('versionchange', (event) => {
      if (!event.newVersion) return undefined;
      this.close();
      if (typeof location !== 'undefined') location.reload();
      return false;
    });
  }
}

/** Exported for tests only. */
export const db = new TubeTrackerDB();

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

/**
 * Applies a change to the stored progress in one transaction, so concurrent copies of the app never overwrite each
 * other. It never queues a backup change (recordJourney and resetStoredProgress do), so the next backup's reconcile
 * step picks up anything written this way.
 */
export async function updateProgress(change: (current: Progress) => Progress): Promise<Progress> {
  return db.transaction('rw', db.progress, async () => {
    const next = change(await readProgress());
    await db.progress.put({ id: 'current', value: next });
    return next;
  });
}

let persistenceRequested = false;

/**
 * Asks the browser to keep saved data even when the device runs low on space (it never protects against clearing site
 * data by hand). Asked at most once per page load. Chromium and Safari decide silently; Firefox asks the user, so
 * callers only ask when there is something worth keeping.
 */
export function requestPersistentStorage() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  navigator.storage?.persist?.().catch((error: unknown) => console.error('Unable to request persistent storage', error));
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

/*
 * Backup & sync (docs/sync-design.md, "Client"). Every function that touches progress, the outbox or the sync records
 * does so in one transaction over all three, and decides whether to queue a change by reading the account record
 * inside that transaction, never from React state or a module variable.
 */

/**
 * A random change id. crypto.randomUUID only exists in secure contexts, and the dev server is also opened over plain
 * http on a LAN address, so fall back to getRandomValues (available everywhere) as hex.
 */
export function newChangeId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const syncTables = () => [db.progress, db.outbox, db.sync];

function syncTransaction<T>(work: () => Promise<T>): Promise<T> {
  return db.transaction('rw', syncTables(), work);
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function readAccount(): Promise<SyncAccountRecord | null> {
  const record = await db.sync.get('account');
  if (record?.id !== 'account' || !isString(record.token) || !isString(record.userHandle) || typeof record.name !== 'string') return null;
  return record;
}

async function readState(): Promise<SyncState> {
  const record = await db.sync.get('state');
  return (record?.id === 'state' ? validateState(record.value) : null) ?? emptyState();
}

async function readClock(): Promise<{ offset: number; lastStampedAt: number }> {
  const record = await db.sync.get('clock');
  if (record?.id !== 'clock') return { offset: 0, lastStampedAt: 0 };
  return {
    offset: Number.isSafeInteger(record.offset) ? record.offset : 0,
    lastStampedAt: isTimestamp(record.lastStampedAt) ? record.lastStampedAt : 0
  };
}

function sanitizeSyncError(value: unknown): SyncError | null {
  if (typeof value !== 'object' || value === null) return null;
  const error = value as Partial<Record<keyof SyncError, unknown>>;
  if (!isString(error.code) || typeof error.message !== 'string') return null;
  return { code: error.code, message: error.message, retryable: error.retryable === true, retryAt: isTimestamp(error.retryAt) ? error.retryAt : null };
}

async function readStatus(): Promise<{ lastSyncedAt: number | null; lastError: SyncError | null }> {
  const record = await db.sync.get('status');
  if (record?.id !== 'status') return { lastSyncedAt: null, lastError: null };
  return { lastSyncedAt: isTimestamp(record.lastSyncedAt) ? record.lastSyncedAt : null, lastError: sanitizeSyncError(record.lastError) };
}

async function readNotice(): Promise<SyncNotice | null> {
  const record = await db.sync.get('notice');
  if (record?.id !== 'notice' || record.kind !== 'signed_out' || typeof record.accountName !== 'string') return null;
  return { kind: 'signed_out', accountName: record.accountName, at: isTimestamp(record.at) ? record.at : 0 };
}

/** Outbox rows in the order they were queued. A row that isn't a valid change (corrupted storage) is left alone. */
async function readOutbox(): Promise<OutboxRow[]> {
  const rows = await db.outbox.orderBy('seq').toArray();
  return rows.flatMap((row) => {
    const result = validateChange(row.change);
    return result.ok ? [{ ...row, change: result.change }] : [];
  });
}

const changesOf = (rows: readonly OutboxRow[]) => rows.map((row) => row.change);

/** What this device should show: the confirmed state with every queued change applied, held ones included. */
function localProgressFrom(state: SyncState, rows: readonly OutboxRow[]): Progress {
  return sanitizeProgress(toProgress(applyAll(state, changesOf(rows))));
}

function sameItems(a: Progress, b: Progress) {
  return (Object.keys(a) as Array<keyof Progress>).every((field) => {
    if (a[field].length !== b[field].length) return false;
    const present = new Set(b[field]);
    return a[field].every((id) => present.has(id));
  });
}

/** Rewrites stored progress only when its sets of ids differ, so the order journeys were recorded in is kept. */
async function writeProgressIfChanged(current: Progress, next: Progress) {
  if (!sameItems(current, next)) await db.progress.put({ id: 'current', value: next });
}

function dedupeItems(items: ChangeItems): ChangeItems {
  const unique: ChangeItems = {};
  for (const kind of ITEM_KINDS) {
    const ids = items[kind];
    if (ids && ids.length > 0) unique[kind] = [...new Set(ids)];
  }
  return unique;
}

/** Stamps and queues a change. Must run inside a sync transaction. An add with `waitUntil` isn't sent before then. */
async function queueChange(type: 'add', items: ChangeItems, waitUntil?: number): Promise<OutboxRow>;
async function queueChange(type: 'reset'): Promise<OutboxRow>;
async function queueChange(type: Change['type'], items?: ChangeItems, waitUntil?: number): Promise<OutboxRow> {
  const clock = await readClock();
  const pending = changesOf(await readOutbox());
  const at = stampAt({
    now: Date.now(),
    clockOffset: clock.offset,
    lastStampedAt: clock.lastStampedAt,
    knownResetAt: knownResetAt(await readState(), pending),
    type
  });
  await db.sync.put({ id: 'clock', offset: clock.offset, lastStampedAt: at });
  const change: Change = type === 'add' ? { id: newChangeId(), type, at, items: dedupeItems(items ?? {}) } : { id: newChangeId(), type, at };
  const row = waitUntil === undefined ? { change } : { change, waitUntil };
  const seq = await db.outbox.add(row);
  return { seq, ...row };
}

/*
 * Timed undo (docs/sync-design.md, "Timed undo"). For a few minutes after a journey is recorded it can be undone. While
 * it can, its backup waits on this device, so undoing never needs a "remove" in the backup format: the queued add is
 * simply deleted. The window ends early when another journey is recorded, on a reset, on "Back up now", when the undo
 * bar is dismissed, when the app is left while backup is on (see SyncEngine) and on any backup change (turning on,
 * restoring, turning off, deleting, being signed out).
 */

/** How long a recorded journey can be undone. */
export const UNDO_WINDOW_MS = 5 * 60_000;

/**
 * Whether a window's end (`expiresAt`, a row's `waitUntil`) is still to come, and no more than one window away. One
 * further off was set by a clock that has since been put back (or is corrupt): that window counts as over, so a
 * journey never waits, or offers Undo, for longer than the window.
 */
const withinUndoWindow = (end: number, now: number) => end > now && end - now <= UNDO_WINDOW_MS;

/** The latest journey's undo window. */
export interface JourneyUndo {
  recordedAt: number;
  /** When it can no longer be undone, and its backup is sent. */
  expiresAt: number;
}

export type UndoOutcome = 'undone' | 'expired' | 'too_late';

/** Valid ids by kind, leaving out empty kinds; null when the value isn't a set of items at all. */
function sanitizeItems(value: unknown): ChangeItems | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Partial<Record<string, unknown>>;
  const items: ChangeItems = {};
  for (const kind of ITEM_KINDS) {
    const ids = Object.hasOwn(record, kind) ? record[kind] : undefined;
    if (!Array.isArray(ids)) continue;
    const valid = ids.filter(isValidItemId);
    if (valid.length > 0) items[kind] = valid;
  }
  return items;
}

async function readUndo(): Promise<Omit<SyncUndoRecord, 'id'> | null> {
  const record = await db.sync.get('undo');
  if (record?.id !== 'undo' || !isTimestamp(record.recordedAt) || !isTimestamp(record.expiresAt)) return null;
  // Opened by a clock that was ahead and has since been put back: over (its add, likewise, no longer waits).
  if (record.expiresAt - Date.now() > UNDO_WINDOW_MS) return null;
  const added = sanitizeItems(record.added);
  const { outboxSeq } = record;
  // A row number that isn't one can't be undone safely: its add might still be sent.
  if (!added || (outboxSeq !== null && !(Number.isSafeInteger(outboxSeq) && outboxSeq > 0))) return null;
  return { recordedAt: record.recordedAt, expiresAt: record.expiresAt, added, outboxSeq };
}

const isWaiting = (row: OutboxRow, now: number) => typeof row.waitUntil === 'number' && withinUndoWindow(row.waitUntil, now);

/**
 * Ends the undo window, if one is open: the latest journey's add no longer waits (so it's sent with the next backup)
 * and the record is deleted. Must run inside a sync transaction. True when a waiting row was released.
 */
async function closeUndoWindow(): Promise<boolean> {
  const released = await db.outbox.filter((row) => row.waitUntil !== undefined).modify((row) => {
    delete row.waitUntil;
  });
  await db.sync.delete('undo');
  return released > 0;
}

/** Each kind's ids in `items`, as a progress record. */
function itemsToProgress(items: ChangeItems): Progress {
  const progress = { ...EMPTY_PROGRESS };
  for (const kind of ITEM_KINDS) progress[PROGRESS_FIELDS[kind]] = items[kind] ?? [];
  return progress;
}

/** `progress` without the ids in `remove`, except those in `keep`; the order of the rest is kept. */
function withoutItems(progress: Progress, remove: Progress, keep: Progress): Progress {
  const next = { ...progress };
  for (const field of Object.keys(progress) as Array<keyof Progress>) {
    const kept = new Set(keep[field]);
    const removed = new Set(remove[field].filter((id) => !kept.has(id)));
    if (removed.size > 0) next[field] = progress[field].filter((id) => !removed.has(id));
  }
  return next;
}

/**
 * Records a journey and, while backup is on, queues every id it touches, even when this device already has them all:
 * another device may have reset since, and the journey must survive that reset. Street-only walks touch nothing.
 *
 * Recording ends any earlier journey's undo window. When this journey adds something new here, it opens its own: its
 * add waits until the window closes, and `undo` says when that is. An already-explored journey offers no undo, and its
 * add is sent straight away.
 */
export async function recordJourney(route: RouteResult): Promise<{ progress: Progress; queued: boolean; undo: JourneyUndo | null }> {
  return syncTransaction(async () => {
    const now = Date.now();
    const current = await readProgress();
    const next = addRouteToProgress(current, route);
    const changed = next !== current;
    await closeUndoWindow();
    if (changed) await db.progress.put({ id: 'current', value: next });
    const items = progressToItems(getRouteItems(route));
    const queued = countItemIds(items) > 0 && (await readAccount()) !== null;
    const undo = changed ? { recordedAt: now, expiresAt: now + UNDO_WINDOW_MS } : null;
    const row = queued ? await queueChange('add', items, undo?.expiresAt) : null;
    if (undo) await db.sync.put({ id: 'undo', ...undo, added: itemsMissingFrom(next, current), outboxSeq: row?.seq ?? null });
    return { progress: next, queued, undo };
  });
}

/**
 * Undoes the latest journey while its window is open: deletes its waiting add (so the backup never sees it) and removes
 * exactly the ids it newly added here, except any a backed-up change still accounts for (another device's journey over
 * the same track that has arrived since). `expired`: no window is open, so nothing changes. `too_late`: its add has
 * been sent anyway (by a copy of the app from before undo existed), so nothing changes either.
 */
export async function undoLastJourney(): Promise<{ outcome: UndoOutcome; progress: Progress; undone: JourneyUndo | null }> {
  return syncTransaction(async () => {
    const current = await readProgress();
    const undo = await readUndo();
    if (!undo || undo.expiresAt <= Date.now()) return { outcome: 'expired', progress: current, undone: null };
    if (undo.outboxSeq !== null) {
      if (!(await db.outbox.get(undo.outboxSeq))) return { outcome: 'too_late', progress: current, undone: null };
      await db.outbox.delete(undo.outboxSeq);
    }
    const keep = (await readAccount()) ? localProgressFrom(await readState(), await readOutbox()) : EMPTY_PROGRESS;
    const next = withoutItems(current, itemsToProgress(undo.added), keep);
    await writeProgressIfChanged(current, next);
    await db.sync.delete('undo');
    return { outcome: 'undone', progress: next, undone: { recordedAt: undo.recordedAt, expiresAt: undo.expiresAt } };
  });
}

/** Dismissing the undo bar: the journey stays, and is backed up next. True when its backup had been waiting. */
export async function endUndoWindow(): Promise<boolean> {
  return syncTransaction(closeUndoWindow);
}

/** The latest journey's undo window, if one was opened and hasn't ended early (it may have run out by the clock). */
export async function readJourneyUndo(): Promise<JourneyUndo | null> {
  const undo = await readUndo();
  return undo && { recordedAt: undo.recordedAt, expiresAt: undo.expiresAt };
}

/** Reports the undo window now and after every change, including changes made by other copies of the app. */
export function observeJourneyUndo(onChange: (undo: JourneyUndo | null) => void, onError: (error: unknown) => void) {
  const subscription = liveQuery(readJourneyUndo).subscribe({ next: onChange, error: onError });
  return () => subscription.unsubscribe();
}

/** Clears progress and, while backup is on, queues a reset in the same transaction. Ends any undo window. */
export async function resetStoredProgress(): Promise<{ progress: Progress; queued: boolean }> {
  return syncTransaction(async () => {
    await closeUndoWindow();
    await db.progress.put({ id: 'current', value: EMPTY_PROGRESS });
    const queued = (await readAccount()) !== null;
    if (queued) await queueChange('reset');
    return { progress: EMPTY_PROGRESS, queued };
  });
}

export interface SyncSummary {
  account: SyncAccountRecord | null;
  /** Rows waiting to be sent (held rows excluded), including the latest journey while it can still be undone. */
  unsent: number;
  /** One of them is a reset, so other devices haven't cleared yet (turning off says so). */
  unsentReset: boolean;
  held: number;
  lastSyncedAt: number | null;
  lastError: SyncError | null;
  notice: SyncNotice | null;
  /**
   * When each unsent row that waits out its journey's undo window may be sent (at most one, normally), as of reading.
   * Rows whose time has passed are sent like any other, and so are rows whose time is more than a window away (set by
   * a clock that has since been put back).
   */
  undoWaits: number[];
}

export async function readSyncSummary(): Promise<SyncSummary> {
  return db.transaction('r', [db.outbox, db.sync], async () => {
    const now = Date.now();
    const rows = await readOutbox();
    const unsent = rows.filter((row) => !row.held);
    const status = await readStatus();
    return {
      account: await readAccount(),
      unsent: unsent.length,
      unsentReset: unsent.some((row) => row.change.type === 'reset'),
      held: rows.length - unsent.length,
      ...status,
      notice: await readNotice(),
      undoWaits: unsent.flatMap((row) => (isTimestamp(row.waitUntil) && withinUndoWindow(row.waitUntil, now) ? [row.waitUntil] : []))
    };
  });
}

/** Reports the backup's shared records now and after every change, including changes made by other copies of the app. */
export function observeSyncSummary(onChange: (summary: SyncSummary) => void, onError: (error: unknown) => void) {
  const subscription = liveQuery(readSyncSummary).subscribe({ next: onChange, error: onError });
  return () => subscription.unsubscribe();
}

/** This device's ids that a backup's state doesn't have: what restoring would offer to add. */
export async function findLocalOnlyItems(state: SyncState): Promise<ChangeItems> {
  return itemsMissingFrom(await readProgress(), sanitizeProgress(toProgress(state)));
}

/**
 * The next rows to send, oldest first, leaving out held rows and a journey that can still be undone: at most `maxRows`,
 * and no more than about `maxBytes` of JSON (always at least one row). Null when backup is off.
 */
export async function takeOutboxBatch({ maxRows, maxBytes }: { maxRows: number; maxBytes: number }): Promise<{ token: string; rows: OutboxRow[] } | null> {
  return db.transaction('r', [db.outbox, db.sync], async () => {
    const account = await readAccount();
    if (!account) return null;
    const now = Date.now();
    const rows: OutboxRow[] = [];
    let bytes = 0;
    for (const row of await readOutbox()) {
      if (row.held || isWaiting(row, now)) continue;
      const size = JSON.stringify(row.change).length;
      if (rows.length >= maxRows || (rows.length > 0 && bytes + size > maxBytes)) break;
      rows.push(row);
      bytes += size;
    }
    return { token: account.token, rows };
  });
}

export interface SyncResponseData {
  state: SyncState;
  /** Server clock minus this device's clock, measured around the request. */
  clockOffset: number;
  rejected: ReadonlyArray<{ id: string; code: string }>;
}

/**
 * Applies a /v1/sync answer in one transaction (docs/sync-design.md, "Applying a sync response"): checks it's for the
 * signed-in session; re-queues anything stored locally that the outbox can't explain (writes from an old tab, a race
 * or a bug); holds refused rows and deletes the rest of those sent; merges so the stored state never goes backwards;
 * re-queues anything the server has lost, with its original times; stores the clock and status; and rewrites local
 * progress if its ids changed.
 */
export async function applySyncResponse({ token, sent, response }: {
  token: string;
  sent: readonly OutboxRow[];
  response: SyncResponseData;
}): Promise<{ applied: boolean; unsent: number }> {
  return syncTransaction(async () => {
    // 1. A response for another session (signed out, or signed in again meanwhile) must change nothing.
    const account = await readAccount();
    if (!account || account.token !== token) return { applied: false, unsent: 0 };

    const now = Date.now();
    const stored = await readProgress();
    const state = await readState();
    const clock = await readClock();
    const rows = await readOutbox();
    let lastStampedAt = clock.lastStampedAt;

    // 2. Reconcile before deleting anything.
    const extras = itemsMissingFrom(stored, localProgressFrom(state, rows));
    if (countItemIds(extras) > 0) {
      const at = stampAt({ now, clockOffset: response.clockOffset, lastStampedAt, knownResetAt: knownResetAt(state, changesOf(rows)), type: 'add' });
      lastStampedAt = at;
      const change: Change = { id: newChangeId(), type: 'add', at, items: extras };
      rows.push({ seq: await db.outbox.add({ change }), change });
    }

    // 3. Hold what the server refused; the rest of what was sent is on the server now.
    const rejected = new Map(response.rejected.map((entry) => [entry.id, entry.code]));
    const sentSeqs = new Set(sent.map((row) => row.seq));
    const kept: OutboxRow[] = [];
    for (const row of rows) {
      if (!sentSeqs.has(row.seq)) {
        kept.push(row);
        continue;
      }
      const code = rejected.get(row.change.id);
      if (code === undefined) {
        await db.outbox.delete(row.seq);
        continue;
      }
      const held = { code, at: now };
      await db.outbox.put({ ...row, held });
      kept.push({ ...row, held });
    }

    // 4. Merge, so the stored state never goes backwards.
    const merged = mergeStates(state, response.state);

    // 5. If the server lacks something we had (a database restore, or an older answer), send it again with its
    // original times. Compared with what the server will have once the queue is applied, so nothing is queued twice.
    const serverWithQueue = applyAll(response.state, changesOf(kept));
    for (const change of changesToRestore(merged, serverWithQueue, newChangeId)) {
      kept.push({ seq: await db.outbox.add({ change }), change });
    }

    // 6. Store.
    await db.sync.bulkPut([
      { id: 'state', value: merged },
      { id: 'clock', offset: response.clockOffset, lastStampedAt },
      { id: 'status', lastSyncedAt: now, lastError: null }
    ]);

    // 7. Recompute local progress.
    await writeProgressIfChanged(stored, localProgressFrom(merged, kept));
    return { applied: true, unsent: kept.filter((row) => !row.held).length };
  });
}

/**
 * The server said this device's clock is off (409 clock_skew). Stores the new offset and moves every queued change by
 * the change in offset, keeping their order and keeping adds after any reset they followed. If changes would still
 * be well ahead of the server (stamped by a clock that has since been corrected, so the offset didn't move), they're
 * moved back so the latest is at the server's present. False when the session changed meanwhile.
 */
export async function shiftOutboxTimes({ token, clockOffset }: { token: string; clockOffset: number }): Promise<boolean> {
  return syncTransaction(async () => {
    const account = await readAccount();
    if (!account || account.token !== token) return false;
    const serverNow = Date.now() + clockOffset;
    const clock = await readClock();
    const state = await readState();
    const rows = await readOutbox();
    const delta = clockOffset - clock.offset;
    let shifted = shiftPendingTimes(changesOf(rows), delta, state.resetAt);
    const latest = shifted.changes.reduce((max, change) => Math.max(max, change.at), 0);
    if (latest > serverNow + LIMITS.maxClockAheadMs / 2) shifted = shiftPendingTimes(shifted.changes, serverNow - latest, state.resetAt);
    await db.outbox.bulkPut(rows.map((row, index) => ({ ...row, change: shifted.changes[index]! })));
    const lastStampedAt = Math.max(shifted.lastStampedAt, Math.min(clock.lastStampedAt + delta, serverNow));
    await db.sync.put({ id: 'clock', offset: clockOffset, lastStampedAt: Math.max(0, lastStampedAt) });
    return true;
  });
}

/** Records why a backup attempt failed, for every copy of the app to show. Ignored if the session changed meanwhile. */
export async function recordSyncFailure({ token, error }: { token: string; error: SyncError }): Promise<void> {
  await db.transaction('rw', db.sync, async () => {
    const account = await readAccount();
    if (!account || account.token !== token) return;
    const status = await readStatus();
    await db.sync.put({ id: 'status', lastSyncedAt: status.lastSyncedAt, lastError: error });
  });
}

/**
 * "Back up now": puts the ids from held rows back in the queue as one freshly stamped add (only those this device
 * still shows, so nothing a later reset removed comes back). A held reset is queued again unchanged, keeping its time.
 */
export async function requeueHeldChanges(): Promise<boolean> {
  return syncTransaction(async () => {
    if (!(await readAccount())) return false;
    const rows = await readOutbox();
    const held = rows.filter((row) => row.held);
    if (held.length === 0) return false;
    const current = applyAll(await readState(), changesOf(rows));
    const items: Partial<Record<ItemKind, Set<string>>> = {};
    for (const row of held) {
      if (row.change.type === 'reset') {
        await db.outbox.put({ seq: row.seq, change: row.change });
        continue;
      }
      for (const kind of ITEM_KINDS) {
        for (const id of row.change.items[kind] ?? []) {
          if (Object.hasOwn(current.items[kind], id)) (items[kind] ??= new Set()).add(id);
        }
      }
      await db.outbox.delete(row.seq);
    }
    const fresh: ChangeItems = {};
    for (const kind of ITEM_KINDS) {
      const ids = items[kind];
      if (ids && ids.size > 0) fresh[kind] = [...ids];
    }
    if (countItemIds(fresh) > 0) await queueChange('add', fresh);
    return true;
  });
}

/**
 * Signs this device in to a backup, in one transaction: stores the session, the server's state and clock offset, and
 * queues this device's journeys as `add` says: all of them (a new backup), only those the backup lacks (restoring,
 * "Add them") or none (restoring, "Don't add them": this device then shows the backup's journeys). Clears any
 * leftover queue and the signed-out notice, and ends any undo window (the latest journey is in what's queued).
 */
export async function beginBackup({ account, state, clockOffset, add }: {
  account: { token: string; userHandle: string; name: string };
  state: SyncState;
  clockOffset: number;
  add: 'all' | 'missing' | 'none';
}): Promise<Progress> {
  return syncTransaction(async () => {
    const now = Date.now();
    const local = await readProgress();
    await db.outbox.clear();
    await db.sync.bulkDelete(['notice', 'undo']);
    await db.sync.bulkPut([
      { id: 'account', token: account.token, userHandle: account.userHandle, name: account.name, signedInAt: now },
      { id: 'state', value: state },
      { id: 'clock', offset: clockOffset, lastStampedAt: 0 },
      { id: 'status', lastSyncedAt: now, lastError: null }
    ]);
    const items = add === 'all' ? progressToItems(local) : add === 'missing' ? itemsMissingFrom(local, sanitizeProgress(toProgress(state))) : {};
    if (countItemIds(items) > 0) await queueChange('add', items);
    const next = localProgressFrom(state, await readOutbox());
    await writeProgressIfChanged(local, next);
    return next;
  });
}

/**
 * Turns backup off on this device: forgets the session, state, status and clock and clears the queue. Journeys stay
 * unless `removeLocal` (cleared without a reset, so other devices keep theirs). With `token`, only if that session is
 * still the signed-in one, so a stale tab can't sign out a newer session. With `notice`, records that this device was
 * signed out (the server no longer knew the session). Ends any undo window. False when nothing was done.
 */
export async function endBackup({ token, removeLocal = false, notice = false }: { token?: string; removeLocal?: boolean; notice?: boolean }): Promise<boolean> {
  return syncTransaction(async () => {
    const account = await readAccount();
    if (!account || (token !== undefined && account.token !== token)) return false;
    await db.sync.bulkDelete(['account', 'state', 'status', 'clock', 'undo']);
    await db.outbox.clear();
    if (removeLocal) await db.progress.put({ id: 'current', value: EMPTY_PROGRESS });
    if (notice) await db.sync.put({ id: 'notice', kind: 'signed_out', accountName: account.name, at: Date.now() });
    return true;
  });
}

export async function dismissSyncNotice(): Promise<void> {
  await db.sync.delete('notice');
}
