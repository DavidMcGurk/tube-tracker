import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRoute, sections } from '../data/network';
import { sanitizeProgress } from './progress';
import {
  beginBackup,
  db,
  endUndoWindow,
  readJourneyUndo,
  readSyncSummary,
  recordJourney,
  resetStoredProgress,
  undoLastJourney,
  UNDO_WINDOW_MS,
  updateProgress,
  type SyncSummary
} from './storage';
import {
  BACKOFF_MIN_MS,
  classifyFailure,
  deriveStatus,
  LOCAL_CHANGE_DELAY_MS,
  LOCK_NAME,
  MAX_REQUESTS_PER_RUN,
  STALE_AFTER_MS,
  STATUS_MESSAGES,
  SyncEngine,
  type SyncApi,
  type SyncAuth,
  type SyncEngineOptions
} from './sync';
import { SyncHttpError, SyncNetworkError, type Account, type SignIn } from './sync-api';
import { MESSAGES } from './sync-auth';
import { applyChange, emptyState, isPlausibleTime, validateState, type Change, type SyncState } from './sync-model';
import type { Progress, RouteResult } from './types';

const T = 1_800_000_000_000;
const ACCOUNT: Account = { userHandle: 'user-1', name: 'Tube Tracker · K3F9', createdAt: T - 1000, passkeys: [] };
const [S1, S2] = sections.map((section) => section.id) as [string, string];

function route(start: string, end: string): RouteResult {
  const found = findRoute(start, end);
  if (!found) throw new Error(`Expected a route from ${start} to ${end}`);
  return found;
}

const sectionIds = (journey: RouteResult) => journey.sections.map((section) => section.id);
const sorted = (ids: readonly string[]) => [...ids].sort();
const storedProgress = async (): Promise<Progress> => sanitizeProgress((await db.progress.get('current'))?.value);
const summary = () => readSyncSummary();

/** The backup server, in memory, applying the shared model's rules (including the clock check). */
function fakeServer() {
  const server = {
    state: emptyState(),
    /** The server's clock minus this device's. */
    offset: 0,
    tokens: new Set(['t1']),
    requests: [] as Change[][],
    /** Thrown (in order) instead of answering. */
    failures: [] as unknown[],
    reject: (_change: Change): string | null => null,
    /** When set, each request waits for this before answering. */
    gate: null as Promise<void> | null,
    api: null as unknown as SyncApi & { [K in keyof SyncApi]: ReturnType<typeof vi.fn> }
  };
  const answerState = () => validateState(JSON.parse(JSON.stringify(server.state)))!;
  server.api = {
    pushChanges: vi.fn(async (token: string, changes: readonly Change[]) => {
      server.requests.push(changes.map((change) => structuredClone(change)));
      if (server.gate) await server.gate;
      const failure = server.failures.shift();
      if (failure) throw failure;
      if (!server.tokens.has(token)) throw new SyncHttpError({ status: 401, code: 'unauthorized' });
      if (changes.some((change) => !isPlausibleTime(change.at, Date.now() + server.offset))) {
        throw new SyncHttpError({ status: 409, code: 'clock_skew', clockOffset: server.offset });
      }
      const rejected: Array<{ id: string; code: string }> = [];
      for (const change of changes) {
        const code = server.reject(change);
        if (code) rejected.push({ id: change.id, code });
        else server.state = applyChange(server.state, change);
      }
      return { state: answerState(), clockOffset: server.offset, rejected };
    }),
    fetchAccount: vi.fn(async () => ACCOUNT),
    deletePasskey: vi.fn(async () => ACCOUNT),
    revokeOtherSessions: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    deleteAccount: vi.fn(async () => undefined)
  };
  return server;
}

type Server = ReturnType<typeof fakeServer>;

function fakeAuth(server: Server) {
  const signIn = (): SignIn => ({ token: 't1', account: ACCOUNT, state: validateState(JSON.parse(JSON.stringify(server.state)))!, clockOffset: server.offset });
  return {
    createBackup: vi.fn(async () => signIn()),
    openBackup: vi.fn(async () => signIn()),
    confirmIdentity: vi.fn(async () => undefined),
    addPasskey: vi.fn(async () => ACCOUNT),
    prefetchSignInOptions: vi.fn(),
    signalBackupDeleted: vi.fn()
  } satisfies SyncAuth;
}

