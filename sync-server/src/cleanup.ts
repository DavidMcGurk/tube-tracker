/** The daily Cron Trigger (docs/sync-design.md, "Daily Cron Trigger"). All in SQL, so it uses almost no Worker CPU. */
import { CHALLENGE_TTL_MS } from './crypto';
import { SESSION_TTL_MS } from './sessions';

const ABANDONED_AFTER_MS = 30 * 86_400_000;

/**
 * Accounts with nothing to lose: older than 30 days, no session used for 30 days, and an empty state (no items; a
 * missing progress row counts as empty, a corrupt one doesn't). Every statement below re-evaluates this in the same
 * transaction; deleting sessions and progress first doesn't change the answer, and users go last.
 */
const ABANDONED_USERS = `
  SELECT u.id FROM users u LEFT JOIN progress p ON p.user_id = u.id
  WHERE u.created_at < ?1
    AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.last_used_at >= ?1)
    AND CASE
      WHEN p.state IS NULL THEN 1
      WHEN json_valid(p.state) THEN NOT EXISTS (SELECT 1 FROM json_tree(p.state, '$.items') WHERE type IN ('integer', 'real'))
      ELSE 0
    END`;

export interface CleanupResult {
  usedChallenges: number;
  expiredSessions: number;
  abandonedAccounts: number;
  /** Passkey, session and progress rows whose user is gone. */
  orphanRows: number;
}

export async function cleanup(db: D1Database, now: number): Promise<CleanupResult> {
  const cutoff = now - ABANDONED_AFTER_MS;
  const results = await db.batch([
    db.prepare('DELETE FROM used_challenges WHERE created_at < ?').bind(now - CHALLENGE_TTL_MS),
    db.prepare('DELETE FROM sessions WHERE last_used_at < ?').bind(now - SESSION_TTL_MS),
    db.prepare(`DELETE FROM credentials WHERE user_id IN (${ABANDONED_USERS})`).bind(cutoff),
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${ABANDONED_USERS})`).bind(cutoff),
    db.prepare(`DELETE FROM progress WHERE user_id IN (${ABANDONED_USERS})`).bind(cutoff),
    db.prepare(`DELETE FROM users WHERE id IN (${ABANDONED_USERS})`).bind(cutoff),
    // A backstop: rows whose user has gone. Sync and new passkeys only insert for a user that exists, but a deletion
    // racing another write (or an older Worker) could still leave one, and nothing else would ever reach or remove it.
    ...['credentials', 'sessions', 'progress'].map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id NOT IN (SELECT id FROM users)`))
  ]);
  return {
    usedChallenges: results[0]?.meta.changes ?? 0,
    expiredSessions: results[1]?.meta.changes ?? 0,
    abandonedAccounts: results[5]?.meta.changes ?? 0,
    orphanRows: results.slice(6).reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)
  };
}
