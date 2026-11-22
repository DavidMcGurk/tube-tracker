import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { collectErrors, isTouchProject, openMap, screenshotPath, stationLabel } from './helpers';

/** Matches INSTALL_PROMPT_DELAY_MS in src/hooks/useInstallPrompt.ts. */
const PROMPT_DELAY_MS = 2000;

const IPHONE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
/** iPadOS Safari asks for desktop sites, so it sends a Mac user agent; only its touch points give it away. */
const IPAD_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

type InstallStubWindow = Window & {
  __installPromptShownAt?: number;
  __installPromptCalls?: number;
  __persistCalls?: number;
};

const installPrompt = (page: Page) => page.getByRole('dialog', { name: 'Install Tube Tracker' });
const anyInstallPrompt = (page: Page) => page.locator('[data-install-prompt]');

function onlyOn(...projects: string[]) {
  test.beforeEach(({ }, testInfo) => {
    test.skip(!projects.includes(testInfo.project.name), `runs on ${projects.join(', ')}`);
  });
}

async function press(locator: Locator, testInfo: TestInfo) {
  if (isTouchProject(testInfo)) await locator.tap();
  else await locator.click();
}

/** Waits past the pop-up's delay, for checks that it did not appear. */
async function waitPastPromptDelay(page: Page) {
  await page.waitForTimeout(PROMPT_DELAY_MS + 1000);
}

/** Records when the pop-up first enters the DOM, in milliseconds since navigation started. */
async function recordPromptAppearance(page: Page) {
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-install-prompt]')) return;
      (window as InstallStubWindow).__installPromptShownAt = performance.now();
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Fires a synthetic `beforeinstallprompt`, as Chromium does when the app becomes installable. */
async function dispatchInstallEvent(page: Page, outcome: 'accepted' | 'dismissed') {
  await page.evaluate((choice) => {
    const stub = window as InstallStubWindow;
    stub.__installPromptCalls = 0;
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      platforms: ['web'],
      prompt: () => {
        stub.__installPromptCalls = (stub.__installPromptCalls ?? 0) + 1;
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: choice, platform: 'web' })
    });
    window.dispatchEvent(event);
  }, outcome);
}

const installPromptCalls = (page: Page) => page.evaluate(() => (window as InstallStubWindow).__installPromptCalls ?? 0);

/**
 * Counts persistent-storage requests instead of making them. The stub goes on the prototype: WebKit can garbage-collect
 * the `navigator.storage` wrapper and lose properties set on it.
 */
async function countPersistRequests(page: Page) {
  await page.addInitScript(() => {
    const stub = window as InstallStubWindow;
    stub.__persistCalls = 0;
    StorageManager.prototype.persist = () => {
      stub.__persistCalls = (stub.__persistCalls ?? 0) + 1;
      return Promise.resolve(true);
    };
  });
}

const persistRequests = (page: Page) => page.evaluate(() => (window as InstallStubWindow).__persistCalls);

/** Pretends to be the home-screen app. */
async function emulateStandalone(page: Page) {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query !== '(display-mode: standalone)') return matchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false
      };
    };
  });
}

/** Reads the persisted pop-up state straight from IndexedDB. */
function storedInstallPromptState(page: Page) {
  return page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('tube-tracker-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('settings').objectStore('settings').get('installPrompt');
      read.onsuccess = () => {
        db.close();
        resolve((read.result as { value?: unknown } | undefined)?.value ?? null);
      };
      read.onerror = () => {
        db.close();
        reject(read.error);
      };
    };
  }));
}

