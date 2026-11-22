/**
 * Tube Tracker backup & sync API: a Cloudflare Worker with D1 on the free plan. The contract is docs/sync-design.md
 * ("Server API"); the backup's data model and merge rules are shared with the app (src/lib/sync-model.ts).
 */
import { cleanup } from './cleanup';
import { listSetting, type Env } from './env';
import { HttpError, errorResponse, logError, mapD1Error } from './http';
import { ROUTES, runRoute, type Route } from './routes';

export type { Env } from './env';

const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  // WebKit clamps this to 600 seconds.
  'Access-Control-Max-Age': '7200'
} as const;

export default {
  /**
   * CORS wraps everything, error paths included, so the app can always read the answer. CORS only stops other
   * websites' scripts: it isn't access control, and no limit depends on it.
   */
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get('Origin');
    if (origin !== null && !listSetting(env.ALLOWED_ORIGINS).includes(origin)) {
      return errorResponse(new HttpError(403, 'forbidden_origin', 'Requests from this site are not allowed.'));
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: origin === null ? { Allow: 'GET, POST, DELETE, OPTIONS' } : { ...corsHeaders(origin), ...PREFLIGHT_HEADERS } });
    }
    const response = await handle(request, env);
    if (origin === null) return response;
    const withCors = new Response(response.body, response);
    for (const [name, value] of Object.entries(corsHeaders(origin))) withCors.headers.set(name, value);
    return withCors;
  },

  async scheduled(_controller, env): Promise<void> {
    try {
      await cleanup(env.DB, Date.now());
    } catch (err) {
      logError('cron cleanup', 'internal', err);
      throw err;
    }
  }
} satisfies ExportedHandler<Env>;

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    // Retry-After isn't a CORS-safelisted response header; the app needs it for backoff and "paused until".
    'Access-Control-Expose-Headers': 'Retry-After',
    Vary: 'Origin'
  };
}

/** Routes a request and turns every failure into a JSON error. Never throws. */
async function handle(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const url = new URL(request.url);
  let routeName = 'unmatched';
  try {
    const match = matchRoute(request.method, url.pathname);
    if (match.kind === 'not_found') throw new HttpError(404, 'not_found', 'No such API endpoint.');
    if (match.kind === 'wrong_method') {
      const response = errorResponse(new HttpError(405, 'method_not_allowed', `Use ${match.allowed.join(' or ')}.`));
      response.headers.set('Allow', match.allowed.join(', '));
      return response;
    }
    routeName = `${match.route.method} ${match.route.path}`;
    return await runRoute(match.route, { request, env, now, params: match.params });
  } catch (err) {
    return failureResponse(err, routeName, now);
  }
}

function failureResponse(err: unknown, routeName: string, now: number): Response {
  if (err instanceof HttpError) return errorResponse(err);
  const mapped = mapD1Error(err, now);
  if (mapped) return errorResponse(mapped);
  logError(routeName, 'internal', err);
  return errorResponse(new HttpError(500, 'internal', 'Something went wrong on the server.'));
}

type RouteMatch =
  | { kind: 'found'; route: Route; params: Record<string, string> }
  | { kind: 'wrong_method'; allowed: string[] }
  | { kind: 'not_found' };

function matchRoute(method: string, pathname: string): RouteMatch {
  const segments = pathname.split('/');
  const allowed: string[] = [];
  for (const route of ROUTES) {
    const params = matchPath(route.path, segments);
    if (!params) continue;
    if (route.method === method) return { kind: 'found', route, params };
    allowed.push(route.method);
  }
  return allowed.length > 0 ? { kind: 'wrong_method', allowed } : { kind: 'not_found' };
}

function matchPath(pattern: string, segments: readonly string[]): Record<string, string> | null {
  const parts = pattern.split('/');
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of parts.entries()) {
    const segment = segments[index]!;
    if (part.startsWith(':')) {
      if (segment.length === 0) return null;
      params[part.slice(1)] = segment;
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
}
