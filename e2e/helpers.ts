import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

export const isTouchProject = (testInfo: TestInfo) => Boolean(testInfo.project.use.hasTouch);

export function screenshotPath(testInfo: TestInfo, name: string) {
  return `test-results/screens/${testInfo.project.name}/${name}.png`;
}

/** Collects uncaught page errors and console errors so tests can assert a clean run. */
export function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

/**
 * Opens the app on the map tab. By default the "Add to Home Screen" pop-up is dismissed through the app's own storage
 * (which the app observes), so it never covers what a test taps; install-prompt tests pass `installPrompt: 'default'`.
 */
export async function openMap(page: Page, { installPrompt = 'dismissed' }: { installPrompt?: 'dismissed' | 'default' } = {}) {
  await page.goto('./');
  if (installPrompt === 'dismissed') await dismissInstallPrompt(page);
  await expect(page.locator('.tube-map-viewport svg')).toBeVisible();
  // Station bindings are attached by an effect once the SVG is in the DOM.
  await expect(page.locator('#text text[data-app-station-id]').first()).toBeAttached();
}

export async function dismissInstallPrompt(page: Page) {
  await page.evaluate(`(async () => {
    const storage = await import('/src/lib/storage.ts');
    await storage.updateInstallPromptState({ dismissedAt: Date.now() });
  })()`);
}

export function stationLabel(page: Page, stationId: string) {
  return page.locator(`#text text[data-app-station-id="${stationId}"]`).first();
}

export async function selectStation(page: Page, testInfo: TestInfo, stationId: string) {
  const label = stationLabel(page, stationId);
  if (isTouchProject(testInfo)) await label.tap();
  else await label.click();
}

export async function expectNoHorizontalPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
}

export async function expectWithinViewport(page: Page, locator: Locator, label: string) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} should be rendered`).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height, `${label} bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
}

/** Runs code inside the page against the app's own modules (served by Vite), e.g. to seed progress. */
export async function seedTravelledSections(page: Page, sectionFilter = 'true') {
  await page.evaluate(`(async () => {
    const network = await import('/src/data/network.ts');
    const storage = await import('/src/lib/storage.ts');
    const ids = network.sections.filter((section) => section.lineId !== 'interchange' && (${sectionFilter})).map((section) => section.id);
    await storage.saveProgress({ travelledSegmentIDs: ids, stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] });
  })()`);
}
