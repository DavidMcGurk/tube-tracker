/** Calls the Worker directly (so tests can swap bindings) and drives whole passkey flows with the software authenticator. */
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { SoftAuthenticator, TEST_ORIGIN } from './authenticator';

export { TEST_ORIGIN };

export interface CallOptions {
  /** JSON-encoded unless it's already a string. */
  body?: unknown;
  token?: string;
  /** Defaults to the app's origin; null sends no Origin header. */
  origin?: string | null;
  headers?: Record<string, string>;
  /** Bindings to replace, e.g. a failing DB or MAX_USERS. */
  env?: Partial<Env>;
}

export interface CallResult {
  status: number;
  headers: Headers;
  /** Parsed JSON; checked field by field. */
  body: any;
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as Env), ...overrides };
}

export async function call(method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
  if (origin !== null) headers.set('Origin', origin);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  const request = new Request(`https://sync.example.test${path}`, { method, headers, body });
  const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], testEnv(options.env));
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

export interface Device {
  token: string;
  auth: SoftAuthenticator;
  account: any;
}

/** Turns backup on with a new passkey. */
export async function register(auth = new SoftAuthenticator()): Promise<Device> {
  const options = await call('GET', '/v1/auth/register/options');
  expect(options.status).toBe(200);
  const response = await auth.create(options.body.options);
  const verify = await call('POST', '/v1/auth/register/verify', { body: { challengeId: options.body.challengeId, response } });
  expect(verify.status, JSON.stringify(verify.body)).toBe(200);
  return { token: verify.body.token, auth, account: verify.body.account };
}

/** Restores with a discoverable passkey. */
export async function login(auth: SoftAuthenticator): Promise<CallResult & { token: string }> {
  const options = await call('GET', '/v1/auth/login/options');
  expect(options.status).toBe(200);
  const response = await auth.get(options.body.options);
  const verify = await call('POST', '/v1/auth/login/verify', { body: { challengeId: options.body.challengeId, response } });
  return { ...verify, token: verify.body?.token };
}

/** "Confirm it's you" on an existing session. */
export async function reauth(device: Device, auth = device.auth): Promise<CallResult> {
  const options = await call('POST', '/v1/auth/reauth/options', { token: device.token, body: {} });
  expect(options.status).toBe(200);
  const response = await auth.get(options.body.options);
  return call('POST', '/v1/auth/reauth/verify', { token: device.token, body: { challengeId: options.body.challengeId, response } });
}

/** Ages a session's last ceremony so "✓ recent" endpoints refuse it. */
export async function makeNotRecent(device: Device): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET verified_at = ? WHERE user_id = ?').bind(Date.now() - 6 * 60_000, device.account.userHandle).run();
}

export async function clearDatabase(): Promise<void> {
  await env.DB.batch(['users', 'credentials', 'sessions', 'used_challenges', 'progress'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

export async function count(table: string, where = '1', ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Decodes a challengeId's payload (tests only: the server never trusts it without the MAC). */
export function challengePayload(challengeId: string): Record<string, unknown> {
  const [body] = challengeId.split('.');
  const binary = atob(body!.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
}

let changeCounter = 0;
export function changeId(): string {
  changeCounter += 1;
  return `c${changeCounter}_${crypto.randomUUID().slice(0, 8)}`;
}
