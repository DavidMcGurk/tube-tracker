/**
 * The backup engine (docs/sync-design.md, "Sync engine"): one per page, started once from main.tsx. It owns every
 * timer and listener; hooks only subscribe to its snapshot and call its actions.
 *
 * It sends the outbox when there's something to send: shortly after a local change, when the app starts, comes back
 * to the foreground or online (and also fetches then if the last sync is over 2 minutes old), when the page is hidden
 * (which also ends the latest journey's undo window), when that window closes, and on "Back up now". There's no
 * periodic poll: every request counts against the free plan's daily budget.
 */
import * as defaultApi from './sync-api';
import { isHttpError, SyncHttpError, SyncNetworkError, SYNC_CONFIGURED, type Account, type Passkey, type PushResult, type SignIn } from './sync-api';
import * as defaultAuth from './sync-auth';
import { describeFailure, MESSAGES, type AuthAction, type FailureOutcome } from './sync-auth';
import {
  applySyncResponse,
  beginBackup,
  dismissSyncNotice,
  endBackup,
  endUndoWindow,
  findLocalOnlyItems,
  observeSyncSummary,
  readSyncSummary,
  recordSyncFailure,
  requeueHeldChanges,
  shiftOutboxTimes,
  takeOutboxBatch,
  type SyncSummary
} from './storage';
import { countItemIds, LIMITS } from './sync-model';

export const LOCAL_CHANGE_DELAY_MS = 1_500;
/** Starting, coming back or coming online also fetches the latest backup when the last sync is at least this old. */
export const STALE_AFTER_MS = 2 * 60 * 1000;
export const MAX_REQUESTS_PER_RUN = 5;
/** The server accepts 256 KB; batches stop at about this much JSON. */
export const MAX_BATCH_BYTES = 200 * 1024;
export const LOCK_NAME = 'tube-tracker-sync';
export const LOCK_TIMEOUT_MS = 10_000;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
export const MAX_SKEW_RETRIES = 2;
/** A failed passkey-list load isn't retried sooner than this, however often the Backup section asks. */
const ACCOUNT_RETRY_MS = 30_000;

/** What a failed attempt records as lastError, so every copy of the app shows the same status. */
export const STATUS_MESSAGES = {
  offline: 'Waiting for a connection',
  unavailable: 'Backup service unavailable',
  paused: 'Backup is paused',
  failed: 'Couldn’t back up. Updating the app may fix this.'
} as const;

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'waiting' | 'paused' | 'error' | 'signed_out';

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncedAt: number | null;
  /** Changes on this device not yet backed up and ready to send (held ones and `awaitingUndo` aside). */
  unsent: boolean;
  /**
   * The latest journey is waiting on this device until it can no longer be undone. On its own it doesn't change the
   * phase: the status stays "Backed up" with a second line saying so.
   */
  awaitingUndo: boolean;
  /** One of them is a reset, so other devices haven't cleared yet. */
  unsentReset: boolean;
  /** Changes the server refused; "Back up now" tries them again. */
  heldCount: number;
  error: { code: string; message: string } | null;
  /** While the server has paused backups (over capacity): when it will try again. */
  pausedUntil: number | null;
}

/** The signed-in backup. Its creation date and passkeys arrive from the server: null until then. */
export interface SyncAccount {
  userHandle: string;
  name: string;
  createdAt: number | null;
  passkeys: Passkey[] | null;
}

export interface SyncSnapshot {
  /** Backup is in this build (VITE_SYNC_URL) and this browser can use passkeys. */
  available: boolean;
  account: SyncAccount | null;
  status: SyncStatus;
  notice: { kind: 'signed_out'; accountName: string } | null;
}

/** For the restore dialog: what this device has that the backup doesn't. */
export interface RestoreMerge {
  accountName: string;
  /** When the backup was last reset (ms), or 0. */
  resetAt: number;
  sections: number;
  walks: number;
  /** Stations entered, exited or changed at, each counted once. */
  stations: number;
}

