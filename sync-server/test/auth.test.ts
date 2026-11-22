import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { signChallenge } from '../src/crypto';
import { ICLOUD_AAGUID, SoftAuthenticator } from './authenticator';
import { call, challengePayload, clearDatabase, count, login, makeNotRecent, reauth, register, type Device } from './helpers';

beforeEach(clearDatabase);

const DAY = 86_400_000;

describe('register', () => {
  it('offers resident-key ES256/RS256 options for a new "Tube Tracker · ABCD" account, writing nothing', async () => {
    const before = await Promise.all(['users', 'credentials', 'sessions', 'used_challenges', 'progress'].map((table) => count(table)));
    const res = await call('GET', '/v1/auth/register/options');
    expect(res.status).toBe(200);
    expect(res.body.apiVersion).toBe(1);
    const { options, challengeId } = res.body;
    expect(options.rp).toEqual({ name: 'Tube Tracker', id: 'localhost' });
    expect(options.user.name).toMatch(/^Tube Tracker · [A-HJ-NP-Z2-9]{4}$/);
    expect(options.user.displayName).toBe(options.user.name);
    expect(options.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' });
    expect(options.authenticatorSelection.authenticatorAttachment).toBeUndefined();
    expect(options.attestation).toBe('none');
    expect(options.pubKeyCredParams.map((param: { alg: number }) => param.alg)).toEqual([-7, -257]);
    expect(options.timeout).toBe(300_000);
    expect(challengePayload(challengeId)).toMatchObject({ purpose: 'register', challenge: options.challenge, userId: options.user.id, userName: options.user.name });
    const after = await Promise.all(['users', 'credentials', 'sessions', 'used_challenges', 'progress'].map((table) => count(table)));
    expect(after).toEqual(before);
  });

  it('creates the user (id = user handle), passkey, verified session and empty progress', async () => {
    const auth = new SoftAuthenticator({ synced: true, aaguid: ICLOUD_AAGUID });
    const options = await call('GET', '/v1/auth/register/options');
    const response = await auth.create(options.body.options);
    const res = await call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response } });
    expect(res.status).toBe(200);
    const { token, account, state, serverTime } = res.body;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(account).toEqual({
      userHandle: options.body.options.user.id,
      name: options.body.options.user.name,
      createdAt: serverTime,
      passkeys: [{ id: response.id, createdAt: serverTime, lastUsedAt: null, synced: true, provider: 'iCloud Keychain' }]
    });
    expect(state).toEqual({ resetAt: 0, items: { sections: {}, walks: {}, entered: {}, changed: {} } });
    expect(Math.abs(serverTime - Date.now())).toBeLessThan(5_000);

    const session = await env.DB.prepare('SELECT * FROM sessions').first<{ token_hash: string; verified_at: number; user_id: string }>();
    expect(session?.user_id).toBe(account.userHandle);
    expect(session?.verified_at).toBe(serverTime);
    expect(session?.token_hash).not.toContain(token);
    expect(await count('progress', 'user_id = ?', account.userHandle)).toBe(1);
    expect(await count('used_challenges')).toBe(1);
  });

  it('reports unsynced passkeys and unknown providers plainly', async () => {
    const device = await register(new SoftAuthenticator());
    expect(device.account.passkeys[0]).toMatchObject({ synced: false, provider: null });
  });

  it('refuses a passkey made for another origin', async () => {
    const auth = new SoftAuthenticator();
    const options = await call('GET', '/v1/auth/register/options');
    const response = await auth.create(options.body.options, { origin: 'https://evil.example' });
    const res = await call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('verification_failed');
    expect(await count('users')).toBe(0);
  });

  it('refuses a duplicate credential id with 409 already_registered, leaving everything as it was', async () => {
    const first = await register();
    const options = await call('GET', '/v1/auth/register/options');
    const response = await first.auth.create(options.body.options, { reuse: first.auth.passkeys[0] });
    const res = await call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_registered');
    expect(await count('users')).toBe(1);
    expect(await count('credentials', 'user_id = ?', first.account.userHandle)).toBe(1);
    // The batch rolled back, so the challenge wasn't used up either.
    expect(await count('used_challenges')).toBe(1);
  });

  it('rejects malformed bodies and unknown fields with 400', async () => {
    const options = await call('GET', '/v1/auth/register/options');
    const extra = await call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response: {}, extra: 1 } });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe('bad_request');
    const missing = await call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response: { id: 'abc' } } });
    expect(missing.status).toBe(400);
    const notJson = await call('POST', '/v1/auth/register/verify', { body: '{"challengeId":' });
    expect(notJson.status).toBe(400);
    const array = await call('POST', '/v1/auth/register/verify', { body: [] });
    expect(array.status).toBe(400);
    const wrongType = await call('POST', '/v1/auth/register/verify', { body: 'x=1', headers: { 'Content-Type': 'text/plain' } });
    expect(wrongType.status).toBe(415);
  });
});

