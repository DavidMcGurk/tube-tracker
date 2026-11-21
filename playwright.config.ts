import { defineConfig, devices } from '@playwright/test';

/** Override with E2E_PORT to run several checkouts (e.g. git worktrees) side by side. */
const PORT = Number(process.env.E2E_PORT ?? 5199);

/**
 * Viewport sweep: the app is mobile-first (iPhone home-screen PWA) but must also work on widescreen.
 * Chromium projects use the locally installed Chrome; the WebKit project approximates iOS Safari.
 */
const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  },
  projects: [
    { name: 'phone-375', use: { channel: 'chrome', viewport: { width: 375, height: 667 }, ...phone, deviceScaleFactor: 2 } },
    { name: 'phone-393', use: { channel: 'chrome', viewport: { width: 393, height: 852 }, ...phone } },
    { name: 'phone-430', use: { channel: 'chrome', viewport: { width: 430, height: 932 }, ...phone } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 15'] } },
    { name: 'tablet-820', use: { channel: 'chrome', viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'laptop-1280', use: { channel: 'chrome', viewport: { width: 1280, height: 800 } } },
    { name: 'wide-1920', use: { channel: 'chrome', viewport: { width: 1920, height: 1080 } } }
  ]
});