function setup(overrides: Partial<SyncEngineOptions> = {}) {
  const server = fakeServer();
  const auth = fakeAuth(server);
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const window = new EventTarget();
  const env = { online: true };
  const engine = new SyncEngine({
    configured: true,
    api: server.api,
    auth,
    passkeysAvailable: () => true,
    isOnline: () => env.online,
    document,
    window,
    locks: null,
    observe: false,
    random: () => 0.5,
    ...overrides
  });
  engines.push(engine);
  const setVisibility = (state: DocumentVisibilityState) => {
    document.visibilityState = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return { server, auth, engine, env, window, setVisibility };
}

const engines: SyncEngine[] = [];

/** Signed in with an up-to-date, empty backup. */
async function signIn(state: SyncState = emptyState(), add: 'all' | 'missing' | 'none' = 'none') {
  await beginBackup({ account: { token: 't1', userHandle: ACCOUNT.userHandle, name: ACCOUNT.name }, state, clockOffset: 0, add });
}

/**
 * Records a journey and closes its undo window, as dismissing the undo bar does (or as if it had been recorded more than
 * five minutes ago), so its add is due at once. The timed undo itself is tested in "timed undo" below.
 */
async function recordAndClose(journey: RouteResult) {
  const result = await recordJourney(journey);
  await endUndoWindow();
  return result;
}

/** Records a journey the way useProgress does (storage, then a nudge), with its undo window closed. */
async function record(engine: SyncEngine, journey: RouteResult) {
  const result = await recordAndClose(journey);
  if (result.queued) engine.nudge();
}

async function reset(engine: SyncEngine) {
  const result = await resetStoredProgress();
  if (result.queued) engine.nudge();
}

async function advance(ms: number, engine: SyncEngine) {
  await vi.advanceTimersByTimeAsync(ms);
  await engine.idle();
}

async function started(engine: SyncEngine) {
  engine.start();
  await engine.idle();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T);
  await Dexie.delete('tube-tracker-db');
});

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    engine.stop();
    await engine.idle();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('triggers', () => {
  it('starts by fetching only when the last sync is stale, and never polls', async () => {
    await signIn();
    const { engine, server, setVisibility } = setup();
    await started(engine);
    expect(server.requests).toHaveLength(0);

    await advance(60 * 60 * 1000, engine);
    expect(server.requests).toHaveLength(0);

    setVisibility('hidden');
    setVisibility('visible');
    await engine.idle();
    expect(server.requests).toEqual([[]]);

    setVisibility('visible');
    await engine.idle();
    expect(server.requests).toHaveLength(1);
  });

  it('starts by sending unsent rows', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const { engine, server } = setup();
    await started(engine);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toHaveLength(1);
    expect(await summary()).toMatchObject({ unsent: 0, lastSyncedAt: T });
  });

  it('debounces local changes into one request', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await record(engine, route('paddington', 'waterloo'));
    await advance(LOCAL_CHANGE_DELAY_MS - 500, engine);
    await record(engine, route('bank', 'stratford'));
    await advance(LOCAL_CHANGE_DELAY_MS - 1, engine);
    expect(server.requests).toHaveLength(0);
    await advance(1, engine);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toHaveLength(2);
    expect(Object.keys(server.state.items.sections).length).toBeGreaterThan(0);
  });

  it('flushes at once when the page is hidden with unsent rows', async () => {
    await signIn();
    const { engine, server, setVisibility } = setup();
    await started(engine);
    setVisibility('hidden');
    await engine.idle();
    expect(server.requests).toHaveLength(0);
    await record(engine, route('paddington', 'waterloo'));
    setVisibility('hidden');
    await engine.idle();
    expect(server.requests).toHaveLength(1);
    // The debounce was cancelled, so nothing more is sent later.
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(server.requests).toHaveLength(1);
  });

  it('sends at most 5 requests per run', async () => {
    await signIn();
    await db.outbox.bulkAdd(Array.from({ length: 1001 }, (_, index) => ({ change: { id: `c${index}`, type: 'add' as const, at: T - 5000 + index, items: { sections: [S1] } } })));
    const { engine, server } = setup();
    await started(engine);
    expect(server.requests).toHaveLength(MAX_REQUESTS_PER_RUN);
    expect(server.requests.every((batch) => batch.length === 200)).toBe(true);
    expect((await summary()).unsent).toBe(1);
  });

  it('“Back up now” always syncs and re-queues held rows as one fresh add', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    server.reject = () => 'backup_full';
    await record(engine, route('paddington', 'waterloo'));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect((await summary()).held).toBe(1);

    server.reject = () => null;
    // Resolves once its sync has finished, so the UI can announce the result.
    await engine.backUpNow();
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).toEqual([expect.objectContaining({ type: 'add', items: { sections: sectionIds(route('paddington', 'waterloo')), entered: ['paddington', 'waterloo'] } })]);
    expect(await summary()).toMatchObject({ held: 0, unsent: 0 });
  });

  it('runs inside the Web Lock, and unlocked if the lock isn’t granted in time', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const request = vi.fn(async (_name: string, _options: LockOptions, callback: () => Promise<void>) => callback());
    const { engine, server } = setup({ locks: { request } as unknown as LockManager });
    await started(engine);
    expect(request).toHaveBeenCalledWith(LOCK_NAME, expect.objectContaining({ signal: expect.any(AbortSignal) }), expect.any(Function));
    expect(server.requests).toHaveLength(1);

    const timedOut = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const second = setup({ locks: { request: timedOut } as unknown as LockManager });
    second.server.state = server.state;
    await recordAndClose(route('bank', 'stratford'));
    await started(second.engine);
    expect(timedOut).toHaveBeenCalled();
    expect(second.server.requests).toHaveLength(1);
  });
});