/**
 * How a backup action ended. `confirm`: restore() found journeys on this device that the backup lacks, so ask, then
 * call confirmRestore() (or cancelRestore()). `verified`: addPasskey() had to confirm it's you first, which used up
 * the tap; tap "Add a passkey" again.
 */
export type Outcome = { status: 'done' } | { status: 'confirm'; merge: RestoreMerge } | { status: 'verified' } | FailureOutcome;

export interface SyncActions {
  turnOn(): Promise<Outcome>;
  restore(): Promise<Outcome>;
  confirmRestore(addLocal: boolean): Promise<Outcome>;
  /** Escape in the restore dialog: forgets the session it signed in with. */
  cancelRestore(): void;
  addPasskey(): Promise<Outcome>;
  removePasskey(id: string): Promise<Outcome>;
  signOutOthers(): Promise<Outcome>;
  /** Syncs now. Resolves once that sync has finished (at once if none could start), so the UI can say how it went. */
  backUpNow(): Promise<void>;
  turnOff(options: { backUpFirst: boolean; removeLocal: boolean }): Promise<Outcome>;
  deleteBackup(): Promise<Outcome>;
  dismissNotice(): void;
  /**
   * Call when the Backup section mounts, on pointerdown/focus of its buttons and when the page becomes visible while
   * it's open. Signed out, it prefetches the passkey options; signed in, it loads the passkey list once per page.
   */
  prepare(): void;
}

const DONE: Outcome = { status: 'done' };

/** Unsent rows still waiting out their journey's undo window at `now`. */
function waitingForUndo(summary: SyncSummary, now: number): number {
  return summary.undoWaits.filter((until) => until > now).length;
}

/** Unsent rows that can be sent at `now`: neither held nor waiting out an undo window. */
export function readyToSend(summary: SyncSummary, now: number): number {
  return summary.unsent - waitingForUndo(summary, now);
}

/** Derives the status every copy of the app shows from the shared records, plus whether this tab is syncing. */
export function deriveStatus(summary: SyncSummary | null, { syncing, online, now }: { syncing: boolean; online: boolean; now: number }): SyncStatus {
  if (!summary?.account) {
    return { phase: summary?.notice ? 'signed_out' : 'off', lastSyncedAt: null, unsent: false, awaitingUndo: false, unsentReset: false, heldCount: 0, error: null, pausedUntil: null };
  }
  const { lastError } = summary;
  const pausedUntil = lastError?.code === 'over_capacity' && lastError.retryAt !== null && lastError.retryAt > now ? lastError.retryAt : null;
  // A journey that can still be undone isn't due yet, so it alone never makes the status "waiting" or "backing up".
  const unsent = readyToSend(summary, now) > 0;
  let phase: SyncPhase = 'idle';
  if (syncing) phase = 'syncing';
  else if (pausedUntil !== null) phase = 'paused';
  else if (lastError && !lastError.retryable) phase = 'error';
  else if (unsent && (!online || lastError)) phase = 'waiting';
  return {
    phase,
    lastSyncedAt: summary.lastSyncedAt,
    unsent,
    awaitingUndo: waitingForUndo(summary, now) > 0,
    unsentReset: unsent && summary.unsentReset,
    heldCount: summary.held,
    error: lastError ? { code: lastError.code, message: lastError.message } : null,
    pausedUntil
  };
}

export interface FailureKind {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
}

/**
 * Network errors, 5xx, 409 busy and 429 (and a skewed clock that two corrections didn't fix) are retried with backoff.
 * Anything else means this version of the app and the server disagree: retried only on the next start or "Back up now".
 */
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof SyncNetworkError) {
    return { code: error.offline ? 'offline' : 'unavailable', message: error.offline ? STATUS_MESSAGES.offline : STATUS_MESSAGES.unavailable, retryable: true, retryAfterMs: null };
  }
  if (error instanceof SyncHttpError) {
    const retryable = error.status >= 500 || error.status === 429 || error.code === 'bad_response'
      || (error.status === 409 && (error.code === 'busy' || error.code === 'clock_skew'));
    if (!retryable) return { code: error.code, message: STATUS_MESSAGES.failed, retryable: false, retryAfterMs: null };
    const message = error.code === 'over_capacity' ? STATUS_MESSAGES.paused : STATUS_MESSAGES.unavailable;
    return { code: error.code, message, retryable: true, retryAfterMs: error.retryAfterMs };
  }
  return { code: 'unavailable', message: STATUS_MESSAGES.unavailable, retryable: true, retryAfterMs: null };
}

