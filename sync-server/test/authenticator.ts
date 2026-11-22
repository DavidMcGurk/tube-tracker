/**
 * A software passkey authenticator for tests: ES256 keys from WebCrypto, 'none' attestation, discoverable credentials
 * with user handles. It builds the same JSON a browser (via @simplewebauthn/browser) would send, so the server's real
 * verification runs end to end.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/server';

export const TEST_ORIGIN = 'http://localhost:5173';
export const ICLOUD_AAGUID = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface StoredPasskey {
  id: string;
  rpId: string;
  userHandle: string;
  keyPair: CryptoKeyPair;
  counter: number;
}

export interface AuthenticatorOptions {
  origin?: string;
  /** Synced passkeys set BE and BS (iCloud Keychain, Google Password Manager). Default false, like Playwright's. */
  synced?: boolean;
  aaguid?: string;
  /** Default true. Some providers never count, always sending 0. */
  counts?: boolean;
}

export class SoftAuthenticator {
  readonly passkeys: StoredPasskey[] = [];
  readonly origin: string;

  constructor(readonly options: AuthenticatorOptions = {}) {
    this.origin = options.origin ?? TEST_ORIGIN;
  }

  /**
   * navigator.credentials.create(). `reuse` re-attests an existing passkey (same id and key), to test duplicates. The
   * rest build responses no real authenticator would, to test what the server stores: a credential id of `idBytes`
   * bytes (default 16), a different id reported in the JSON (`responseId`), a public key padded with `keyPadding`
   * bytes under an unknown COSE label, and the given `transports`.
   */
  async create(options: PublicKeyCredentialCreationOptionsJSON, overrides: {
    origin?: string;
    reuse?: StoredPasskey;
    idBytes?: number;
    responseId?: string;
    keyPadding?: number;
    transports?: unknown;
  } = {}): Promise<RegistrationResponseJSON> {
    const rpId = options.rp.id ?? 'localhost';
    const passkey: StoredPasskey = overrides.reuse ?? {
      id: base64url(crypto.getRandomValues(new Uint8Array(overrides.idBytes ?? 16))),
      rpId,
      userHandle: options.user.id,
      keyPair: (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair,
      counter: 0
    };
    const jwk = (await crypto.subtle.exportKey('jwk', passkey.keyPair.publicKey)) as JsonWebKey;
    const coseKey = cbor(new Map<number, CborValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, fromBase64url(jwk.x!)],
      [-3, fromBase64url(jwk.y!)],
      ...(overrides.keyPadding ? [[-70_000, new Uint8Array(overrides.keyPadding)] as [number, CborValue]] : [])
    ]));
    const credentialId = fromBase64url(passkey.id);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([FLAG_UP | FLAG_UV | FLAG_AT | this.backupFlags()]),
      uint32(passkey.counter),
      uuidBytes(this.options.aaguid ?? '00000000-0000-0000-0000-000000000000'),
      new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      coseKey
    );
    const attestationObject = cbor(new Map<string, CborValue>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, overrides.origin);
    if (!overrides.reuse) this.passkeys.push(passkey);
    const id = overrides.responseId ?? passkey.id;
    return {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON, attestationObject: base64url(attestationObject), transports: (overrides.transports ?? ['hybrid', 'internal']) as string[] }
    };
  }

  /**
   * navigator.credentials.get(). Picks the first stored passkey in allowCredentials, or (discoverable) the latest one
   * for the RP. `userHandle: null` leaves it out, as some authenticators do when allowCredentials is given.
   */
  async get(options: PublicKeyCredentialRequestOptionsJSON, overrides: { passkey?: StoredPasskey; userHandle?: string | null; origin?: string } = {}): Promise<AuthenticationResponseJSON> {
    const rpId = options.rpId ?? 'localhost';
    const allowed = options.allowCredentials?.map((credential) => credential.id) ?? [];
    const passkey = overrides.passkey
      ?? (allowed.length > 0
        ? this.passkeys.find((candidate) => allowed.includes(candidate.id))
        : this.passkeys.filter((candidate) => candidate.rpId === rpId).at(-1));
    if (!passkey) throw new Error('NotAllowedError: no passkey for this request');
    if (this.options.counts ?? true) passkey.counter += 1;

    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([FLAG_UP | FLAG_UV | this.backupFlags()]),
      uint32(passkey.counter)
    );
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, overrides.origin);
    const signed = concat(authData, await sha256(fromBase64url(clientDataJSON)));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, passkey.keyPair.privateKey, signed));
    const userHandle = overrides.userHandle === undefined ? passkey.userHandle : overrides.userHandle;
    return {
      id: passkey.id,
      rawId: passkey.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON,
        authenticatorData: base64url(authData),
        signature: base64url(derSignature(signature)),
        ...(userHandle === null ? {} : { userHandle })
      }
    };
  }

  /** A copy that shares these passkeys, like a password manager syncing to another device. */
  syncedCopy(): SoftAuthenticator {
    const copy = new SoftAuthenticator(this.options);
    copy.passkeys.push(...this.passkeys);
    return copy;
  }

  private backupFlags(): number {
    return this.options.synced ? FLAG_BE | FLAG_BS : 0;
  }

  private clientData(type: string, challenge: string, origin = this.origin): string {
    return base64url(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding

type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

/** Minimal CBOR encoder: unsigned and negative integers, byte and text strings, arrays and maps. */
export function cbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const head = (major: number, length: number) => {
    if (length < 24) out.push((major << 5) | length);
    else if (length < 0x100) out.push((major << 5) | 24, length);
    else if (length < 0x10000) out.push((major << 5) | 25, length >> 8, length & 0xff);
    else out.push((major << 5) | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  };
  const write = (item: CborValue) => {
    if (typeof item === 'number') {
      if (item >= 0) head(0, item);
      else head(1, -1 - item);
    } else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item);
      head(3, bytes.length);
      out.push(...bytes);
    } else if (item instanceof Uint8Array) {
      head(2, item.length);
      out.push(...item);
    } else if (Array.isArray(item)) {
      head(4, item.length);
      item.forEach(write);
    } else {
      head(5, item.size);
      for (const [key, entry] of item) {
        write(key);
        write(entry);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}

/** WebCrypto signs ECDSA as r‖s; WebAuthn wants ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.slice(start);
    const body = trimmed[0]! & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed;
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  return new Uint8Array(Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