describe('failures', () => {
  it('backs off exponentially after network errors, and coming back resets the backoff', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const { engine, server, setVisibility } = setup();
    server.failures.push(new SyncNetworkError({ offline: false, timedOut: false }), new SyncNetworkError({ offline: false, timedOut: true }));
    await started(engine);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'waiting', error: { code: 'unavailable', message: STATUS_MESSAGES.unavailable } });

    await advance(BACKOFF_MIN_MS - 1, engine);
    expect(server.requests).toHaveLength(1);
    await advance(1, engine);
    expect(server.requests).toHaveLength(2);
    // Second wait: doubled.
    await advance(BACKOFF_MIN_MS * 2 - 1, engine);
    expect(server.requests).toHaveLength(2);
    setVisibility('visible');
    await engine.idle();
    expect(server.requests).toHaveLength(3);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', error: null, unsent: false });
  });

  it('says “waiting for a connection” only when the browser is offline', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const { engine, server, env } = setup();
    env.online = false;
    server.failures.push(new SyncNetworkError({ offline: true, timedOut: false }));
    await started(engine);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'waiting', unsent: true, error: { code: 'offline', message: STATUS_MESSAGES.offline } });
  });

  it('honours Retry-After: paused, with nothing sent until it ends', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const { engine, server, setVisibility, window } = setup();
    const pause = 3 * 60 * 60 * 1000;
    server.failures.push(new SyncHttpError({ status: 503, code: 'over_capacity', retryAfterMs: pause }));
    await started(engine);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'paused', pausedUntil: T + pause });

    await record(engine, route('bank', 'stratford'));
    setVisibility('visible');
    window.dispatchEvent(new Event('online'));
    engine.backUpNow();
    await advance(pause - 1, engine);
    expect(server.requests).toHaveLength(1);
    await advance(1, engine);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).toHaveLength(2);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', pausedUntil: null });
  });

  it('keeps waiting out a Retry-After across a reload', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const first = setup();
    first.server.failures.push(new SyncHttpError({ status: 429, code: 'rate_limited', retryAfterMs: 30_000 }));
    await started(first.engine);
    first.engine.stop();

    const second = setup();
    await started(second.engine);
    expect(second.server.requests).toHaveLength(0);
    await advance(30_000, second.engine);
    expect(second.server.requests).toHaveLength(1);
  });

  it('keeps everything after a refused request, and only retries on start or “Back up now”', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await record(engine, route('paddington', 'waterloo'));
    const before = await storedProgress();
    server.failures.push(new SyncHttpError({ status: 400, code: 'invalid' }));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'error', unsent: true, error: { code: 'invalid', message: STATUS_MESSAGES.failed } });
    expect(await storedProgress()).toEqual(before);

    await record(engine, route('bank', 'stratford'));
    await advance(60 * 60 * 1000, engine);
    expect(server.requests).toHaveLength(1);

    engine.backUpNow();
    await engine.idle();
    expect(server.requests).toHaveLength(2);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', error: null, unsent: false });
  });

  it('halves the batch after 413', async () => {
    await signIn();
    await db.outbox.bulkAdd(Array.from({ length: 10 }, (_, index) => ({ change: { id: `c${index}`, type: 'add' as const, at: T - 100 + index, items: { sections: [S1] } } })));
    const { engine, server } = setup();
    server.failures.push(new SyncHttpError({ status: 413, code: 'too_large' }));
    await started(engine);
    expect(server.requests.map((batch) => batch.length)).toEqual([10, 5, 5]);
    expect((await summary()).unsent).toBe(0);
  });

  it('never shrinks progress for refused changes', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    server.reject = (change) => (change.type === 'add' ? 'backup_full' : null);
    await record(engine, route('paddington', 'waterloo'));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(sectionIds(route('paddington', 'waterloo'))));
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', heldCount: 1, unsent: false });

    // Later syncs don't send it, re-queue it, or drop it.
    engine.backUpNow();
    await engine.idle();
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(sectionIds(route('paddington', 'waterloo'))));
    expect(engine.getSnapshot().status.heldCount).toBe(1);
  });
});

