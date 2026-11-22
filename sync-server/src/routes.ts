/** Passkey, session and account endpoints (docs/sync-design.md, "Endpoints"). Sync lives in sync.ts. */
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { emptyState } from '../../src/lib/sync-model';
import { BASE64URL_PATTERN, openChallenge, randomBase64url, randomCode, signChallenge, type ChallengePayload, type ChallengePurpose } from './crypto';
import { accountView, loadAccount, selectCredentials, selectUser, uniqueViolation, type CredentialRow, type UserRow } from './db';
import type { Env } from './env';
import { HttpError, MAX_BODY_BYTES, expectFields, json, readJson, secondsUntilUtcMidnight } from './http';
import { clientNetworkKey, enforceRateLimit } from './rate-limit';
import { authenticate, newSession, requireRecent, unauthorized, type Session } from './sessions';
import { handleSync, parseStoredState } from './sync';
import {
  MAX_ID_LENGTH,
  MAX_PASSKEYS,
  authenticationOptions,
  parseAuthenticationResponse,
  parseRegistrationResponse,
  registrationOptions,
  requireUserHandle,
  verifyAuthentication,
  verifyRegistration
} from './webauthn';

export interface Context {
  request: Request;
  env: Env;
  /** One clock reading per request. */
  now: number;
  params: Record<string, string>;
}

type Auth = 'none' | 'session' | 'recent';
type Handler = (c: Context, session: Session) => Promise<Response>;

export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  auth: Auth;
  /** Unauthenticated passkey endpoints share a per-network rate limit. */
  limitByNetwork?: boolean;
  handler: Handler;
}

const DEFAULT_MAX_USERS = 2_500;
const DEFAULT_MAX_NEW_USERS_PER_DAY = 200;
const DAY_MS = 86_400_000;

export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/v1/health', auth: 'none', handler: async () => json({ ok: true }) },
  { method: 'GET', path: '/v1/auth/register/options', auth: 'none', limitByNetwork: true, handler: registerOptions },
  { method: 'POST', path: '/v1/auth/register/verify', auth: 'none', limitByNetwork: true, handler: registerVerify },
  { method: 'GET', path: '/v1/auth/login/options', auth: 'none', limitByNetwork: true, handler: loginOptions },
  { method: 'POST', path: '/v1/auth/login/verify', auth: 'none', limitByNetwork: true, handler: loginVerify },
  { method: 'POST', path: '/v1/auth/reauth/options', auth: 'session', handler: reauthOptions },
  { method: 'POST', path: '/v1/auth/reauth/verify', auth: 'session', handler: reauthVerify },
  { method: 'POST', path: '/v1/passkeys/options', auth: 'recent', handler: addPasskeyOptions },
  // ✓ recent when the ceremony started (its challenge was issued), however long the user took: see addPasskeyVerify.
  { method: 'POST', path: '/v1/passkeys/verify', auth: 'session', handler: addPasskeyVerify },
  { method: 'DELETE', path: '/v1/passkeys/:id', auth: 'recent', handler: removePasskey },
  { method: 'POST', path: '/v1/sessions/revoke-others', auth: 'recent', handler: revokeOtherSessions },
  { method: 'GET', path: '/v1/account', auth: 'session', handler: getAccount },
  { method: 'POST', path: '/v1/sync', auth: 'session', handler: (c, session) => handleSync(c.request, c.env, session, c.now) },
  { method: 'POST', path: '/v1/auth/logout', auth: 'session', handler: logout },
  { method: 'DELETE', path: '/v1/account', auth: 'recent', handler: deleteAccount }
];

/** Runs a route's guards (rate limit, session, recent ceremony), then its handler. */
export async function runRoute(route: Route, c: Context): Promise<Response> {
  if (route.limitByNetwork) await enforceRateLimit(c.env, c.env.AUTH_RATE_LIMITER, clientNetworkKey(c.request));
  if (route.auth === 'none') return route.handler(c, NO_SESSION);
  const session = await authenticate(c.request, c.env, c.now);
  if (route.auth === 'recent') requireRecent(session, c.now);
  return route.handler(c, session);
}

const NO_SESSION: Session = { tokenHash: '', userId: '', verifiedAt: null };

// ---------------------------------------------------------------------------------------------------------------
// Turning backup on

async function registerOptions(c: Context): Promise<Response> {
  const userId = randomBase64url(32);
  const userName = `Tube Tracker · ${randomCode(4)}`;
  const options = await registrationOptions(c.env, { id: userId, name: userName }, []);
  return challengeResponse(c, { purpose: 'register', issuedAt: c.now, challenge: options.challenge, userId, userName }, options);
}

