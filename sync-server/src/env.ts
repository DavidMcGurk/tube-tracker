/** Bindings and settings (wrangler.jsonc, plus the CHALLENGE_KEY secret). */
export interface Env {
  DB: D1Database;
  /** HMAC key for stateless WebAuthn challenges. A secret: at least 32 characters. */
  CHALLENGE_KEY: string;
  /** WebAuthn relying party id: the app's host, never this Worker's. */
  RP_ID: string;
  /** Comma-separated origins a passkey ceremony may come from. */
  EXPECTED_ORIGINS: string;
  /** Comma-separated origins that get CORS headers. Anything else that sends an Origin gets 403. */
  ALLOWED_ORIGINS: string;
  /** Registrations close at this many backups (default 2,500). */
  MAX_USERS?: string;
  /** At most this many new backups per UTC day (default 200). The e2e server raises it. */
  MAX_NEW_USERS_PER_DAY?: string;
  /** 'off' disables rate limiting (local and e2e only). */
  RATE_LIMITS?: string;
  AUTH_RATE_LIMITER?: RateLimit;
  SYNC_RATE_LIMITER?: RateLimit;
}

export function listSetting(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}