describe('applying answers', () => {
  it('pushes a write from an old version-1 tab, which survives the sync', async () => {
    await signIn();
    const { engine, server, setVisibility } = setup();
    await started(engine);
    const oldTab = new Dexie('tube-tracker-db');
    oldTab.version(1).stores({ progress: 'id', settings: 'id' });
    await oldTab.table('progress').put({ id: 'current', value: { travelledSegmentIDs: [S1, S2], walkedLinkIDs: [], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] } });
    oldTab.close();

    vi.setSystemTime(T + STALE_AFTER_MS);
    setVisibility('visible');
    await engine.idle();
    // The first request fetched; reconcile then queued the old tab's ids and the same run sent them.
    expect(server.requests).toEqual([[], [expect.objectContaining({ type: 'add', items: { sections: [S1, S2] } })]]);
    expect(sorted(Object.keys(server.state.items.sections))).toEqual(sorted([S1, S2]));
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted([S1, S2]));
  });

  it('restores what a rolled-back server lost, with the original times', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await record(engine, route('paddington', 'waterloo'));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    const before = structuredClone(server.state);
    expect(Object.keys(before.items.sections).length).toBeGreaterThan(0);

    server.state = emptyState();
    engine.backUpNow();
    await engine.idle();
    expect(server.requests).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(server.state))).toEqual(JSON.parse(JSON.stringify(before)));
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(sectionIds(route('paddington', 'waterloo'))));
  });

  it('ignores an answer for a session that changed while the request was out', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    let open: () => void = () => undefined;
    server.gate = new Promise((resolve) => { open = resolve; });
    server.state = applyChange(server.state, { id: 'x', type: 'add', at: T - 10, items: { sections: [S1] } });
    engine.backUpNow();
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));

    // Meanwhile this device signs out and in again (a different session).
    await beginBackup({ account: { token: 't2', userHandle: 'user-2', name: 'Tube Tracker · ZZZZ' }, state: emptyState(), clockOffset: 0, add: 'none' });
    open();
    await engine.idle();
    expect((await summary()).account?.token).toBe('t2');
    expect(await storedProgress()).toEqual({ travelledSegmentIDs: [], walkedLinkIDs: [], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] });
    expect(await db.sync.get('state')).toMatchObject({ value: emptyState() });
  });

  it('signs out with a notice on 401, keeping local journeys', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const before = await storedProgress();
    const { engine, server } = setup();
    server.tokens.clear();
    await started(engine);
    expect(await summary()).toMatchObject({ account: null, unsent: 0, notice: { kind: 'signed_out', accountName: ACCOUNT.name } });
    expect(engine.getSnapshot()).toMatchObject({ account: null, status: { phase: 'signed_out' }, notice: { kind: 'signed_out', accountName: ACCOUNT.name } });
    expect(await storedProgress()).toEqual(before);

    engine.dismissNotice();
    await vi.waitFor(() => expect(engine.getSnapshot().notice).toBeNull());
    expect(engine.getSnapshot().status.phase).toBe('off');
  });
});

describe('clocks', () => {
  it('a fast clock: a reset then a journey in one batch keeps the journey', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    // This device's clock is 10 minutes fast and it hasn't synced since: its offset is stale.
    server.offset = -10 * 60 * 1000;
    await reset(engine);
    await record(engine, route('paddington', 'waterloo'));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.map((change) => change.type)).toEqual(['reset', 'add']);
    expect(sorted(Object.keys(server.state.items.sections))).toEqual(sorted(sectionIds(route('paddington', 'waterloo'))));
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(sectionIds(route('paddington', 'waterloo'))));
    expect(await db.sync.get('clock')).toMatchObject({ offset: -10 * 60 * 1000 });
  });

  it('a clock years slow is corrected and its journey accepted', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    const slow = T - 1_500_000_000_000;
    vi.setSystemTime(slow);
    server.offset = T - slow;
    await record(engine, route('paddington', 'waterloo'));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]![0]!.at).toBeGreaterThanOrEqual(T);
    expect(Object.keys(server.state.items.sections).length).toBeGreaterThan(0);
  });

  it('gives up after two corrections and waits', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const { engine, server } = setup();
    server.failures.push(...Array.from({ length: 3 }, () => new SyncHttpError({ status: 409, code: 'clock_skew', clockOffset: 0 })));
    await started(engine);
    expect(server.requests).toHaveLength(3);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'waiting', error: { code: 'clock_skew' } });
  });
});

