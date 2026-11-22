/**
 * The backup server's JSON API (docs/sync-design.md, "Server API"). Each call either returns the parsed, validated
 * answer or throws a SyncHttpError (the server answered with an error) or a SyncNetworkError (no answer at all).
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/browser';
import { clockOffsetFrom, validateState, type Change, type SyncState } from './sync-model';

const BASE_URL = (import.meta.env.VITE_SYNC_URL ?? '').trim().replace(/\/+$/, '');

/** Backup exists in this build only when the server's URL was set at build time. */
export const SYNC_CONFIGURED = BASE_URL !== '';

export const REQUEST_TIMEOUT_MS = 20_000;
/** Retry-After is honoured up to a day; anything longer is treated as a day. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface Passkey {
  /** Full base64url credential id. */
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Backed up by its password manager (so it reaches the user's other devices). */
  synced: boolean;
  /** The password manager that saved it, from its AAGUID, when known. */
  provider: string | null;
}

export interface Account {
  userHandle: string;
  name: string;
  createdAt: number;
  passkeys: Passkey[];
}

/** The server answered with an error. `retryAfterMs` comes from Retry-After, or a default for the error code. */
export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  /** From a clock_skew answer's serverTime: the server's clock minus this device's. */
  readonly clockOffset: number | null;

  constructor({ status, code, message, retryAfterMs = null, clockOffset = null }: {
    status: number;
    code: string;
    message?: string;
    retryAfterMs?: number | null;
    clockOffset?: number | null;
  }) {
    super(message ?? `The backup server answered ${status} ${code}`);
    this.name = 'SyncHttpError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.clockOffset = clockOffset;
  }
}

/**
 * No answer: offline, a timeout, DNS, CORS or the connection dropping. Counts as offline only when the browser says
 * so (navigator.onLine === false); otherwise the backup service is unavailable.
 */
export class SyncNetworkError extends Error {
  readonly offline: boolean;
  readonly timedOut: boolean;

  constructor({ offline, timedOut, cause }: { offline: boolean; timedOut: boolean; cause?: unknown }) {
    super(timedOut ? 'The backup server took too long to answer' : 'Couldn’t reach the backup server', { cause });
    this.name = 'SyncNetworkError';
    this.offline = offline;
    this.timedOut = timedOut;
  }
}

export const isHttpError = (error: unknown, status?: number, code?: string): error is SyncHttpError =>
  error instanceof SyncHttpError && (status === undefined || error.status === status) && (code === undefined || error.code === code);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const badResponse = (status: number, what: string) => new SyncHttpError({ status, code: 'bad_response', message: `The backup server sent an unexpected answer (${what})` });

function msUntilUtcMidnight(now: number) {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.getTime() - now;
}

/**
 * Retry-After as milliseconds (seconds or an HTTP date), capped at a day. The header is only readable cross-origin if
 * the server exposes it (Access-Control-Expose-Headers), so known codes fall back to what the server would have sent.
 */
function retryAfterMs(response: Response, code: string, now: number): number | null {
  const header = response.headers.get('Retry-After')?.trim();
  let ms: number | null = null;
  if (header && /^\d+$/.test(header)) ms = Number(header) * 1000;
  else if (header && !Number.isNaN(Date.parse(header))) ms = Math.max(0, Date.parse(header) - now);
  else if (code === 'over_capacity') ms = msUntilUtcMidnight(now);
  else if (code === 'busy' && response.status === 503) ms = 5_000;
  return ms === null ? null : Math.min(ms, MAX_RETRY_AFTER_MS);
}

interface Answer {
  data: Json;
  startedAt: number;
  endedAt: number;
}

async function request(method: 'GET' | 'POST' | 'DELETE', path: string, { token, body }: { token?: string; body?: unknown } = {}): Promise<Answer> {
  if (!SYNC_CONFIGURED) throw new SyncNetworkError({ offline: false, timedOut: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Unauthenticated GETs send no custom headers, so they're CORS-simple and need no preflight request.
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const startedAt = Date.now();
  try {
    let response: Response;
    let data: unknown;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit'
      });
      // A body that isn't JSON is a bad answer, but a timeout while reading it is still a timeout.
      data = await response.json().catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        return null;
      });
    } catch (error) {
      throw new SyncNetworkError({ offline: navigator.onLine === false, timedOut: controller.signal.aborted, cause: error });
    }
    const endedAt = Date.now();
    if (!response.ok) {
      const error = isObject(data) && isObject(data.error) ? data.error : {};
      const code = typeof error.code === 'string' ? error.code : `http_${response.status}`;
      const serverTime = isObject(data) ? (isTime(data.serverTime) ? data.serverTime : isTime(error.serverTime) ? error.serverTime : null) : null;
      throw new SyncHttpError({
        status: response.status,
        code,
        message: typeof error.message === 'string' ? error.message : undefined,
        retryAfterMs: retryAfterMs(response, code, endedAt),
        clockOffset: serverTime === null ? null : clockOffsetFrom(serverTime, startedAt, endedAt)
      });
    }
    if (!isObject(data)) throw badResponse(response.status, 'not JSON');
    return { data, startedAt, endedAt };
  } finally {
    clearTimeout(timer);
  }
}

