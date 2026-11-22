/** Random tokens, hashing and the stateless WebAuthn challenges (docs/sync-design.md, "Stateless challenges"). */
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { HttpError } from './http';

export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function randomBase64url(byteLength: number): string {
  return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return isoBase64URL.fromBuffer(new Uint8Array(digest));
}

/** No 0/O, 1/I: the code appears in passkey names people read in their password manager. 32 symbols, so unbiased. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Challenges: options calls write nothing to D1. The challenge travels to the client inside a signed challengeId and
// comes back with the verify call; used_challenges then makes it single use.

export type ChallengePurpose = 'register' | 'login' | 'reauth' | 'add';

export interface ChallengePayload {
  purpose: ChallengePurpose;
  issuedAt: number;
  /** The WebAuthn challenge (base64url), as sent in the options. */
  challenge: string;
  /** reauth and add: the session's user; register: the new user handle. */
  userId?: string;
  /** register and add: the account name. */
  userName?: string;
}

/** Options may be prefetched up to 4 minutes before the tap, then the passkey prompt can take 5. */
export const CHALLENGE_TTL_MS = 10 * 60_000;
const MAX_CHALLENGE_ID_LENGTH = 1024;
const MIN_KEY_LENGTH = 32;

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(secret: string | undefined): Promise<CryptoKey> {
  // A configuration error, not bad input: it surfaces as a logged 500.
  if (!secret || secret.length < MIN_KEY_LENGTH) throw new Error(`CHALLENGE_KEY is missing or shorter than ${MIN_KEY_LENGTH} characters`);
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

export async function signChallenge(secret: string | undefined, payload: ChallengePayload): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(payload)) as Uint8Array<ArrayBuffer>;
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), body);
  return `${isoBase64URL.fromBuffer(body)}.${isoBase64URL.fromBuffer(new Uint8Array(mac))}`;
}

function invalidChallenge(message: string): HttpError {
  return new HttpError(400, 'challenge_invalid', message);
}

/**
 * Checks a challengeId's MAC, purpose, age and (for reauth and add) user, and returns its payload. Doesn't mark it
 * used: the caller does that in the same D1 batch as the ceremony's writes, so a failed write can be retried.
 */
export async function openChallenge(
  secret: string | undefined,
  challengeId: unknown,
  purpose: ChallengePurpose,
  now: number,
  sessionUserId?: string
): Promise<ChallengePayload> {
  if (typeof challengeId !== 'string' || challengeId.length > MAX_CHALLENGE_ID_LENGTH) throw invalidChallenge('challengeId is missing or malformed.');
  const [body, mac, extra] = challengeId.split('.');
  if (!body || !mac || extra !== undefined || !BASE64URL_PATTERN.test(body) || !BASE64URL_PATTERN.test(mac)) {
    throw invalidChallenge('challengeId is malformed.');
  }
  const bodyBytes = isoBase64URL.toBuffer(body);
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), isoBase64URL.toBuffer(mac), bodyBytes);
  if (!valid) throw invalidChallenge('challengeId was not issued by this server.');

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as ChallengePayload;
  } catch {
    throw invalidChallenge('challengeId is malformed.');
  }
  if (payload.purpose !== purpose) throw invalidChallenge(`This challenge is for ${String(payload.purpose)}, not ${purpose}.`);
  const age = now - payload.issuedAt;
  // A challenge "from the future" can only come from a server with a different clock; allow a little skew.
  if (!(age <= CHALLENGE_TTL_MS && age >= -60_000)) {
    throw new HttpError(400, 'challenge_expired', 'This request expired (over 10 minutes old). Please try again.');
  }
  if ((purpose === 'reauth' || purpose === 'add') && payload.userId !== sessionUserId) {
    throw invalidChallenge('This challenge was issued to a different account.');
  }
  return payload;
}