describe('scenarios', () => {
  it('a reset on another device, then a journey here over old track: the journey is kept', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    const journey = route('paddington', 'waterloo');
    await record(engine, journey);
    await advance(LOCAL_CHANGE_DELAY_MS, engine);

    // Device B resets; this device hasn't heard yet and records the same journey (nothing new locally).
    vi.setSystemTime(T + 60_000);
    server.state = applyChange(server.state, { id: 'b-reset', type: 'reset', at: Date.now() });
    vi.setSystemTime(T + 120_000);
    const { progress, queued } = await recordJourney(journey);
    expect(queued).toBe(true);
    expect(sorted(progress.travelledSegmentIDs)).toEqual(sorted(sectionIds(journey)));
    engine.nudge();
    await advance(LOCAL_CHANGE_DELAY_MS, engine);

    expect(sorted(Object.keys(server.state.items.sections))).toEqual(sorted(sectionIds(journey)));
    expect(sorted((await storedProgress()).travelledSegmentIDs)).toEqual(sorted(sectionIds(journey)));
  });

  it('a reset on another device clears this one at the next sync', async () => {
    await signIn();
    const { engine, server, setVisibility } = setup();
    await started(engine);
    await record(engine, route('paddington', 'waterloo'));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    server.state = applyChange(server.state, { id: 'b-reset', type: 'reset', at: Date.now() + 1000 });
    // Coming back under 2 minutes after the last sync doesn't fetch; after that it does.
    vi.setSystemTime(Date.now() + STALE_AFTER_MS - 1);
    setVisibility('visible');
    await engine.idle();
    expect(server.requests).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1);
    setVisibility('visible');
    await engine.idle();
    expect(server.requests).toHaveLength(2);
    expect(await storedProgress()).toEqual({ travelledSegmentIDs: [], walkedLinkIDs: [], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] });
  });
});