/**
 * start: app start. visible/online: back in the foreground or online. retry: a backoff or Retry-After ended. These
 * fetch even with nothing to send, if the last sync is stale. local: a change was recorded (after the debounce).
 * hidden: the page is being hidden (after ending any undo window). signin: backup was just turned on or restored.
 * released: the latest journey's undo window closed. These only send. manual: "Back up now", which always syncs, and first ends the undo window and
 * re-queues held rows.
 */
type Trigger = 'start' | 'visible' | 'online' | 'retry' | 'local' | 'hidden' | 'signin' | 'released' | 'manual';

const TRIGGER_RANK: Record<Trigger, number> = { local: 1, hidden: 1, signin: 1, released: 1, start: 2, visible: 2, online: 2, retry: 2, manual: 3 };

interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export type SyncApi = Pick<typeof defaultApi, 'pushChanges' | 'fetchAccount' | 'deletePasskey' | 'revokeOtherSessions' | 'logout' | 'deleteAccount'>;
export type SyncAuth = Pick<typeof defaultAuth, 'createBackup' | 'openBackup' | 'confirmIdentity' | 'addPasskey' | 'prefetchSignInOptions' | 'signalBackupDeleted'>;

export interface SyncEngineOptions {
  /** VITE_SYNC_URL was set: without it the engine never starts. */
  configured: boolean;
  api: SyncApi;
  auth: SyncAuth;
  passkeysAvailable: () => boolean;
  isOnline: () => boolean;
  document?: (Listenable & { readonly visibilityState: DocumentVisibilityState }) | null;
  window?: Listenable | null;
  /** Web Locks, so only one tab syncs at a time. Without them, tabs sync unlocked (pushes are idempotent). */
  locks?: Pick<LockManager, 'request'> | null;
  /** Follow the shared records as other copies of the app change them. Tests read them after each step instead. */
  observe?: boolean;
  random?: () => number;
}