test.describe('iPhone Safari', () => {
  onlyOn('iphone-webkit');

  test('shows Share instructions after a short delay; closing it is remembered', async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await recordPromptAppearance(page);
    await openMap(page, { installPrompt: 'default' });

    const prompt = installPrompt(page);
    await expect(prompt).toBeVisible();
    const shownAt = await page.evaluate(() => (window as InstallStubWindow).__installPromptShownAt ?? 0);
    expect(shownAt, 'the pop-up waits before appearing').toBeGreaterThanOrEqual(PROMPT_DELAY_MS);
    await expect(prompt).toHaveAttribute('aria-modal', 'false');
    await expect(prompt.locator('[data-install-arrow="down"]')).toBeVisible();
    await expect(prompt.getByRole('list', { name: /how to add/i })).toContainText('Share');
    await expect(prompt.getByRole('list', { name: /how to add/i })).toContainText('Add to Home Screen');
    await expect(prompt).toContainText('Don’t see Share? Tap ••• first.');
    await expect(prompt).toContainText('7 days');

    await press(prompt.getByRole('button', { name: 'Close' }), testInfo);
    await expect(prompt).toBeHidden();
    await expect.poll(() => storedInstallPromptState(page)).toMatchObject({ dismissedAt: expect.any(Number) });

    await page.reload();
    await expect(page.locator('.tube-map-viewport svg')).toBeVisible();
    await waitPastPromptDelay(page);
    await expect(anyInstallPrompt(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Settings' }).tap();
    const settings = page.getByRole('main');
    await expect(settings.getByRole('heading', { name: 'Install app' })).toBeVisible();
    await expect(settings.getByRole('list', { name: /how to add/i })).toContainText('Add to Home Screen');
    expect(errors).toEqual([]);
  });

  test('explains that journeys recorded in Safari stay in Safari', async ({ page }) => {
    await openMap(page, { installPrompt: 'default' });
    await page.evaluate(`(async () => {
      const storage = await import('/src/lib/storage.ts');
      await storage.updateProgress(() => ({ travelledSegmentIDs: [], walkedLinkIDs: [], stationsEnteredOrExitedIDs: ['bank'], stationsChangedAtIDs: [] }));
    })()`);
    const prompt = installPrompt(page);
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('keeps its own data');
    await expect(prompt).not.toContainText('keeps your progress safe');
  });

  test('Escape dismisses it', async ({ page }) => {
    await openMap(page, { installPrompt: 'default' });
    await expect(installPrompt(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(installPrompt(page)).toBeHidden();
    await expect.poll(() => storedInstallPromptState(page)).toMatchObject({ dismissedAt: expect.any(Number) });
  });

  test('steps aside while a route is selected', async ({ page }) => {
    await openMap(page, { installPrompt: 'default' });
    const prompt = installPrompt(page);
    await expect(prompt).toBeVisible();

    // Keyboard selection, so the pop-up cannot intercept a tap on a station it happens to cover.
    for (const stationId of ['paddington', 'waterloo']) {
      await stationLabel(page, stationId).focus();
      await page.keyboard.press('Enter');
    }
    const routeBar = page.locator('.route-action-bar');
    await expect(routeBar).toBeVisible();
    await expect(prompt).toBeHidden();

    await routeBar.getByRole('button', { name: 'Clear selection' }).tap();
    await expect(routeBar).toBeHidden();
    await expect(prompt).toBeVisible();
  });

  test('steps aside while a journey can be undone', async ({ page }) => {
    await openMap(page, { installPrompt: 'default' });
    const prompt = installPrompt(page);
    await expect(prompt).toBeVisible();

    for (const stationId of ['paddington', 'waterloo']) {
      await stationLabel(page, stationId).focus();
      await page.keyboard.press('Enter');
    }
    const routeBar = page.locator('.route-action-bar');
    await routeBar.getByRole('button', { name: 'Record route' }).tap();
    await expect(routeBar).toBeHidden();
    // The undo bar sits where the route actions were, and the pop-up keeps out of its way.
    const undoBar = page.locator('[data-undo-bar]');
    await expect(undoBar).toBeVisible();
    await expect(prompt).toBeHidden();

    await undoBar.getByRole('button', { name: 'Dismiss' }).tap();
    await expect(undoBar).toBeHidden();
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('keeps its own data');
  });

  test('never shows in the home-screen app, which asks for persistent storage once', async ({ page }) => {
    const errors = collectErrors(page);
    await emulateStandalone(page);
    await countPersistRequests(page);
    await openMap(page, { installPrompt: 'default' });
    await waitPastPromptDelay(page);
    await expect(anyInstallPrompt(page)).toHaveCount(0);
    expect(await persistRequests(page)).toBe(1);

    await page.getByRole('button', { name: 'Settings' }).tap();
    await expect(page.getByRole('button', { name: 'Reset progress' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Install app' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a regular Safari tab asks for persistent storage once, when a journey is first recorded', async ({ page }) => {
    await countPersistRequests(page);
    await openMap(page, { installPrompt: 'default' });
    await expect(installPrompt(page)).toBeVisible();
    expect(await persistRequests(page)).toBe(0);
    await installPrompt(page).getByRole('button', { name: 'Close' }).tap();

    const routeBar = page.locator('.route-action-bar');
    for (const [from, to] of [['paddington', 'waterloo'], ['bank', 'stratford']] as const) {
      await stationLabel(page, from).tap();
      await stationLabel(page, to).tap();
      await routeBar.getByRole('button', { name: /record route/i }).tap();
      await expect(routeBar).toBeHidden();
    }
    expect(await persistRequests(page)).toBe(1);
  });
});

test.describe('Android Chrome', () => {
  onlyOn('phone-393');
  test.use({ userAgent: ANDROID_CHROME_UA });

  test('offers the native install prompt, which can be used once', async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await openMap(page, { installPrompt: 'default' });
    await waitPastPromptDelay(page);
    await expect(anyInstallPrompt(page), 'nothing to offer until the browser says the app is installable').toHaveCount(0);

    await dispatchInstallEvent(page, 'accepted');
    const prompt = installPrompt(page);
    await expect(prompt).toBeVisible();
    await expect(anyInstallPrompt(page)).toHaveAttribute('data-install-prompt', 'native');
    await press(prompt.getByRole('button', { name: 'Install app' }), testInfo);
    await expect(prompt).toBeHidden();
    expect(await installPromptCalls(page)).toBe(1);
    await expect.poll(() => storedInstallPromptState(page)).toMatchObject({ installedAt: expect.any(Number) });

    await page.getByRole('button', { name: 'Settings' }).tap();
    await expect(page.getByText('Tube Tracker is installed on this device.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('declining the native prompt counts as a dismissal', async ({ page }, testInfo) => {
    await openMap(page, { installPrompt: 'default' });
    await dispatchInstallEvent(page, 'dismissed');
    const prompt = installPrompt(page);
    await press(prompt.getByRole('button', { name: 'Install app' }), testInfo);
    await expect(prompt).toBeHidden();
    await expect.poll(() => storedInstallPromptState(page)).toMatchObject({ dismissedAt: expect.any(Number) });

    await page.reload();
    await expect(page.locator('.tube-map-viewport svg')).toBeVisible();
    await dispatchInstallEvent(page, 'accepted');
    await waitPastPromptDelay(page);
    await expect(anyInstallPrompt(page)).toHaveCount(0);

    // Settings still offers the install as a fallback.
    await page.getByRole('button', { name: 'Settings' }).tap();
    await press(page.getByRole('main').getByRole('button', { name: 'Install app' }), testInfo);
    expect(await installPromptCalls(page)).toBe(1);
  });

  test('never shows in the installed app', async ({ page }) => {
    await emulateStandalone(page);
    await openMap(page, { installPrompt: 'default' });
    await dispatchInstallEvent(page, 'accepted');
    await waitPastPromptDelay(page);
    await expect(anyInstallPrompt(page)).toHaveCount(0);
  });
});

test.describe('desktop', () => {
  onlyOn('laptop-1280', 'wide-1920');

  test('never shows the pop-up, even when the browser offers an install', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, { installPrompt: 'default' });
    await dispatchInstallEvent(page, 'accepted');
    await waitPastPromptDelay(page);
    await expect(anyInstallPrompt(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('main').getByRole('button', { name: 'Install app' }).click();
    expect(await installPromptCalls(page)).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a narrow desktop window still gets no pop-up', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await openMap(page, { installPrompt: 'default' });
    await dispatchInstallEvent(page, 'accepted');
    await waitPastPromptDelay(page);
    await expect(anyInstallPrompt(page)).toHaveCount(0);
  });

  test('the browser toolbar colour follows the app theme, not just the system one', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openMap(page);
    const themeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => meta.getAttribute('content')));
    await expect.poll(themeColors).toEqual(['#fcfdfe', '#fcfdfe']);
    await page.getByRole('banner').getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect.poll(themeColors).toEqual(['#0c1327', '#0c1327']);
  });

  test('the icons linked from the page head resolve', async ({ page, request }) => {
    await page.goto('./');
    const hrefs = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"]')
      .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) {
      const response = await request.get(href);
      expect(response.ok(), href).toBe(true);
      expect(response.headers()['content-type'], href).toMatch(/^image\//);
    }
  });
});

/** Visual review: the pop-up on an iPhone (WebKit and Chromium) and an iPad, in both themes. */
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} screenshots`, () => {
    test.use({ colorScheme });

    test.describe('iPhone', () => {
      onlyOn('iphone-webkit');
      test('Share pop-up', async ({ page }, testInfo) => {
        await openMap(page, { installPrompt: 'default' });
        await expect(installPrompt(page)).toBeVisible();
        await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-install-prompt`) });
      });
    });

    test.describe('iPhone user agent on Chromium', () => {
      onlyOn('phone-375');
      test.use({ userAgent: IPHONE_SAFARI_UA });
      test('Share pop-up', async ({ page }, testInfo) => {
        await openMap(page, { installPrompt: 'default' });
        const prompt = installPrompt(page);
        await expect(prompt.locator('[data-install-arrow="down"]')).toBeVisible();
        await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-install-prompt`) });
      });
    });

    test.describe('iPad', () => {
      onlyOn('tablet-820');
      test.use({ userAgent: IPAD_SAFARI_UA });
      test('Share pop-up points up at the toolbar', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
        });
        await openMap(page, { installPrompt: 'default' });
        const prompt = installPrompt(page);
        await expect(anyInstallPrompt(page)).toHaveAttribute('data-install-prompt', 'ipad-share');
        await expect(prompt.locator('[data-install-arrow="up"]')).toBeVisible();
        await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-install-prompt`) });
      });
    });
  });
}
