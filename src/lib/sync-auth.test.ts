import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncHttpError, SyncNetworkError, type Account } from './sync-api';
import { emptyState } from './sync-model';

const mocks = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  sendSignal: vi.fn(async () => undefined),
  fetchRegisterOptions: vi.fn(),
  verifyRegistration: vi.fn(),
  fetchLoginOptions: vi.fn(),
  verifyLogin: vi.fn(),
  fetchPasskeyOptions: vi.fn(),
  verifyPasskey: vi.fn(),
  fetchAccount: vi.fn()
}));

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: mocks.startRegistration,
  startAuthentication: mocks.startAuthentication,
  sendSignal: mocks.sendSignal
}));

vi.mock('./sync-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync-api')>()),
  fetchRegisterOptions: mocks.fetchRegisterOptions,
  verifyRegistration: mocks.verifyRegistration,
  fetchLoginOptions: mocks.fetchLoginOptions,
  verifyLogin: mocks.verifyLogin,
  fetchPasskeyOptions: mocks.fetchPasskeyOptions,
  verifyPasskey: mocks.verifyPasskey,
  fetchAccount: mocks.fetchAccount
}));

const { addPasskey, createBackup, describeFailure, MESSAGES, openBackup, OPTIONS_FRESH_MS, OptionsCache, PasskeyNotSavedError, signalBackupDeleted, VERIFY_RETRY_DELAY_MS } = await import('./sync-auth');

const T = 1_800_000_000_000;
const ACCOUNT: Account = { userHandle: 'user-1', name: 'Tube Tracker · K3F9', createdAt: T, passkeys: [] };
const SIGN_IN = { token: 't1', account: ACCOUNT, state: emptyState(), clockOffset: 0 };
const creationOptions = { challengeId: 'c1', options: { challenge: 'abc', rp: { id: 'example.github.io', name: 'Tube Tracker' } } };
const requestOptions = { challengeId: 'c2', options: { challenge: 'def', rpId: 'example.github.io' } };
const credential = { id: 'cred-1', rawId: 'cred-1', response: {}, clientExtensionResults: {}, type: 'public-key' };
const named = (name: string) => Object.assign(new Error(name), { name });
const unavailable = () => new SyncHttpError({ status: 500, code: 'internal' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T);
  vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential: () => undefined, signalAllAcceptedCredentials: () => undefined });
  mocks.fetchRegisterOptions.mockResolvedValue(creationOptions);
  mocks.fetchLoginOptions.mockResolvedValue(requestOptions);
  mocks.fetchPasskeyOptions.mockResolvedValue(creationOptions);
  mocks.startRegistration.mockResolvedValue(credential);
  mocks.startAuthentication.mockResolvedValue(credential);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