function parsePasskey(raw: unknown): Passkey | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !isTime(raw.createdAt)) return null;
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    lastUsedAt: isTime(raw.lastUsedAt) ? raw.lastUsedAt : null,
    synced: raw.synced === true,
    provider: typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : null
  };
}

function parseAccount(raw: unknown): Account {
  if (!isObject(raw) || typeof raw.userHandle !== 'string' || typeof raw.name !== 'string' || !Array.isArray(raw.passkeys)) throw badResponse(200, 'account');
  return {
    userHandle: raw.userHandle,
    name: raw.name,
    createdAt: isTime(raw.createdAt) ? raw.createdAt : 0,
    passkeys: raw.passkeys.flatMap((passkey) => parsePasskey(passkey) ?? [])
  };
}

function parseState(raw: unknown): SyncState {
  const state = validateState(raw);
  if (!state) throw badResponse(200, 'state');
  return state;
}

function clockOffsetOf({ data, startedAt, endedAt }: Answer) {
  if (!isTime(data.serverTime)) throw badResponse(200, 'serverTime');
  return clockOffsetFrom(data.serverTime, startedAt, endedAt);
}

export interface CeremonyOptions<T> {
  challengeId: string;
  options: T;
}

function parseOptions<T>({ data }: Answer): CeremonyOptions<T> {
  if (typeof data.challengeId !== 'string' || !isObject(data.options) || typeof data.options.challenge !== 'string') throw badResponse(200, 'options');
  return { challengeId: data.challengeId, options: data.options as T };
}

/** A new or restored session: the server's state is held by the caller until it's applied. */
export interface SignIn {
  token: string;
  account: Account;
  state: SyncState;
  clockOffset: number;
}

function parseSignIn(answer: Answer): SignIn {
  const { data } = answer;
  if (typeof data.token !== 'string' || data.token === '') throw badResponse(200, 'token');
  return { token: data.token, account: parseAccount(data.account), state: parseState(data.state), clockOffset: clockOffsetOf(answer) };
}

export async function fetchRegisterOptions(): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
  return parseOptions(await request('GET', '/v1/auth/register/options'));
}

export async function verifyRegistration(challengeId: string, response: RegistrationResponseJSON): Promise<SignIn> {
  return parseSignIn(await request('POST', '/v1/auth/register/verify', { body: { challengeId, response } }));
}

export async function fetchLoginOptions(): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON>> {
  return parseOptions(await request('GET', '/v1/auth/login/options'));
}

export async function verifyLogin(challengeId: string, response: AuthenticationResponseJSON): Promise<SignIn> {
  return parseSignIn(await request('POST', '/v1/auth/login/verify', { body: { challengeId, response } }));
}

export async function fetchReauthOptions(token: string): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON>> {
  return parseOptions(await request('POST', '/v1/auth/reauth/options', { token, body: {} }));
}

export async function verifyReauth(token: string, challengeId: string, response: AuthenticationResponseJSON): Promise<void> {
  await request('POST', '/v1/auth/reauth/verify', { token, body: { challengeId, response } });
}

export async function fetchPasskeyOptions(token: string): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
  return parseOptions(await request('POST', '/v1/passkeys/options', { token, body: {} }));
}

export async function verifyPasskey(token: string, challengeId: string, response: RegistrationResponseJSON): Promise<Account> {
  return parseAccount((await request('POST', '/v1/passkeys/verify', { token, body: { challengeId, response } })).data.account);
}

export async function deletePasskey(token: string, id: string): Promise<Account> {
  return parseAccount((await request('DELETE', `/v1/passkeys/${encodeURIComponent(id)}`, { token })).data.account);
}

export async function revokeOtherSessions(token: string): Promise<void> {
  await request('POST', '/v1/sessions/revoke-others', { token, body: {} });
}

export async function fetchAccount(token: string): Promise<Account> {
  return parseAccount((await request('GET', '/v1/account', { token })).data.account);
}

export interface PushResult {
  state: SyncState;
  clockOffset: number;
  rejected: Array<{ id: string; code: string }>;
}

/** POST /v1/sync: sends queued changes (or none, to fetch the latest state) and returns the merged state. */
export async function pushChanges(token: string, changes: readonly Change[]): Promise<PushResult> {
  const answer = await request('POST', '/v1/sync', { token, body: { changes } });
  const { data } = answer;
  if (!Array.isArray(data.rejected)) throw badResponse(200, 'rejected');
  const rejected = data.rejected.flatMap((entry) =>
    isObject(entry) && typeof entry.id === 'string' && typeof entry.code === 'string' ? [{ id: entry.id, code: entry.code }] : []);
  return { state: parseState(data.state), clockOffset: clockOffsetOf(answer), rejected };
}

export async function logout(token: string): Promise<void> {
  await request('POST', '/v1/auth/logout', { token, body: {} });
}

export async function deleteAccount(token: string): Promise<void> {
  await request('DELETE', '/v1/account', { token });
}
