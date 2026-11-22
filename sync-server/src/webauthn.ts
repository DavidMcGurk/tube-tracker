/** Passkey ceremonies via @simplewebauthn/server (docs/sync-design.md, "WebAuthn"). */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { BASE64URL_PATTERN } from './crypto';
import { parseTransports, type CredentialRow } from './db';
import { listSetting, type Env } from './env';
import { HttpError, isObject } from './http';

const RP_NAME = 'Tube Tracker';
const ALGORITHMS = [-7, -257]; // ES256, RS256
const CEREMONY_TIMEOUT_MS = 300_000;
export const MAX_PASSKEYS = 10;

export function registrationOptions(env: Env, user: { id: string; name: string }, existing: readonly CredentialRow[]): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: env.RP_ID,
    userName: user.name,
    userDisplayName: user.name,
    userID: isoBase64URL.toBuffer(user.id),
    attestationType: 'none',
    // A fresh object each time: the library writes requireResidentKey into it.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    supportedAlgorithmIDs: ALGORITHMS,
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: existing.map((row) => ({ id: row.id, transports: parseTransports(row.transports) }))
  });
}

/** Without allowCredentials (sign-in), the browser offers every passkey it holds for the RP. */
export function authenticationOptions(env: Env, allow?: readonly CredentialRow[]): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: env.RP_ID,
    userVerification: 'preferred',
    timeout: CEREMONY_TIMEOUT_MS,
    allowCredentials: allow?.map((row) => ({ id: row.id, transports: parseTransports(row.transports) }))
  });
}

function malformed(what: string): HttpError {
  return new HttpError(400, 'bad_request', `The passkey response is malformed: ${what}.`);
}

function base64url(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !BASE64URL_PATTERN.test(value)) throw malformed(what);
  return value;
}

/*
 * What one passkey may store, so MAX_USERS can be sized from the worst case (docs/sync-design.md, "Caps"). WebAuthn
 * allows credential ids of up to 1,023 bytes, but passkeys (discoverable credentials, which registration requires) use
 * 16 to 64: ids are capped at 342 base64url characters (256 bytes). A public key is at most 600 bytes of COSE (RS256
 * with a 4,096-bit key is about 530; ES256 is 77).
 */
export const MAX_ID_LENGTH = 342;
const MAX_PUBLIC_KEY_BYTES = 600;
const MAX_DATA_LENGTH = 12_000;
/** Transports a browser may report; anything else is dropped rather than stored. */
const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set(['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal', 'cable']);

function credentialBasics(raw: unknown): { id: string; rawId: string; response: Record<string, unknown>; authenticatorAttachment?: 'platform' | 'cross-platform' } {
  if (!isObject(raw)) throw malformed('missing');
  if (raw.type !== 'public-key') throw malformed('type');
  const id = base64url(raw.id, 'id', MAX_ID_LENGTH);
  const rawId = base64url(raw.rawId, 'rawId', MAX_ID_LENGTH);
  if (!isObject(raw.response)) throw malformed('response');
  const attachment = raw.authenticatorAttachment;
  return {
    id,
    rawId,
    response: raw.response,
    ...(attachment === 'platform' || attachment === 'cross-platform' ? { authenticatorAttachment: attachment } : {})
  };
}

/**
 * Copies only the fields the server uses from a browser's registration response. Other fields are ignored rather
 * than rejected here: browsers add to this JSON over time, and it isn't the API's own shape.
 */
export function parseRegistrationResponse(raw: unknown): RegistrationResponseJSON {
  const { id, rawId, response, authenticatorAttachment } = credentialBasics(raw);
  // Only known transports, each once: they're stored with the passkey and only ever hint which way to reach it.
  const transports = Array.isArray(response.transports)
    ? [...new Set(response.transports.filter((item): item is string => typeof item === 'string' && KNOWN_TRANSPORTS.has(item)))]
    : [];
  return {
    id,
    rawId,
    type: 'public-key',
    clientExtensionResults: {},
    ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
    response: {
      clientDataJSON: base64url(response.clientDataJSON, 'clientDataJSON', MAX_DATA_LENGTH),
      attestationObject: base64url(response.attestationObject, 'attestationObject', MAX_DATA_LENGTH),
      ...(transports.length > 0 ? { transports } : {})
    }
  };
}

export function parseAuthenticationResponse(raw: unknown): AuthenticationResponseJSON {
  const { id, rawId, response, authenticatorAttachment } = credentialBasics(raw);
  const userHandle = response.userHandle;
  return {
    id,
    rawId,
    type: 'public-key',
    clientExtensionResults: {},
    ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
    response: {
      clientDataJSON: base64url(response.clientDataJSON, 'clientDataJSON', MAX_DATA_LENGTH),
      authenticatorData: base64url(response.authenticatorData, 'authenticatorData', MAX_DATA_LENGTH),
      signature: base64url(response.signature, 'signature', MAX_DATA_LENGTH),
      ...(userHandle === undefined || userHandle === null ? {} : { userHandle: base64url(userHandle, 'userHandle', 200) })
    }
  };
}

function verificationFailed(err?: unknown): HttpError {
  const detail = err instanceof Error ? `: ${err.message.slice(0, 200)}` : '.';
  return new HttpError(400, 'verification_failed', `The passkey response could not be verified${detail}`);
}

export async function verifyRegistration(env: Env, response: RegistrationResponseJSON, expectedChallenge: string) {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: listSetting(env.EXPECTED_ORIGINS),
      expectedRPID: env.RP_ID,
      // Acceptable for this data: sensitive actions need a fresh ceremony instead ("✓ recent").
      requireUserVerification: false,
      supportedAlgorithmIDs: ALGORITHMS
    });
  } catch (err) {
    throw verificationFailed(err);
  }
  if (!verification.verified) throw verificationFailed();
  const info = verification.registrationInfo;
  // The id stored is the one inside the signed authenticator data. It must be the one the browser reported, which the
  // length cap applies to, or a client could store an id of any length.
  if (info.credential.id !== response.id) throw malformed('id');
  if (info.credential.publicKey.byteLength > MAX_PUBLIC_KEY_BYTES) throw malformed('public key');
  return info;
}

export async function verifyAuthentication(env: Env, response: AuthenticationResponseJSON, expectedChallenge: string, credential: CredentialRow) {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: listSetting(env.EXPECTED_ORIGINS),
      expectedRPID: env.RP_ID,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.counter,
        transports: parseTransports(credential.transports)
      },
      requireUserVerification: false
    });
  } catch (err) {
    throw verificationFailed(err);
  }
  if (!verification.verified) throw verificationFailed();
  return verification.authenticationInfo;
}

/** The assertion must name the passkey's own user: a passkey saved for one backup can't open another. */
export function requireUserHandle(response: AuthenticationResponseJSON, credential: CredentialRow): void {
  const handle = response.response.userHandle;
  if (!handle || isoBase64URL.trimPadding(handle) !== credential.user_id) {
    throw new HttpError(400, 'user_mismatch', 'This passkey belongs to a different backup.');
  }
}