describe('caps on new backups', () => {
  async function insertUsers(n: number, createdAt: number): Promise<void> {
    const statements = Array.from({ length: n }, (_, index) =>
      env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(`seed_${createdAt}_${index}`, 'Tube Tracker · SEED', createdAt));
    for (let start = 0; start < statements.length; start += 100) await env.DB.batch(statements.slice(start, start + 100));
  }

  async function tryRegister(overrides: Partial<{ MAX_USERS: string; MAX_NEW_USERS_PER_DAY: string }> = {}) {
    const auth = new SoftAuthenticator();
    const options = await call('GET', '/v1/auth/register/options');
    const response = await auth.create(options.body.options);
    return call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response }, env: overrides });
  }

  it('closes registrations at MAX_USERS with 503 registrations_closed', async () => {
    await insertUsers(5, Date.now() - 40 * DAY);
    const closed = await tryRegister({ MAX_USERS: '5' });
    expect(closed.status).toBe(503);
    expect(closed.body.error.code).toBe('registrations_closed');
    expect(closed.headers.get('Retry-After')).toBeNull();
    expect(await count('users')).toBe(5);
    const open = await tryRegister({ MAX_USERS: '6' });
    expect(open.status).toBe(200);
  });

  it('allows at most 200 new backups per UTC day', async () => {
    await insertUsers(199, Date.now());
    await insertUsers(50, Date.now() - 2 * DAY); // earlier days don't count
    expect((await tryRegister()).status).toBe(200);
    const closed = await tryRegister();
    expect(closed.status).toBe(503);
    expect(closed.body.error.code).toBe('registrations_closed');
    const retryAfter = Number(closed.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
  });

  it('reads the daily cap from MAX_NEW_USERS_PER_DAY', async () => {
    await insertUsers(2, Date.now());
    const closed = await tryRegister({ MAX_NEW_USERS_PER_DAY: '2' });
    expect(closed.status).toBe(503);
    expect(closed.body.error.code).toBe('registrations_closed');
    expect((await tryRegister({ MAX_NEW_USERS_PER_DAY: '3' })).status).toBe(200);
  });
});

