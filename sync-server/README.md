# Tube Tracker sync server

The backup & sync API for Tube Tracker: one Cloudflare Worker with a D1 database, on the **Workers Free plan** only. Going over a free limit makes requests fail until the next day (00:00 UTC); it is never billed. The contract is [`docs/sync-design.md`](../docs/sync-design.md) ("Server API"). The backup's data model and merge rules are shared with the app: the Worker imports [`src/lib/sync-model.ts`](../src/lib/sync-model.ts) by relative path.

The app only shows sync when it's built with `VITE_SYNC_URL` set, so this server can be deployed, tested and torn down without users seeing anything.

## Layout

- `src/index.ts`: entry point. CORS wraps every response (errors included), routing, error mapping, and the daily `scheduled()` cleanup
- `src/routes.ts`: passkey, session and account endpoints
- `src/sync.ts`: `POST /v1/sync` (validation, clock check, limits, optimistic concurrency)
- `src/webauthn.ts`: passkey options and verification (`@simplewebauthn/server`)
- `src/crypto.ts`: tokens, hashing and the stateless HMAC-signed challenges
- `src/sessions.ts`: bearer-token sessions; `src/rate-limit.ts`: Workers Rate Limiting; `src/cleanup.ts`: the cron job
- `src/http.ts`: JSON responses, body limits, D1 error mapping and logging; `src/db.ts`: row types and the account view
- `migrations/0001_init.sql`: the schema
- `test/`: Vitest in the Workers runtime against a local D1, with a software passkey authenticator (`test/authenticator.ts`)

## Local development

Needs Node 22.12 or later. Everything runs offline; nothing here talks to Cloudflare.

```bash
cd sync-server
npm install
cp .dev.vars.example .dev.vars   # local CHALLENGE_KEY, RP_ID=localhost, local origins, RATE_LIMITS=off
npm run dev                      # applies migrations to .wrangler/state, then serves http://localhost:8870
```

Then run the app against it from the repository root: `VITE_SYNC_URL=http://localhost:8870 npm run dev`. Passkeys work on `http://localhost` in desktop Chrome and Safari. `.dev.vars` allows the app's origin `http://localhost:5173`; change `EXPECTED_ORIGINS` and `ALLOWED_ORIGINS` there if the app runs on another port.

```bash
curl http://localhost:8870/v1/health   # {"apiVersion":1,"ok":true}
npm run db:migrate:local               # apply new migrations to the local database
```

The cron job doesn't run by itself under `wrangler dev`; the tests cover it.

## Tests

```bash
npm test            # Vitest 4.1 + @cloudflare/vitest-pool-workers: the Worker in workerd, against a fresh in-memory D1
npm run typecheck   # the Worker, the tests and vitest.config.ts
```

`vitest.config.ts` applies the migrations in `test/setup.ts` and swaps the production vars for test ones (RP ID `localhost`, origin `http://localhost:5173`, a test `CHALLENGE_KEY`, rate limits off). Tests call the Worker's `fetch` directly, so a test can replace any binding: a failing D1, a refusing rate limiter, a lower `MAX_USERS`. Registration, sign-in, reauth and adding passkeys go through the real `@simplewebauthn/server` verification, driven by the software authenticator (ES256, `none` attestation, discoverable credentials with user handles).

The root project's Vitest excludes `sync-server/**`; this package has its own dependencies and lockfile.

## Configuration

| Name | Kind | Production value | Purpose |
|---|---|---|---|
| `RP_ID` | var | `davidmcgurk.github.io` | WebAuthn relying party: the app's host, never this Worker's. Can't change after the first real passkey. |
| `EXPECTED_ORIGINS` | var | `https://davidmcgurk.github.io` | Comma-separated origins a passkey ceremony may come from. |
| `ALLOWED_ORIGINS` | var | `https://davidmcgurk.github.io` | Comma-separated origins that get CORS headers. Any other `Origin` gets 403. |
| `MAX_USERS` | var | `2500` | Registrations close at this many backups. The worst case per backup is about 155 KB (a full 128 KB state, 10 passkeys at the capped sizes and 20 sign-ins), so 2,500 fit D1 Free's 500 MB with room to spare. |
| `MAX_NEW_USERS_PER_DAY` | var | unset (200) | At most this many new backups per UTC day. The e2e server raises it so repeated runs (`--repeat-each`) don't reach it. |
| `RATE_LIMITS` | var | unset | `off` disables rate limiting. Local and e2e only. |
| `CHALLENGE_KEY` | **secret** | 32 random bytes | HMAC key for WebAuthn challenges; at least 32 characters. Without it the options endpoints answer 500. |
| `DB` | D1 | `tube-tracker-sync` | The database. |
| `AUTH_RATE_LIMITER` | rate limit | 20 / 60 s | Unauthenticated `/v1/auth/*`, keyed by IPv4 address or IPv6 /64. |
| `SYNC_RATE_LIMITER` | rate limit | 30 / 60 s | `/v1/sync`, keyed by user. |

