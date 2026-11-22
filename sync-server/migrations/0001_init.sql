-- Backup & sync schema (docs/sync-design.md, "D1 schema"). Times are Unix milliseconds from the server clock.
-- Deletes are explicit statements in one batch; nothing relies on foreign-key cascades.

-- One row per backup. id is the WebAuthn user handle: 32 random bytes, base64url without padding.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,            -- 'Tube Tracker · ABCD', the passkey's name and display name
  created_at INTEGER NOT NULL
);
CREATE INDEX users_created_at ON users (created_at);

-- One row per passkey.
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,           -- credential id, base64url
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,      -- COSE public key, base64url
  counter INTEGER NOT NULL,
  transports TEXT,               -- JSON array of strings
  device_type TEXT NOT NULL,     -- 'multiDevice' (backup eligible) or 'singleDevice'
  backed_up INTEGER NOT NULL,    -- 1 when the authenticator says it's synced
  aaguid TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX credentials_user_id ON credentials (user_id);

-- One row per signed-in device. Only the token's SHA-256 is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL, -- written at most once a day
  verified_at INTEGER            -- the last passkey ceremony on this session (sign-in or reauth)
);
CREATE INDEX sessions_user_id ON sessions (user_id);

-- WebAuthn challenges already used. Challenges themselves are stateless (HMAC-signed); this makes them single use.
CREATE TABLE used_challenges (
  challenge TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per backup: the SyncState as JSON, with a version for optimistic concurrency.
CREATE TABLE progress (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
