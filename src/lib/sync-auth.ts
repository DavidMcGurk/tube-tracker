/**
 * Passkey ceremonies for backup (docs/sync-design.md, "WebAuthn in the client"), on @simplewebauthn/browser.
 *
 * Sign-in options are prefetched while the Backup section is open, because a passkey sheet should open straight from
 * the tap. Each set of options is used once and only while under 4 minutes old (the server accepts a challenge for 10
 * minutes and a ceremony may take 5). The relying party id is never hardcoded: it comes from the server's options.
 */
import {
  sendSignal,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import * as api from './sync-api';
import { isHttpError, SyncHttpError, SyncNetworkError, type Account, type CeremonyOptions, type SignIn } from './sync-api';

export const OPTIONS_FRESH_MS = 4 * 60 * 1000;
/** After a passkey was created or used, verifying it is retried this many times on a network error, timeout or 5xx. */
export const VERIFY_RETRIES = 2;
export const VERIFY_RETRY_DELAY_MS = 1_000;

/** Plain-words results shown by the Backup section. The first five are the design's; the rest fill its gaps. */
export const MESSAGES = {
  noPasskey: 'No passkey was used. If no passkey window appeared, open Tube Tracker in Safari or Chrome and try again.',
  passkeyAlreadySaved: 'Your password manager here already has a passkey for this backup. To add another, pick a different option in the passkey window, such as another device or a security key.',
  notTurnedOn: 'Backup wasn’t turned on, so nothing was saved. Please try again.',
  unknownCredential: 'That passkey isn’t linked to a backup any more.',
  registrationsClosed: 'New backups are paused right now. Please try again later.',
  passkeyNotAdded: 'The passkey wasn’t added. Please try again.',
  userMismatch: 'That passkey belongs to a different backup.',
  lastPasskey: 'This is your backup’s only passkey, so it can’t be removed.',
  offline: 'You’re offline. Please try again when you’re connected.',
  unreachable: 'Can’t reach the backup service. Please try again later.',
  unsupported: 'This browser can’t use passkeys here.',
  signedOut: 'This device is no longer signed in to backup.',
  notBackedUp: 'Couldn’t back up, so backup is still on. Please try again.',
  generic: 'Something went wrong. Please try again.'
} as const;

/**
 * How a backup action ended badly: `ignored` when there's nothing to say (a newer ceremony took over), otherwise a
 * message, `neutral` when nothing went wrong as such (the passkey window was cancelled).
 */
export type FailureOutcome = { status: 'ignored' } | { status: 'failed'; message: string; neutral: boolean };

const failed = (message: string, neutral = false): FailureOutcome => ({ status: 'failed', message, neutral });

/** create() succeeded but the server never confirmed the new passkey, so nothing was saved. */
export class PasskeyNotSavedError extends Error {
  constructor(cause: unknown) {
    super('The passkey was created but the backup server didn’t save it', { cause });
    this.name = 'PasskeyNotSavedError';
  }
}

export type AuthAction = 'turnOn' | 'restore' | 'addPasskey' | 'manage';

/** Maps anything a backup action can throw to what the Backup section should say. */
export function describeFailure(error: unknown, action: AuthAction): FailureOutcome {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return { status: 'ignored' };
  if (name === 'NotAllowedError') return failed(MESSAGES.noPasskey, true);
  if (name === 'InvalidStateError' && action === 'addPasskey') return failed(MESSAGES.passkeyAlreadySaved);
  if (name === 'SecurityError' || name === 'NotSupportedError') return failed(MESSAGES.unsupported);
  if (error instanceof PasskeyNotSavedError) return failed(action === 'addPasskey' ? MESSAGES.passkeyNotAdded : MESSAGES.notTurnedOn);
  if (error instanceof SyncNetworkError) return failed(error.offline ? MESSAGES.offline : MESSAGES.unreachable);
  if (error instanceof SyncHttpError) {
    if (error.code === 'unknown_credential') return failed(MESSAGES.unknownCredential);
    if (error.code === 'registrations_closed') return failed(MESSAGES.registrationsClosed);
    if (error.code === 'user_mismatch') return failed(MESSAGES.userMismatch);
    if (error.code === 'last_passkey') return failed(MESSAGES.lastPasskey);
    if (error.status === 401) return failed(MESSAGES.signedOut);
    if (error.status >= 500 || error.status === 429) return failed(MESSAGES.unreachable);
  }
  return failed(MESSAGES.generic);
}

interface CachedOptions<T> extends CeremonyOptions<T> {
  fetchedAt: number;
}

/** One kind of prefetched, single-use ceremony options. */
export class OptionsCache<T> {
  private ready: CachedOptions<T> | null = null;
  private pending: Promise<CachedOptions<T>> | null = null;

  constructor(private readonly load: () => Promise<CeremonyOptions<T>>) {}

  private static isFresh(entry: CachedOptions<unknown>) {
    return Date.now() - entry.fetchedAt < OPTIONS_FRESH_MS;
  }

  /** Fetches options in the background, unless fresh ones are ready or already on their way. */
  prefetch(): void {
    if ((this.ready && OptionsCache.isFresh(this.ready)) || this.pending) return;
    // A failed prefetch is quiet: the tap fetches again and reports any error then.
    this.fetch().catch(() => undefined);
  }

  private fetch(): Promise<CachedOptions<T>> {
    const pending: Promise<CachedOptions<T>> = this.load()
      .then((options) => {
        const entry = { ...options, fetchedAt: Date.now() };
        if (this.pending === pending) this.ready = entry;
        return entry;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }

  /** Options for a tap, used up by it: the prefetched ones if still fresh, otherwise fetched now. */
  async take(): Promise<CeremonyOptions<T>> {
    const ready = this.ready;
    this.ready = null;
    if (ready && OptionsCache.isFresh(ready)) return ready;
    if (this.pending) {
      try {
        const fetched = await this.pending;
        if (this.ready === fetched) this.ready = null;
        if (OptionsCache.isFresh(fetched)) return fetched;
      } catch {
        // Fetch again below; that attempt's error is the one to report.
      }
    }
    return this.load();
  }
}

const registerOptions = new OptionsCache<PublicKeyCredentialCreationOptionsJSON>(api.fetchRegisterOptions);
const loginOptions = new OptionsCache<PublicKeyCredentialRequestOptionsJSON>(api.fetchLoginOptions);

/** Gets turn-on and restore options ready, so the passkey window opens straight from the tap. */
export function prefetchSignInOptions(): void {
  registerOptions.prefetch();
  loginOptions.prefetch();
}

let lastRpId: string | null = null;

/** The relying party id from the server's options, remembered for signals sent outside a ceremony. */
function rememberRpId(rpId: string | undefined): string {
  if (rpId) lastRpId = rpId;
  return rpId ?? currentRpId();
}

/** The server's RP ID is the app's own host (a github.io site can't use a parent domain), so that's the fallback. */
const currentRpId = () => lastRpId ?? (typeof location === 'undefined' ? '' : location.hostname);

const isTransient = (error: unknown) =>
  error instanceof SyncNetworkError
  || (error instanceof SyncHttpError && error.status >= 500 && error.code !== 'registrations_closed' && error.code !== 'over_capacity');

/** Retries verifying the same response on a network error, timeout or 5xx. */
async function verifyWithRetry<T>(verify: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await verify();
    } catch (error) {
      if (attempt >= VERIFY_RETRIES || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, VERIFY_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

interface SignalMethods {
  signalUnknownCredential?: unknown;
  signalAllAcceptedCredentials?: unknown;
}

const signalMethods = () => (globalThis as { PublicKeyCredential?: SignalMethods }).PublicKeyCredential;

/** Asks the password manager to hide a passkey the server doesn't know. Feature-detected and not awaited. */
export function signalUnknownCredential(rpId: string, credentialId: string): void {
  if (typeof signalMethods()?.signalUnknownCredential !== 'function') return;
  sendSignal({ signalName: 'unknownCredential', rpID: rpId, credentialID: credentialId })
    .catch((error: unknown) => console.warn('Unable to signal an unknown passkey', error));
}

/** After deleting a backup: tells the password manager none of its passkeys work any more. Not awaited. */
export function signalBackupDeleted(userHandle: string): void {
  if (typeof signalMethods()?.signalAllAcceptedCredentials !== 'function') return;
  sendSignal({ signalName: 'allAcceptedCredentials', rpID: currentRpId(), userID: userHandle, allAcceptedCredentialIDs: [] })
    .catch((error: unknown) => console.warn('Unable to signal the deleted backup’s passkeys', error));
}

/** Turn on: creates a passkey and a new, empty backup. */
export async function createBackup(): Promise<SignIn> {
  const { challengeId, options } = await registerOptions.take();
  const rpId = rememberRpId(options.rp.id);
  const credential = await startRegistration({ optionsJSON: options });
  try {
    return await verifyWithRetry(() => api.verifyRegistration(challengeId, credential));
  } catch (error) {
    // The server didn't keep the new passkey, so ask the password manager not to offer it again.
    signalUnknownCredential(rpId, credential.id);
    throw isHttpError(error, 503, 'registrations_closed') ? error : new PasskeyNotSavedError(error);
  }
}

/** Restore: signs in with an existing passkey. The returned state isn't applied yet. */
export async function openBackup(): Promise<SignIn> {
  const { challengeId, options } = await loginOptions.take();
  const rpId = rememberRpId(options.rpId);
  const credential = await startAuthentication({ optionsJSON: options });
  try {
    return await verifyWithRetry(() => api.verifyLogin(challengeId, credential));
  } catch (error) {
    if (isHttpError(error, 404, 'unknown_credential')) signalUnknownCredential(rpId, credential.id);
    throw error;
  }
}

/** "Confirm it's you": makes the session recently verified, which sensitive actions need. */
export async function confirmIdentity(token: string): Promise<void> {
  const { challengeId, options } = await api.fetchReauthOptions(token);
  const rpId = rememberRpId(options.rpId);
  const credential = await startAuthentication({ optionsJSON: options });
  try {
    await verifyWithRetry(() => api.verifyReauth(token, challengeId, credential));
  } catch (error) {
    if (isHttpError(error, 404, 'unknown_credential')) signalUnknownCredential(rpId, credential.id);
    throw error;
  }
}

/** Adds another passkey to the signed-in backup. Throws reauth_required (403) before any ceremony if not recent. */
export async function addPasskey(token: string): Promise<Account> {
  const { challengeId, options } = await api.fetchPasskeyOptions(token);
  const rpId = rememberRpId(options.rp.id);
  const credential = await startRegistration({ optionsJSON: options });
  try {
    return await verifyWithRetry(() => api.verifyPasskey(token, challengeId, credential));
  } catch (error) {
    if (isHttpError(error, 401)) throw error;
    // The answer may have been lost after the server saved it: check before asking the password manager to hide it.
    const account = await api.fetchAccount(token).catch(() => null);
    if (account?.passkeys.some((passkey) => passkey.id === credential.id)) return account;
    if (account) signalUnknownCredential(rpId, credential.id);
    throw new PasskeyNotSavedError(error);
  }
}
