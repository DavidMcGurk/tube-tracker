import { describe, expect, it } from 'vitest';
import {
  applyAll,
  applyChange,
  changesToRestore,
  clockOffsetFrom,
  countStateItems,
  emptyState,
  exceedsLimits,
  isPlausibleTime,
  isValidItemId,
  itemsMissingFrom,
  ITEM_KINDS,
  knownResetAt,
  LIMITS,
  mergeStates,
  progressToItems,
  shiftPendingTimes,
  stampAt,
  statesEqual,
  toProgress,
  validateChange,
  validateState,
  type Change,
  type ChangeItems,
  type ItemKind,
  type SyncState
} from './sync-model';

const T = 1_700_000_000_000;
let nextId = 0;
const newId = () => `c${(nextId += 1)}`;
const add = (at: number, items: ChangeItems): Change => ({ id: newId(), type: 'add', at, items });
const reset = (at: number): Change => ({ id: newId(), type: 'reset', at });
const ids = (state: SyncState, kind: ItemKind = 'sections') => Object.keys(state.items[kind]).sort();

/** Small deterministic PRNG (mulberry32), so property tests are reproducible. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChanges(random: () => number, count: number): Change[] {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'];
  return Array.from({ length: count }, () => {
    // Few distinct times, so ties between adds and resets are common.
    const at = T + Math.floor(random() * 6) * 1000;
    if (random() < 0.25) return reset(at);
    const items: ChangeItems = {};
    for (const kind of ITEM_KINDS) {
      if (random() < 0.5) items[kind] = pool.filter(() => random() < 0.4);
    }
    return add(at, items);
  });
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe('applyChange', () => {
  it('records each id with the latest time it was added', () => {
    const state = applyAll(emptyState(), [add(T + 2, { sections: ['a'] }), add(T + 1, { sections: ['a', 'b'] })]);
    expect(state.items.sections.a).toBe(T + 2);
    expect(state.items.sections.b).toBe(T + 1);
  });

  it('returns the same object when a change makes no difference', () => {
    const state = applyChange(emptyState(), add(T + 5, { sections: ['a'] }));
    expect(applyChange(state, add(T + 5, { sections: ['a'] }))).toBe(state);
    expect(applyChange(state, add(T + 1, { sections: ['a'] }))).toBe(state);
    expect(applyChange(state, add(T + 9, {}))).toBe(state);
    const afterReset = applyChange(state, reset(T + 10));
    expect(applyChange(afterReset, reset(T + 10))).toBe(afterReset);
    expect(applyChange(afterReset, reset(T + 3))).toBe(afterReset);
  });

  it('does not modify the state it was given', () => {
    const state = applyChange(emptyState(), add(T, { sections: ['a'] }));
    const snapshot = JSON.stringify(state);
    applyChange(state, add(T + 1, { sections: ['a', 'b'], walks: ['w'] }));
    applyChange(state, reset(T + 2));
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('a reset removes items added at or before it; a tie goes to the reset whichever arrives first', () => {
    for (const order of [[add(T, { sections: ['x'] }), reset(T)], [reset(T), add(T, { sections: ['x'] })]]) {
      expect(ids(applyAll(emptyState(), order))).toEqual([]);
    }
  });

  it('keeps items added after a reset whichever arrives first', () => {
    for (const order of [[add(T + 1, { sections: ['x'] }), reset(T)], [reset(T), add(T + 1, { sections: ['x'] })]]) {
      const state = applyAll(emptyState(), order);
      expect(ids(state)).toEqual(['x']);
      expect(state.resetAt).toBe(T);
    }
  });

  it('keeps a journey over old track that was recorded after a reset made on another device', () => {
    // Phone has section x from t1. The iPad resets at t2. The phone, not yet synced, records a journey over x at t3:
    // its change carries every id the journey touched, so x survives in any order of arrival.
    const phone = applyChange(emptyState(), add(T + 1, { sections: ['x', 'y'] }));
    const changes = [reset(T + 2), add(T + 3, { sections: ['x', 'z'] })];
    for (const order of [changes, [...changes].reverse()]) {
      expect(ids(applyAll(phone, order))).toEqual(['x', 'z']);
    }
  });

  it('is safe for ids named like Object.prototype members', () => {
    const state = applyChange(emptyState(), add(T, { sections: ['constructor', 'tostring', 'hasownproperty', '__proto__'] }));
    expect(state.items.sections.constructor).toBe(T);
    expect(state.items.sections.__proto__).toBe(T);
    expect(Object.getPrototypeOf(state.items.sections)).toBeNull();
    expect(countStateItems(state)).toBe(4);
    expect(statesEqual(validateState(JSON.parse(JSON.stringify(state)))!, applyChange(emptyState(), add(T, { sections: ['tostring', 'hasownproperty'] })))).toBe(true);
  });
});

describe('merge properties', () => {
  it('converges whatever order changes arrive in (commutative)', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = prng(seed);
      const changes = randomChanges(random, 12);
      const expected = applyAll(emptyState(), changes);
      expect(statesEqual(applyAll(emptyState(), shuffled(changes, random)), expected)).toBe(true);
    }
  });

  it('applying changes again changes nothing (idempotent)', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = prng(seed);
      const changes = randomChanges(random, 10);
      const once = applyAll(emptyState(), changes);
      expect(statesEqual(applyAll(once, shuffled(changes, random)), once)).toBe(true);
    }
  });

  it('merging two replicas equals applying both sets of changes, and merging is associative', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = prng(seed);
      const [a, b, c] = [randomChanges(random, 6), randomChanges(random, 6), randomChanges(random, 6)];
      const [sa, sb, sc] = [applyAll(emptyState(), a), applyAll(emptyState(), b), applyAll(emptyState(), c)];
      expect(statesEqual(mergeStates(sa, sb), applyAll(emptyState(), [...a, ...b]))).toBe(true);
      expect(statesEqual(mergeStates(sa, sb), mergeStates(sb, sa))).toBe(true);
      expect(statesEqual(mergeStates(mergeStates(sa, sb), sc), mergeStates(sa, mergeStates(sb, sc)))).toBe(true);
      expect(statesEqual(mergeStates(sa, sa), sa)).toBe(true);
    }
  });
});

describe('changesToRestore', () => {
  it('brings a server state that went backwards up to the device’s state', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = prng(seed);
      const changes = randomChanges(random, 12);
      const local = applyAll(emptyState(), changes);
      const server = applyAll(emptyState(), changes.slice(0, Math.floor(random() * changes.length)));
      const merged = mergeStates(local, server);
      const restored = applyAll(server, changesToRestore(merged, server, newId));
      expect(statesEqual(restored, merged)).toBe(true);
    }
  });

  it('returns nothing when the server already holds everything', () => {
    const state = applyAll(emptyState(), [add(T, { sections: ['a'] }), reset(T + 1), add(T + 2, { walks: ['w'] })]);
    expect(changesToRestore(state, state, newId)).toEqual([]);
  });
});

describe('toProgress and progress helpers', () => {
  it('orders ids by when they were added, then by id', () => {
    const state = applyAll(emptyState(), [
      add(T + 2, { sections: ['b'], entered: ['bank'] }),
      add(T + 1, { sections: ['c', 'a'], changed: ['oxford_circus'] }),
      add(T + 3, { walks: ['isi_bank_monument'] })
    ]);
    expect(toProgress(state)).toEqual({
      travelledSegmentIDs: ['a', 'c', 'b'],
      walkedLinkIDs: ['isi_bank_monument'],
      stationsEnteredOrExitedIDs: ['bank'],
      stationsChangedAtIDs: ['oxford_circus']
    });
  });

  it('converts progress to change items and finds ids missing from another record', () => {
    const progress = { travelledSegmentIDs: ['a', 'b'], walkedLinkIDs: [], stationsEnteredOrExitedIDs: ['bank'], stationsChangedAtIDs: [] };
    const other = { travelledSegmentIDs: ['b'], walkedLinkIDs: ['w'], stationsEnteredOrExitedIDs: ['bank'], stationsChangedAtIDs: [] };
    expect(progressToItems(progress)).toEqual({ sections: ['a', 'b'], entered: ['bank'] });
    expect(itemsMissingFrom(progress, other)).toEqual({ sections: ['a'] });
    expect(itemsMissingFrom(other, other)).toEqual({});
  });
});

describe('validateChange', () => {
  it('accepts well-formed adds and resets', () => {
    expect(validateChange({ id: 'a1-B_2', type: 'add', at: T, items: { sections: ['x_1'], walks: [] } })).toEqual({
      ok: true,
      change: { id: 'a1-B_2', type: 'add', at: T, items: { sections: ['x_1'], walks: [] } }
    });
    expect(validateChange({ id: 'r', type: 'reset', at: T })).toEqual({ ok: true, change: { id: 'r', type: 'reset', at: T } });
  });

  it('never rejects a change for its time alone, however far off the clock is', () => {
    expect(validateChange({ id: 'a', type: 'add', at: T * 2, items: {} }).ok).toBe(true);
    expect(validateChange({ id: 'a', type: 'reset', at: 5 }).ok).toBe(true);
  });

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['a bad id', { id: 'has space', type: 'reset', at: T }],
    ['an overlong id', { id: 'x'.repeat(65), type: 'reset', at: T }],
    ['a fractional time', { id: 'a', type: 'reset', at: T + 0.5 }],
    ['a zero time', { id: 'a', type: 'reset', at: 0 }],
    ['a string time', { id: 'a', type: 'reset', at: String(T) }],
    ['an unknown type', { id: 'a', type: 'remove', at: T }],
    ['a reset with items', { id: 'a', type: 'reset', at: T, items: {} }],
    ['an unknown field', { id: 'a', type: 'add', at: T, items: {}, extra: 1 }],
    ['missing items', { id: 'a', type: 'add', at: T }],
    ['an unknown kind', { id: 'a', type: 'add', at: T, items: { lines: ['x'] } }],
    ['ids that are not an array', { id: 'a', type: 'add', at: T, items: { sections: 'x' } }],
    ['an upper-case item id', { id: 'a', type: 'add', at: T, items: { sections: ['Bank'] } }],
    ['an item id with dots', { id: 'a', type: 'add', at: T, items: { sections: ['a.b'] } }],
    ['an overlong item id', { id: 'a', type: 'add', at: T, items: { sections: ['x'.repeat(65)] } }],
    ['__proto__', { id: 'a', type: 'add', at: T, items: { sections: ['__proto__'] } }],
    ['constructor', { id: 'a', type: 'add', at: T, items: { sections: ['constructor'] } }],
    ['prototype', { id: 'a', type: 'add', at: T, items: { sections: ['prototype'] } }],
    ['toString', { id: 'a', type: 'add', at: T, items: { sections: ['toString'] } }],
    ['hasOwnProperty', { id: 'a', type: 'add', at: T, items: { sections: ['hasOwnProperty'] } }],
    ['too many ids', { id: 'a', type: 'add', at: T, items: { sections: Array.from({ length: LIMITS.maxIdsPerChange + 1 }, (_, i) => `s${i}`) } }]
  ])('rejects %s', (_, raw) => {
    expect(validateChange(raw)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('rejects a __proto__ kind coming from JSON', () => {
    expect(validateChange(JSON.parse(`{"id":"a","type":"add","at":${T},"items":{"__proto__":["x"]}}`)).ok).toBe(false);
  });

  it('accepts every id in the network data', async () => {
    const { sections, stations, walkLinks } = await import('../data/network');
    const all = [...sections, ...stations, ...walkLinks].map((item) => item.id);
    expect(all.filter((id) => !isValidItemId(id))).toEqual([]);
  });
});

describe('validateState', () => {
  it('round-trips through JSON into null-prototype records', () => {
    const state = applyAll(emptyState(), [add(T, { sections: ['a'], changed: ['bank'] }), reset(T + 1), add(T + 2, { walks: ['w'] })]);
    const parsed = validateState(JSON.parse(JSON.stringify(state)))!;
    expect(statesEqual(parsed, state)).toBe(true);
    for (const kind of ITEM_KINDS) expect(Object.getPrototypeOf(parsed.items[kind])).toBeNull();
  });

  it('drops bad entries and keeps the rest', () => {
    const parsed = validateState(JSON.parse(`{"resetAt":${T},"items":{"sections":{"ok":${T + 1},"old":${T},"bad":"x","Upper":${T + 1},"__proto__":${T + 1}},"walks":[],"extra":{}}}`))!;
    expect(ids(parsed)).toEqual(['ok']);
    expect(ids(parsed, 'walks')).toEqual([]);
    expect(parsed.resetAt).toBe(T);
  });

  it.each([[null], ['x'], [[]], [{}], [{ resetAt: -1, items: {} }], [{ resetAt: 0 }], [{ resetAt: 0, items: [] }]])('returns null for %j', (raw) => {
    expect(validateState(raw)).toBeNull();
  });
});

describe('limits', () => {
  it('flags states over the item or size limit', () => {
    const many = (count: number, length = 8) => Array.from({ length: count }, (_, i) => `s${String(i).padStart(length - 1, '0')}`);
    expect(exceedsLimits(applyChange(emptyState(), add(T, { sections: many(LIMITS.maxStateItems) })))).toBe(false);
    expect(exceedsLimits(applyChange(emptyState(), add(T, { sections: many(LIMITS.maxStateItems + 1) })))).toBe(true);
    expect(exceedsLimits(applyChange(emptyState(), add(T, { sections: many(2_500, 60) })))).toBe(true);
  });
});

describe('clocks', () => {
  it('judges times against the server clock', () => {
    expect(isPlausibleTime(T, T)).toBe(true);
    expect(isPlausibleTime(T + LIMITS.maxClockAheadMs, T)).toBe(true);
    expect(isPlausibleTime(T + LIMITS.maxClockAheadMs + 1, T)).toBe(false);
    expect(isPlausibleTime(LIMITS.minPlausibleTime - 1, T)).toBe(false);
  });

  it('measures the offset at the middle of the request', () => {
    expect(clockOffsetFrom(T + 5_000, T, T + 200)).toBe(4_900);
    expect(clockOffsetFrom(T, T + 60_000, T + 60_000)).toBe(-60_000);
  });

  it('stamps with the corrected clock, always after the previous change, and adds after known resets', () => {
    expect(stampAt({ now: T, clockOffset: 500, lastStampedAt: 0, knownResetAt: 0, type: 'add' })).toBe(T + 500);
    expect(stampAt({ now: T, clockOffset: 0, lastStampedAt: T + 10, knownResetAt: 0, type: 'reset' })).toBe(T + 11);
    // A slow clock can't place a new journey before a reset the device has already seen.
    expect(stampAt({ now: T, clockOffset: 0, lastStampedAt: 0, knownResetAt: T + 3_600_000, type: 'add' })).toBe(T + 3_600_001);
    expect(stampAt({ now: T, clockOffset: 0, lastStampedAt: 0, knownResetAt: T + 3_600_000, type: 'reset' })).toBe(T);
  });

  it('knows of the synced reset and resets still waiting to be sent', () => {
    const state = applyChange(emptyState(), reset(T));
    expect(knownResetAt(state, [add(T + 5, {}), reset(T + 3)])).toBe(T + 3);
    expect(knownResetAt(state, [])).toBe(T);
  });

  it('keeps a journey recorded after a reset on the same device, even with a fast clock', () => {
    // The phone's clock is 10 minutes fast and it hasn't synced yet. It resets, then records a journey a second later.
    const fast = 10 * 60_000;
    const resetAt = stampAt({ now: T + fast, clockOffset: 0, lastStampedAt: 0, knownResetAt: 0, type: 'reset' });
    const pending: Change[] = [{ id: 'r', type: 'reset', at: resetAt }];
    const addAt = stampAt({ now: T + fast + 1_000, clockOffset: 0, lastStampedAt: resetAt, knownResetAt: knownResetAt(emptyState(), pending), type: 'add' });
    pending.push({ id: 'a', type: 'add', at: addAt, items: { sections: ['x'] } });

    // The server says clock_skew; the phone learns its offset and re-stamps before sending again.
    const { changes, lastStampedAt } = shiftPendingTimes(pending, -fast, 0);
    expect(changes.map((change) => change.at)).toEqual([T, T + 1_000]);
    expect(lastStampedAt).toBe(T + 1_000);
    expect(changes.every((change) => isPlausibleTime(change.at, T + 2_000))).toBe(true);
    expect(ids(applyAll(emptyState(), changes))).toEqual(['x']);
  });

  it('re-stamping keeps order and keeps adds after resets the device knew of', () => {
    const pending: Change[] = [add(T + 10, { sections: ['a'] }), reset(T + 20), add(T + 21, { sections: ['b'] })];
    // A shift that would put the adds at or before the synced reset raises them just past it.
    const { changes } = shiftPendingTimes(pending, -1_000, T);
    expect(changes.map((change) => change.at)).toEqual([T + 1, T + 2, T + 3]);
    expect(changes.map((change) => change.type)).toEqual(['add', 'reset', 'add']);
    // The first add was recorded before the pending reset, the second after it.
    expect(ids(applyAll(applyChange(emptyState(), reset(T)), changes))).toEqual(['b']);
  });
});
