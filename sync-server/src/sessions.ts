/** Bearer-token sessions (docs/sync-design.md, "Sessions"). Only the token's SHA-256 is stored. */
import { randomBase64url, sha256Base64url } from './crypto';
import { HttpError, mapD1Error } from './http';
import type { Env } from './env';

const DAY_MS = 86_400_000;
export const SESSION_TTL_MS = 400 * DAY_MS;
export const MAX_SESSIONS = 20;
/** "✓ recent": a passkey ceremony on this session within the last 5 minutes. */
export const RECENT_MS = 5 * 60_000;
/** last_used_at is written at most once a day, so most requests write nothing. */
const LAST_USED_RESOLUTION_MS = DAY_MS;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface Session {
  tokenHash: string;
  userId: string;
  verifiedAt: number | null;
}

/**
 * A new session's token and the statements that store it, for the caller's batch. The batch also drops this user's
 * expired sessions and, beyond 20, the least recently used ones.
 */
export async function newSession(db: D1Database, userId: string, now: number): Promise<{ token: string; statements: D1PreparedStatement[] }> {
  const token = randomBase64url(32);
  const tokenHash = await sha256Base64url(token);
  return {
    token,
    statements: [
      db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, verified_at) VALUES (?1, ?2, ?3, ?3, ?3)')
        .bind(tokenHash, userId, now),
      db.prepare(
        `DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2 AND (last_used_at < ?3 OR token_hash NOT IN (
           SELECT token_hash FROM sessions WHERE user_id = ?1 AND token_hash != ?2
           ORDER BY last_used_at DESC, created_at DESC LIMIT ?4))`
      ).bind(userId, tokenHash, now - SESSION_TTL_MS, MAX_SESSIONS - 1)
    ]
  };
}

/** 401: no usable session, or its backup no longer exists. */
export function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Not signed in to backup, or the sign-in has expired.');
}

/**
 * The session for the request's bearer token. 401 means the lookup worked and found nothing usable; if D1 fails, the
 * answer is 503, so a client never signs out because of an outage.
 */
export async function authenticate(request: Request, env: Env, now: number): Promise<Session> {
  const match = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') ?? '');
  const token = match?.[1];
  if (!token || !TOKEN_PATTERN.test(token)) throw unauthorized();
  const tokenHash = await sha256Base64url(token);

  let row: { user_id: string; last_used_at: number; verified_at: number | null } | null;
  try {
    row = await env.DB.prepare('SELECT user_id, last_used_at, verified_at FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
  } catch (err) {
    throw mapD1Error(err, now) ?? new HttpError(503, 'unavailable', 'The backup service is unavailable. Please try again soon.', 5);
  }
  if (!row || now - row.last_used_at > SESSION_TTL_MS) throw unauthorized();

  if (now - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    try {
      await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').bind(now, tokenHash).run();
    } catch {
      // Only bookkeeping for expiry and cleanup; the request itself can still succeed.
    }
  }
  return { tokenHash, userId: row.user_id, verifiedAt: row.verified_at };
}

export function requireRecent(session: Session, now: number): void {
  if (session.verifiedAt === null || now - session.verifiedAt > RECENT_MS) {
    throw new HttpError(403, 'reauth_required', "Confirm it's you with your passkey first.");
  }
}
