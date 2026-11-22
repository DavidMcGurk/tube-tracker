/** POST /v1/sync (docs/sync-design.md, "Sync write path"). */
import {
  ITEM_KINDS,
  LIMITS,
  applyChange,
  countStateItems,
  emptyState,
  isPlausibleTime,
  mergeStates,
  stateSize,
  statesEqual,
  validateChange,
  validateState,
  type Change,
  type ChangeItems,
  type ResetChange,
  type SyncState
} from '../../src/lib/sync-model';
import type { ProgressRow } from './db';
import type { Env } from './env';
import { API_VERSION, HttpError, MAX_SYNC_BODY_BYTES, badRequest, expectFields, isObject, jsonText, readJson } from './http';
import { enforceRateLimit } from './rate-limit';
import { unauthorized, type Session } from './sessions';

/** After the first write loses a race, re-read and re-apply up to this many times. */
const MAX_WRITE_RETRIES = 5;

export interface Rejection {
  /** The change's id, or null when the change didn't carry a usable one. */
  id: string | null;
  code: 'invalid' | 'backup_full';
}

export async function handleSync(request: Request, env: Env, session: Session, now: number): Promise<Response> {
  await enforceRateLimit(env, env.SYNC_RATE_LIMITER, session.userId);

  // 1. The envelope.
  const body = await readJson(request, MAX_SYNC_BODY_BYTES);
  expectFields(body, ['changes']);
  const rawChanges = body.changes;
  if (!Array.isArray(rawChanges)) throw badRequest('changes must be an array.');
  if (rawChanges.length > LIMITS.maxChangesPerRequest) throw badRequest(`Send at most ${LIMITS.maxChangesPerRequest} changes at a time.`);

  // 2. The clock: applying nothing is safer than storing a time that would outrank later changes.
  for (const raw of rawChanges) {
    const at = isObject(raw) ? raw.at : undefined;
    if (typeof at === 'number' && Number.isSafeInteger(at) && !isPlausibleTime(at, now)) {
      throw new HttpError(409, 'clock_skew', "This device's clock is too far from the server's. Correct the times and try again.", undefined, { serverTime: now });
    }
  }

  // 3. Each change on its own.
  const valid: Change[] = [];
  const invalid: Rejection[] = [];
  for (const raw of rawChanges) {
    const result = validateChange(raw);
    if (result.ok) valid.push(result.change);
    else invalid.push({ id: rawChangeId(raw), code: result.code });
  }

  // 4-6. Read, apply and write with optimistic concurrency.
  for (let attempt = 0; ; attempt++) {
    const row = await env.DB.prepare('SELECT state, version FROM progress WHERE user_id = ?').bind(session.userId).first<ProgressRow>();
    const base = parseStoredState(row?.state);
    const { state, full } = applyWithinLimits(base, valid);
    const stateJson = JSON.stringify(state);

    if (state !== base) {
      // A missing row is only created for a user that still exists: if the backup was deleted on another device while
      // this request was under way, writing it would leave a row that nothing can reach or clean up.
      const write = row
        ? env.DB.prepare('UPDATE progress SET state = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?')
          .bind(stateJson, now, session.userId, row.version)
        : env.DB.prepare(
          'INSERT INTO progress (user_id, state, version, updated_at) SELECT ?1, ?2, 1, ?3 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1) ON CONFLICT (user_id) DO NOTHING'
        ).bind(session.userId, stateJson, now);
      const { meta } = await write.run();
      if (meta.changes !== 1) {
        if (!row && !(await userExists(env.DB, session.userId))) throw unauthorized();
        if (attempt >= MAX_WRITE_RETRIES) throw new HttpError(409, 'busy', 'The backup is being changed by another device. Please try again.');
        continue;
      }
    }

    // 7. The state is serialized once, for D1 and for the response.
    const rejected: Rejection[] = [...invalid, ...full.map((id) => ({ id, code: 'backup_full' as const }))];
    return jsonText(`{"apiVersion":${API_VERSION},"state":${stateJson},"serverTime":${now},"rejected":${JSON.stringify(rejected)}}`);
  }
}

async function userExists(db: D1Database, userId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(userId).first()) !== null;
}

function rawChangeId(raw: unknown): string | null {
  const id = isObject(raw) ? raw.id : undefined;
  return typeof id === 'string' && id.length <= 64 ? id : null;
}

/** A stored state that fails validation is treated as empty; devices then re-upload what they hold. */
export function parseStoredState(text: string | undefined): SyncState {
  if (text === undefined) return emptyState();
  try {
    return validateState(JSON.parse(text)) ?? emptyState();
  } catch {
    return emptyState();
  }
}

