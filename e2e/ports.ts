/**
 * Ports for the end-to-end servers, all derived from E2E_PORT so several checkouts (e.g. git worktrees) can run side
 * by side: the app without backup (every spec but sync.spec.ts), the app with backup, and the backup server.
 */
export const APP_PORT = Number(process.env.E2E_PORT ?? 5199);
export const SYNC_APP_PORT = APP_PORT + 1;
export const SYNC_SERVER_PORT = APP_PORT + 2;

export const SYNC_APP_URL = `http://localhost:${SYNC_APP_PORT}/`;
export const SYNC_APP_ORIGIN = `http://localhost:${SYNC_APP_PORT}`;
export const SYNC_SERVER_URL = `http://localhost:${SYNC_SERVER_PORT}`;