describe('account actions', () => {
  it('turning on queues this device’s journeys and backs them up', async () => {
    await updateProgress(() => ({ travelledSegmentIDs: [S1, S2], walkedLinkIDs: [], stationsEnteredOrExitedIDs: ['bank'], stationsChangedAtIDs: [] }));
    const { engine, server } = setup();
    await started(engine);
    expect(engine.getSnapshot()).toMatchObject({ available: true, account: null, status: { phase: 'off' } });
    expect(await engine.turnOn()).toEqual({ status: 'done' });
    await engine.idle();
    expect(server.requests).toEqual([[expect.objectContaining({ type: 'add', items: { sections: [S1, S2], entered: ['bank'] } })]]);
    expect(engine.getSnapshot()).toMatchObject({ account: { name: ACCOUNT.name, passkeys: [] }, status: { phase: 'idle', unsent: false } });
  });

  it('restoring asks before adding this device’s journeys, and “Don’t add them” shows the backup’s', async () => {
    await updateProgress(() => ({ travelledSegmentIDs: [S1], walkedLinkIDs: [], stationsEnteredOrExitedIDs: ['bank'], stationsChangedAtIDs: ['bank'] }));
    const { engine, server } = setup();
    server.state = applyChange(server.state, { id: 'x', type: 'add', at: T - 10, items: { sections: [S2] } });
    await started(engine);
    expect(await engine.restore()).toEqual({ status: 'confirm', merge: { accountName: ACCOUNT.name, resetAt: 0, sections: 1, walks: 0, stations: 1 } });
    expect((await summary()).account).toBeNull();
    expect(await engine.confirmRestore(false)).toEqual({ status: 'done' });
    await engine.idle();
    expect(await storedProgress()).toEqual({ travelledSegmentIDs: [S2], walkedLinkIDs: [], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] });
    expect(server.requests).toHaveLength(0);
  });

  it('cancelling a restore signs that session out again', async () => {
    await updateProgress(() => ({ travelledSegmentIDs: [S1], walkedLinkIDs: [], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] }));
    const { engine, server } = setup();
    await started(engine);
    expect((await engine.restore()).status).toBe('confirm');
    engine.cancelRestore();
    expect(server.api.logout).toHaveBeenCalledWith('t1');
    expect((await summary()).account).toBeNull();
    expect(await engine.confirmRestore(true)).toMatchObject({ status: 'failed' });
  });

  it('a cancelled passkey window is neutral, and one action runs at a time', async () => {
    const { engine, auth } = setup();
    await started(engine);
    let fail: (error: unknown) => void = () => undefined;
    auth.createBackup.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const first = engine.turnOn();
    expect(await engine.restore()).toEqual({ status: 'ignored' });
    fail(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    expect(await first).toEqual({ status: 'failed', message: MESSAGES.noPasskey, neutral: true });
  });

  it('deleting confirms it’s you when asked, then signs out keeping journeys and signals the passkeys', async () => {
    await signIn();
    await recordAndClose(route('paddington', 'waterloo'));
    const before = await storedProgress();
    const { engine, server, auth } = setup();
    await started(engine);
    server.api.deleteAccount.mockRejectedValueOnce(new SyncHttpError({ status: 403, code: 'reauth_required' }));
    expect(await engine.deleteBackup()).toEqual({ status: 'done' });
    expect(auth.confirmIdentity).toHaveBeenCalledWith('t1');
    expect(server.api.deleteAccount).toHaveBeenCalledTimes(2);
    expect(auth.signalBackupDeleted).toHaveBeenCalledWith(ACCOUNT.userHandle);
    expect(await summary()).toMatchObject({ account: null, unsent: 0, notice: null });
    expect(await storedProgress()).toEqual(before);
  });

  it('adding a passkey when not recently verified confirms it’s you first, using up the tap', async () => {
    await signIn();
    const { engine, auth } = setup();
    await started(engine);
    auth.addPasskey.mockRejectedValueOnce(new SyncHttpError({ status: 403, code: 'reauth_required' }));
    expect(await engine.addPasskey()).toEqual({ status: 'verified' });
    expect(await engine.addPasskey()).toEqual({ status: 'done' });
    expect(auth.addPasskey).toHaveBeenCalledTimes(2);
  });

  it('turning off can back up first, and keeps or removes local journeys', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await record(engine, route('paddington', 'waterloo'));
    expect(await engine.turnOff({ backUpFirst: true, removeLocal: false })).toEqual({ status: 'done' });
    expect(server.requests).toHaveLength(1);
    expect(server.api.logout).toHaveBeenCalledWith('t1');
    expect(await summary()).toMatchObject({ account: null, unsent: 0 });
    expect((await storedProgress()).travelledSegmentIDs.length).toBeGreaterThan(0);

    await signIn();
    expect(await engine.turnOff({ backUpFirst: false, removeLocal: true })).toEqual({ status: 'done' });
    expect((await storedProgress()).travelledSegmentIDs).toEqual([]);
  });

  it('won’t turn off after “Back up first” fails', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await recordAndClose(route('paddington', 'waterloo'));
    server.failures.push(new SyncNetworkError({ offline: true, timedOut: false }));
    expect(await engine.turnOff({ backUpFirst: true, removeLocal: false })).toEqual({ status: 'failed', message: MESSAGES.notBackedUp, neutral: false });
    expect((await summary()).account).not.toBeNull();
  });

  it('prepare prefetches sign-in options when signed out, and loads the passkeys once when signed in', async () => {
    const { engine, server, auth } = setup();
    await started(engine);
    engine.prepare();
    expect(auth.prefetchSignInOptions).toHaveBeenCalledTimes(1);
    await signIn();
    await engine.idle();
    engine.nudge();
    await vi.waitFor(() => expect(engine.getSnapshot().account).not.toBeNull());
    engine.prepare();
    engine.prepare();
    await vi.waitFor(() => expect(engine.getSnapshot().account?.passkeys).toEqual([]));
    expect(server.api.fetchAccount).toHaveBeenCalledTimes(1);
  });
});