async function registerVerify(c: Context): Promise<Response> {
  const { env, now } = c;
  const { challenge, response } = await readCeremony(c, 'register');
  const { userId, userName } = challenge;
  if (!userId || !userName) throw new HttpError(400, 'challenge_invalid', 'This challenge has no account details.');
  await requireRegistrationsOpen(env, now);
  const info = await verifyRegistration(env, parseRegistrationResponse(response), challenge.challenge);

  const user: UserRow = { id: userId, name: userName, created_at: now };
  const credential = credentialRow(userId, info, now);
  const session = await newSession(env.DB, userId, now);
  const state = emptyState();
  await ceremonyBatch(env.DB, challenge, now, [
    env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(user.id, user.name, user.created_at),
    insertCredential(env.DB, credential),
    ...session.statements,
    env.DB.prepare('INSERT INTO progress (user_id, state, version, updated_at) VALUES (?, ?, 1, ?)').bind(userId, JSON.stringify(state), now)
  ]);
  return json({ token: session.token, account: accountView(user, [credential]), state, serverTime: now });
}

/** A whole-number setting from wrangler.jsonc, or `fallback` when it's unset or not a number. */
function countSetting(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function requireRegistrationsOpen(env: Env, now: number): Promise<void> {
  const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM users) AS total, (SELECT COUNT(*) FROM users WHERE created_at >= ?) AS today')
    .bind(Math.floor(now / DAY_MS) * DAY_MS)
    .first<{ total: number; today: number }>();
  const total = counts?.total ?? 0;
  const today = counts?.today ?? 0;
  if (total >= countSetting(env.MAX_USERS, DEFAULT_MAX_USERS)) {
    throw new HttpError(503, 'registrations_closed', 'New backups are paused right now.');
  }
  if (today >= countSetting(env.MAX_NEW_USERS_PER_DAY, DEFAULT_MAX_NEW_USERS_PER_DAY)) {
    throw new HttpError(503, 'registrations_closed', 'New backups are paused until tomorrow.', secondsUntilUtcMidnight(now));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Restoring (sign-in with a discoverable passkey)

async function loginOptions(c: Context): Promise<Response> {
  const options = await authenticationOptions(c.env);
  return challengeResponse(c, { purpose: 'login', issuedAt: c.now, challenge: options.challenge }, options);
}

async function loginVerify(c: Context): Promise<Response> {
  const { env, now } = c;
  const { challenge, response: raw } = await readCeremony(c, 'login');
  const response = parseAuthenticationResponse(raw);
  const credential = await env.DB.prepare('SELECT * FROM credentials WHERE id = ?').bind(response.id).first<CredentialRow>();
  if (!credential) throw unknownCredential();
  requireUserHandle(response, credential);
  const info = await verifyAuthentication(env, response, challenge.challenge, credential);

  const session = await newSession(env.DB, credential.user_id, now);
  const results = await ceremonyBatch(env.DB, challenge, now, [
    updateCredentialUse(env.DB, credential.id, info, now),
    ...session.statements,
    selectUser(env.DB, credential.user_id),
    selectCredentials(env.DB, credential.user_id),
    env.DB.prepare('SELECT state FROM progress WHERE user_id = ?').bind(credential.user_id)
  ]);
  const [users, credentials, progress] = results.slice(-3);
  const user = users?.results[0] as UserRow | undefined;
  if (!user) {
    // A passkey left behind by a deleted account (can't normally happen: deletes are one batch).
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(credential.user_id).run();
    throw unknownCredential();
  }
  const stored = (progress?.results[0] as { state: string } | undefined)?.state;
  return json({
    token: session.token,
    account: accountView(user, (credentials?.results ?? []) as CredentialRow[]),
    state: parseStoredState(stored),
    serverTime: now
  });
}

function unknownCredential(): HttpError {
  return new HttpError(404, 'unknown_credential', "That passkey isn't linked to a backup any more.");
}

// ---------------------------------------------------------------------------------------------------------------
// Confirming it's you (reauth), for "✓ recent" endpoints

async function reauthOptions(c: Context, session: Session): Promise<Response> {
  expectFields(await readJson(c.request, MAX_BODY_BYTES), []);
  const { results } = await selectCredentials(c.env.DB, session.userId).all<CredentialRow>();
  const options = await authenticationOptions(c.env, results);
  return challengeResponse(c, { purpose: 'reauth', issuedAt: c.now, challenge: options.challenge, userId: session.userId }, options);
}

async function reauthVerify(c: Context, session: Session): Promise<Response> {
  const { env, now } = c;
  const { challenge, response: raw } = await readCeremony(c, 'reauth', session.userId);
  const response = parseAuthenticationResponse(raw);
  const credential = await env.DB.prepare('SELECT * FROM credentials WHERE id = ?').bind(response.id).first<CredentialRow>();
  if (!credential) throw unknownCredential();
  if (credential.user_id !== session.userId) throw new HttpError(400, 'user_mismatch', 'This passkey belongs to a different backup.');
  requireUserHandle(response, credential);
  const info = await verifyAuthentication(env, response, challenge.challenge, credential);
  await ceremonyBatch(env.DB, challenge, now, [
    updateCredentialUse(env.DB, credential.id, info, now),
    env.DB.prepare('UPDATE sessions SET verified_at = ? WHERE token_hash = ?').bind(now, session.tokenHash)
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Passkeys

async function addPasskeyOptions(c: Context, session: Session): Promise<Response> {
  expectFields(await readJson(c.request, MAX_BODY_BYTES), []);
  const { user, credentials } = await requireAccount(c.env.DB, session);
  requirePasskeyRoom(credentials);
  const options = await registrationOptions(c.env, user, credentials);
  return challengeResponse(c, { purpose: 'add', issuedAt: c.now, challenge: options.challenge, userId: user.id, userName: user.name }, options);
}

async function addPasskeyVerify(c: Context, session: Session): Promise<Response> {
  const { env, now } = c;
  const { challenge, response } = await readCeremony(c, 'add', session.userId);
  // An add challenge is only issued to a recently verified session (passkeys/options), and creating the passkey can take
  // minutes (another device, a security key). So "recent" is measured to when the challenge was issued, not to now: a
  // ceremony that started in time isn't refused at the end, leaving a passkey the server never saved.
  requireRecent(session, challenge.issuedAt);
  const { user, credentials } = await requireAccount(env.DB, session);
  requirePasskeyRoom(credentials);
  const info = await verifyRegistration(env, parseRegistrationResponse(response), challenge.challenge);
  const credential = credentialRow(user.id, info, now);
  const [, inserted] = await ceremonyBatch(env.DB, challenge, now, [insertCredential(env.DB, credential)]);
  // The backup was deleted (on another device) since this request began, so nothing was added.
  if (inserted?.meta.changes !== 1) throw unauthorized();
  return json({ account: accountView(user, [...credentials, credential]) });
}

function requirePasskeyRoom(credentials: readonly CredentialRow[]): void {
  if (credentials.length >= MAX_PASSKEYS) throw new HttpError(409, 'too_many_passkeys', `A backup can have at most ${MAX_PASSKEYS} passkeys.`);
}

async function removePasskey(c: Context, session: Session): Promise<Response> {
  const { env } = c;
  const id = c.params.id ?? '';
  if (id.length > MAX_ID_LENGTH || !BASE64URL_PATTERN.test(id)) throw new HttpError(404, 'not_found', 'No such passkey on this backup.');
  const { user, credentials } = await requireAccount(env.DB, session);
  if (!credentials.some((row) => row.id === id)) throw new HttpError(404, 'not_found', 'No such passkey on this backup.');
  if (credentials.length <= 1) throw lastPasskey();

  // Both statements re-check in the transaction, so a concurrent removal can't take away the last passkey, and other
  // devices are only signed out if the passkey really went.
  const [removed] = await env.DB.batch([
    env.DB.prepare('DELETE FROM credentials WHERE id = ?1 AND user_id = ?2 AND (SELECT COUNT(*) FROM credentials WHERE user_id = ?2) > 1').bind(id, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2 AND NOT EXISTS (SELECT 1 FROM credentials WHERE id = ?3)')
      .bind(user.id, session.tokenHash, id)
  ]);
  if (removed?.meta.changes !== 1) throw lastPasskey();
  return json({ account: accountView(user, credentials.filter((row) => row.id !== id)) });
}

function lastPasskey(): HttpError {
  return new HttpError(409, 'last_passkey', "A backup's only passkey can't be removed. Add another first.");
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and the account

async function revokeOtherSessions(c: Context, session: Session): Promise<Response> {
  expectFields(await readJson(c.request, MAX_BODY_BYTES), []);
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(session.userId, session.tokenHash).run();
  return json({ ok: true });
}

async function getAccount(c: Context, session: Session): Promise<Response> {
  const { user, credentials } = await requireAccount(c.env.DB, session);
  return json({ account: accountView(user, credentials) });
}

async function logout(c: Context, session: Session): Promise<Response> {
  expectFields(await readJson(c.request, MAX_BODY_BYTES), []);
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
  return json({ ok: true });
}

/**
 * Deletes the backup for every device, in one transaction. used_challenges rows aren't linked to users (they hold
 * only random challenges) and go within a day with the cron cleanup.
 */
async function deleteAccount(c: Context, session: Session): Promise<Response> {
  const { DB } = c.env;
  await DB.batch([
    DB.prepare('DELETE FROM credentials WHERE user_id = ?').bind(session.userId),
    DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(session.userId),
    DB.prepare('DELETE FROM progress WHERE user_id = ?').bind(session.userId),
    DB.prepare('DELETE FROM users WHERE id = ?').bind(session.userId)
  ]);
  return json({ ok: true });
}

async function requireAccount(db: D1Database, session: Session): Promise<{ user: UserRow; credentials: CredentialRow[] }> {
  const account = await loadAccount(db, session.userId);
  if (!account) throw unauthorized();
  return account;
}

// ---------------------------------------------------------------------------------------------------------------
// Ceremony helpers

async function challengeResponse(c: Context, payload: ChallengePayload, options: object): Promise<Response> {
  const challengeId = await signChallenge(c.env.CHALLENGE_KEY, payload);
  return json({ challengeId, options });
}

/** The body of every verify call: `{ challengeId, response }`, with the challenge checked (but not yet used). */
async function readCeremony(c: Context, purpose: ChallengePurpose, sessionUserId?: string): Promise<{ challenge: ChallengePayload; response: unknown }> {
  const body = await readJson(c.request, MAX_BODY_BYTES);
  expectFields(body, ['challengeId', 'response']);
  const challenge = await openChallenge(c.env.CHALLENGE_KEY, body.challengeId, purpose, c.now, sessionUserId);
  return { challenge, response: body.response };
}

/**
 * Marks the challenge used in the same transaction as the ceremony's writes: if any write fails, the challenge stays
 * unused, so the client can retry the same body after a network error or a 5xx.
 */
async function ceremonyBatch(db: D1Database, challenge: ChallengePayload, now: number, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await db.batch([
      db.prepare('INSERT INTO used_challenges (challenge, created_at) VALUES (?, ?)').bind(challenge.challenge, now),
      ...statements
    ]);
  } catch (err) {
    const constraint = uniqueViolation(err);
    if (constraint === 'used_challenges.challenge') throw new HttpError(400, 'challenge_used', 'This request has already been used. Please try again.');
    if (constraint === 'credentials.id') throw new HttpError(409, 'already_registered', 'This passkey is already registered.');
    throw err;
  }
}

type RegistrationInfo = Awaited<ReturnType<typeof verifyRegistration>>;
type AuthenticationInfo = Awaited<ReturnType<typeof verifyAuthentication>>;

function credentialRow(userId: string, info: RegistrationInfo, now: number): CredentialRow {
  return {
    id: info.credential.id,
    user_id: userId,
    public_key: isoBase64URL.fromBuffer(info.credential.publicKey),
    counter: info.credential.counter,
    transports: info.credential.transports ? JSON.stringify(info.credential.transports) : null,
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp ? 1 : 0,
    aaguid: info.aaguid,
    created_at: now,
    last_used_at: null
  };
}

/**
 * No ON CONFLICT: a duplicate id is an error (already_registered), never a silent overwrite of someone's passkey. Only
 * for a user that exists (inserted earlier in the same batch, when turning on): a passkey added while the backup was
 * being deleted on another device inserts nothing, rather than a row no user can reach.
 */
function insertCredential(db: D1Database, row: CredentialRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, created_at, last_used_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)`
  ).bind(row.id, row.user_id, row.public_key, row.counter, row.transports, row.device_type, row.backed_up, row.aaguid, row.created_at, row.last_used_at);
}

function updateCredentialUse(db: D1Database, id: string, info: AuthenticationInfo, now: number): D1PreparedStatement {
  return db.prepare('UPDATE credentials SET counter = ?, backed_up = ?, device_type = ?, last_used_at = ? WHERE id = ?')
    .bind(info.newCounter, info.credentialBackedUp ? 1 : 0, info.credentialDeviceType, now, id);
}
