/**
 * The backup's data model and merge rules, shared by the app and the sync server (which imports this file by relative
 * path, so it must stay pure: no DOM, IndexedDB or Worker APIs). See docs/sync-design.md, "Data model and merge rules".
 *
 * A backup is a state-based CRDT: each item remembers the latest time it was added, and a reset removes everything
 * added at or before it. Applying changes is commutative, associative and idempotent, so devices can sync in any
 * order, retry freely and still converge.
 */
import type { Progress } from './types';

export const ITEM_KINDS = ['sections', 'walks', 'entered', 'changed'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Which progress field each kind of item lives in. */
export const PROGRESS_FIELDS: Readonly<Record<ItemKind, keyof Progress>> = {
  sections: 'travelledSegmentIDs',
  walks: 'walkedLinkIDs',
  entered: 'stationsEnteredOrExitedIDs',
  changed: 'stationsChangedAtIDs'
};

/** Item id → the latest time it was added (ms). Always a null-prototype object, read with Object.hasOwn. */
export type ItemTimes = Record<string, number>;

export interface SyncState {
  /** The latest reset applied (ms since epoch); 0 = never. */
  resetAt: number;
  /** Only items added after resetAt are kept. */
  items: Record<ItemKind, ItemTimes>;
}

export type ChangeItems = Partial<Record<ItemKind, string[]>>;
export interface AddChange { id: string; type: 'add'; at: number; items: ChangeItems }
export interface ResetChange { id: string; type: 'reset'; at: number }
export type Change = AddChange | ResetChange;

export const CHANGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Every current network id matches (the longest is 55 characters). Lower case only, so ids can't collide by case. */
export const ITEM_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
/** Names that match the pattern but would touch Object.prototype if a plain object were ever used by mistake. */
const RESERVED_ITEM_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const LIMITS = {
  maxIdsPerChange: 3_000,
  maxChangesPerRequest: 200,
  /** Today's whole network is 1,029 ids (about 55 KB of state), so these leave room for growth and renamed ids. */
  maxStateItems: 3_000,
  maxStateBytes: 128 * 1024,
  /** Earlier than this (Sep 2020) means the device clock is broken. */
  minPlausibleTime: 1_600_000_000_000,
  /** A change stamped further ahead of the server than this means the device clock is fast. */
  maxClockAheadMs: 60_000
} as const;

function emptyTimes(): ItemTimes {
  return Object.create(null) as ItemTimes;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function isValidItemId(id: unknown): id is string {
  return typeof id === 'string' && ITEM_ID_PATTERN.test(id) && !RESERVED_ITEM_IDS.has(id);
}

export function emptyState(): SyncState {
  return { resetAt: 0, items: { sections: emptyTimes(), walks: emptyTimes(), entered: emptyTimes(), changed: emptyTimes() } };
}

/** Returns the same object when the change makes no difference, so callers can skip writes by comparing references. */
export function applyChange(state: SyncState, change: Change): SyncState {
  if (change.at <= state.resetAt) return state;

  if (change.type === 'reset') {
    const items = {} as Record<ItemKind, ItemTimes>;
    for (const kind of ITEM_KINDS) {
      items[kind] = emptyTimes();
      for (const [id, time] of Object.entries(state.items[kind])) {
        if (time > change.at) items[kind][id] = time;
      }
    }
    return { resetAt: change.at, items };
  }

  let next: SyncState | null = null;
  for (const kind of ITEM_KINDS) {
    const ids = change.items[kind];
    if (!ids) continue;
    for (const id of ids) {
      const current = (next ?? state).items[kind];
      const existing = Object.hasOwn(current, id) ? current[id]! : 0;
      if (change.at <= existing) continue;
      if (!next) next = { resetAt: state.resetAt, items: { ...state.items } };
      if (next.items[kind] === state.items[kind]) next.items[kind] = Object.assign(emptyTimes(), state.items[kind]);
      next.items[kind][id] = change.at;
    }
  }
  return next ?? state;
}

export function applyAll(state: SyncState, changes: Iterable<Change>): SyncState {
  let result = state;
  for (const change of changes) result = applyChange(result, change);
  return result;
}

/** The union of two replicas: the later reset, and each item's latest time, minus anything at or before that reset. */
export function mergeStates(a: SyncState, b: SyncState): SyncState {
  const resetAt = Math.max(a.resetAt, b.resetAt);
  const items = {} as Record<ItemKind, ItemTimes>;
  for (const kind of ITEM_KINDS) {
    items[kind] = emptyTimes();
    for (const source of [a.items[kind], b.items[kind]]) {
      for (const [id, time] of Object.entries(source)) {
        if (time > resetAt && time > (Object.hasOwn(items[kind], id) ? items[kind][id]! : 0)) items[kind][id] = time;
      }
    }
  }
  return { resetAt, items };
}

export function statesEqual(a: SyncState, b: SyncState): boolean {
  if (a === b) return true;
  if (a.resetAt !== b.resetAt) return false;
  return ITEM_KINDS.every((kind) => {
    const left = Object.entries(a.items[kind]);
    return left.length === Object.keys(b.items[kind]).length
      && left.every(([id, time]) => Object.hasOwn(b.items[kind], id) && b.items[kind][id] === time);
  });
}

/**
 * Changes that would bring `server` up to `local`: a reset at local's reset time if the server's is earlier, and one
 * add per distinct time for items the server lacks or holds at an earlier time. Used when a server answer has gone
 * backwards (e.g. after a database restore), so the device re-uploads what it held instead of losing it.
 */
export function changesToRestore(local: SyncState, server: SyncState, newId: () => string): Change[] {
  const changes: Change[] = [];
  if (local.resetAt > server.resetAt) changes.push({ id: newId(), type: 'reset', at: local.resetAt });
  const byTime = new Map<number, ChangeItems>();
  for (const kind of ITEM_KINDS) {
    for (const [id, time] of Object.entries(local.items[kind])) {
      const serverTime = Object.hasOwn(server.items[kind], id) ? server.items[kind][id]! : 0;
      if (time <= serverTime) continue;
      const items = byTime.get(time) ?? {};
      (items[kind] ??= []).push(id);
      byTime.set(time, items);
    }
  }
  for (const [at, items] of [...byTime].sort(([a], [b]) => a - b)) changes.push({ id: newId(), type: 'add', at, items });
  return changes;
}

/** The progress record a state shows: each kind's ids ordered by when they were added, then by id. */
export function toProgress(state: SyncState): Progress {
  const progress = {} as Progress;
  for (const kind of ITEM_KINDS) {
    progress[PROGRESS_FIELDS[kind]] = Object.entries(state.items[kind])
      .sort(([idA, timeA], [idB, timeB]) => timeA - timeB || (idA < idB ? -1 : idA > idB ? 1 : 0))
      .map(([id]) => id);
  }
  return progress;
}

/** A progress record's ids by kind, leaving out empty kinds. */
export function progressToItems(progress: Progress): ChangeItems {
  const items: ChangeItems = {};
  for (const kind of ITEM_KINDS) {
    const ids = progress[PROGRESS_FIELDS[kind]];
    if (ids.length > 0) items[kind] = [...ids];
  }
  return items;
}

/** Ids in `progress` that aren't in `other`, by kind, leaving out empty kinds. */
export function itemsMissingFrom(progress: Progress, other: Progress): ChangeItems {
  const items: ChangeItems = {};
  for (const kind of ITEM_KINDS) {
    const field = PROGRESS_FIELDS[kind];
    const present = new Set(other[field]);
    const missing = progress[field].filter((id) => !present.has(id));
    if (missing.length > 0) items[kind] = missing;
  }
  return items;
}

export function countItemIds(items: ChangeItems): number {
  return ITEM_KINDS.reduce((sum, kind) => sum + (items[kind]?.length ?? 0), 0);
}

export function countStateItems(state: SyncState): number {
  return ITEM_KINDS.reduce((sum, kind) => sum + Object.keys(state.items[kind]).length, 0);
}

/** Serialized size in bytes. Ids and numbers are ASCII, so string length is the byte count. */
export function stateSize(state: SyncState): number {
  return JSON.stringify(state).length;
}

export function exceedsLimits(state: SyncState): boolean {
  return countStateItems(state) > LIMITS.maxStateItems || stateSize(state) > LIMITS.maxStateBytes;
}

/**
 * Rebuilds a state parsed from storage or the network into null-prototype records, dropping entries whose time isn't
 * a positive safe integer or isn't after the reset. Null when the value isn't a state at all.
 */
export function validateState(raw: unknown): SyncState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as { resetAt?: unknown; items?: unknown };
  const resetAt = record.resetAt === 0 ? 0 : isTime(record.resetAt) ? record.resetAt : null;
  if (resetAt === null) return null;
  if (typeof record.items !== 'object' || record.items === null || Array.isArray(record.items)) return null;
  const rawItems = record.items as Record<string, unknown>;
  const state = emptyState();
  state.resetAt = resetAt;
  for (const kind of ITEM_KINDS) {
    const times = Object.hasOwn(rawItems, kind) ? rawItems[kind] : undefined;
    if (typeof times !== 'object' || times === null || Array.isArray(times)) continue;
    for (const [id, time] of Object.entries(times as Record<string, unknown>)) {
      if (isValidItemId(id) && isTime(time) && time > resetAt) state.items[kind][id] = time;
    }
  }
  return state;
}

export type ChangeValidation = { ok: true; change: Change } | { ok: false; code: 'invalid'; reason: string };

const invalid = (reason: string): ChangeValidation => ({ ok: false, code: 'invalid', reason });

/**
 * Checks a change's shape. Its time is never a reason to reject it: clock problems are handled separately (see
 * isPlausibleTime), so a device with a wrong clock never loses journeys to validation.
 */
export function validateChange(raw: unknown): ChangeValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('not an object');
  const record = raw as Record<string, unknown>;
  const { id, type, at } = record;
  if (typeof id !== 'string' || !CHANGE_ID_PATTERN.test(id)) return invalid('bad id');
  if (!isTime(at)) return invalid('bad time');

  if (type === 'reset') {
    if (Object.keys(record).some((key) => !['id', 'type', 'at'].includes(key))) return invalid('unknown field');
    return { ok: true, change: { id, type, at } };
  }
  if (type !== 'add') return invalid('bad type');
  if (Object.keys(record).some((key) => !['id', 'type', 'at', 'items'].includes(key))) return invalid('unknown field');

  const rawItems = record.items;
  if (typeof rawItems !== 'object' || rawItems === null || Array.isArray(rawItems)) return invalid('bad items');
  const items: ChangeItems = {};
  let count = 0;
  for (const [kind, ids] of Object.entries(rawItems as Record<string, unknown>)) {
    if (!(ITEM_KINDS as readonly string[]).includes(kind)) return invalid('unknown kind');
    if (!Array.isArray(ids)) return invalid('bad ids');
    count += ids.length;
    if (count > LIMITS.maxIdsPerChange) return invalid('too many ids');
    if (!ids.every(isValidItemId)) return invalid('bad item id');
    items[kind as ItemKind] = ids as string[];
  }
  return { ok: true, change: { id, type, at, items } };
}