describe('login (restore)', () => {
  it('signs in with a discoverable passkey and returns the token, account, state and server time', async () => {
    const device = await register();
    await call('POST', '/v1/sync', { token: device.token, body: { changes: [{ id: 'first', type: 'add', at: Date.now(), items: { sections: ['bakerloo_1'] } }] } });

    const options = await call('GET', '/v1/auth/login/options');
    expect(options.body.options.allowCredentials).toBeUndefined();
    expect(options.body.options.userVerification).toBe('preferred');
    expect(options.body.options.rpId).toBe('localhost');

    const otherPhone = device.auth.syncedCopy();
    const res = await login(otherPhone);
    expect(res.status).toBe(200);
    expect(res.token).not.toBe(device.token);
    expect(res.body.account.userHandle).toBe(device.account.userHandle);
    expect(Object.keys(res.body.state.items.sections)).toEqual(['bakerloo_1']);
    expect(typeof res.body.serverTime).toBe('number');

    const credential = await env.DB.prepare('SELECT counter, last_used_at FROM credentials').first<{ counter: number; last_used_at: number }>();
    expect(credential?.counter).toBe(1);
    expect(credential?.last_used_at).toBe(res.body.serverTime);
    expect(res.body.account.passkeys[0].lastUsedAt).toBe(res.body.serverTime);
    expect(await count('sessions', 'user_id = ?', device.account.userHandle)).toBe(2);
  });

  it('answers 404 unknown_credential for a passkey the server doesn’t know', async () => {
    const device = await register();
    await call('DELETE', '/v1/account', { token: device.token });
    const res = await login(device.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('unknown_credential');
  });

  it('requires the user handle to match the passkey’s user (400 user_mismatch)', async () => {
    const a = await register();
    const b = await register();
    const options = await call('GET', '/v1/auth/login/options');
    const forged = await a.auth.get(options.body.options, { userHandle: b.account.userHandle });
    const res = await call('POST', '/v1/auth/login/verify', { body: { challengeId: options.body.challengeId, response: forged } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('user_mismatch');

    const options2 = await call('GET', '/v1/auth/login/options');
    const missing = await a.auth.get(options2.body.options, { userHandle: null });
    const res2 = await call('POST', '/v1/auth/login/verify', { body: { challengeId: options2.body.challengeId, response: missing } });
    expect(res2.status).toBe(400);
    expect(res2.body.error.code).toBe('user_mismatch');
  });

  it('refuses a replayed signature counter', async () => {
    const device = await register();
    const options = await call('GET', '/v1/auth/login/options');
    const response = await device.auth.get(options.body.options);
    expect((await call('POST', '/v1/auth/login/verify', { body: { challengeId: options.body.challengeId, response } })).status).toBe(200);
    const replay = await call('POST', '/v1/auth/login/verify', { body: { challengeId: options.body.challengeId, response } });
    expect(replay.status).toBe(400);
  });

  it('keeps at most 20 sessions per user, dropping expired and least recently used ones', async () => {
    const device = await register();
    const now = Date.now();
    const insert = (hash: string, lastUsed: number) =>
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, verified_at) VALUES (?, ?, ?, ?, NULL)')
        .bind(hash, device.account.userHandle, lastUsed, lastUsed);
    await env.DB.batch([
      insert('expired', now - 401 * DAY),
      ...Array.from({ length: 21 }, (_, index) => insert(`old_${String(index).padStart(2, '0')}`, now - (index + 2) * DAY))
    ]);
    const res = await login(device.auth);
    expect(res.status).toBe(200);
    expect(await count('sessions', 'user_id = ?', device.account.userHandle)).toBe(20);
    expect(await count('sessions', "token_hash = 'expired'")).toBe(0);
    // The newest login and the registration session survive; the least recently used seeded ones go.
    expect((await call('GET', '/v1/account', { token: res.token })).status).toBe(200);
    expect((await call('GET', '/v1/account', { token: device.token })).status).toBe(200);
    expect(await count('sessions', "token_hash IN ('old_18', 'old_19', 'old_20')")).toBe(0);
    expect(await count('sessions', "token_hash = 'old_00'")).toBe(1);
  });
});

describe('challenges', () => {
  async function registrationAttempt() {
    const auth = new SoftAuthenticator();
    const options = await call('GET', '/v1/auth/register/options');
    const response = await auth.create(options.body.options);
    return { options: options.body.options, challengeId: options.body.challengeId as string, response };
  }

  it('rejects a challengeId whose MAC doesn’t match', async () => {
    const { challengeId, response } = await registrationAttempt();
    const [body, mac] = challengeId.split('.');
    const tamperedMac = `${body}.${mac!.slice(0, -2)}${mac!.endsWith('AA') ? 'BB' : 'AA'}`;
    const res = await call('POST', '/v1/auth/register/verify', { body: { challengeId: tamperedMac, response } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('challenge_invalid');

    // A payload signed with another key.
    const payload = challengePayload(challengeId);
    const forged = await signChallenge('another-key-that-is-at-least-32-characters', payload as never);
    const res2 = await call('POST', '/v1/auth/register/verify', { body: { challengeId: forged, response } });
    expect(res2.body.error.code).toBe('challenge_invalid');

    const res3 = await call('POST', '/v1/auth/register/verify', { body: { challengeId: 'not-a-challenge', response } });
    expect(res3.body.error.code).toBe('challenge_invalid');
  });

  it('rejects a challenge issued for another purpose', async () => {
    const device = await register();
    const loginOptions = await call('GET', '/v1/auth/login/options');
    const response = await device.auth.get(loginOptions.body.options);
    // A login challenge sent to the reauth endpoint.
    const res = await call('POST', '/v1/auth/reauth/verify', { token: device.token, body: { challengeId: loginOptions.body.challengeId, response } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('challenge_invalid');
  });

  it('rejects a challenge older than 10 minutes', async () => {
    const { challengeId, response } = await registrationAttempt();
    const payload = { ...challengePayload(challengeId), issuedAt: Date.now() - 10 * 60_000 - 1_000 };
    const old = await signChallenge(env.CHALLENGE_KEY, payload as never);
    const res = await call('POST', '/v1/auth/register/verify', { body: { challengeId: old, response } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('challenge_expired');

    const almost = await signChallenge(env.CHALLENGE_KEY, { ...payload, issuedAt: Date.now() - 9 * 60_000 } as never);
    expect((await call('POST', '/v1/auth/register/verify', { body: { challengeId: almost, response } })).status).toBe(200);
  });

  it('uses each challenge once (400 challenge_used)', async () => {
    const device = await register();
    const options = await call('GET', '/v1/auth/login/options');
    const first = await device.auth.get(options.body.options);
    expect((await call('POST', '/v1/auth/login/verify', { body: { challengeId: options.body.challengeId, response: first } })).status).toBe(200);
    // A fresh, valid signature over the same challenge (higher counter) still can't use it again.
    const second = await device.auth.get(options.body.options);
    const res = await call('POST', '/v1/auth/login/verify', { body: { challengeId: options.body.challengeId, response: second } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('challenge_used');
  });

  it('refuses another account’s reauth challenge (cross-user)', async () => {
    const a = await register();
    const b = await register();
    const aOptions = await call('POST', '/v1/auth/reauth/options', { token: a.token, body: {} });
    const response = await b.auth.get({ ...aOptions.body.options, allowCredentials: undefined });
    const res = await call('POST', '/v1/auth/reauth/verify', { token: b.token, body: { challengeId: aOptions.body.challengeId, response } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('challenge_invalid');
  });

  it('answers 500 (logged) when CHALLENGE_KEY is missing, not a usable challenge', async () => {
    const res = await call('GET', '/v1/auth/login/options', { env: { CHALLENGE_KEY: 'short' } });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
  });
});

describe('reauth', () => {
  it('lists only this account’s passkeys and refreshes verified_at', async () => {
    const device = await register();
    await register(); // someone else
    await makeNotRecent(device);
    const options = await call('POST', '/v1/auth/reauth/options', { token: device.token, body: {} });
    expect(options.status).toBe(200);
    expect(options.body.options.allowCredentials.map((credential: { id: string }) => credential.id)).toEqual([device.auth.passkeys[0]!.id]);
    expect(challengePayload(options.body.challengeId)).toMatchObject({ purpose: 'reauth', userId: device.account.userHandle });

    const response = await device.auth.get(options.body.options);
    const res = await call('POST', '/v1/auth/reauth/verify', { token: device.token, body: { challengeId: options.body.challengeId, response } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiVersion: 1, ok: true });
    const session = await env.DB.prepare('SELECT verified_at FROM sessions WHERE user_id = ?').bind(device.account.userHandle).first<{ verified_at: number }>();
    expect(Date.now() - session!.verified_at).toBeLessThan(5_000);
  });

  it('refuses another account’s passkey (400 user_mismatch) and a wrong user handle', async () => {
    const a = await register();
    const b = await register();
    const options = await call('POST', '/v1/auth/reauth/options', { token: a.token, body: {} });
    const bResponse = await b.auth.get({ ...options.body.options, allowCredentials: undefined });
    const res = await call('POST', '/v1/auth/reauth/verify', { token: a.token, body: { challengeId: options.body.challengeId, response: bResponse } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('user_mismatch');

    const options2 = await call('POST', '/v1/auth/reauth/options', { token: a.token, body: {} });
    const wrongHandle = await a.auth.get(options2.body.options, { userHandle: b.account.userHandle });
    const res2 = await call('POST', '/v1/auth/reauth/verify', { token: a.token, body: { challengeId: options2.body.challengeId, response: wrongHandle } });
    expect(res2.body.error.code).toBe('user_mismatch');
  });

  it('needs a session (401) and a body of {}', async () => {
    expect((await call('POST', '/v1/auth/reauth/options', { body: {} })).status).toBe(401);
    const device = await register();
    expect((await call('POST', '/v1/auth/reauth/options', { token: device.token, body: { x: 1 } })).status).toBe(400);
  });
});

describe('"✓ recent" endpoints', () => {
  it('answer 403 reauth_required more than 5 minutes after the last ceremony, and work again after reauth', async () => {
    const device = await register();
    await makeNotRecent(device);
    const blocked = [
      await call('POST', '/v1/passkeys/options', { token: device.token, body: {} }),
      await call('DELETE', `/v1/passkeys/${device.auth.passkeys[0]!.id}`, { token: device.token }),
      await call('POST', '/v1/sessions/revoke-others', { token: device.token, body: {} }),
      await call('DELETE', '/v1/account', { token: device.token })
    ];
    for (const res of blocked) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('reauth_required');
    }
    // Ordinary endpoints still work.
    expect((await call('GET', '/v1/account', { token: device.token })).status).toBe(200);
    // passkeys/verify checks the challenge's time instead (below), so a body without one is simply malformed.
    expect((await call('POST', '/v1/passkeys/verify', { token: device.token, body: {} })).status).toBe(400);
    expect((await call('POST', '/v1/passkeys/verify', { body: {} })).status).toBe(401);

    expect((await reauth(device)).status).toBe(200);
    expect((await call('POST', '/v1/sessions/revoke-others', { token: device.token, body: {} })).status).toBe(200);
  });

  it('accept a new passkey whose ceremony began within 5 minutes of the last one, however long it then took', async () => {
    const device = await register();
    const options = await call('POST', '/v1/passkeys/options', { token: device.token, body: {} });
    expect(options.status).toBe(200);
    const response = await new SoftAuthenticator().create(options.body.options);
    // The session's last ceremony was 5:01 ago. Options issued 4:59 after it are in time; 5:01 after it, they aren't.
    const verifiedAt = Date.now() - 5 * 60_000 - 1_000;
    await env.DB.prepare('UPDATE sessions SET verified_at = ? WHERE user_id = ?').bind(verifiedAt, device.account.userHandle).run();
    const issuedAt = (offset: number) => signChallenge(env.CHALLENGE_KEY, { ...challengePayload(options.body.challengeId), issuedAt: verifiedAt + offset } as never);

    const late = await call('POST', '/v1/passkeys/verify', { token: device.token, body: { challengeId: await issuedAt(5 * 60_000 + 1_000), response } });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe('reauth_required');
    const inTime = await call('POST', '/v1/passkeys/verify', { token: device.token, body: { challengeId: await issuedAt(4 * 60_000 + 59_000), response } });
    expect(inTime.status).toBe(200);
    expect(inTime.body.account.passkeys).toHaveLength(2);
  });
});

describe('passkeys', () => {
  async function addPasskey(device: Device, auth = new SoftAuthenticator({ synced: true })) {
    const options = await call('POST', '/v1/passkeys/options', { token: device.token, body: {} });
    if (options.status !== 200) return options;
    const response = await auth.create(options.body.options);
    return call('POST', '/v1/passkeys/verify', { token: device.token, body: { challengeId: options.body.challengeId, response } });
  }

  it('adds a passkey for the same user, excluding the existing ones', async () => {
    const device = await register();
    const options = await call('POST', '/v1/passkeys/options', { token: device.token, body: {} });
    expect(options.status).toBe(200);
    expect(options.body.options.user).toEqual({ id: device.account.userHandle, name: device.account.name, displayName: device.account.name });
    expect(options.body.options.excludeCredentials.map((credential: { id: string }) => credential.id)).toEqual([device.auth.passkeys[0]!.id]);
    expect(challengePayload(options.body.challengeId)).toMatchObject({ purpose: 'add', userId: device.account.userHandle });

    const securityKey = new SoftAuthenticator();
    const response = await securityKey.create(options.body.options);
    const res = await call('POST', '/v1/passkeys/verify', { token: device.token, body: { challengeId: options.body.challengeId, response } });
    expect(res.status).toBe(200);
    expect(res.body.account.passkeys.map((passkey: { id: string }) => passkey.id)).toEqual([device.auth.passkeys[0]!.id, response.id]);

    // The new passkey restores the same backup.
    const restored = await login(securityKey);
    expect(restored.body.account.userHandle).toBe(device.account.userHandle);
  });

  it('refuses a passkey already registered (409) and another user’s add challenge', async () => {
    const a = await register();
    const b = await register();
    const options = await call('POST', '/v1/passkeys/options', { token: a.token, body: {} });
    const duplicate = await b.auth.create(options.body.options, { reuse: b.auth.passkeys[0] });
    const res = await call('POST', '/v1/passkeys/verify', { token: a.token, body: { challengeId: options.body.challengeId, response: duplicate } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_registered');

    const fresh = await new SoftAuthenticator().create(options.body.options);
    const crossUser = await call('POST', '/v1/passkeys/verify', { token: b.token, body: { challengeId: options.body.challengeId, response: fresh } });
    expect(crossUser.status).toBe(400);
    expect(crossUser.body.error.code).toBe('challenge_invalid');
  });

  it('allows at most 10 passkeys per account', async () => {
    const device = await register();
    for (let index = 0; index < 9; index++) expect((await addPasskey(device)).status).toBe(200);
    const res = await addPasskey(device);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('too_many_passkeys');
    expect(await count('credentials', 'user_id = ?', device.account.userHandle)).toBe(10);
  });

  it('removes a passkey, ends the user’s other sessions, and never removes the last one', async () => {
    const device = await register();
    const other = await login(device.auth);
    const added = await addPasskey(device);
    const secondId = added.body.account.passkeys[1].id;

    const res = await call('DELETE', `/v1/passkeys/${secondId}`, { token: device.token });
    expect(res.status).toBe(200);
    expect(res.body.account.passkeys.map((passkey: { id: string }) => passkey.id)).toEqual([device.auth.passkeys[0]!.id]);
    expect((await call('GET', '/v1/account', { token: other.token })).status).toBe(401);
    expect((await call('GET', '/v1/account', { token: device.token })).status).toBe(200);

    const last = await call('DELETE', `/v1/passkeys/${device.auth.passkeys[0]!.id}`, { token: device.token });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('last_passkey');
    expect(await count('credentials', 'user_id = ?', device.account.userHandle)).toBe(1);
  });

  it('adds nothing, and answers 401, when the backup is deleted on another device meanwhile', async () => {
    const device = await register();
    const options = await call('POST', '/v1/passkeys/options', { token: device.token, body: {} });
    const response = await new SoftAuthenticator().create(options.body.options);
    // The backup is deleted just before the new passkey is stored: the second batch is the ceremony's (the first loads
    // the account).
    let batches = 0;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            batches += 1;
            if (batches === 2) expect((await call('DELETE', '/v1/account', { token: device.token })).status).toBe(200);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const res = await call('POST', '/v1/passkeys/verify', { token: device.token, body: { challengeId: options.body.challengeId, response }, env: { DB: db } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(batches).toBe(2);
    expect(await count('credentials')).toBe(0);
  });

  it('answers 404 for a passkey that isn’t on this account', async () => {
    const a = await register();
    const b = await register();
    await addPasskey(a);
    const res = await call('DELETE', `/v1/passkeys/${b.auth.passkeys[0]!.id}`, { token: a.token });
    expect(res.status).toBe(404);
    expect(await count('credentials', 'user_id = ?', b.account.userHandle)).toBe(1);
    expect((await call('DELETE', '/v1/passkeys/not%20base64', { token: a.token })).status).toBe(404);
  });
});

describe('what a passkey may store', () => {
  async function registerWith(overrides: Parameters<SoftAuthenticator['create']>[1]) {
    const options = await call('GET', '/v1/auth/register/options');
    const response = await new SoftAuthenticator().create(options.body.options, overrides);
    return call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response } });
  }

  async function expectRefused(res: Awaited<ReturnType<typeof registerWith>>) {
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(await count('users')).toBe(0);
    expect(await count('credentials')).toBe(0);
  }

  it('refuses a credential id in the signed data that isn’t the one reported (so the length cap can’t be bypassed)', async () => {
    const reported = btoa('a'.repeat(16)).replace(/=+$/, '');
    await expectRefused(await registerWith({ idBytes: 8_000, responseId: reported }));
    await expectRefused(await registerWith({ responseId: reported }));
  });

  it('caps credential ids at 342 characters (256 bytes)', async () => {
    await expectRefused(await registerWith({ idBytes: 257 }));
    const longest = await registerWith({ idBytes: 256 });
    expect(longest.status).toBe(200);
    expect(longest.body.account.passkeys[0].id).toHaveLength(342);
  });

  it('caps public keys at 600 bytes', async () => {
    await expectRefused(await registerWith({ keyPadding: 600 }));
    // A padded key that still fits is stored as it came.
    expect((await registerWith({ keyPadding: 400 })).status).toBe(200);
  });

  it('keeps only known transports, each once, and ignores the rest', async () => {
    const res = await registerWith({ transports: ['usb', 'usb', 'made-up', 'x'.repeat(100), 7, 'internal'] });
    expect(res.status).toBe(200);
    const stored = await env.DB.prepare('SELECT transports FROM credentials').first<{ transports: string | null }>();
    expect(JSON.parse(stored!.transports!)).toEqual(['usb', 'internal']);

    await clearDatabase();
    expect((await registerWith({ transports: 'usb' })).status).toBe(200);
    expect((await env.DB.prepare('SELECT transports FROM credentials').first<{ transports: string | null }>())?.transports).toBeNull();
  });
});

describe('sessions and the account', () => {
  it('GET /v1/account returns only the caller’s account', async () => {
    const a = await register();
    const b = await register();
    const res = await call('GET', '/v1/account', { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body.account.userHandle).toBe(a.account.userHandle);
    expect(JSON.stringify(res.body)).not.toContain(b.account.userHandle);
  });

  it('401s a missing, malformed, unknown or expired token', async () => {
    const device = await register();
    expect((await call('GET', '/v1/account')).status).toBe(401);
    expect((await call('GET', '/v1/account', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
    expect((await call('GET', '/v1/account', { token: 'short' })).status).toBe(401);
    const unknown = await call('GET', '/v1/account', { token: 'A'.repeat(43) });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('unauthorized');

    await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE user_id = ?').bind(Date.now() - 401 * DAY, device.account.userHandle).run();
    expect((await call('GET', '/v1/account', { token: device.token })).status).toBe(401);
  });

  it('writes last_used_at at most once a day', async () => {
    const device = await register();
    const lastUsed = () => env.DB.prepare('SELECT last_used_at AS t FROM sessions WHERE user_id = ?').bind(device.account.userHandle).first<{ t: number }>();
    const hourAgo = Date.now() - 3_600_000;
    await env.DB.prepare('UPDATE sessions SET last_used_at = ?').bind(hourAgo).run();
    await call('GET', '/v1/account', { token: device.token });
    expect((await lastUsed())?.t).toBe(hourAgo);

    await env.DB.prepare('UPDATE sessions SET last_used_at = ?').bind(Date.now() - 2 * DAY).run();
    await call('GET', '/v1/account', { token: device.token });
    expect(Date.now() - (await lastUsed())!.t).toBeLessThan(5_000);
  });

  it('logout deletes only this session', async () => {
    const device = await register();
    const other = await login(device.auth);
    const res = await call('POST', '/v1/auth/logout', { token: device.token, body: {} });
    expect(res.body).toEqual({ apiVersion: 1, ok: true });
    expect((await call('GET', '/v1/account', { token: device.token })).status).toBe(401);
    expect((await call('GET', '/v1/account', { token: other.token })).status).toBe(200);
  });

  it('revoke-others ends every other session of this user only', async () => {
    const a = await register();
    const aOther = await login(a.auth);
    const b = await register();
    expect((await call('POST', '/v1/sessions/revoke-others', { token: a.token, body: {} })).status).toBe(200);
    expect((await call('GET', '/v1/account', { token: aOther.token })).status).toBe(401);
    expect((await call('GET', '/v1/account', { token: a.token })).status).toBe(200);
    expect((await call('GET', '/v1/account', { token: b.token })).status).toBe(200);
  });

  it('DELETE /v1/account removes the user, passkeys, sessions and progress, and nobody else’s', async () => {
    const a = await register();
    await login(a.auth);
    await call('POST', '/v1/sync', { token: a.token, body: { changes: [{ id: 'x', type: 'add', at: Date.now(), items: { walks: ['osi_a'] } }] } });
    const b = await register();

    const res = await call('DELETE', '/v1/account', { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiVersion: 1, ok: true });
    const id = a.account.userHandle;
    expect(await count('users', 'id = ?', id)).toBe(0);
    expect(await count('credentials', 'user_id = ?', id)).toBe(0);
    expect(await count('sessions', 'user_id = ?', id)).toBe(0);
    expect(await count('progress', 'user_id = ?', id)).toBe(0);
    expect((await call('GET', '/v1/account', { token: a.token })).status).toBe(401);
    expect((await login(a.auth)).status).toBe(404);

    expect((await call('GET', '/v1/account', { token: b.token })).status).toBe(200);
    expect(await count('progress', 'user_id = ?', b.account.userHandle)).toBe(1);
  });
});