describe('timed undo', () => {
  const journey = route('paddington', 'waterloo');

  /** Records a journey the way useProgress does, leaving its undo window open. */
  async function recordUndoable(engine: SyncEngine, recorded: RouteResult = journey) {
    const result = await recordJourney(recorded);
    if (result.queued) engine.nudge();
  }

  it('skips the waiting add, staying “backed up”, and sends it when the window closes', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await recordUndoable(engine);
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(server.requests).toHaveLength(0);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', unsent: false, awaitingUndo: true });

    await advance(UNDO_WINDOW_MS - LOCAL_CHANGE_DELAY_MS - 1, engine);
    expect(server.requests).toHaveLength(0);
    await advance(1, engine);
    expect(server.requests).toEqual([[expect.objectContaining({ type: 'add', at: T, items: expect.objectContaining({ sections: sectionIds(journey) }) })]]);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', unsent: false, awaitingUndo: false });
    expect(await summary()).toMatchObject({ unsent: 0, undoWaits: [] });
  });

  it('leaving the app ends the window, so the journey is backed up now rather than when the app is next opened', async () => {
    await signIn();
    const { engine, server, setVisibility } = setup();
    await started(engine);
    await recordUndoable(engine);
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(server.requests).toHaveLength(0);

    setVisibility('hidden');
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    await engine.idle();
    expect(server.requests).toEqual([[expect.objectContaining({ type: 'add', at: T, items: expect.objectContaining({ sections: sectionIds(journey) }) })]]);
    expect(await readJourneyUndo()).toBeNull();
    expect((await undoLastJourney()).outcome).toBe('expired');
    expect(await summary()).toMatchObject({ unsent: 0, undoWaits: [] });
  });

  it('leaving the app while backup is off keeps the undo', async () => {
    const { engine, setVisibility } = setup();
    await started(engine);
    await recordJourney(journey);
    setVisibility('hidden');
    await advance(1000, engine);
    expect(await readJourneyUndo()).not.toBeNull();
    expect((await undoLastJourney()).outcome).toBe('undone');
  });

  it('a window opened by a clock that has since been put back is over: the journey is sent, and can’t be undone', async () => {
    await signIn();
    // Recorded while this device's clock was 30 days fast (past what a timer can wait), then the clock was corrected.
    vi.setSystemTime(T + 30 * 86_400_000);
    await recordJourney(journey);
    vi.setSystemTime(T);
    expect(await readJourneyUndo()).toBeNull();
    expect(await summary()).toMatchObject({ unsent: 1, undoWaits: [] });

    const { engine, server } = setup();
    await started(engine);
    // Sent on the first run: once with the fast clock's time (clock_skew), then moved back to the server's present.
    expect(server.requests).toHaveLength(2);
    expect(Object.keys(server.state.items.sections).sort()).toEqual(sorted(sectionIds(journey)));
    expect(await summary()).toMatchObject({ unsent: 0, undoWaits: [] });
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', awaitingUndo: false });
    expect((await undoLastJourney()).outcome).toBe('expired');
    // And nothing keeps running (a release timer set by the old window would fire at once, over and over).
    await advance(UNDO_WINDOW_MS, engine);
    expect(server.requests).toHaveLength(2);
  });

  it('an undone journey never reaches the backup', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await recordUndoable(engine);
    await advance(60_000, engine);
    expect((await undoLastJourney()).outcome).toBe('undone');
    engine.nudge();
    await advance(UNDO_WINDOW_MS, engine);
    expect(server.requests).toHaveLength(0);
    expect(engine.getSnapshot().status).toMatchObject({ phase: 'idle', unsent: false, awaitingUndo: false });
    // A later sync (another device's turn to fetch) doesn't bring it back.
    await engine.backUpNow();
    expect(server.requests).toEqual([[]]);
    expect(server.state).toEqual(emptyState());
    expect(await storedProgress()).toEqual({ travelledSegmentIDs: [], walkedLinkIDs: [], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] });
  });

  it('“Back up now” ends the window and sends it', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await recordUndoable(engine);
    await engine.backUpNow();
    expect(server.requests).toEqual([[expect.objectContaining({ type: 'add' })]]);
    expect(await readJourneyUndo()).toBeNull();
    expect((await undoLastJourney()).outcome).toBe('expired');
  });

  it('recording another journey releases the previous one, which is sent after the usual delay', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await recordUndoable(engine);
    await recordUndoable(engine, route('bank', 'stratford'));
    await advance(LOCAL_CHANGE_DELAY_MS, engine);
    expect(server.requests).toEqual([[expect.objectContaining({ items: expect.objectContaining({ sections: sectionIds(journey) }) })]]);
    expect(engine.getSnapshot().status).toMatchObject({ unsent: false, awaitingUndo: true });
    await advance(UNDO_WINDOW_MS, engine);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).toEqual([expect.objectContaining({ items: expect.objectContaining({ sections: sectionIds(route('bank', 'stratford')) }) })]);
  });

  it('a journey left waiting when the app closed is sent on the first run after its window', async () => {
    await signIn();
    await recordJourney(journey);
    // Reopened during the window: nothing is sent until it closes.
    const during = setup();
    await started(during.engine);
    expect(during.server.requests).toHaveLength(0);
    during.engine.stop();

    vi.setSystemTime(T + UNDO_WINDOW_MS + 60_000);
    const after = setup();
    await started(after.engine);
    expect(after.server.requests).toEqual([[expect.objectContaining({ type: 'add', at: T })]]);
  });

  it('turning off offers to back up a waiting journey first, which ends its window', async () => {
    await signIn();
    const { engine, server } = setup();
    await started(engine);
    await recordUndoable(engine);
    expect(await summary()).toMatchObject({ unsent: 1 });
    expect(await engine.turnOff({ backUpFirst: true, removeLocal: false })).toEqual({ status: 'done' });
    expect(server.requests).toEqual([[expect.objectContaining({ type: 'add' })]]);
    expect(await readJourneyUndo()).toBeNull();
  });
});

