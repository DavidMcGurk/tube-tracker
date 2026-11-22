# Backup & sync: design (v2)

Status: phase 1 contract. v2 includes 47 confirmed findings from an adversarial review (sync correctness, security, Cloudflare free plan, codebase fit, UX). Finding ids are in brackets.

## Goals

- **Automatic backup.** Progress survives cleared browser data, a lost or replaced device, and the gap between the Safari tab and the Home Screen app.
- **Sync across devices.** Every signed-in browser or app converges on the same progress.
- **Local-first.** IndexedDB stays the source the UI reads. The app works fully offline and with sync off. Sync is opt-in.
- **Never lose a journey the user recorded.** No server response, rejection, rollback or race may delete local progress, except a reset the user asked for, or "Don't add them" when restoring.
- **Robust for other people.** Strict validation, abuse limits, no 500s on bad input, old cached clients keep working, honest privacy copy, data can be deleted.
- **Free.** Cloudflare Workers + D1 + Cron Triggers on the free plan, which stops at its limits and never bills. Nothing that needs a payment method (no R2).

Non-goals for v1: a nudge to turn backup on, Android-specific work, undoing a reset, merging two separate backups.

## Phase 0 findings (real devices, 2026-11-21)

- **Where passkeys worked:** iPhone Safari, iPhone Chrome, the iPhone Home Screen app (in both directions with the tab), and Mac Chrome.
- **Where they're saved:** iCloud Keychain and Google Password Manager. All were synced and user-verified.
- **Timing:** WebAuthn called 12 s after the tap still worked on iOS with no extra sheet. The client still prefers prefetched options.

## Architecture

```
GitHub Pages (https://davidmcgurk.github.io/tube-tracker/)        Cloudflare (free plan)
┌───────────────────────────────────────────────┐   HTTPS + CORS   ┌──────────────────────────────┐
│ React app                                      │  Bearer token    │ Worker  tube-tracker-sync    │
│  IndexedDB (Dexie v2): progress, settings,     │ ───────────────► │  /v1/* JSON API, daily cron  │
│    outbox, sync                                │                  │  @simplewebauthn/server      │
│  SyncEngine singleton (started in main.tsx)    │ ◄─────────────── │ D1  tube-tracker-sync        │
│  @simplewebauthn/browser                       │   merged state   │  users, credentials,         │
└───────────────────────────────────────────────┘                  │  used_challenges, sessions,  │
                                                                    │  progress (1 row per user)   │
                                                                    └──────────────────────────────┘
```

- **Server location:** `sync-server/` has its own `package.json` (vitest ~4.1, `@cloudflare/vitest-pool-workers` ~0.23, wrangler 4.166, `engines.node >= 22.12`), plus `wrangler.jsonc`, `migrations/`, `src/` and tests. The Worker imports `src/lib/sync-model.ts` by relative path. Root `vite.config.ts` excludes `sync-server/**` from vitest, and `.gitignore` gets `.wrangler/` and `.dev.vars`. [cf-7, client-5]
- **Switching it on:** the app enables sync only when `VITE_SYNC_URL` is set at build time. Unset, every sync UI and all sync-related copy are absent, and today's strings are unchanged.
- **Passkey relying party:** `RP_ID` and `EXPECTED_ORIGINS` are Worker env vars, so the client never hardcodes them. The Worker's own hostname never appears in WebAuthn.
- **Trust boundary [sec-5]:** every page under `https://<RP_ID>/` is the same origin as the app. It can read the sync token in IndexedDB and run passkey ceremonies the server accepts. The RP ID can't change after the first real passkey without Related Origin Requests. **Decided (owner, 2026-11-21):** keep `davidmcgurk.github.io`. Standing rule: no other Pages site in that account may load third-party scripts or user-submitted content.

## Data model and merge rules (`src/lib/sync-model.ts`, pure, shared)

```ts
export type ItemKind = 'sections' | 'walks' | 'entered' | 'changed';
// sections → Progress.travelledSegmentIDs, walks → walkedLinkIDs,
// entered → stationsEnteredOrExitedIDs, changed → stationsChangedAtIDs

export interface SyncState {
  resetAt: number;                                   // latest reset applied (ms); 0 = never
  items: Record<ItemKind, Record<string, number>>;   // NULL-PROTOTYPE records: id → latest time added (ms)
}

export type Change =
  | { id: string; type: 'add'; at: number; items: Partial<Record<ItemKind, string[]>> }
  | { id: string; type: 'reset'; at: number };
```

- **`applyChange(state, change)`**, pure:
  - `add`: for each id, if `at > state.resetAt`, set `items[kind][id] = max(existing ?? 0, at)`.
  - `reset`: if `at > state.resetAt`, set `resetAt = at` and remove items whose time is `<= at`.
  - Applying changes is commutative, associative and idempotent. On a tie between a reset and an add, the reset wins.
- **`mergeStates(a, b)`:** `resetAt = max`; items = union with the max time, dropping items `<= resetAt`.
- **`toProgress(state)`:** `Progress` arrays ordered by time added, then id. Unknown ids stay in the state. The UI still filters them with `sanitizeProgress`, so a data update that renames ids can be repaired from the server copy.
- **`validateChange(raw)`:** returns a `Change` or a rejection code. [sec-1, sec-7, sync-3]
  - Change `id`: `^[A-Za-z0-9_-]{1,64}$`.
  - `at`: a positive safe integer. Time is never a reason to reject; see Clocks.
  - Item ids: `^[a-z0-9_]{1,64}$`, excluding `__proto__`, `constructor` and `prototype`. All 1,029 current ids match; the longest is 55.
  - At most 3,000 ids per change.
  - Unknown fields are rejected.
- **`validateState(raw)`:** rebuilds any state parsed from D1, IndexedDB or the network into null-prototype records, dropping entries whose time isn't a positive safe integer. Code reads records only with `Object.hasOwn`. [sec-7]
- **State limits:** at most 3,000 items in total and at most 128 KB serialized (today's full network is about 55 KB, well under D1's 2 MB value limit and the 10 ms CPU budget). A change that would exceed either is rejected per change with `backup_full`. [sec-1, sync-10, cf-3]
- **`getRouteItems(route)`** in `src/lib/progress.ts`: every id a journey touches (sections, ridden walks, entered/exited and changed-at stations), before de-duplication. `addRouteToProgress` and the outbox both use it. [sync-1]

