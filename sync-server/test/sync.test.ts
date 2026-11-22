import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ITEM_KINDS, LIMITS, applyChange, emptyState, exceedsLimits, statesEqual, type Change, type SyncState } from '../../src/lib/sync-model';
import worker from '../src/index';
import { applyWithinLimits } from '../src/sync';
import { call, changeId, clearDatabase, count, register, testEnv, TEST_ORIGIN, type Device } from './helpers';

beforeEach(clearDatabase);

function sync(device: Device, changes: unknown, options: { env?: Parameters<typeof testEnv>[0] } = {}) {
  return call('POST', '/v1/sync', { token: device.token, body: { changes }, env: options.env });
}

const add = (at: number, items: Record<string, string[]>, id = changeId()) => ({ id, type: 'add', at, items });
const reset = (at: number, id = changeId()) => ({ id, type: 'reset', at });

async function storedVersion(device: Device): Promise<number> {
  const row = await env.DB.prepare('SELECT version FROM progress WHERE user_id = ?').bind(device.account.userHandle).first<{ version: number }>();
  return row!.version;
}

describe('POST /v1/sync', () => {
  it('applies adds and resets with the shared merge rules and returns the merged state', async () => {
    const device = await register();
    const t = Date.now() - 10_000;
    const res = await sync(device, [
      add(t, { sections: ['bakerloo_1', 'bakerloo_2'], entered: ['oxford_circus'] }),
      reset(t + 1),
      add(t + 2, { sections: ['bakerloo_2'], changed: ['baker_street'] })
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ apiVersion: 1, rejected: [] });
    expect(res.body.state).toEqual({ resetAt: t + 1, items: { sections: { bakerloo_2: t + 2 }, walks: {}, entered: {}, changed: { baker_street: t + 2 } } });
    expect(Math.abs(res.body.serverTime - Date.now())).toBeLessThan(5_000);
    expect(await storedVersion(device)).toBe(2);

    // Idempotent: the same changes again change nothing and write nothing.
    const again = await sync(device, [add(t + 2, { sections: ['bakerloo_2'] })]);
    expect(again.body.state).toEqual(res.body.state);
    expect(await storedVersion(device)).toBe(2);

    // An empty push is a pull.
    const pull = await sync(device, []);
    expect(pull.body.state).toEqual(res.body.state);
  });

  it('never rewrites times: a reset ties with an add and wins', async () => {
    const device = await register();
    const t = Date.now() - 5_000;
    const res = await sync(device, [add(t, { walks: ['osi_x'] }), reset(t)]);
    expect(res.body.state).toEqual({ resetAt: t, items: { sections: {}, walks: {}, entered: {}, changed: {} } });
  });

  it('rejects invalid changes one by one and applies the rest', async () => {
    const device = await register();
    const t = Date.now();
    const res = await sync(device, [
      add(t, { sections: ['good_id'] }, 'ok1'),
      { id: 'bad id!', type: 'add', at: t, items: {} },
      { id: 'proto', type: 'add', at: t, items: { sections: ['__proto__'] } },
      { id: 'upper', type: 'add', at: t, items: { sections: ['Bad_Case'] } },
      { id: 'kind', type: 'add', at: t, items: { trains: ['x'] } },
      { id: 'extra', type: 'reset', at: t, by: 'me' },
      { id: 'type', type: 'remove', at: t },
      { id: 'time', type: 'add', at: 'soon', items: {} },
      42,
      add(t, { entered: ['constructor_street'] }, 'ok2')
    ]);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual(['bad id!', 'proto', 'upper', 'kind', 'extra', 'type', 'time', null].map((id) => ({ id, code: 'invalid' })));
    expect(res.body.state.items.sections).toEqual({ good_id: t });
    expect(res.body.state.items.entered).toEqual({ constructor_street: t });
    expect(Object.getPrototypeOf(res.body.state.items.sections)).toBe(Object.prototype); // plain JSON on the wire
  });

  it('answers 409 clock_skew with serverTime and applies nothing when any time is implausible', async () => {
    const device = await register();
    const now = Date.now();
    for (const at of [now + 120_000, LIMITS.minPlausibleTime - 1]) {
      const res = await sync(device, [add(now, { sections: ['fine'] }), add(at, { sections: ['skewed'] })]);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('clock_skew');
      expect(Math.abs(res.body.serverTime - Date.now())).toBeLessThan(5_000);
    }
    expect(await storedVersion(device)).toBe(1);
    // Up to a minute ahead is fine.
    expect((await sync(device, [add(now + 50_000, { sections: ['fine'] })])).status).toBe(200);
  });

  it('rejects a bad envelope as a whole with 400', async () => {
    const device = await register();
    expect((await call('POST', '/v1/sync', { token: device.token, body: {} })).status).toBe(400);
    expect((await call('POST', '/v1/sync', { token: device.token, body: { changes: {} } })).status).toBe(400);
    expect((await call('POST', '/v1/sync', { token: device.token, body: { changes: [], extra: true } })).status).toBe(400);
    const tooMany = Array.from({ length: LIMITS.maxChangesPerRequest + 1 }, () => add(Date.now(), { sections: ['a'] }));
    const res = await sync(device, tooMany);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    // Exactly 200 is fine.
    expect((await sync(device, tooMany.slice(1))).status).toBe(200);
  });

  it('accepts bodies up to 256 KB and refuses larger ones with 413 too_large', async () => {
    const device = await register();
    const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, index) => `${prefix}_${String(index).padStart(5, '0')}_${'x'.repeat(40)}`);
    // About 130 KB: over the 16 KB cap for other endpoints, under the sync cap.
    const big = await sync(device, [add(Date.now(), { sections: ids('a', 1000) }), add(Date.now(), { walks: ids('b', 1000) }), add(Date.now(), { entered: ids('c', 600) })]);
    expect(big.status).toBe(200);
    const tooBig = await sync(device, Array.from({ length: 6 }, (_, index) => add(Date.now(), { sections: ids(`d${index}`, 1000) })));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('too_large');
  });

  it('rejects a change that would pass the size cap with backup_full (not a 500), keeping later ones that fit', async () => {
    const device = await register();
    const t = Date.now();
    const longIds = (prefix: string, n: number) => Array.from({ length: n }, (_, index) => `${prefix}${String(index).padStart(4, '0')}_${'y'.repeat(50)}`);
    const res = await sync(device, [
      add(t, { sections: longIds('a', 1500) }, 'big'), // about 116 KB of state
      add(t, { walks: longIds('b', 300) }, 'too_much'), // would pass 128 KB
      add(t, { walks: ['small_one'] }, 'small')
    ]);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ id: 'too_much', code: 'backup_full' }]);
    expect(Object.keys(res.body.state.items.sections)).toHaveLength(1500);
    expect(res.body.state.items.walks).toEqual({ small_one: t });
    expect(JSON.stringify(res.body.state).length).toBeLessThanOrEqual(LIMITS.maxStateBytes);
  });

  it('rejects a change that would pass 3,000 items with backup_full', async () => {
    const device = await register();
    const t = Date.now();
    const shortIds = (prefix: string, n: number) => Array.from({ length: n }, (_, index) => `${prefix}${index}`);
    const first = await sync(device, [add(t, { sections: shortIds('s', 3000) }, 'fill')]);
    expect(first.body.rejected).toEqual([]);
    const res = await sync(device, [add(t + 1, { walks: ['one_more'] }, 'over'), add(t + 1, { sections: ['s0', 's1'] }, 'existing')]);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ id: 'over', code: 'backup_full' }]);
    expect(res.body.state.items.sections.s0).toBe(t + 1);
    // A reset frees room.
    const after = await sync(device, [reset(t + 2), add(t + 3, { walks: ['one_more'] }, 'fits')]);
    expect(after.body.rejected).toEqual([]);
    expect(after.body.state.items.walks).toEqual({ one_more: t + 3 });
  });

  it('keeps one account’s state apart from another’s', async () => {
    const a = await register();
    const b = await register();
    await sync(a, [add(Date.now(), { sections: ['only_a'] })]);
    const res = await sync(b, []);
    expect(res.body.state.items.sections).toEqual({});
    expect((await call('POST', '/v1/sync', { body: { changes: [] } })).status).toBe(401);
  });

  it('treats a corrupt stored state as empty instead of failing', async () => {
    const device = await register();
    await env.DB.prepare('UPDATE progress SET state = ? WHERE user_id = ?').bind('{not json', device.account.userHandle).run();
    const res = await sync(device, [add(Date.now(), { sections: ['again'] })]);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.state.items.sections)).toEqual(['again']);
  });

  describe('a backup deleted on another device during a sync', () => {
    const deleteBackup = async (device: Device) => expect((await call('DELETE', '/v1/account', { token: device.token })).status).toBe(200);

    it('answers 401 and leaves no progress row when it goes while the request is being read', async () => {
      const device = await register();
      const body = new TextEncoder().encode(JSON.stringify({ changes: [add(Date.now(), { sections: ['orphan'] })] }));
      // A slow upload: the body arrives only once it's read, after the session was checked.
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent) return;
          sent = true;
          await deleteBackup(device);
          controller.enqueue(body);
          controller.close();
        }
      }, { highWaterMark: 0 });
      const request = new Request('https://sync.example.test/v1/sync', {
        method: 'POST',
        headers: { Origin: TEST_ORIGIN, Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' },
        body: stream,
        duplex: 'half'
      } as RequestInit);
      const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], testEnv());
      expect(sent).toBe(true);
      expect(response.status).toBe(401);
      expect(await count('progress', 'user_id = ?', device.account.userHandle)).toBe(0);
      expect(await count('users')).toBe(0);
    });

    it('answers 401 and leaves no progress row when it goes between reading the backup and writing it', async () => {
      const device = await register();
      let deleted = false;
      const db = new Proxy(env.DB, {
        get(target, property) {
          if (property !== 'prepare') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith('SELECT state, version FROM progress')) return statement;
            return {
              bind: (...values: unknown[]) => {
                const bound = statement.bind(...values);
                return {
                  first: async () => {
                    const row = await bound.first();
                    if (!deleted) {
                      deleted = true;
                      await deleteBackup(device);
                    }
                    return row;
                  }
                };
              }
            };
          };
        }
      });
      // The write (version-checked) then changes nothing, the re-read finds no row, and nothing is inserted.
      const res = await sync(device, [add(Date.now(), { sections: ['orphan'] })], { env: { DB: db as D1Database } });
      expect(deleted).toBe(true);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(await count('progress', 'user_id = ?', device.account.userHandle)).toBe(0);
    });
  });

  describe('optimistic concurrency', () => {
    /** A DB whose `UPDATE progress` loses the race `conflicts` times: another device writes just before it. */
    function racingDb(conflicts: number, onConflict: (attempt: number) => Promise<void>): { db: D1Database; attempts: () => number } {
      const real = env.DB;
      let attempts = 0;
      const db = new Proxy(real, {
        get(target, property) {
          if (property !== 'prepare') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith('UPDATE progress SET state')) return statement;
            return {
              bind: (...values: unknown[]) => {
                const bound = statement.bind(...values);
                return {
                  run: async () => {
                    attempts += 1;
                    if (attempts <= conflicts) await onConflict(attempts);
                    return bound.run();
                  }
                };
              }
            };
          };
        }
      });
      return { db: db as D1Database, attempts: () => attempts };
    }

    it('re-reads and re-applies after losing a race, keeping both writes', async () => {
      const device = await register();
      const t = Date.now() - 1_000;
      const { db, attempts } = racingDb(2, async (attempt) => {
        const concurrent: SyncState = emptyState();
        concurrent.items.walks[`from_other_device_${attempt}`] = t;
        if (attempt === 2) concurrent.items.walks.from_other_device_1 = t;
        await env.DB.prepare('UPDATE progress SET state = ?, version = version + 1 WHERE user_id = ?').bind(JSON.stringify(concurrent), device.account.userHandle).run();
      });
      const res = await sync(device, [add(t + 1, { sections: ['mine'] })], { env: { DB: db } });
      expect(res.status).toBe(200);
      expect(attempts()).toBe(3);
      expect(res.body.state.items).toEqual({ sections: { mine: t + 1 }, walks: { from_other_device_1: t, from_other_device_2: t }, entered: {}, changed: {} });
      expect(await storedVersion(device)).toBe(4);
    });

    it('gives up with 409 busy after 5 retries', async () => {
      const device = await register();
      const { db, attempts } = racingDb(Infinity, async () => {
        await env.DB.prepare('UPDATE progress SET version = version + 1 WHERE user_id = ?').bind(device.account.userHandle).run();
      });
      const res = await sync(device, [add(Date.now(), { sections: ['mine'] })], { env: { DB: db } });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('busy');
      expect(attempts()).toBe(6);
    });
  });
});

