import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { clearDatabase, count } from './helpers';

beforeEach(clearDatabase);

const DAY = 86_400_000;
const MINUTE = 60_000;

const EMPTY = JSON.stringify({ resetAt: 0, items: { sections: {}, walks: {}, entered: {}, changed: {} } });
const RESET_EMPTY = JSON.stringify({ resetAt: 1_700_000_000_000, items: { sections: {}, walks: {}, entered: {}, changed: {} } });
const NOT_EMPTY = JSON.stringify({ resetAt: 0, items: { sections: {}, walks: {}, entered: {}, changed: { bank: 1_700_000_000_000 } } });

async function seedUser(id: string, options: { createdAt: number; state?: string | null; sessionLastUsed?: number }): Promise<void> {
  const statements = [
    env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(id, `Tube Tracker · ${id}`, options.createdAt),
    env.DB.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, created_at, last_used_at)
       VALUES (?, ?, 'pk', 0, NULL, 'singleDevice', 0, NULL, ?, NULL)`
    ).bind(`cred_${id}`, id, options.createdAt)
  ];
  if (options.state !== null) {
    statements.push(env.DB.prepare('INSERT INTO progress (user_id, state, version, updated_at) VALUES (?, ?, 1, ?)').bind(id, options.state ?? EMPTY, options.createdAt));
  }
  if (options.sessionLastUsed !== undefined) {
    statements.push(env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, verified_at) VALUES (?, ?, ?, ?, NULL)')
      .bind(`session_${id}`, id, options.createdAt, options.sessionLastUsed));
  }
  await env.DB.batch(statements);
}

/** The handler awaits its work rather than using waitUntil, so awaiting it is enough. */
async function runCron(): Promise<void> {
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), env);
}

describe('daily cleanup', () => {
  it('deletes old used challenges and expired sessions', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO used_challenges (challenge, created_at) VALUES (?, ?), (?, ?)').bind('old', now - 11 * MINUTE, 'recent', now - 9 * MINUTE),
      env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').bind('keeper', 'Tube Tracker · KEEP', now),
      env.DB.prepare('INSERT INTO progress (user_id, state, version, updated_at) VALUES (?, ?, 1, ?)').bind('keeper', NOT_EMPTY, now),
      env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, verified_at) VALUES
        ('expired', 'keeper', 0, ?1, NULL), ('alive', 'keeper', 0, ?2, NULL)`).bind(now - 401 * DAY, now - 399 * DAY)
    ]);
    await runCron();
    expect(await count('used_challenges')).toBe(1);
    expect(await count('used_challenges', "challenge = 'recent'")).toBe(1);
    expect(await count('sessions')).toBe(1);
    expect(await count('sessions', "token_hash = 'alive'")).toBe(1);
  });

  it('deletes abandoned empty accounts (over 30 days old, no session use for 30 days) and keeps the rest', async () => {
    const now = Date.now();
    await seedUser('abandoned', { createdAt: now - 40 * DAY, sessionLastUsed: now - 31 * DAY });
    await seedUser('abandoned_no_sessions', { createdAt: now - 40 * DAY });
    await seedUser('abandoned_after_reset', { createdAt: now - 40 * DAY, state: RESET_EMPTY });
    await seedUser('abandoned_no_progress', { createdAt: now - 40 * DAY, state: null });
    await seedUser('has_journeys', { createdAt: now - 400 * DAY });
    await env.DB.prepare('UPDATE progress SET state = ? WHERE user_id = ?').bind(NOT_EMPTY, 'has_journeys').run();
    await seedUser('recently_used', { createdAt: now - 40 * DAY, sessionLastUsed: now - 29 * DAY });
    await seedUser('new', { createdAt: now - 29 * DAY });
    await seedUser('corrupt_state', { createdAt: now - 40 * DAY, state: '{oops' });

    await runCron();

    const users = await env.DB.prepare('SELECT id FROM users ORDER BY id').all<{ id: string }>();
    expect(users.results.map((row) => row.id)).toEqual(['corrupt_state', 'has_journeys', 'new', 'recently_used']);
    for (const table of ['credentials', 'progress', 'sessions']) {
      expect(await count(table, "user_id LIKE 'abandoned%'")).toBe(0);
    }
    expect(await count('credentials')).toBe(4);
    expect(await count('sessions', "user_id = 'recently_used'")).toBe(1);
  });

  it('deletes passkeys, sessions and progress whose backup has gone', async () => {
    const now = Date.now();
    await seedUser('keeper', { createdAt: now - 400 * DAY, state: NOT_EMPTY, sessionLastUsed: now });
    await seedUser('gone', { createdAt: now - DAY, state: NOT_EMPTY, sessionLastUsed: now });
    // Left behind by a deletion that raced another device's write.
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind('gone').run();

    await runCron();

    for (const table of ['credentials', 'sessions', 'progress']) {
      expect(await count(table, "user_id = 'gone'"), table).toBe(0);
      expect(await count(table, "user_id = 'keeper'"), table).toBe(1);
    }
    expect(await count('users')).toBe(1);
  });
});