### Clocks [sync-4, client-2, ux-1]

- **Client stamping:** every change is stamped `at = max(Date.now() + clockOffset, lastStampedAt + 1)`. Adds are also stamped at least `knownResetAt + 1`, where `knownResetAt` is the largest of the stored state's `resetAt` and any pending reset's `at`. A reset followed by journeys on the same device always keeps the journeys.
- **Offset:** `clockOffset = serverTime − (request start + request end) / 2`. It's taken from every `/v1/sync`, `register/verify` and `login/verify` response, and stored in the `sync` table together with `lastStampedAt`.
- **The server never rewrites `at`**, so applying a change twice gives the same state. If any change in a request has `at > serverNow + 60 s` or `at < 1,600,000,000,000`, the server applies nothing and returns 409 `clock_skew` with `serverTime`.
- **Recovering from a skew:** in one transaction the client updates `clockOffset` and shifts every pending row's `at` by the change in offset. Their order is kept and the add floor is re-applied. It then retries, at most twice per run.

## Server API (`sync-server`, prefix `/v1`)

### General rules

- **CORS [sec-6, sync-9, cf-1]:** a middleware layer wraps the whole handler, error paths included.
  - For an `Origin` in `ALLOWED_ORIGINS`, every response carries `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`. That includes preflights, every 4xx and 5xx, and the catch-all 500.
  - Preflight answers 204 with `Access-Control-Allow-Methods: GET, POST, DELETE`, `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Max-Age: 7200` (WebKit clamps it to 600).
  - Never `Allow-Credentials`. Other origins get 403. Requests without `Origin` get no CORS headers.
  - CORS only stops other websites' scripts. It is **not access control**, and no limit may depend on it.
- **Requests:** POST bodies are `application/json` and at most 16 KB, or 256 KB for `/v1/sync` (413 `too_large` beyond). Unknown fields are rejected.
- **Errors:** `{ error: { code, message } }`. Malformed input is always 4xx. Mapping [cf-5]:
  - A D1 "exceeded … free tier daily" error → 503 `over_capacity` with `Retry-After` = the seconds until 00:00 UTC.
  - A D1 "overloaded" error → 503 `busy` with `Retry-After: 5`.
  - A D1 error while looking up a session → 503, **never 401**. 401 means the lookup succeeded and found nothing.
  - Anything else unexpected → 500 `internal`.
- **Logging [sec-4]:** a 500 logs only the route, the error code and the error's name and message. Never headers, IP addresses, bodies, tokens or progress. `observability` is on, with per-request invocation logs **off**.
- **Versioning:** every response includes `"apiVersion": 1`. `/v1` is never broken. The Worker is always deployed before an app build that sends new fields.
- **Authenticated endpoints:** `Authorization: Bearer <token>`. A missing, unknown or expired token gets 401 `unauthorized`.

