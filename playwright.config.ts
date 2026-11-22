import { defineConfig, devices } from '@playwright/test';
import { APP_PORT, SYNC_APP_ORIGIN, SYNC_APP_PORT, SYNC_APP_URL, SYNC_SERVER_PORT, SYNC_SERVER_URL } from './e2e/ports';

/**
 * Viewport sweep: the app is mobile-first (iPhone home-screen PWA) but must also work on widescreen.
 * Chromium projects use the locally installed Chrome (CI uses Playwright's own Chromium build); the WebKit project
 * approximates iOS Safari.
 *
 * Ports come from E2E_PORT (see e2e/ports.ts), so several checkouts (e.g. git worktrees) can run side by side.
 */
const CI = Boolean(process.env.CI);
const chrome = CI ? {} : { channel: 'chrome' };
const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: true,
  workers: CI ? 2 : 4,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${APP_PORT}/`,
    trace: 'retain-on-failure'
  },
  webServer: [
    // The app as deployed today, without backup: every spec except sync.spec.ts.
    {
      name: 'app',
      command: `npx vite --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}/`,
      reuseExistingServer: !CI,
      timeout: 60_000
    },
    // The app built with backup switched on, for sync.spec.ts.
    {
      name: 'sync-app',
      command: `npx vite --port ${SYNC_APP_PORT} --strictPort`,
      env: { VITE_SYNC_URL: SYNC_SERVER_URL },
      url: SYNC_APP_URL,
      reuseExistingServer: !CI,
      timeout: 60_000
    },
    // The backup server (wrangler dev) with a fresh local database every run, so never reused.
    {
      name: 'sync-server',
      command: `node e2e/sync-server.mjs ${SYNC_SERVER_PORT} ${SYNC_APP_ORIGIN}`,
      url: `${SYNC_SERVER_URL}/v1/health`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      timeout: 120_000
    }
  ],
  projects: [
    { name: 'phone-375', use: { ...chrome, viewport: { width: 375, height: 667 }, ...phone, deviceScaleFactor: 2 } },
    { name: 'phone-393', use: { ...chrome, viewport: { width: 393, height: 852 }, ...phone } },
    { name: 'phone-430', use: { ...chrome, viewport: { width: 430, height: 932 }, ...phone } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 15'] } },
    { name: 'tablet-820', use: { ...chrome, viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'laptop-1280', use: { ...chrome, viewport: { width: 1280, height: 800 } } },
    { name: 'wide-1920', use: { ...chrome, viewport: { width: 1920, height: 1080 } } }
  ]
});
