import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapD1Error, secondsUntilUtcMidnight } from '../src/http';
import { clientNetworkKey } from '../src/rate-limit';
import { TEST_ORIGIN, call, clearDatabase, register } from './helpers';

beforeEach(clearDatabase);
afterEach(() => vi.restoreAllMocks());

describe('CORS', () => {
  it('answers a DELETE preflight from the app with 204 and the allowed methods and headers', async () => {
    const res = await call('OPTIONS', '/v1/passkeys/abc', {
      headers: { 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization' }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, DELETE');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('7200');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('puts CORS headers on successes and on 400, 401, 404 and 500 errors', async () => {
    const cases = [
      await call('GET', '/v1/health'),
      await call('POST', '/v1/auth/login/verify', { body: '{' }),
      await call('GET', '/v1/account'),
      await call('GET', '/v1/nowhere'),
      await call('GET', '/v1/auth/login/options', { env: { CHALLENGE_KEY: '' } })
    ];
    expect(cases.map((res) => res.status)).toEqual([200, 400, 401, 404, 500]);
    for (const res of cases) {
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);
      expect(res.headers.get('Vary')).toBe('Origin');
      expect(res.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
      expect(res.body.apiVersion).toBe(1);
    }
  });

  it('refuses other origins with 403 and no CORS headers, preflights included', async () => {
    for (const res of [
      await call('GET', '/v1/health', { origin: 'https://evil.example' }),
      await call('OPTIONS', '/v1/account', { origin: 'https://evil.example', headers: { 'Access-Control-Request-Method': 'DELETE' } }),
      await call('GET', '/v1/health', { origin: 'null' })
    ]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('sends no CORS headers when there is no Origin', async () => {
    const res = await call('GET', '/v1/health', { origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
  });

  it('reads the allowed origins from a comma-separated list', async () => {
    const res = await call('GET', '/v1/health', { origin: 'https://b.example', env: { ALLOWED_ORIGINS: 'https://a.example, https://b.example' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example');
  });
});

describe('routing and requests', () => {
  it('GET /v1/health', async () => {
    const res = await call('GET', '/v1/health');
    expect(res.body).toEqual({ apiVersion: 1, ok: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('answers 404 for unknown paths and 405 (with Allow) for wrong methods', async () => {
    const missing = await call('GET', '/v2/health');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toEqual({ code: 'not_found', message: expect.any(String) });
    const wrong = await call('POST', '/v1/health', { body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('GET');
    const account = await call('PUT', '/v1/account');
    expect(account.headers.get('Allow')).toBe('GET, DELETE');
  });

  it('caps ordinary POST bodies at 16 KB (413 too_large), with or without Content-Length', async () => {
    const big = JSON.stringify({ challengeId: 'x', response: { pad: 'p'.repeat(17 * 1024) } });
    const declared = await call('POST', '/v1/auth/login/verify', { body: big });
    expect(declared.status).toBe(413);
    expect(declared.body.error.code).toBe('too_large');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 20; index++) controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        controller.close();
      }
    });
    const request = new Request('https://sync.example.test/v1/auth/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
      body: stream,
      duplex: 'half'
    } as RequestInit);
    const { default: worker } = await import('../src/index');
    const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], env);
    expect(response.status).toBe(413);
  });

  it('accepts an empty body for endpoints whose request is {}', async () => {
    const device = await register();
    const res = await call('POST', '/v1/auth/logout', { token: device.token });
    expect(res.status).toBe(200);
  });
});

describe('D1 errors', () => {
  const DAILY = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow";
  const OVERLOADED = 'D1_ERROR: D1 DB is overloaded. Too many requests queued.';
  const LOST = 'D1_ERROR: Network connection lost.';

  /** A D1 binding that fails every query (or only queries matching `when`) with `message`. */
  function failingDb(message: string, when: (sql: string) => boolean = () => true): D1Database {
    const real = env.DB;
    const fail = async () => {
      throw new Error(message);
    };
    const failingStatement = { bind: () => failingStatement, first: fail, run: fail, all: fail, raw: fail };
    return new Proxy(real, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => (when(sql) ? failingStatement : target.prepare(sql));
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          if (statements.some((statement) => statement === (failingStatement as unknown))) return fail();
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as D1Database;
  }

  it('maps the free-tier daily limit to 503 over_capacity, retrying after 00:00 UTC', async () => {
    const res = await call('GET', '/v1/account', { token: 'A'.repeat(43), env: { DB: failingDb(DAILY) } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('over_capacity');
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(Math.abs(retryAfter - secondsUntilUtcMidnight(Date.now()))).toBeLessThanOrEqual(2);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);
  });

  it('maps an overloaded database to 503 busy with Retry-After: 5', async () => {
    const res = await call('GET', '/v1/account', { token: 'A'.repeat(43), env: { DB: failingDb(OVERLOADED) } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('busy');
    expect(res.headers.get('Retry-After')).toBe('5');
  });

  it('answers 503, never 401, when the session lookup itself fails', async () => {
    const device = await register();
    const res = await call('POST', '/v1/sync', { token: device.token, body: { changes: [] }, env: { DB: failingDb(LOST) } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('unavailable');
  });

  it('maps failures after the session lookup the same way, and anything else to a logged 500 internal', async () => {
    const device = await register();
    const progressFails = (message: string) => failingDb(message, (sql) => sql.includes('FROM progress'));
    const capacity = await call('POST', '/v1/sync', { token: device.token, body: { changes: [] }, env: { DB: progressFails(DAILY) } });
    expect(capacity.body.error.code).toBe('over_capacity');

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('POST', '/v1/sync', { token: device.token, body: { changes: [] }, env: { DB: progressFails(LOST) } });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);
    expect(logged).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(logged.mock.calls[0]![0]));
    expect(entry).toEqual({ route: 'POST /v1/sync', code: 'internal', name: 'Error', message: LOST });
    expect(String(logged.mock.calls[0]![0])).not.toContain(device.token);
  });

  it('recognises D1’s messages', () => {
    expect(mapD1Error(new Error(DAILY.replace('read', 'write')), 0)?.code).toBe('over_capacity');
    expect(mapD1Error(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'), 0)?.code).toBe('busy');
    expect(mapD1Error(new Error(LOST), 0)).toBeNull();
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 10, 22, 23, 59, 30))).toBe(30);
  });
});

describe('rate limiting', () => {
  const refusing: RateLimit = { limit: async () => ({ success: false }) };
  const throwing: RateLimit = {
    limit: async () => {
      throw new Error('limiter unavailable');
    }
  };

  it('limits unauthenticated passkey endpoints by network with 429 and Retry-After', async () => {
    const keys: string[] = [];
    const recording: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      }
    };
    const res = await call('GET', '/v1/auth/login/options', { headers: { 'CF-Connecting-IP': '203.0.113.7' }, env: { RATE_LIMITS: 'on', AUTH_RATE_LIMITER: recording } });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(keys).toEqual(['203.0.113.7']);
    // Health isn't limited.
    expect((await call('GET', '/v1/health', { env: { RATE_LIMITS: 'on', AUTH_RATE_LIMITER: refusing } })).status).toBe(200);
  });

  it('limits sync per user', async () => {
    const device = await register();
    const keys: string[] = [];
    const recording: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.length <= 1 };
      }
    };
    const options = { token: device.token, body: { changes: [] }, env: { RATE_LIMITS: 'on', SYNC_RATE_LIMITER: recording } };
    expect((await call('POST', '/v1/sync', options)).status).toBe(200);
    expect((await call('POST', '/v1/sync', options)).status).toBe(429);
    expect(keys).toEqual([device.account.userHandle, device.account.userHandle]);
  });

  it('is off with RATE_LIMITS=off, and allows requests when the binding is missing or fails', async () => {
    expect((await call('GET', '/v1/auth/login/options', { env: { RATE_LIMITS: 'off', AUTH_RATE_LIMITER: refusing } })).status).toBe(200);
    expect((await call('GET', '/v1/auth/login/options', { env: { RATE_LIMITS: 'on', AUTH_RATE_LIMITER: undefined } })).status).toBe(200);
    expect((await call('GET', '/v1/auth/login/options', { env: { RATE_LIMITS: 'on', AUTH_RATE_LIMITER: throwing } })).status).toBe(200);
  });

  it('keys IPv6 by /64', () => {
    const key = (ip: string) => clientNetworkKey(new Request('https://x.test', { headers: { 'CF-Connecting-IP': ip } }));
    expect(key('2001:db8:85a3:0042:1000:8a2e:370:7334')).toBe('2001:db8:85a3:42::/64');
    expect(key('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(key('2001:DB8:0:0:ffff::')).toBe('2001:db8:0:0::/64');
    expect(key('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(key('198.51.100.4')).toBe('198.51.100.4');
    expect(clientNetworkKey(new Request('https://x.test'))).toBe('unknown');
  });
});