export class SyncEngine implements SyncActions {
  private started = false;
  private summary: SyncSummary | null = null;
  private syncing = false;
  private snapshot: SyncSnapshot;
  private snapshotKey = '';
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires when the latest journey's undo window closes, to send it. */
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffAttempt = 0;
  /** Set from Retry-After: nothing is sent before then, whatever the trigger. */
  private retryAfterUntil = 0;
  /** Halved after a 413, for the rest of this page's life. */
  private batchRows: number = LIMITS.maxChangesPerRequest;
  private running: Promise<void> | null = null;
  private queuedRun: Promise<void> | null = null;
  private queuedTrigger: Trigger | null = null;
  private details: { token: string; account: Account } | null = null;
  private loadingDetails = false;
  private detailsFailedAt = 0;
  private prepareWhenLoaded = false;
  private pendingRestore: SignIn | null = null;
  private operation: Promise<Outcome> | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: SyncEngineOptions) {
    this.snapshot = this.buildSnapshot();
  }

  /** Idempotent. Reads the account from IndexedDB, then syncs if there's anything to send or the last sync is stale. */
  start(): void {
    if (this.started || !this.options.configured) return;
    this.started = true;
    const { document, window } = this.options;
    if (document) {
      const onVisibilityChange = () => this.onVisibilityChange(document.visibilityState);
      document.addEventListener('visibilitychange', onVisibilityChange);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    }
    if (window) {
      const onOnline = () => this.trigger('online');
      const onOffline = () => this.emit();
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      this.cleanups.push(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      });
    }
    if (this.options.observe !== false) {
      this.cleanups.push(observeSyncSummary((summary) => this.setSummary(summary), (error) => console.error('Unable to load the backup status', error)));
    }
    this.starting = this.refresh().then((summary) => {
      this.starting = null;
      const retryAt = summary?.lastError?.retryAt ?? 0;
      if (retryAt > Date.now()) {
        // A previous page was asked to pause (Retry-After): carry on waiting rather than sending at once.
        this.retryAfterUntil = retryAt;
        this.scheduleRetry(retryAt - Date.now());
        return;
      }
      void this.requestRun('start');
    });
  }

  /** Stops every timer and listener. For tests; the app's engine lives as long as the page. */
  stop(): void {
    this.started = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.clearDebounce();
    for (const timer of [this.retryTimer, this.statusTimer, this.releaseTimer]) if (timer !== null) clearTimeout(timer);
    this.retryTimer = null;
    this.statusTimer = null;
    this.releaseTimer = null;
  }

  /** Resolves once no sync is running or queued in this tab. */
  async idle(): Promise<void> {
    while (this.starting || this.running || this.queuedRun) await (this.starting ?? this.queuedRun ?? this.running);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  /** A change was queued locally: sync once things settle. */
  nudge(): void {
    if (!this.started) return;
    void this.refresh();
    if (this.retryAfterActive()) return;
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.requestRun('local');
    }, LOCAL_CHANGE_DELAY_MS);
  }

  backUpNow = (): Promise<void> => {
    if (!this.started || this.retryAfterActive()) return Promise.resolve();
    this.resetBackoff();
    this.clearDebounce();
    return this.requestRun('manual');
  };

  private onVisibilityChange(state: DocumentVisibilityState) {
    if (state === 'visible') {
      this.trigger('visible');
      return;
    }
    // Best effort: the page may be frozen or closed soon, so send what's waiting now rather than after the debounce.
    const now = Date.now();
    if (this.summary && waitingForUndo(this.summary, now) > 0) {
      // Leaving the app ends the latest journey's undo window (its bar can't be seen meanwhile), so the journey is
      // backed up now: a hidden page is often suspended, timers and all, until the app is next opened. If the page is
      // frozen before this is stored, the journey just keeps waiting as before.
      endUndoWindow().then(() => this.trigger('hidden'), (error: unknown) => console.error('Unable to end the undo window', error));
    } else if (this.debounceTimer !== null || (this.summary && readyToSend(this.summary, now) > 0)) {
      this.trigger('hidden');
    }
  }

  private trigger(trigger: Trigger) {
    if (!this.started) return;
    if (this.retryAfterActive()) {
      this.emit();
      return;
    }
    if (trigger === 'visible' || trigger === 'online') this.resetBackoff();
    if (trigger === 'hidden') this.clearDebounce();
    void this.requestRun(trigger);
  }

  private retryAfterActive() {
    return Math.max(this.retryAfterUntil, this.summary?.lastError?.retryAt ?? 0) > Date.now();
  }

  private clearDebounce() {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private resetBackoff() {
    this.backoffAttempt = 0;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(delay: number) {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.requestRun('retry');
    }, delay);
  }

  /** 5 s, doubling to 5 minutes, each with ±25% jitter so devices don't retry in step. */
  private nextBackoff() {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.backoffAttempt);
    this.backoffAttempt += 1;
    const jittered = base * (0.75 + (this.options.random ?? Math.random)() * 0.5);
    return Math.round(Math.max(BACKOFF_MIN_MS, Math.min(BACKOFF_MAX_MS, jittered)));
  }

  /** At most one run at a time in this tab, and at most one waiting behind it (with the strongest trigger asked for). */
  private requestRun(trigger: Trigger): Promise<void> {
    if (this.running) {
      if (!this.queuedTrigger || TRIGGER_RANK[trigger] > TRIGGER_RANK[this.queuedTrigger]) this.queuedTrigger = trigger;
      this.queuedRun ??= this.running.then(() => {
        const next = this.queuedTrigger ?? trigger;
        this.queuedTrigger = null;
        this.queuedRun = null;
        return this.requestRun(next);
      });
      return this.queuedRun;
    }
    const run: Promise<void> = this.runLocked(trigger)
      .catch((error: unknown) => console.error('Backup failed', error))
      .finally(() => {
        if (this.running === run) this.running = null;
      });
    this.running = run;
    return run;
  }

  /** Holds the Web Lock for one run only (never a backoff wait). If it isn't granted in 10 s, runs anyway. */
  private async runLocked(trigger: Trigger): Promise<void> {
    const { locks } = this.options;
    if (!locks) return this.run(trigger);
    let entered = false;
    try {
      await locks.request(LOCK_NAME, { signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) }, async () => {
        entered = true;
        await this.run(trigger);
      });
    } catch (error) {
      if (entered) throw error;
      await this.run(trigger);
    }
  }

  private shouldSend(trigger: Trigger, summary: SyncSummary) {
    if (!summary.account) return false;
    if (trigger === 'manual') return true;
    if (summary.lastError && !summary.lastError.retryable && trigger !== 'start') return false;
    if (readyToSend(summary, Date.now()) > 0) return true;
    if (TRIGGER_RANK[trigger] === 1) return false;
    return summary.lastSyncedAt === null || Date.now() - summary.lastSyncedAt >= STALE_AFTER_MS;
  }

  private async run(trigger: Trigger): Promise<void> {
    // Re-read after waiting for the lock: another tab may have sent everything meanwhile.
    const summary = await this.refresh();
    if (!summary || !this.shouldSend(trigger, summary)) return;
    this.setSyncing(true);
    try {
      if (trigger === 'manual') {
        await endUndoWindow();
        await requeueHeldChanges();
      }
      await this.push();
    } catch (error) {
      // IndexedDB failed: nothing was lost; try again later.
      console.error('Backup failed', error);
      this.scheduleRetry(this.nextBackoff());
    } finally {
      this.setSyncing(false);
      await this.refresh();
    }
  }

  /** Sends batches (held rows excluded) and applies each answer, up to 5 requests. */
  private async push(): Promise<void> {
    let requests = 0;
    let skewRetries = 0;
    while (requests < MAX_REQUESTS_PER_RUN) {
      const batch = await takeOutboxBatch({ maxRows: this.batchRows, maxBytes: MAX_BATCH_BYTES });
      // The first request goes even when empty: it fetches the latest backup.
      if (!batch || (requests > 0 && batch.rows.length === 0)) return;
      requests += 1;
      let result: PushResult;
      try {
        result = await this.options.api.pushChanges(batch.token, batch.rows.map((row) => row.change));
      } catch (error) {
        if (isHttpError(error, 409, 'clock_skew') && error.clockOffset !== null && skewRetries < MAX_SKEW_RETRIES) {
          skewRetries += 1;
          if (await shiftOutboxTimes({ token: batch.token, clockOffset: error.clockOffset })) continue;
          return;
        }
        // Nothing is dropped for a refused request. Too large: record it, and send half as many rows from now on.
        if (isHttpError(error, 413) && batch.rows.length > 1) {
          this.batchRows = Math.max(1, Math.floor(batch.rows.length / 2));
          await this.recordFailure(batch.token, error);
          continue;
        }
        await this.recordFailure(batch.token, error);
        return;
      }
      const applied = await applySyncResponse({ token: batch.token, sent: batch.rows, response: result });
      this.clearFailure();
      // Not applied: the session changed while the request was out, so these rows weren't removed. Stop.
      if (!applied.applied || applied.unsent === 0) return;
    }
  }

  private clearFailure() {
    this.resetBackoff();
    this.retryAfterUntil = 0;
  }

  private async recordFailure(token: string, error: unknown) {
    if (isHttpError(error, 401)) {
      await this.signedOutByServer(token);
      return;
    }
    const failure = classifyFailure(error);
    let retryAt: number | null = null;
    if (failure.retryable && failure.retryAfterMs !== null) {
      retryAt = Date.now() + failure.retryAfterMs;
      this.retryAfterUntil = retryAt;
      this.scheduleRetry(failure.retryAfterMs);
    } else if (failure.retryable) {
      this.scheduleRetry(this.nextBackoff());
    }
    await recordSyncFailure({ token, error: { code: failure.code, message: failure.message, retryable: failure.retryable, retryAt } });
  }

  /** 401: the server no longer knows this session. Signs out (only if it's still the current one) with a notice. */
  private async signedOutByServer(token: string) {
    if (await endBackup({ token, notice: true })) {
      this.details = null;
      this.clearDebounce();
      this.clearFailure();
    }
    await this.refresh();
  }

  private setSyncing(syncing: boolean) {
    this.syncing = syncing;
    this.emit();
  }

  private async refresh(): Promise<SyncSummary | null> {
    try {
      const summary = await readSyncSummary();
      this.setSummary(summary);
      return summary;
    } catch (error) {
      console.error('Unable to read the backup status', error);
      return null;
    }
  }

  private setSummary(summary: SyncSummary) {
    this.summary = summary;
    if (this.prepareWhenLoaded) this.prepare();
    this.scheduleRelease();
    this.emit();
  }

  /**
   * Sends the latest journey once its undo window closes (and re-derives the status then). Every open copy of the app
   * sets this timer; the Web Lock and the re-read at the start of each run mean only one of them sends it.
   */
  private scheduleRelease() {
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (!this.started || !this.summary?.account) return;
    const now = Date.now();
    const next = Math.min(...this.summary.undoWaits.filter((until) => until > now));
    if (!Number.isFinite(next)) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.emit();
      this.trigger('released');
    }, next - now);
  }

  private buildSnapshot(): SyncSnapshot {
    const record = this.summary?.account ?? null;
    const details = record && this.details?.token === record.token ? this.details.account : null;
    return {
      available: this.options.configured && this.options.passkeysAvailable(),
      account: record ? { userHandle: record.userHandle, name: record.name, createdAt: details?.createdAt ?? null, passkeys: details?.passkeys ?? null } : null,
      status: deriveStatus(this.summary, { syncing: this.syncing, online: this.options.isOnline(), now: Date.now() }),
      notice: this.summary?.notice ? { kind: 'signed_out', accountName: this.summary.notice.accountName } : null
    };
  }

  private emit() {
    const snapshot = this.buildSnapshot();
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    const { pausedUntil } = snapshot.status;
    // "Paused" ends by the clock, so re-derive the status then.
    if (pausedUntil !== null) {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = null;
        this.emit();
      }, pausedUntil - Date.now());
    }
    const key = JSON.stringify(snapshot);
    if (key === this.snapshotKey) return;
    this.snapshotKey = key;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private setDetails(token: string, account: Account) {
    if (this.summary?.account?.token !== token) return;
    this.details = { token, account };
    this.emit();
  }

  private logoutQuietly(token: string) {
    this.options.api.logout(token).catch((error: unknown) => console.warn('Unable to sign out of the backup server', error));
  }

  /** One backup action at a time: a second tap while one is running is ignored (the UI disables its buttons). */
  private exclusive(action: AuthAction, work: () => Promise<Outcome>): Promise<Outcome> {
    if (this.operation) return Promise.resolve({ status: 'ignored' });
    const operation = work()
      .catch((error: unknown) => this.fail(error, action))
      .finally(() => {
        this.operation = null;
      });
    this.operation = operation;
    return operation;
  }

  private async fail(error: unknown, action: AuthAction, token?: string): Promise<Outcome> {
    if (token !== undefined && isHttpError(error, 401)) await this.signedOutByServer(token);
    const outcome = describeFailure(error, action);
    // Only the unexplained ones are errors; the rest (offline, a passkey the server doesn't know…) are expected.
    if (outcome.status === 'failed' && outcome.message === MESSAGES.generic) console.error(`Backup action failed (${action})`, error);
    else if (outcome.status === 'failed' && !outcome.neutral) console.warn(`Backup action failed (${action})`, error);
    return outcome;
  }

  private async commitSignIn(signIn: SignIn, add: 'all' | 'missing' | 'none') {
    const { token, account, state, clockOffset } = signIn;
    await beginBackup({ account: { token, userHandle: account.userHandle, name: account.name }, state, clockOffset, add });
    this.details = { token, account };
    this.clearFailure();
    this.batchRows = LIMITS.maxChangesPerRequest;
    await this.refresh();
    void this.requestRun('signin');
  }

  turnOn = (): Promise<Outcome> => this.exclusive('turnOn', async () => {
    this.cancelRestore();
    if (this.summary?.account) return DONE;
    try {
      await this.commitSignIn(await this.options.auth.createBackup(), 'all');
      return DONE;
    } catch (error) {
      return this.fail(error, 'turnOn');
    }
  });

  restore = (): Promise<Outcome> => this.exclusive('restore', async () => {
    this.cancelRestore();
    if (this.summary?.account) return DONE;
    let signIn: SignIn;
    try {
      signIn = await this.options.auth.openBackup();
    } catch (error) {
      return this.fail(error, 'restore');
    }
    this.pendingRestore = signIn;
    try {
      const localOnly = await findLocalOnlyItems(signIn.state);
      if (countItemIds(localOnly) === 0) return await this.commitRestore(true);
      const stations = new Set([...(localOnly.entered ?? []), ...(localOnly.changed ?? [])]);
      return {
        status: 'confirm',
        merge: {
          accountName: signIn.account.name,
          resetAt: signIn.state.resetAt,
          sections: localOnly.sections?.length ?? 0,
          walks: localOnly.walks?.length ?? 0,
          stations: stations.size
        }
      };
    } catch (error) {
      this.cancelRestore();
      return this.fail(error, 'restore');
    }
  });

  private async commitRestore(addLocal: boolean): Promise<Outcome> {
    const pending = this.pendingRestore;
    this.pendingRestore = null;
    if (!pending) return { status: 'failed', message: MESSAGES.generic, neutral: false };
    try {
      await this.commitSignIn(pending, addLocal ? 'missing' : 'none');
      return DONE;
    } catch (error) {
      this.logoutQuietly(pending.token);
      return this.fail(error, 'restore');
    }
  }

  confirmRestore = (addLocal: boolean): Promise<Outcome> => this.exclusive('restore', () => this.commitRestore(addLocal));

  cancelRestore = (): void => {
    const pending = this.pendingRestore;
    this.pendingRestore = null;
    if (pending) this.logoutQuietly(pending.token);
  };

  /** Runs a sensitive action; if the server wants a recent passkey check, does one (same tap) and tries again. */
  private async withRecentAuth<T>(token: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!isHttpError(error, 403, 'reauth_required')) throw error;
      await this.options.auth.confirmIdentity(token);
      return action();
    }
  }

  private signedInToken(): string | null {
    return this.summary?.account?.token ?? null;
  }

  addPasskey = (): Promise<Outcome> => this.exclusive('addPasskey', async () => {
    const token = this.signedInToken();
    if (!token) return { status: 'failed', message: MESSAGES.signedOut, neutral: false };
    try {
      this.setDetails(token, await this.options.auth.addPasskey(token));
      return DONE;
    } catch (error) {
      if (!isHttpError(error, 403, 'reauth_required')) return this.fail(error, 'addPasskey', token);
    }
    // Confirming it's you is a passkey ceremony of its own, so creating the new passkey needs another tap.
    try {
      await this.options.auth.confirmIdentity(token);
      return { status: 'verified' };
    } catch (error) {
      return this.fail(error, 'manage', token);
    }
  });

  removePasskey = (id: string): Promise<Outcome> => this.exclusive('manage', async () => {
    const token = this.signedInToken();
    if (!token) return { status: 'failed', message: MESSAGES.signedOut, neutral: false };
    try {
      this.setDetails(token, await this.withRecentAuth(token, () => this.options.api.deletePasskey(token, id)));
      return DONE;
    } catch (error) {
      return this.fail(error, 'manage', token);
    }
  });

  signOutOthers = (): Promise<Outcome> => this.exclusive('manage', async () => {
    const token = this.signedInToken();
    if (!token) return { status: 'failed', message: MESSAGES.signedOut, neutral: false };
    try {
      await this.withRecentAuth(token, () => this.options.api.revokeOtherSessions(token));
      return DONE;
    } catch (error) {
      return this.fail(error, 'manage', token);
    }
  });

  turnOff = ({ backUpFirst, removeLocal }: { backUpFirst: boolean; removeLocal: boolean }): Promise<Outcome> => this.exclusive('manage', async () => {
    const account = (await readSyncSummary()).account;
    if (!account) return DONE;
    if (backUpFirst) {
      if (!this.retryAfterActive()) {
        this.resetBackoff();
        this.clearDebounce();
        await this.requestRun('manual');
      }
      const after = await readSyncSummary();
      if (after.account?.token === account.token && after.unsent > 0) return { status: 'failed', message: MESSAGES.notBackedUp, neutral: false };
    }
    await endBackup({ token: account.token, removeLocal });
    this.details = null;
    this.clearDebounce();
    this.clearFailure();
    this.logoutQuietly(account.token);
    await this.refresh();
    return DONE;
  });

  deleteBackup = (): Promise<Outcome> => this.exclusive('manage', async () => {
    const account = this.summary?.account;
    if (!account) return DONE;
    try {
      await this.withRecentAuth(account.token, () => this.options.api.deleteAccount(account.token));
    } catch (error) {
      return this.fail(error, 'manage', account.token);
    }
    await endBackup({ token: account.token });
    this.details = null;
    this.clearDebounce();
    this.clearFailure();
    this.options.auth.signalBackupDeleted(account.userHandle);
    await this.refresh();
    return DONE;
  });

  dismissNotice = (): void => {
    dismissSyncNotice()
      .then(() => this.refresh())
      .catch((error: unknown) => console.error('Unable to dismiss the backup notice', error));
  };

  prepare = (): void => {
    if (!this.options.configured) return;
    if (!this.summary) {
      this.prepareWhenLoaded = true;
      if (!this.started) void this.refresh();
      return;
    }
    this.prepareWhenLoaded = false;
    const account = this.summary.account;
    if (!account) {
      if (this.options.passkeysAvailable()) this.options.auth.prefetchSignInOptions();
      return;
    }
    if (this.details?.token === account.token || this.loadingDetails || Date.now() - this.detailsFailedAt < ACCOUNT_RETRY_MS) return;
    this.loadingDetails = true;
    this.options.api.fetchAccount(account.token)
      .then((details) => this.setDetails(account.token, details))
      .catch(async (error: unknown) => {
        this.detailsFailedAt = Date.now();
        if (isHttpError(error, 401)) await this.signedOutByServer(account.token);
        else console.warn('Unable to load the backup’s passkeys', error);
      })
      .finally(() => {
        this.loadingDetails = false;
      });
  };
}