/** A safe integer has at most 16 digits, so a reset can lengthen the serialized state by at most this much. */
const RESET_DIGITS_SLACK = 16;

/**
 * Applies changes in order, skipping any that would take the state past LIMITS (rejected as backup_full), exactly as
 * applying them one by one with applyChange() and exceedsLimits() would. Returns `base` itself when nothing changed.
 *
 * One by one, every change copies the item records it touches: about 30 ms for a long offline queue of 200 journeys,
 * three times the free plan's CPU budget. So when nothing can hit a limit, the batch is merged in one go instead:
 * applying changes is commutative, associative and idempotent, so the result is the base merged with the union of the
 * adds, minus anything at or before the latest reset. Every state along the way holds a subset of that union (with
 * times no longer), so if the union fits, with room for resetAt to gain digits, no change can be rejected. Only a
 * nearly full backup takes the one-by-one path.
 */
export function applyWithinLimits(base: SyncState, changes: readonly Change[]): { state: SyncState; full: string[] } {
  if (changes.length === 0) return { state: base, full: [] };
  const added = emptyState();
  let latestReset: ResetChange | null = null;
  for (const change of changes) {
    if (change.type === 'reset') {
      if (!latestReset || change.at > latestReset.at) latestReset = change;
      continue;
    }
    for (const kind of ITEM_KINDS) {
      const times = added.items[kind];
      for (const id of change.items[kind] ?? []) {
        if (!Object.hasOwn(times, id) || times[id]! < change.at) times[id] = change.at;
      }
    }
  }
  const union = mergeStates(base, added);
  if (countStateItems(union) > LIMITS.maxStateItems || stateSize(union) + RESET_DIGITS_SLACK > LIMITS.maxStateBytes) {
    return applyOneByOne(base, changes);
  }
  const state = latestReset ? applyChange(union, latestReset) : union;
  return { state: statesEqual(state, base) ? base : state, full: [] };
}

/**
 * The one-by-one path. An add's exact effect on the item count and serialized size is worked out before applying it
 * (ids never need escaping in JSON, and times are plain integers), so a rejected change costs no copying and no
 * serializing. Resets are rare; the state is serialized once after each.
 */
function applyOneByOne(base: SyncState, changes: readonly Change[]): { state: SyncState; full: string[] } {
  let state = base;
  let count = countStateItems(base);
  let size = stateSize(base);
  const full: string[] = [];

  for (const change of changes) {
    if (change.type === 'reset') {
      const next = applyChange(state, change);
      if (next === state) continue;
      // Only removes items, but resetAt may gain digits.
      const nextSize = stateSize(next);
      if (nextSize > LIMITS.maxStateBytes) {
        full.push(change.id);
        continue;
      }
      state = next;
      count = countStateItems(next);
      size = nextSize;
      continue;
    }
    const growth = addGrowth(state, change.items, change.at);
    if (!growth) continue;
    if (count + growth.items > LIMITS.maxStateItems || size + growth.bytes > LIMITS.maxStateBytes) {
      full.push(change.id);
      continue;
    }
    state = applyChange(state, change);
    count += growth.items;
    size += growth.bytes;
  }
  return { state, full };
}

/**
 * How many items an add would create and exactly how many bytes it would add to stateSize(), or null if it would
 * change nothing (the same cases in which applyChange() returns its input). Each new entry is "id":time, plus a comma
 * unless it's the first in its record; a later time for an existing entry can only lengthen it.
 */
function addGrowth(state: SyncState, items: ChangeItems, at: number): { items: number; bytes: number } | null {
  if (at <= state.resetAt) return null;
  const timeLength = String(at).length;
  let changed = false;
  let added = 0;
  let bytes = 0;
  for (const kind of ITEM_KINDS) {
    const ids = items[kind];
    if (!ids) continue;
    const existing = state.items[kind];
    const seen = new Set<string>();
    let addedHere = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!Object.hasOwn(existing, id)) {
        addedHere += 1;
        bytes += id.length + 3 + timeLength;
      } else if (existing[id]! < at) {
        changed = true;
        bytes += timeLength - String(existing[id]).length;
      }
    }
    if (addedHere > 0) {
      changed = true;
      added += addedHere;
      bytes += isEmpty(existing) ? addedHere - 1 : addedHere;
    }
  }
  return changed ? { items: added, bytes } : null;
}

function isEmpty(record: object): boolean {
  for (const _ in record) return false;
  return true;
}
