/** Responses, errors, request bodies and D1 error mapping. Malformed input always becomes a 4xx, never a 500. */

export const API_VERSION = 1;

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_SYNC_BODY_BYTES = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds, sent as Retry-After. */
    readonly retryAfter?: number,
    /** Extra top-level fields, e.g. serverTime for clock_skew. */
    readonly fields?: Record<string, unknown>
  ) {
    super(message);
  }
}

export type Json = Record<string, unknown>;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
} as const;

/** Every JSON response carries apiVersion, so old clients can tell which API answered. */
export function json(body: Json, status = 200): Response {
  return jsonText(JSON.stringify({ apiVersion: API_VERSION, ...body }), status);
}

/** A response from JSON already serialized (the sync state is stringified once, for both D1 and the response). */
export function jsonText(text: string, status = 200): Response {
  return new Response(text, { status, headers: JSON_HEADERS });
}

export function errorResponse(err: HttpError): Response {
  const response = json({ ...err.fields, error: { code: err.code, message: err.message } }, err.status);
  if (err.retryAfter !== undefined) response.headers.set('Retry-After', String(err.retryAfter));
  return response;
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, 'bad_request', message);
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects any field not listed: the API never silently ignores input. */
export function expectFields(body: Json, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest(`Unknown field "${key.slice(0, 40)}".`);
  }
}

/**
 * Reads a JSON object body, counting bytes as they arrive so a body without Content-Length can't pass the cap either.
 * An empty body reads as {} (for endpoints whose request is `{}`).
 */
export async function readJson(request: Request, maxBytes: number): Promise<Json> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) throw tooLarge(maxBytes);
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  if (size === 0) return {};
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
  if (!isObject(parsed)) throw badRequest('The request body must be a JSON object.');
  return parsed;
}

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, 'too_large', `Request bodies are limited to ${maxBytes / 1024} KB.`);
}

export function secondsUntilUtcMidnight(now: number): number {
  const DAY = 86_400_000;
  return Math.max(1, Math.ceil((Math.floor(now / DAY) * DAY + DAY - now) / 1000));
}

/**
 * The client-facing error for a D1 failure that has a known meaning, or null. Free-plan daily quotas reset at
 * 00:00 UTC; an overloaded database is worth retrying in a few seconds.
 */
export function mapD1Error(err: unknown, now: number): HttpError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (/exceeded .*free tier daily/i.test(message)) {
    return new HttpError(503, 'over_capacity', 'The backup service has reached its daily limit. Please try again after 00:00 UTC.', secondsUntilUtcMidnight(now));
  }
  if (/overloaded/i.test(message)) {
    return new HttpError(503, 'busy', 'The backup service is busy. Please try again in a few seconds.', 5);
  }
  return null;
}

/** Only the route and the error's name and message: never headers, addresses, bodies, tokens or progress. */
export function logError(route: string, code: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  console.error(JSON.stringify({ route, code, name, message }));
}
