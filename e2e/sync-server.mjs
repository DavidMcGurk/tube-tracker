/**
 * Runs the backup server (sync-server/) for the end-to-end tests: a fresh local D1 database with the migrations
 * applied, served by `wrangler dev` with test settings (RP ID localhost, the e2e app's origin, rate limits off, a
 * daily cap on new backups that no run reaches, and a test challenge key). Nothing here talks to Cloudflare.
 *
 * Usage: node e2e/sync-server.mjs <port> <app origin>
 *
 * The settings come from a generated env file, so a developer's sync-server/.dev.vars is never used. The database
 * lives in a new temporary directory each time, removed again when Playwright stops the server (SIGTERM).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [port, appOrigin] = process.argv.slice(2);
if (!port || !appOrigin) {
  console.error('Usage: node e2e/sync-server.mjs <port> <app origin>');
  process.exit(2);
}

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '../sync-server');
const wrangler = join(serverDir, 'node_modules/wrangler/bin/wrangler.js');
const stateDir = mkdtempSync(join(tmpdir(), 'tube-tracker-sync-e2e-'));
const envFile = join(stateDir, 'e2e.env');
writeFileSync(envFile, [
  'CHALLENGE_KEY=e2e-challenge-key-not-a-secret-0123456789abcdef',
  'RP_ID=localhost',
  `EXPECTED_ORIGINS=${appOrigin}`,
  `ALLOWED_ORIGINS=${appOrigin}`,
  'RATE_LIMITS=off',
  // Every test turns backup on afresh, so repeated runs (--repeat-each) would pass the real 200 a day.
  'MAX_NEW_USERS_PER_DAY=100000',
  ''
].join('\n'));

const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const cleanUp = () => rmSync(stateDir, { recursive: true, force: true });

const migrate = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir], {
  cwd: serverDir,
  env,
  stdio: ['ignore', 'inherit', 'inherit']
});
if (migrate.status !== 0) {
  cleanUp();
  process.exit(migrate.status ?? 1);
}

const dev = spawn(process.execPath, [
  wrangler, 'dev',
  '--local',
  '--port', port,
  '--persist-to', stateDir,
  '--env-file', envFile,
  '--show-interactive-dev-session=false'
], { cwd: serverDir, env, stdio: ['ignore', 'inherit', 'inherit'] });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => dev.kill(signal));
}
dev.on('exit', (code, signal) => {
  cleanUp();
  process.exit(code ?? (signal ? 0 : 1));
});