### Endpoints

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `GET /v1/health` | – | – | `{ ok, apiVersion }` |
| `GET /v1/auth/register/options` | – | – | `{ challengeId, options }` (a CORS-simple request, so no preflight) |
| `POST /v1/auth/register/verify` | – | `{ challengeId, response }` | `{ token, account, state, serverTime }`, which creates the user, passkey, session (`verified_at = now`) and an empty progress row |
| `GET /v1/auth/login/options` | – | – | `{ challengeId, options }` (discoverable) |
| `POST /v1/auth/login/verify` | – | `{ challengeId, response }` | `{ token, account, state, serverTime }`, or 404 `unknown_credential` / 400 `user_mismatch` |
| `POST /v1/auth/reauth/options` | ✓ | `{}` | `{ challengeId, options }` (`allowCredentials` = this account's passkeys) [sec-3] |
| `POST /v1/auth/reauth/verify` | ✓ | `{ challengeId, response }` | `{ ok }`, which sets the session's `verified_at = now` |
| `POST /v1/passkeys/options` | ✓ recent | `{}` | `{ challengeId, options }` (same `user.id` and name; `excludeCredentials` = existing) |
| `POST /v1/passkeys/verify` | ✓ (recent at issue) | `{ challengeId, response }` | `{ account }`; 401 if the backup was deleted meanwhile |
| `DELETE /v1/passkeys/:id` | ✓ recent | – | `{ account }`; refuses to remove the last passkey (409 `last_passkey`); also ends the user's other sessions |
| `POST /v1/sessions/revoke-others` | ✓ recent | `{}` | `{ ok }` |
| `GET /v1/account` | ✓ | – | `{ account }` |
| `POST /v1/sync` | ✓ | `{ changes: Change[] }` (≤ 200) | `{ state, serverTime, rejected: [{ id, code }] }` |
| `POST /v1/auth/logout` | ✓ | `{}` | `{ ok }`, which deletes this session |
| `DELETE /v1/account` | ✓ recent | – | `{ ok }`, which deletes the user, passkeys, sessions, progress and used challenges |

- **"✓ recent"** means the session's `verified_at` is within 5 minutes; otherwise 403 `reauth_required`. [sec-3]
- **"Recent at issue"** (`passkeys/verify` only): the `add` challenge must have been issued within 5 minutes of the session's `verified_at`, measured to the challenge's `issuedAt`, not to now. Creating a passkey on another device or a security key can take minutes after a `passkeys/options` call that was itself ✓ recent, so the ceremony isn't refused at the end (which would leave a passkey the server never saved). The challenge is MAC'd, at most 10 minutes old and bound to the session's user.
- **`account`:** `{ userHandle, name, createdAt, passkeys: [{ id /* full base64url */, createdAt, lastUsedAt, synced, provider /* from AAGUID, or null */ }] }`.

### WebAuthn

- **User handle [sec-8]:** `users.id` *is* the WebAuthn user handle: 32 random bytes, base64url without padding.
- **Relying party:** RP name `Tube Tracker`. Account name `Tube Tracker · ABCD`: 4 characters from an unambiguous alphabet, used as both name and displayName.
- **Options:**
  - `residentKey: 'required'`, `userVerification: 'preferred'`, `attestation: 'none'`.
  - No attachment restriction; algorithms ES256 and RS256; timeout 300,000 ms.
  - `requireUserVerification: false` when verifying, which is acceptable for this data. Sensitive actions instead need a fresh ceremony (✓ recent).
- **Stateless challenges [sec-2, cf-2]:**
  - `challengeId = base64url(payload) + '.' + base64url(HMAC-SHA-256(CHALLENGE_KEY, payload))`.
  - `payload = { purpose: 'register'|'login'|'reauth'|'add', issuedAt, challenge, userId?, userName? }`.
  - **Verify checks:** the MAC (`crypto.subtle.verify`); that the purpose matches the endpoint; an age of at most 10 minutes; and, for reauth and add, that `userId` equals the session's user.
  - **Single use:** `INSERT INTO used_challenges(challenge PRIMARY KEY, created_at) WITHOUT ROWID`; a conflict returns 400 `challenge_used`.
  - Options calls write nothing to D1. `CHALLENGE_KEY` is a Worker secret, set with `wrangler secret put`; local runs use `.dev.vars`.
- **Login and reauth verify [sec-8]:** require `response.response.userHandle`, which must equal the credential's `user_id`, otherwise 400 `user_mismatch`. Then update the counter, `backed_up` and `last_used_at`.
- **New credentials [sec-8]:** inserted with an `INSERT … SELECT … WHERE EXISTS (the user)` and no conflict clause. A duplicate id returns 409 `already_registered`. At most 10 passkeys per account. If the backup was deleted (on another device) while `passkeys/verify` ran, nothing is inserted and the answer is 401.
- **What a passkey may store** (so `MAX_USERS` can be sized from the worst case, see Caps):
  - The credential id stored is the one in the signed authenticator data, so it must equal the response's `id`, which is capped at 342 base64url characters (256 bytes; discoverable credentials use 16–64). Otherwise 400 `bad_request`.
  - The COSE public key is at most 600 bytes (RS256 with a 4,096-bit key is about 530). Otherwise 400 `bad_request`.
  - Transports: only `usb`, `nfc`, `ble`, `smart-card`, `hybrid`, `internal` and `cable`, each once; anything else is dropped, not rejected.

### Sessions

- **Token:** 32 random bytes, base64url, stored as `SHA-256(token)`.
- **Columns:** `created_at`, `last_used_at` (written at most once a day) and `verified_at`.
- **Expiry:** 400 days after the last use.
- **Cap [sec-1]:** at most 20 sessions per user. Creating one deletes the oldest beyond 20, and expired ones.

### D1 schema (`migrations/0001_init.sql`)

- `users(id TEXT PRIMARY KEY /* user handle */, name TEXT NOT NULL, created_at INTEGER NOT NULL)`, with an index on `created_at`.
- `credentials(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL, aaguid TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)`, with an index on `user_id`.
- `sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, verified_at INTEGER)`, with an index on `user_id`.
- `used_challenges(challenge TEXT PRIMARY KEY, created_at INTEGER NOT NULL) WITHOUT ROWID`
- `progress(user_id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)`

Deletes are explicit statements in one `batch`; nothing relies on foreign-key cascades.

### Sync write path

1. **Validate the envelope:** an object, `changes` an array of at most 200 entries.
2. **Clock check:** any `at` out of range → 409 `clock_skew`.
3. **Validate each change on its own.** Invalid ones go into `rejected` (e.g. `invalid`).
4. **Read** `progress` (state and version) and run it through `validateState`.
5. **Apply** the valid changes in order. A change that would break the state limits is skipped and rejected with `backup_full`.
6. **Write only if the state changed:** `UPDATE … SET state=?, version=version+1, updated_at=? WHERE user_id=? AND version=?`. If no row changed, re-read and re-apply, up to 5 times, then 409 `busy`. A missing row is inserted only while the user exists (`INSERT … SELECT … WHERE EXISTS`); if that inserts nothing and the user is gone (the backup was deleted on another device mid-request), answer 401, so no orphan row is left.
7. **Return** `{ state, serverTime, rejected }`.

### Abuse, cost and request budget [sec-1, sec-2, cf-1]

- **The binding limit** is Workers Free's 100,000 requests a day, shared by the whole account and reset at 00:00 UTC. Every invocation counts, including preflights and 4xx/429.
  - WebKit caches preflights for at most 600 s, so a sync after more than 10 minutes usually costs 2 requests.
  - The target is about 25–50 requests per active user a day (every return to the app checks for changes), roughly 2,000–4,000 daily active users.
- **D1 is not the binding cost:** one row is written per sync that changes something, plus session and credential updates.
- **Rate Limiting binding** (if it's available on the free plan; verify, otherwise document):
  - unauthenticated `/v1/auth/*`, keyed by IPv4 address or IPv6 /64: 20 a minute (a coarse CPU guard);
  - `/v1/sync`, keyed by user: 30 per 60 s. It's shared by all of a user's sessions, and each one checks for changes whenever it comes back (at most about 12 a minute). A sync that changes nothing reads D1 but writes nothing.
  - These protect D1 and CPU, not the request budget. Nothing inside a Worker can protect that.
  - `RATE_LIMITS=off` (local and e2e only) disables them.
- **Caps:**
  - `MAX_USERS` (default 2,500). The worst case per account is about 155 KB measured in D1: a full 128 KB state, 10 passkeys at the capped sizes (WebAuthn above) and 20 sessions. 2,500 × 155 KB ≈ 390 MB, under D1 Free's 500 MB. At that count `register/verify` returns 503 `registrations_closed`.
  - At most 200 new accounts per UTC day (`MAX_NEW_USERS_PER_DAY`; the e2e server raises it so repeated runs don't reach it).
  - 10 passkeys per account and 20 sessions per user.
- **Daily Cron Trigger (free):** deletes `used_challenges` older than 10 minutes, expired sessions, and accounts whose state is empty, that are more than 30 days old, and that have had no session use for 30 days. As a backstop it also deletes `credentials`, `sessions` and `progress` rows whose user no longer exists.
- **Accepted risk:** anyone can use up the daily free quotas. Clients treat that as a temporary outage and lose nothing. A persistent abuser can at worst close new registrations; existing backups keep working.

## Client

### Storage (Dexie version 2, `src/lib/storage.ts`)

- **New tables:**
  - `outbox: '++seq'`, rows `{ seq, change: Change, held?: { code, at } }`.
  - `sync: 'id'`, records:
    - `{ id: 'account', token, userHandle, name, signedInAt }`
    - `{ id: 'state', value: SyncState }`
    - `{ id: 'clock', offset, lastStampedAt }`
    - `{ id: 'status', lastSyncedAt, lastError }`
    - `{ id: 'notice', kind: 'signed_out', accountName, at }` (survives sign-out; cleared on dismiss)
- **Migration:** the v1→v2 upgrade keeps all data. From v2, `db.on('versionchange')` closes the database and reloads the page, so future upgrades don't leave old tabs writing. [sync-2] Since `src/lib/app-updates.ts` (upstream), open pages also reload as soon as a new service-worker version takes over. That shrinks the old-tab window, but it doesn't close it (a tab can be offline or suspended), so the reconcile step stays.
- **Whether to write the outbox** is decided by reading `sync.account` **inside** the same rw transaction over `[progress, outbox, sync]`. Never from React state or a module variable. [sync-2, client-1]
- **Recording a journey while signed in** enqueues an `add` of `getRouteItems(route)`, even when local progress doesn't change. `recordRoute` writes that row before returning `'unchanged'`. [sync-1]
- **Resetting while signed in** writes empty progress and a `reset` change in one transaction.
- **Local progress** = `sanitize(toProgress(applyAll(storedState, outbox rows including held ones)))`, written only when the sets differ.

#### Applying a sync response (one rw transaction over progress, outbox, sync) [client-1, sync-2, sync-3, sync-5, cf-4]

1. **Token check:** if there is no `account` record, or its token differs from the token the request was sent with, discard the response and touch nothing. [sync-6]
2. **Reconcile, before deleting anything.**
   - Let L = the stored progress (sanitized), S0 = the stored state (empty if none) and O = all outbox rows.
   - `expected = sanitize(toProgress(applyAll(S0, O)))`.
   - `extras` = the ids in L that aren't in `expected`.
   - If `extras` isn't empty, append one `add` of them. That catches writes from old tabs, races and bugs.
3. **Rejected rows:** mark them `held` (code, time). They aren't sent automatically but still apply locally. Delete the other sent rows.
4. **Merge:** `merged = mergeStates(S0, response.state)`. The stored state never goes backwards.
5. **Undo a server regression:** if `merged` holds anything `response.state` lacks (a higher `resetAt`, or an item missing or with an earlier time on the server), enqueue changes that restore it with their original times. That means a `reset` at `merged.resetAt`, and one `add` per distinct time. They're sent next run, so a Time Travel restore or an older response never deletes local journeys.
6. **Store** `merged`, `clockOffset`, `lastSyncedAt`, and clear `lastError`.
7. **Recompute and write** local progress.

#### Turning backup on, restoring, turning off [sync-7, ux-5, sync-6, ux-6]

- **Turn on (new backup):**
  - `register/verify` returns the token, account, (empty) state and serverTime.
  - One transaction writes `account`, `state` and `clock`, and enqueues one `add` of all local ids.
- **Restore:**
  - `login/verify` returns the state, which is held in memory and not applied yet.
  - `localOnly` = this device's sanitized ids that aren't in `state.items`.
  - If `localOnly` is non-empty, show the merge dialog (UI): [Add them] / [Don't add them]. Escape cancels the restore: discard the token and call `logout` on a best-effort basis.
  - Then one transaction writes `account`, `state` and `clock`. On "Add them", it also enqueues one `add` of `localOnly`, stamped at least `state.resetAt + 1`. On "Don't add them", local progress becomes the backup's.
- **Turn off on this device:**
  - Optionally sync first ("Back up first").
  - Then delete `account`, `state`, `status` and `clock`, and clear the outbox.
  - Keep local progress, unless "Also remove journeys from this device" is ticked: then clear progress without a reset change.
  - Call `logout` on a best-effort basis.
- **401** (with a token check, so a stale tab can't sign out a newer session): the same cleanup as turning off, then write the `notice` record.
- **Delete backup:** `DELETE /v1/account` (✓ recent), then the same cleanup as turning off, keeping local progress. Then, feature-detected and not awaited, call `PublicKeyCredential.signalAllAcceptedCredentials({ rpId, userId: userHandle, allAcceptedCredentialIds: [] })`.

### Sync engine (`src/lib/sync.ts`) [client-6, client-7, sync-11, cf-1]

- **Ownership:** a module singleton. `startSync()` is called once from `main.tsx`, next to `initInstallPromptCapture()`. It's idempotent, reads the account from IndexedDB, and owns every timer and listener. Hooks only subscribe.
- **Triggers:**
  - A local change (debounced 1.5 s).
  - App start, `visibilitychange` to visible, window `focus` (on a computer, switching between windows that are both on screen never changes visibility) and `online`. These sync if the outbox has unsent rows, and otherwise fetch unless the last successful sync was under 5 seconds ago, so coming back to the app shows changes made on other devices. The short gap stops quick switching, and tabs (which share it), from fetching the same thing repeatedly. Each browser's storage has its own, so one session can check about 12 times a minute at most, under the server's 30 syncs a minute per user.
  - Coming back (`visible`) and `focus` run after a 1.5 s pause, and leaving again during it (hidden or `blur`) cancels the check. The window or app being left sends anything ready at once, so the pause lets that reach the server before the check. Several of these events during the pause make one check.
  - Window `blur` with unsent rows (or a debounce waiting): cancel the debounce and sync now. Unlike hidden, it doesn't end the undo window, as the bar is still on screen.
  - `visibilitychange` to hidden with unsent rows: cancel the debounce and sync now (best effort). A journey still in its undo window has its window ended first (see Timed undo), so it's sent too.
  - "Back up now", which also re-queues held rows as one fresh `add`.
  - There is **no periodic poll**.
- **One tab at a time:** `navigator.locks.request('tube-tracker-sync', { signal: AbortSignal.timeout(10_000) }, run)`, with at most one pending request per tab. The lock covers one run only, never a backoff wait. On timeout, or without Web Locks, run unlocked; it's safe because pushes are idempotent and responses merge.
- **Each run:**
  - Capture the token.
  - Send batches of at most 200 rows and about 200 KB, excluding held rows.
  - Apply each response.
  - Repeat while unsent rows remain, up to **5 requests per run**. Stop early if a response didn't remove the rows just sent.
- **Failures:**
  - Network errors, 5xx, 409 `busy` and 429 back off exponentially with jitter: 5 s up to 5 min. `Retry-After` is honoured, capped at 24 h. Becoming visible or coming online resets the backoff, unless a `Retry-After` is still running. Focus doesn't (it can change many times a minute on a computer). A coming-back or focus check, or `online`, adds no request while a retry is waiting, and no run (other than the retry itself and "Back up now") sends while a `Retry-After` is running, even if it was queued before the `Retry-After` began.
  - 409 `clock_skew`: shift and retry (see Clocks).
  - 400 or 413 for the whole request: nothing is dropped. Record `lastError`. On 413, halve the batch.
  - Other non-retryable 4xx: `lastError` "Couldn't back up. Updating the app may fix this.", retried only on the next start or "Back up now".
- **Status** (`useSync().status`):
  - `syncing` comes from the tab running a sync.
  - Other tabs derive it from shared records: `notice`/`lastError` → `error` or `signed_out`; unsent rows while offline or after a failure → `waiting`; otherwise `idle`.
  - `paused` when a `Retry-After` from `over_capacity` is running.
  - Offline vs unavailable [ux-9]: a failed fetch counts as offline only when `navigator.onLine === false`. Otherwise it's "Backup service unavailable".
- **Request timeout:** 20 s (`AbortController`).

### WebAuthn in the client (`src/lib/sync-auth.ts`) [ux-2, client-8, cf-2]

- **Library:** `@simplewebauthn/browser` v14 (`startRegistration` / `startAuthentication`).
- **Prefetching:**
  - When the Backup section mounts, prefetch the options the current state needs: register and login options when signed out; nothing otherwise, because reauth and add options need fresh state.
  - Re-check on `pointerdown`/`focus` of a button and on `visibilitychange` to visible.
  - There is no background refresh.
  - Options are **single use** (taken when `start*` is called) and count as ready only if they're under 4 minutes old at tap time. Otherwise the tap fetches, then calls.
- **One operation at a time:** every Backup button is disabled with `aria-busy` from the tap until the result. The pressed button reads "Turning on…", "Restoring…" or "Adding passkey…".
- **When create() succeeded but verify failed:**
  - On a network error, timeout or 5xx, retry the same body up to twice.
  - If it still fails, call `signalUnknownCredential({ rpId, credentialId })` (feature-detected, not awaited). For add-passkey, first check `GET /v1/account`, so a passkey the server already holds isn't removed.
  - Then show "Backup wasn't turned on, so nothing was saved. Please try again."
- **Errors in plain words:**
  - `NotAllowedError` → neutral "No passkey was used. If no passkey window appeared, open Tube Tracker in Safari or Chrome and try again."
  - `AbortError` → ignore it; a newer ceremony owns the UI.
  - `InvalidStateError`, on add-passkey only → "Your password manager here already has a passkey for this backup. To add another, pick a different option in the passkey window, such as another device or a security key."
  - 404 `unknown_credential` → "That passkey isn't linked to a backup any more." plus `signalUnknownCredential`.
  - 503 `registrations_closed` → "New backups are paused right now. Please try again later."
- **Sensitive actions:** if the server answers `reauth_required`, run a reauth ceremony from the same tap. Delete, Remove passkey and Sign out other devices therefore each take one tap after their confirm dialog. Add a passkey needs two taps when not recently verified: "Confirm it's you", then "Add a passkey".

### Hook (`src/hooks/useSync.ts`)

```ts
useSync(): {
  available: boolean;              // VITE_SYNC_URL set and window.PublicKeyCredential exists
  account: Account | null;
  status: {
    phase: 'off' | 'idle' | 'syncing' | 'waiting' | 'paused' | 'error' | 'signed_out';
    lastSyncedAt: number | null;
    unsent: boolean;               // rows ready to send: held rows and a journey still in its undo window left out
    awaitingUndo: boolean;         // the latest journey is waiting out its undo window
    unsentReset: boolean;          // one of the unsent rows is a reset
    heldCount: number;
    error: { code: string; message: string } | null;
    pausedUntil: number | null;
  };
  notice: { kind: 'signed_out'; accountName: string } | null;
  turnOn(): Promise<Outcome>; restore(): Promise<Outcome>; confirmRestore(addLocal: boolean): Promise<Outcome>; cancelRestore(): void;
  addPasskey(): Promise<Outcome>; removePasskey(id: string): Promise<Outcome>; signOutOthers(): Promise<Outcome>;
  backUpNow(): Promise<void>;      // resolves once that sync has finished, so the UI can announce how it went
  turnOff(opts: { backUpFirst: boolean; removeLocal: boolean }): Promise<Outcome>;
  deleteBackup(): Promise<Outcome>; dismissNotice(): void;
  prepare(): void;                 // signed out: prefetch passkey options; signed in: load the passkey list once
}
// Outcome: { status: 'done' } | { status: 'confirm'; merge } | { status: 'verified' } (addPasskey confirmed it's you;
// tap again) | { status: 'failed'; message; neutral } | { status: 'ignored' }
```

- `status.unsent` means "ready to send". The stored summary's `unsent` count (`readSyncSummary`) also includes a row waiting out its undo window, which is why "Turn off" checks `unsent || awaitingUndo`.
- `useProgress` keeps its existing API and adds `undo` (the open window, or null), `undoJourney()` and `dismissUndo()`. `recordRoute` and `resetProgress` go through storage functions that enqueue when signed in, and then nudge the engine.

## Timed undo (owner decision, 2026-11-22)

After recording a journey, it can be undone for a short window. While the window is open, its backup waits on the device, so undo never needs a "remove" in the backup format. Once the window has closed, it can't be undone (a reset is the only way back). The backup doesn't store individual journeys.

- **Window:** `UNDO_WINDOW_MS = 5 * 60_000`. It ends early when another journey is recorded (including "Already explored"), on a reset, on "Back up now", when the undo bar is dismissed, when the page is hidden while backup is on, or on any backup change (turn on, restore, turn off, delete, signed out).
- **Leaving the app while backup is on** ends the window (owner to confirm: this reverses "the hidden flush skips waiting rows" from the original decision). A hidden page is often suspended soon after (on iOS especially), timers and all, so a journey left waiting would only be backed up when the app is next opened, often the next day: until then other devices don't have it, and a lost device or cleared site data would lose it from the backup too. The undo is for the in-app "oops" moment, and the bar can't be seen while the app is hidden. Signed out, nothing waits, so leaving the app keeps the undo.
- **Clock corrections:** a window's end (`expiresAt`, a row's `waitUntil`) more than `UNDO_WINDOW_MS` ahead of now was set by a clock that has since been put back, so the window counts as over: the row is sent, the record reads as none (`undoLastJourney` → `'expired'`), and no timer ever waits longer than the window.
- **Storage:** an `{ id: 'undo', recordedAt, expiresAt, added: ChangeItems, outboxSeq: number | null }` record in the `sync` table.
  - `added` = the ids this journey newly added on this device (`itemsMissingFrom(after, before)`).
  - Outbox rows gain `waitUntil?: number`, which is separate from `held`.
- **`recordJourney` when local progress changed**, in its existing transaction:
  1. End any previous window: clear `waitUntil` on all rows and delete the undo record.
  2. Write progress.
  3. If signed in, enqueue the add with `waitUntil = expiresAt`.
  4. Write the new undo record.
- **"Already explored" (unchanged)** ends any window, offers no undo, and its add isn't delayed.
- **`undoLastJourney()`**, in one rw transaction over `[progress, outbox, sync]`:
  - If there's no record, or it has expired, return `'expired'`.
  - If `outboxSeq` is set and that row no longer exists (it was sent somehow), return `'too_late'` and change nothing.
  - Otherwise delete the row, remove `added` from local progress except ids the confirmed state plus the remaining outbox still account for (another device's journey over the same track that has arrived since), delete the record, and return `'undone'`.
- **Engine:**
  - `takeOutboxBatch` skips rows whose `waitUntil` is still ahead (and within one window, see Clock corrections).
  - A timer syncs when the earliest `waitUntil` passes.
  - Hiding the page while a row waits ends the window first (`endUndoWindow`), then flushes. If the page is frozen before that's stored, the row simply keeps waiting.
  - "Back up now" releases waits first.
  - If the app is closed while a row waits without being hidden first, it's sent on the next run after the window.
- **Status:** when the only unsent rows are waiting for their undo window, the phase stays `idle`, with a second line under the status: "Your latest journey backs up once it can no longer be undone." The line shows only while backing up goes ahead: not in the `paused` or `error` phases, where the window closing doesn't send the journey either (`describeUndoWait`).
- **UI:**
  - A small bar where the route action bar sits (never at the same time as it): "Journey recorded" with [Undo] and a dismiss button (aria-label "Dismiss", ends the window). It's visible while the record exists and hasn't expired, and disappears on its own when the window closes.
  - **Double taps:** the bar replaces the route actions as soon as the journey is saved, and on phones Undo sits where "Record route" was. Undo ignores presses whose `event.timeStamp` is less than 800 ms after the bar appeared (`UNDO_GUARD_MS`, measured with `performance.now()` on mount), including presses that began before it. Dismiss isn't guarded: it keeps the journey.
  - **Focus** follows the swapped bars, since the focused button goes with the old one: after recording, Undo; after undoing, the route bar's Record button; after "too late", Dismiss; after Dismiss (or an expired undo), the map region (`tabIndex=-1`). Each is a one-shot request, cleared when used or when the tab changes; programmatic focus after a tap shows no focus ring.
  - An app-level `role="status"` region announces "Journey recorded" and, after undo, "Journey removed".
  - If it's simple with `useRouteSelection`, re-select the journey's start and end, so the user can pick the right route straight away.
  - Works the same signed in or signed out, except that leaving the app ends the window only while backup is on. Checked at phone, tablet and widescreen, light and dark.
- **Tests:**
  - Unit: hold, undo removes only `added`, expiry, every way the window ends, the engine skips waiting rows, and sends them after expiry.
  - E2E: record → undo → progress reverts, and with backup on the server never receives it (a second device restores without it); record → past the window (Playwright clock) → backed up; record → page hidden → backed up at once and another device gets it; a double tap on Record (150 and 500 ms) keeps the journey on phones; focus after Record, Undo and Dismiss; the turn-off dialog offers "Back up first" while a journey waits. Existing specs that record journeys keep passing (they wait out the Undo guard before pressing Undo).

## UI

All copy uses typographic quotes (’ ‘ ’ “ ”) like the rest of the app, and "back up" wording throughout. [ux-12]

### Settings → "Backup & sync" (directly after "Progress")

- **Absent** when `VITE_SYNC_URL` is unset. If WebAuthn isn't available: "This browser can’t use passkeys, so backup isn’t available here."
- **Off:**
  - Explanation:
    - "Back up your journeys so you can get them back if this browser’s data is cleared (or “this app’s data” in the Home Screen app), and use them on your other devices."
    - "You sign in with a passkey (Face ID, Touch ID, fingerprint or your screen lock), with no email or password."
    - "Your passkey is the only way into your backup. Your password manager (such as iCloud Keychain or Google Password Manager) keeps it and syncs it to your other devices. If it’s lost, the backup can’t be recovered."
  - **No local journeys:** primary "Restore from a backup" ("Backed up before, here or on another device?"); secondary "Turn on backup" ("New to backup? Start one."). [client-9, ux-3]
  - **Local journeys:** primary "Turn on backup". The tap first shows an inline step: "Already backing up Tube Tracker on another device? Restore that backup instead, so your devices share one." with [Restore my backup] [Start a new backup]. The second tap is the user gesture. Secondary: "Restore from a backup". [ux-3]
  - Privacy line [sec-4, ux-7, cf-8]: "Your backup holds the journeys you’ve recorded and when you recorded them, plus each passkey’s public key, which password manager saved it and when it was last used, and when each signed-in device last connected. No name, email or password, and we don’t keep your IP address. You can delete your backup at any time from a device that’s using it." It links to the privacy details (below).
- **On:**
  - Status line, plain text and not live: "Backed up · 2 minutes ago" / "Backing up…" / "Waiting for a connection · your latest journeys are saved on this device" / "Backup service unavailable · will retry" / "Backup is paused until 00:00. Your journeys are safe on this device." / "Couldn’t back up. Updating the app may fix this." Then "Back up now". Held rows: "Some journeys couldn’t be backed up." [ux-12]
  - "Backup: Tube Tracker · K3F9" and "Keep the “Tube Tracker · K3F9” passkey in your passwords app. Without it, this backup can’t be restored."
  - Passkeys list: provider (or "Passkey"), date added, last used, a text warning when not synced, and a "Remove" button (not on the last one). Unsynced warning: "This passkey is saved only on this device. If you lose the device, you can’t restore your backup. Tap Add a passkey and save one somewhere that syncs, such as your phone or a password manager." [ux-10]
  - "Add a passkey", with the helper "Save another passkey for this backup, for example on another phone, in a different password manager or on a security key, so you can restore it from more places."
  - "Sign out other devices".
  - "Using a different backup on your other devices? Delete this one, then choose Restore from a backup. This device’s journeys are added to it." [ux-3]
  - "Turn off on this device" and "Delete backup…" (red).

### Dialogs

All dialogs use `<dialog>` + `showModal()`: focus stays inside, Escape closes, focus returns to the trigger, or to the section heading if the trigger is gone. [ux-11]

- **Restore merge [ux-5]:**
  - Title: "Add this device’s journeys to your backup?"
  - Body: "This device has 12 track sections and 3 stations that aren’t in Tube Tracker · K3F9." Plus, if `resetAt > 0`: "Your backup was reset on 3 March 2027, so some of these may be from before then."
  - Buttons: [Add them] (default) / [Don’t add them], with the sub-line "This device will show your backup’s journeys instead."
- **Turn off [ux-6, sync-6]:**
  - Title: "Turn off backup on this device?"
  - Body: "Your backup and your other devices aren’t affected. Journeys stay on this device unless you remove them."
  - Checkbox: "Also remove journeys from this device".
  - With unsent rows: "Some journeys on this device haven’t been backed up yet." (or the reset variant), with [Back up first] as well.
  - Buttons: [Cancel] (autofocus) / [Turn off].
- **Delete [ux-6]:**
  - Title: "Delete your backup for all devices?"
  - Body: "This permanently deletes Tube Tracker · K3F9 and its journeys from Tube Tracker’s server. Every device using it stops backing up; each keeps the journeys it already has, including this one. This can’t be undone."
  - Buttons: [Cancel] (autofocus) / [Delete backup] (red).
  - Afterwards: "You can also delete the “Tube Tracker · K3F9” passkey in your passwords app."
- **Reset, when signed in [ux-12]:** "This permanently clears your recorded routes on this device and on every device using Tube Tracker · K3F9. It can’t be undone." When offline, add: "Your other devices will clear when this one is back online." Signed in or not, it's the same modal `<dialog>` (Cancel focused first; focus returns to "Reset progress", or the Progress heading).

### Elsewhere

- **App-level notice [ux-8]:** when the `notice` record exists, show a dismissible banner in `app-alert`'s amber colours, with `role="status"`, on the Map and Statistics tabs. It sits in the page's flow between the tabs and the view, never over the header or tabs (on wider screens the map tab's grid gives it its own row, 0 tall when there's no notice); the fixed `app-alert` overlay stays for transient errors:
  - "This device was signed out of backup Tube Tracker · K3F9. It may have been deleted on another device or not used for over a year. Your journeys are still on this device."
  - [Backup settings] [Dismiss]. Settings shows the same line above the buttons.
- **Install pop-up and InstallAppSection copy [client-3, ux-4]:** unchanged when sync isn't available. Otherwise:
  - Pop-up, signed out: "The Home Screen app keeps its own data. To bring your journeys across, turn on Backup & sync in Settings here, then choose “Restore from a backup” in the app."
  - Pop-up, signed in: "The Home Screen app keeps its own data. Your journeys are backed up: in the app, open Settings and choose “Restore from a backup”."
  - InstallAppSection, signed in: "… won’t appear in it until you restore your backup there." Signed out: "… won’t appear in it unless you turn on Backup & sync above, then restore your backup in the app."
- **About text:** only when sync is available: "Your progress is stored on this device. If you turn on Backup & sync, a copy is also kept on Tube Tracker’s server so you can restore it."
- **Privacy details** (a short expandable section in Settings → About):
  - who runs Tube Tracker, and that it runs on Cloudflare;
  - what's stored, as in the privacy line, plus: "For each device signed in to your backup, it also keeps a random sign-in code (stored only as a hash), when it signed in and the day it last connected. Sign-ins unused for 400 days are deleted.";
  - that request logs keep no IP addresses or headers, and error logs are kept up to 7 days;
  - that deleting removes the backup at once, and it leaves Cloudflare's recovery copies within 7 days;
  - contact: GitHub issues for the project.
- **Accessibility [ux-11]:**
  - One visually hidden `role="status"` region announces only results: "Backup turned on", "Restored Tube Tracker · K3F9", "Backed up", "Backup turned off", "Can’t reach the backup service".
  - After any Off↔On change, focus moves to the "Backup & sync" heading (`tabIndex=-1`).
  - The app-level status region (Timed undo) announces "Journey recorded" and "Journey removed".
  - Tap targets are at least 44 px. Light and dark. Checked at phone, tablet and widescreen.

## Testing

- **Unit (root vitest; `fake-indexeddb/auto` from `setupFiles`; storage tests `Dexie.delete` between tests):**
  - **`sync-model`:**
    - Properties: commutative, associative, idempotent.
    - The reset/add matrix including ties, `getRouteItems`, the limits, and the proto ids (`__proto__`, `constructor`, `toString`, `hasOwnProperty`).
    - `validateState`, and `toProgress` order.
  - **Storage:**
    - The v1→v2 upgrade (seeded through a separate `Dexie` version(1) instance).
    - The outbox is written only when signed in, and atomically.
    - An already-explored route still enqueues.
    - A version(1)-only Dexie instance's write survives a sync and gets pushed.
  - **Engine** (with a fake API and fake timers):
    - Reconcile; held rows never shrinking progress; regression restore; clock skew shift (fast and slow); token mismatch ignored; 401 → notice.
    - The 5-request cap; Retry-After; the debounce; the hidden flush; no periodic poll.
    - Scenarios: remote reset then a local journey over old track → kept; a fast clock with reset→add in one batch → add kept.
- **Server (`sync-server`, vitest 4.1 + pool-workers against local D1):**
  - A software authenticator helper (ES256, `none` attestation) drives registration, login, reauth and add.
  - Every endpoint's happy path and errors.
  - Challenges: MAC, purpose, age and single use.
  - CORS: preflight for DELETE; headers on 400, 401 and 500; no CORS for other origins.
  - Limits: body caps; the state cap → `backup_full` (not 500); per-change rejection; `clock_skew`.
  - Optimistic-concurrency retry.
  - `user_mismatch`; duplicate credential; the reauth requirement; cross-user challenge.
  - `MAX_USERS` and the daily cap (`MAX_NEW_USERS_PER_DAY`); cron cleanup, including rows whose user is gone.
  - What a passkey may store: a reported id that isn't the signed one, the id and public-key caps, transport filtering.
  - A backup deleted mid-request: a sync (while its body is read, and between its read and write) and an added passkey answer 401 and leave no row.
  - `passkeys/verify` accepts a ceremony begun in time that ends after the 5 minutes, and refuses one begun too late.
  - D1 error mapping, via an injected failing DB.
  - Delete removes everything; session expiry; one account can't read another.
- **E2E (Playwright) [client-4]:**
  - **Three webServers** with ports derived from `E2E_PORT`:
    - Vite on `E2E_PORT` without sync (all existing specs; also covers "section absent").
    - Vite on `E2E_PORT+1` with `VITE_SYNC_URL=http://localhost:E2E_PORT+2`.
    - `wrangler d1 migrations apply DB --local --persist-to <fresh dir> && wrangler dev --port E2E_PORT+2 --persist-to <dir>`, with `RP_ID=localhost`, origins `http://localhost:E2E_PORT+1`, `RATE_LIMITS=off` and a test `CHALLENGE_KEY`.
  - **Passkeys** come from Playwright's `browserContext.credentials` (works in WebKit and Chromium), copied between contexts to imitate syncing. Re-seed from the last context that signed in, so the counter only increases. Expect the "not synced" warning: the test authenticator doesn't set BE/BS.
  - **Projects:** sync scenarios run on `iphone-webkit` and `laptop-1280`; layout and screenshots on `phone-375`, `phone-393`, `iphone-webkit`, `tablet-820` and `wide-1920`.
  - **Reauth in a real browser:** a test answers one request to a ✓ recent endpoint with 403 `reauth_required` (`page.route`), so the app runs the real confirm-it's-you ceremony against the real server: two taps for "Add a passkey", one for "Remove".
  - **Scenarios:**
    - Turn on on A with existing journeys (confirm step); restore on B with no journeys (Restore is primary) and see A's journeys.
    - Record on A and see it on B after "Back up now" / visibility.
    - Reset on B propagates to A.
    - A offline records an already-explored route after B's reset; back online the route shows on both.
    - Restore on a device with old journeys after a reset → merge dialog; "Don’t add them" keeps A empty.
    - Turn off keeps local progress; delete backup → the other device shows the signed-out notice.
    - Cancel (an empty authenticator) is neutral.
    - Focus lands on the heading after turn-on, and the live region announces.
  - Screenshots of the Backup section (Off and On) and the dialogs at phone, tablet and widescreen, light and dark. No horizontal overflow.
  - The console-error filter allows "Failed to load resource" only for statuses a scenario expects.
- **CI:** `ci.yml` installs `sync-server` dependencies and runs its tests in the checks job, and installs them in the e2e job. `setup-node` `cache-dependency-path` lists both lockfiles. The checks job also type-checks the e2e specs and `playwright.config.ts` (`npx tsc -p e2e`, with `@types/node`).

## Deploy and operations

- **Before go-live:**
  - Settle the trust-boundary decision (Architecture).
  - Optionally rename the account's `workers.dev` subdomain.
  - `wrangler secret put CHALLENGE_KEY` with 32 random bytes.
- **Server, first time:**
  - `npm run deploy` creates D1; the app is still hidden.
  - Commit the database id wrangler writes into `wrangler.jsonc`.
  - Then `npm run db:migrate:remote`.
  - Production vars `RP_ID`, `EXPECTED_ORIGINS` and `ALLOWED_ORIGINS` live in `wrangler.jsonc`, with the cron trigger daily. [cf-6]
- **Every later release:** migrate first, then deploy. Migrations must be additive and work with the previous Worker. Deploy the Worker before an app build that sends new fields.
- **App:** `deploy.yml` sets `VITE_SYNC_URL` for the build once the server is live.
- **Recovery [cf-4, sync-5]:**
  - D1 Time Travel (7 days on Free) restores the **whole database**. Use it only for disasters.
  - Devices re-upload what they hold (client step 5), so a restore loses at most what no device still has.
  - There is no per-user undo; deliberate deletion goes through a reset or account deletion.
- **Logs [cf-8]:** free, invocation logs off. From 1 Dec 2026 the free allowance is 0.5 GB a day with 7-day retention; ingestion stops at the cap and never bills.
- **Release:** tag `v1.0.0` once sync is live.