/** Runs a ceremony to the end, letting its retry pauses pass. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(VERIFY_RETRY_DELAY_MS * 10);
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

describe('OptionsCache', () => {
  it('uses prefetched options once, while under 4 minutes old', async () => {
    const load = vi.fn(async () => ({ challengeId: `c${load.mock.calls.length}`, options: {} }));
    const cache = new OptionsCache(load);
    cache.prefetch();
    cache.prefetch();
    expect(load).toHaveBeenCalledTimes(1);
    expect((await cache.take()).challengeId).toBe('c1');
    // Used up: the next tap fetches.
    expect((await cache.take()).challengeId).toBe('c2');

    cache.prefetch();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(T + OPTIONS_FRESH_MS);
    expect((await cache.take()).challengeId).toBe('c4');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('waits for a prefetch already on its way, and fetches again if it failed', async () => {
    let finish: (value: { challengeId: string; options: object }) => void = () => undefined;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ challengeId: 'later', options: {} });
    const cache = new OptionsCache<object>(load);
    cache.prefetch();
    const taken = cache.take();
    finish({ challengeId: 'first', options: {} });
    expect((await taken).challengeId).toBe('first');

    cache.prefetch();
    await vi.advanceTimersByTimeAsync(0);
    expect((await cache.take()).challengeId).toBe('later');
  });
});

describe('createBackup', () => {
  it('retries verifying the same response on network errors and 5xx', async () => {
    mocks.verifyRegistration
      .mockRejectedValueOnce(new SyncNetworkError({ offline: false, timedOut: true }))
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(SIGN_IN);
    expect(await settle(createBackup())).toBe(SIGN_IN);
    expect(mocks.verifyRegistration).toHaveBeenCalledTimes(3);
    expect(mocks.verifyRegistration.mock.calls.every(([challengeId, response]) => challengeId === 'c1' && response === credential)).toBe(true);
    expect(mocks.sendSignal).not.toHaveBeenCalled();
  });

  it('when verifying still fails, asks the password manager to forget the passkey and says nothing was saved', async () => {
    mocks.verifyRegistration.mockRejectedValue(unavailable());
    const error = await settle(createBackup()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PasskeyNotSavedError);
    expect(mocks.verifyRegistration).toHaveBeenCalledTimes(3);
    expect(mocks.sendSignal).toHaveBeenCalledWith({ signalName: 'unknownCredential', rpID: 'example.github.io', credentialID: 'cred-1' });
    expect(describeFailure(error, 'turnOn')).toEqual({ status: 'failed', message: MESSAGES.notTurnedOn, neutral: false });
  });

  it('doesn’t retry when new backups are paused', async () => {
    mocks.verifyRegistration.mockRejectedValue(new SyncHttpError({ status: 503, code: 'registrations_closed' }));
    const error = await settle(createBackup()).catch((caught: unknown) => caught);
    expect(mocks.verifyRegistration).toHaveBeenCalledTimes(1);
    expect(mocks.sendSignal).toHaveBeenCalledTimes(1);
    expect(describeFailure(error, 'turnOn')).toEqual({ status: 'failed', message: MESSAGES.registrationsClosed, neutral: false });
  });

  it('sends signals only where the browser supports them', async () => {
    vi.stubGlobal('PublicKeyCredential', {});
    mocks.verifyRegistration.mockRejectedValue(new SyncHttpError({ status: 400, code: 'challenge_used' }));
    await settle(createBackup()).catch(() => undefined);
    signalBackupDeleted('user-1');
    expect(mocks.sendSignal).not.toHaveBeenCalled();
  });
});

describe('openBackup', () => {
  it('signals a passkey the server doesn’t know', async () => {
    mocks.verifyLogin.mockRejectedValue(new SyncHttpError({ status: 404, code: 'unknown_credential' }));
    const error = await settle(openBackup()).catch((caught: unknown) => caught);
    expect(mocks.sendSignal).toHaveBeenCalledWith({ signalName: 'unknownCredential', rpID: 'example.github.io', credentialID: 'cred-1' });
    expect(describeFailure(error, 'restore')).toEqual({ status: 'failed', message: MESSAGES.unknownCredential, neutral: false });
  });
});

describe('addPasskey', () => {
  it('checks the account before hiding a passkey the server may have saved', async () => {
    mocks.verifyPasskey.mockRejectedValue(new SyncNetworkError({ offline: false, timedOut: true }));
    const saved = { ...ACCOUNT, passkeys: [{ id: 'cred-1', createdAt: T, lastUsedAt: null, synced: true, provider: null }] };
    mocks.fetchAccount.mockResolvedValueOnce(saved);
    expect(await settle(addPasskey('t1'))).toBe(saved);
    expect(mocks.sendSignal).not.toHaveBeenCalled();

    mocks.fetchAccount.mockResolvedValueOnce(ACCOUNT);
    const error = await settle(addPasskey('t1')).catch((caught: unknown) => caught);
    expect(mocks.sendSignal).toHaveBeenCalledTimes(1);
    expect(describeFailure(error, 'addPasskey')).toEqual({ status: 'failed', message: MESSAGES.passkeyNotAdded, neutral: false });

    // Can't check (offline): leave the passkey alone.
    mocks.fetchAccount.mockRejectedValueOnce(new SyncNetworkError({ offline: true, timedOut: false }));
    await settle(addPasskey('t1')).catch(() => undefined);
    expect(mocks.sendSignal).toHaveBeenCalledTimes(1);
  });
});

describe('signalBackupDeleted', () => {
  it('tells the password manager no passkey for the user works any more', () => {
    signalBackupDeleted('user-1');
    expect(mocks.sendSignal).toHaveBeenCalledWith({ signalName: 'allAcceptedCredentials', rpID: 'example.github.io', userID: 'user-1', allAcceptedCredentialIDs: [] });
  });
});

describe('describeFailure', () => {
  it('puts passkey and server errors in plain words', () => {
    expect(describeFailure(named('AbortError'), 'turnOn')).toEqual({ status: 'ignored' });
    expect(describeFailure(named('NotAllowedError'), 'restore')).toEqual({ status: 'failed', message: MESSAGES.noPasskey, neutral: true });
    expect(describeFailure(named('InvalidStateError'), 'addPasskey')).toMatchObject({ message: MESSAGES.passkeyAlreadySaved });
    expect(describeFailure(named('InvalidStateError'), 'turnOn')).toMatchObject({ message: MESSAGES.generic });
    expect(describeFailure(new SyncNetworkError({ offline: true, timedOut: false }), 'restore')).toMatchObject({ message: MESSAGES.offline });
    expect(describeFailure(new SyncNetworkError({ offline: false, timedOut: true }), 'restore')).toMatchObject({ message: MESSAGES.unreachable });
    expect(describeFailure(new SyncHttpError({ status: 400, code: 'user_mismatch' }), 'restore')).toMatchObject({ message: MESSAGES.userMismatch });
    expect(describeFailure(new SyncHttpError({ status: 409, code: 'last_passkey' }), 'manage')).toMatchObject({ message: MESSAGES.lastPasskey });
    expect(describeFailure(new SyncHttpError({ status: 401, code: 'unauthorized' }), 'manage')).toMatchObject({ message: MESSAGES.signedOut });
  });
});