let engine: SyncEngine | null = null;

function getEngine(): SyncEngine {
  engine ??= new SyncEngine({
    configured: SYNC_CONFIGURED,
    api: defaultApi,
    auth: defaultAuth,
    passkeysAvailable: () => typeof window !== 'undefined' && 'PublicKeyCredential' in window,
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    document: typeof document === 'undefined' ? null : document,
    window: typeof window === 'undefined' ? null : window,
    locks: typeof navigator === 'undefined' ? null : navigator.locks ?? null
  });
  return engine;
}

/** Starts backup for this page (from main.tsx). Does nothing in a build without VITE_SYNC_URL. Idempotent. */
export function startSync(): void {
  getEngine().start();
}

/** Something was queued for backup: sync after the debounce. */
export function nudgeSync(): void {
  engine?.nudge();
}

export const subscribeSync = (listener: () => void) => getEngine().subscribe(listener);
export const getSyncSnapshot = (): SyncSnapshot => getEngine().getSnapshot();

export function getSyncActions(): SyncActions {
  const { turnOn, restore, confirmRestore, cancelRestore, addPasskey, removePasskey, signOutOthers, backUpNow, turnOff, deleteBackup, dismissNotice, prepare } = getEngine();
  return { turnOn, restore, confirmRestore, cancelRestore, addPasskey, removePasskey, signOutOthers, backUpNow, turnOff, deleteBackup, dismissNotice, prepare };
}
