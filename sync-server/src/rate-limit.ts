/**
 * Workers Rate Limiting (docs/sync-design.md, "Abuse, cost and request budget"). A coarse guard for CPU and D1, not
 * access control and not the request budget: a refused request still counts towards the daily total.
 */
import type { Env } from './env';
import { HttpError } from './http';

/** Matches the bindings' 60-second period (wrangler.jsonc). */
const RETRY_AFTER_SECONDS = 60;

/** Allows the request when limits are off, the binding is missing, or the limiter itself fails. */
export async function enforceRateLimit(env: Env, limiter: RateLimit | undefined, key: string): Promise<void> {
  if (env.RATE_LIMITS === 'off' || !limiter) return;
  let success: boolean;
  try {
    ({ success } = await limiter.limit({ key }));
  } catch {
    return;
  }
  if (!success) throw new HttpError(429, 'rate_limited', 'Too many requests. Please try again in a minute.', RETRY_AFTER_SECONDS);
}

/**
 * The key for unauthenticated requests: the IPv4 address, or the IPv6 /64 (one home or phone usually gets a whole
 * /64). Used only as a short-lived limiter key: never stored or logged.
 */
export function clientNetworkKey(request: Request): string {
  const address = (request.headers.get('CF-Connecting-IP') ?? '').trim().toLowerCase();
  if (!address.includes(':')) return address || 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1]!;
  const halves = address.split('::');
  if (halves.length > 2) return address;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