/** Whether a change's time could have come from a working clock, judged against the server's clock. */
export function isPlausibleTime(at: number, serverNow: number): boolean {
  return at >= LIMITS.minPlausibleTime && at <= serverNow + LIMITS.maxClockAheadMs;
}

/** The latest reset a device knows of: its last synced state's, or a reset still waiting to be sent. */
export function knownResetAt(state: SyncState, pending: Iterable<Change>): number {
  let latest = state.resetAt;
  for (const change of pending) if (change.type === 'reset' && change.at > latest) latest = change.at;
  return latest;
}

/**
 * The time to stamp a new change with: the device clock corrected by the server offset, always after the device's
 * previous change (so a reset and the journey after it can never tie), and for adds always after any reset the device
 * knows of (so a slow clock can't put a new journey before a reset it has already seen).
 */
export function stampAt(options: { now: number; clockOffset: number; lastStampedAt: number; knownResetAt: number; type: Change['type'] }): number {
  let at = Math.max(Math.round(options.now + options.clockOffset), options.lastStampedAt + 1);
  if (options.type === 'add') at = Math.max(at, options.knownResetAt + 1);
  return at;
}

/** The server clock minus the device clock, measured at the middle of a request. */
export function clockOffsetFrom(serverTime: number, requestStartedAt: number, requestEndedAt: number): number {
  return Math.round(serverTime - (requestStartedAt + requestEndedAt) / 2);
}

/**
 * Re-stamps changes still waiting to be sent after the device's clock offset changed by `delta` (the server answered
 * clock_skew). Keeps their order, keeps each after the previous one, and keeps adds after any reset known at that
 * point (the synced state's or an earlier pending one). Returns the new changes and the last time stamped.
 */
export function shiftPendingTimes(pending: readonly Change[], delta: number, stateResetAt: number): { changes: Change[]; lastStampedAt: number } {
  let previous = 0;
  let resetFloor = stateResetAt;
  const changes = pending.map((change) => {
    let at = Math.max(Math.round(change.at + delta), previous + 1, 1);
    if (change.type === 'add') at = Math.max(at, resetFloor + 1);
    else resetFloor = Math.max(resetFloor, at);
    previous = at;
    return { ...change, at };
  });
  return { changes, lastStampedAt: previous };
}