describe('deriveStatus', () => {
  const base: SyncSummary = {
    account: { id: 'account', token: 't', userHandle: 'u', name: 'n', signedInAt: T },
    unsent: 0,
    unsentReset: false,
    held: 0,
    lastSyncedAt: T,
    lastError: null,
    notice: null,
    undoWaits: []
  };
  const derive = (summary: SyncSummary | null, { syncing = false, online = true } = {}) => deriveStatus(summary, { syncing, online, now: T });

  it('is off or signed out without an account', () => {
    expect(derive(null).phase).toBe('off');
    expect(derive({ ...base, account: null }).phase).toBe('off');
    expect(derive({ ...base, account: null, notice: { kind: 'signed_out', accountName: 'n', at: T } }).phase).toBe('signed_out');
  });

  it('derives the other phases from the shared records', () => {
    expect(derive(base)).toEqual({ phase: 'idle', lastSyncedAt: T, unsent: false, awaitingUndo: false, unsentReset: false, heldCount: 0, error: null, pausedUntil: null });
    expect(derive({ ...base, unsent: 1, unsentReset: true })).toMatchObject({ unsent: true, unsentReset: true });
    expect(derive(base, { syncing: true }).phase).toBe('syncing');
    expect(derive({ ...base, unsent: 2 }, { online: false }).phase).toBe('waiting');
    expect(derive({ ...base, unsent: 2 }).phase).toBe('idle');
    const unavailable = { code: 'unavailable', message: 'x', retryable: true, retryAt: null };
    expect(derive({ ...base, unsent: 2, lastError: unavailable }).phase).toBe('waiting');
    expect(derive({ ...base, lastError: unavailable }).phase).toBe('idle');
    expect(derive({ ...base, lastError: { code: 'invalid', message: 'x', retryable: false, retryAt: null } }).phase).toBe('error');
    const paused = derive({ ...base, unsent: 1, lastError: { code: 'over_capacity', message: 'x', retryable: true, retryAt: T + 5 } });
    expect(paused).toMatchObject({ phase: 'paused', pausedUntil: T + 5 });
    expect(derive({ ...base, unsent: 1, lastError: { code: 'busy', message: 'x', retryable: true, retryAt: T + 5 } }).phase).toBe('waiting');
  });

  it('leaves a journey that can still be undone out of “unsent”, whatever the connection', () => {
    const waiting = { ...base, unsent: 1, undoWaits: [T + 1] };
    expect(derive(waiting)).toMatchObject({ phase: 'idle', unsent: false, awaitingUndo: true });
    expect(derive(waiting, { online: false })).toMatchObject({ phase: 'idle', unsent: false, awaitingUndo: true });
    expect(derive({ ...waiting, unsent: 2 }, { online: false })).toMatchObject({ phase: 'waiting', unsent: true, awaitingUndo: true });
    // Its window has closed: an ordinary unsent change.
    expect(derive({ ...waiting, undoWaits: [T] })).toMatchObject({ unsent: true, awaitingUndo: false });
  });
});

describe('classifyFailure', () => {
  it('retries outages and throttling, and stops on other client errors', () => {
    expect(classifyFailure(new SyncNetworkError({ offline: true, timedOut: false }))).toMatchObject({ code: 'offline', retryable: true });
    expect(classifyFailure(new SyncNetworkError({ offline: false, timedOut: true }))).toMatchObject({ code: 'unavailable', retryable: true });
    for (const [status, code] of [[500, 'internal'], [503, 'busy'], [409, 'busy'], [429, 'rate_limited']] as const) {
      expect(classifyFailure(new SyncHttpError({ status, code }))).toMatchObject({ retryable: true });
    }
    expect(classifyFailure(new SyncHttpError({ status: 503, code: 'over_capacity', retryAfterMs: 1000 }))).toMatchObject({ retryable: true, retryAfterMs: 1000, message: STATUS_MESSAGES.paused });
    for (const [status, code] of [[400, 'invalid'], [403, 'forbidden'], [404, 'http_404'], [413, 'too_large']] as const) {
      expect(classifyFailure(new SyncHttpError({ status, code }))).toMatchObject({ retryable: false, message: STATUS_MESSAGES.failed });
    }
  });
});