**Rate limiting on the Free plan:** the [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) has been generally available since September 2025, and neither its docs nor the Workers pricing and limits pages list a plan restriction or a price, so it's configured. Limits are approximate and counted per Cloudflare location. They guard CPU and D1, not the 100,000-requests-a-day budget, because a refused request still counts. If the binding is missing or fails, requests are allowed, and `RATE_LIMITS=off` turns it off. If a deploy is ever refused because of the binding, delete the `ratelimits` block from `wrangler.jsonc`; the code works without it.

**Logs:** `observability` is on with per-request invocation logs off (`observability.logs.invocation_logs: false`), so no URLs, headers or IP addresses are kept. Only unexpected errors are logged, as `{ route, code, name, message }`. Never bodies, tokens or progress.

## Deploying

You run these yourself; they need `npx wrangler login` with the Cloudflare account.

### First time

1. `npm run deploy`. Wrangler creates the D1 database `tube-tracker-sync` (automatic provisioning: there's no `database_id` in `wrangler.jsonc` yet) and offers to write its id into `wrangler.jsonc`. Accept, and **commit that change**. On a brand-new account it also asks for a `workers.dev` subdomain.
2. `npm run db:migrate:remote` to create the tables.
3. `openssl rand -base64 32 | npx wrangler secret put CHALLENGE_KEY`
4. Check it: `curl https://tube-tracker-sync.<subdomain>.workers.dev/v1/health`.
5. Only then set `VITE_SYNC_URL` to that URL in `.github/workflows/deploy.yml`, so the next app build shows Backup & sync.

Until step 5 nothing uses the API, so the gaps between steps 1–3 don't matter.

### Every later release

1. **Migrate first:** `npm run db:migrate:remote`. Migrations must be additive and work with the Worker that's still running.
2. **Then deploy:** `npm run deploy`.
3. Deploy the Worker before any app build that sends new fields. `/v1` never breaks; every response carries `apiVersion: 1`.

Rotating `CHALLENGE_KEY` only invalidates challenges issued in the last 10 minutes; nobody is signed out.

### Recovery

D1 Time Travel (7 days on Free) restores the **whole database**, so keep it for disasters. Devices re-upload what they still hold after a restore, so a restore loses at most what no device has. There is no per-user undo.

## Teardown

1. Remove `VITE_SYNC_URL` from `deploy.yml` and deploy the app, so it stops offering sync.
2. `npx wrangler delete` (the Worker, its cron trigger and secrets).
3. `npx wrangler d1 delete tube-tracker-sync` (the data; Cloudflare's recovery copies expire within 7 days).

## API notes for the client

Error bodies are `{ apiVersion: 1, error: { code, message } }`; `Retry-After` is exposed to the app through CORS.

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | Malformed JSON, unknown fields, a bad envelope (e.g. over 200 changes), a malformed passkey response (including a credential id over 342 characters, one that isn't the id in the signed data, or a public key over 600 bytes) |
| 400 | `challenge_invalid` / `challenge_expired` / `challenge_used` | A challengeId that's forged, for another purpose or account, over 10 minutes old, or already used |
| 400 | `verification_failed` / `user_mismatch` | The passkey response doesn't verify; the passkey belongs to another backup (or has no user handle) |
| 401 | `unauthorized` | Missing, unknown or expired token (only when the session lookup itself worked); also a sync or new passkey for a backup deleted on another device while the request was under way |
| 403 | `reauth_required` | A "✓ recent" endpoint more than 5 minutes after the session's last passkey ceremony (for `passkeys/verify`, an add challenge issued more than 5 minutes after it) |
| 403 | `forbidden_origin` | An `Origin` not in `ALLOWED_ORIGINS` (no CORS headers) |
| 404 | `unknown_credential` / `not_found` | Sign-in with a passkey the server doesn't know; a passkey or path that isn't there |
| 409 | `already_registered` / `last_passkey` / `too_many_passkeys` | Duplicate credential; removing the only passkey; an 11th passkey |
| 409 | `clock_skew` (+ `serverTime`) / `busy` | A change time out of range, so nothing was applied; the optimistic write lost 6 races |
| 413 | `too_large` | Bodies over 16 KB, or 256 KB for `/v1/sync` |
| 415 | `unsupported_media_type` | A non-empty body that isn't `application/json` |
| 429 | `rate_limited` | Rate limit hit (`Retry-After: 60`) |
| 503 | `over_capacity` / `busy` / `unavailable` / `registrations_closed` | D1's free daily quota (`Retry-After` until 00:00 UTC); D1 overloaded (`Retry-After: 5`); the session lookup failed; registrations closed |

`POST /v1/sync` returns `{ state, serverTime, rejected: [{ id, code }] }`, with `code` `invalid` or `backup_full`. A change that isn't an object with a usable id is reported with `id: null`.

## CPU budget

Workers Free allows 10 ms of CPU per request. Measured roughly in Node (same V8 engine, warmed up): a one-journey sync costs about 0.6 ms in total, and a 200-journey offline queue against a full-network state (1,029 ids, about 50 KB) about 1.6 ms. When no limit is at risk, a batch is merged in one go instead of change by change (`applyWithinLimits` in `src/sync.ts`; tests check it against the shared model's one-by-one definition). A nearly full backup (3,000 items or 128 KB, which the app can't reach with today's 1,029-id network) takes the one-by-one path, about 9 ms for 200 changes.