describe('applyWithinLimits', () => {
  /** The design's definition, using only the shared model: apply in order, skipping a change that breaks a limit. */
  function reference(base: SyncState, changes: readonly Change[]): { state: SyncState; full: string[] } {
    let state = base;
    const full: string[] = [];
    for (const change of changes) {
      const next = applyChange(state, change);
      if (next === state) continue;
      if (exceedsLimits(next)) full.push(change.id);
      else state = next;
    }
    return { state, full };
  }

  /** Deterministic PRNG (mulberry32), so a failure can be reproduced from its seed. */
  function random(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function expectSameAsReference(base: SyncState, changes: Change[], label: string): void {
    const expected = reference(base, changes);
    const actual = applyWithinLimits(base, changes);
    expect(actual.full, label).toEqual(expected.full);
    expect(statesEqual(actual.state, expected.state), label).toBe(true);
    expect(actual.state === base, label).toBe(expected.state === base);
  }

  it('agrees with applying changes one by one: small random batches with ties, duplicates and resets', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = random(seed);
      const pick = <T,>(values: readonly T[]) => values[Math.floor(rand() * values.length)]!;
      // Times of different lengths, so digit changes are covered too.
      const times = [5, 9, 10, 99, 100, 1_000, 99_999, 100_000, 1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002];
      const ids = Array.from({ length: 12 }, (_, index) => `i${index}`);
      const base = emptyState();
      for (let index = 0; index < Math.floor(rand() * 15); index++) base.items[pick(ITEM_KINDS)][pick(ids)] = pick(times);
      if (rand() < 0.3) {
        base.resetAt = pick(times);
        for (const kind of ITEM_KINDS) for (const id of Object.keys(base.items[kind])) if (base.items[kind][id]! <= base.resetAt) delete base.items[kind][id];
      }
      const changes: Change[] = Array.from({ length: Math.floor(rand() * 12) }, (_, index) =>
        rand() < 0.2
          ? { id: `r${index}`, type: 'reset', at: pick(times) }
          : { id: `a${index}`, type: 'add', at: pick(times), items: Object.fromEntries(ITEM_KINDS.filter(() => rand() < 0.5).map((kind) => [kind, Array.from({ length: Math.floor(rand() * 4) }, () => pick(ids))])) });
      expectSameAsReference(base, changes, `seed ${seed}`);
    }
  });

  it('agrees with applying changes one by one near the item cap', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = random(1_000 + seed);
      const base = emptyState();
      const start = LIMITS.maxStateItems - 12 + Math.floor(rand() * 12);
      for (let index = 0; index < start; index++) base.items[ITEM_KINDS[index % 4]!][`n${index}`] = 1_700_000_000_000 + index;
      const changes: Change[] = Array.from({ length: 1 + Math.floor(rand() * 15) }, (_, index) =>
        rand() < 0.1
          ? { id: `r${index}`, type: 'reset', at: 1_700_000_000_000 + Math.floor(rand() * 3_000) }
          : { id: `a${index}`, type: 'add', at: 1_700_000_001_000 + index, items: { [ITEM_KINDS[Math.floor(rand() * 4)]!]: Array.from({ length: Math.floor(rand() * 6) }, () => `n${Math.floor(rand() * (start + 20))}`) } });
      expectSameAsReference(base, changes, `seed ${seed}`);
    }
  });

  it('agrees with applying changes one by one near the size cap', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = random(2_000 + seed);
      const base = emptyState();
      let index = 0;
      // Leave anywhere from no room to a few hundred bytes.
      const target = LIMITS.maxStateBytes - Math.floor(rand() * 400);
      let size = JSON.stringify(base).length;
      while (size < target - 120) {
        const id = `long_${index}_${'w'.repeat(40)}`;
        base.items[ITEM_KINDS[index++ % 3]!][id] = 1_700_000_000_000;
        size += id.length + 17; // "id":time and a comma
      }
      const changes: Change[] = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, n) =>
        rand() < 0.1
          ? { id: `r${n}`, type: 'reset', at: 1_600_000_000_000 + Math.floor(rand() * 10) }
          : { id: `a${n}`, type: 'add', at: 1_700_000_000_001 + n, items: { [ITEM_KINDS[Math.floor(rand() * 4)]!]: Array.from({ length: Math.floor(rand() * 4) }, () => 'q'.repeat(1 + Math.floor(rand() * 64))) } });
      expectSameAsReference(base, changes, `seed ${seed}`);
    }
  });

  /** A state that serializes to exactly `size` bytes: sections filled with 13-digit times, the other kinds empty. */
  function stateOfSize(size: number, resetAt = 0): SyncState {
    const state = emptyState();
    state.resetAt = resetAt;
    let current = JSON.stringify(state).length;
    let index = 0;
    while (size - current > 140) {
      const id = `fill_${index++}_${'f'.repeat(40)}`;
      state.items.sections[id] = 1_700_000_000_000;
      current += id.length + 17 - (index === 1 ? 1 : 0);
    }
    // One last entry of just the right length ("id":time plus a comma).
    state.items.sections['l'.repeat(size - current - 17)] = 1_700_000_000_000;
    expect(JSON.stringify(state).length).toBe(size);
    return state;
  }

  it('matches exceedsLimits exactly at the size boundary, with and without a comma', () => {
    const base = stateOfSize(LIMITS.maxStateBytes - 40);
    for (const kind of ['sections', 'walks'] as const) {
      for (let length = 1; length <= 40; length++) {
        const changes: Change[] = [{ id: 'c', type: 'add', at: 1_700_000_000_001, items: { [kind]: ['q'.repeat(length)] } }];
        // "id":time, plus a comma unless the record was empty.
        const fits = length + 16 + (kind === 'sections' ? 1 : 0) <= 40;
        expect(applyWithinLimits(base, changes).full.length === 0, `${kind} ${length}`).toBe(fits);
        expectSameAsReference(base, changes, `${kind} ${length}`);
      }
    }
  });

  it('counts a later time with more digits as growth', () => {
    const base = stateOfSize(LIMITS.maxStateBytes - 60);
    for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) base.items.entered[id] = 5;
    // Five "dN":5 entries and four commas leave 26 bytes of room; each update below adds 12.
    expect(LIMITS.maxStateBytes - JSON.stringify(base).length).toBe(26);
    const update = (ids: string[], id: string): Change => ({ id, type: 'add', at: 1_700_000_000_002, items: { entered: ids } });
    expectSameAsReference(base, [update(['d1', 'd2'], 'two')], 'two fit');
    expectSameAsReference(base, [update(['d1', 'd2', 'd3'], 'three')], 'three don’t');
    expect(applyWithinLimits(base, [update(['d1', 'd2', 'd3'], 'three')]).full).toEqual(['three']);
  });

  it('rejects a reset whose longer resetAt alone would pass the size cap', () => {
    for (const room of [11, 12, 13]) {
      const base = stateOfSize(LIMITS.maxStateBytes - room);
      // Removes nothing (every item is later), but resetAt grows from "0" to 13 digits: 12 more bytes.
      const changes: Change[] = [{ id: 'reset', type: 'reset', at: 1_600_000_000_000 }];
      expect(applyWithinLimits(base, changes).full, `room ${room}`).toEqual(room < 12 ? ['reset'] : []);
      expectSameAsReference(base, changes, `room ${room}`);
    }
  });
});
