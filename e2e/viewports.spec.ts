import { expect, test } from '@playwright/test';
import {
  collectErrors,
  expectNoHorizontalPageOverflow,
  expectWithinViewport,
  openMap,
  screenshotPath,
  selectStation,
  stationLabel
} from './helpers';

/**
 * Smoke flow across every viewport project, in light and dark themes.
 * Screenshots land in test-results/screens/<project>/ for visual review.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('map, route preview, record, statistics, settings and full screen', async ({ page }, testInfo) => {
      const errors = collectErrors(page);
      await openMap(page);
      await expectNoHorizontalPageOverflow(page);
      await expectWithinViewport(page, page.getByRole('button', { name: 'Zoom in' }), 'zoom in button');
      await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-1-map`) });

      await selectStation(page, testInfo, 'paddington');
      await selectStation(page, testInfo, 'waterloo');
      const routeBar = page.locator('.route-action-bar');
      await expect(routeBar).toBeVisible();
      await expect(routeBar).toContainText('Paddington → Waterloo');
      const recordButton = routeBar.getByRole('button', { name: /record route/i });
      await expectWithinViewport(page, recordButton, 'record route button');
      await expectNoHorizontalPageOverflow(page);
      await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-2-route-preview`) });

      await recordButton.click();
      await expect(routeBar).toBeHidden();
      // The undo bar takes the route actions' place, within reach and with full-size buttons.
      const undoBar = page.locator('[data-undo-bar]');
      await expect(undoBar).toBeVisible();
      await expectWithinViewport(page, undoBar, 'undo bar');
      for (const control of await undoBar.getByRole('button').all()) {
        await expectWithinViewport(page, control, `undo bar ${await control.textContent()} button`);
        const box = await control.boundingBox();
        expect(Math.min(box!.width, box!.height), 'undo bar buttons are at least 44px each way').toBeGreaterThanOrEqual(44);
      }
      await expectNoHorizontalPageOverflow(page);
      await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-2b-undo-bar`) });

      await page.getByRole('button', { name: 'Statistics' }).click();
      const networkTrack = page.getByRole('progressbar', { name: 'Whole network track travelled' });
      await expect(networkTrack).toBeVisible();
      expect(Number(await networkTrack.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
      await expectNoHorizontalPageOverflow(page);
      await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-3-statistics`), fullPage: true });

      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByRole('button', { name: 'Reset progress' })).toBeVisible();
      await expectNoHorizontalPageOverflow(page);
      await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-4-settings`), fullPage: true });

      // Reset asks first, in a modal dialog with Cancel focused; focus goes back to the button afterwards.
      const resetButton = page.getByRole('button', { name: 'Reset progress' });
      await resetButton.click();
      const resetDialog = page.getByRole('dialog', { name: 'Reset all progress?' });
      await expect(resetDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expectWithinViewport(page, resetDialog, 'reset dialog');
      await expectNoHorizontalPageOverflow(page);
      await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-4b-reset-dialog`) });
      await resetDialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(resetDialog).toBeHidden();
      await expect(resetButton).toBeFocused();

      await page.getByRole('button', { name: 'Map' }).click();
      await expect(page.locator('.tube-map-viewport svg')).toBeVisible();
      await page.getByRole('button', { name: 'View map full screen' }).click();
      await expectWithinViewport(page, page.getByRole('button', { name: 'Exit full screen map' }), 'exit full screen button');
      await expectNoHorizontalPageOverflow(page);
      await page.screenshot({ path: screenshotPath(testInfo, `${colorScheme}-5-fullscreen`) });

      expect(errors).toEqual([]);
    });
  });
}

test('the app fits the screen: the title and tabs stay put, only the content scrolls, and nothing zooms', async ({ page }, testInfo) => {
  await openMap(page);
  const pageState = () => page.evaluate(() => {
    const view = document.querySelector('.tube-map-viewport')?.getBoundingClientRect();
    const header = document.querySelector('.app-shell > header')!.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      gapUnderMap: view ? window.innerHeight - view.bottom : null,
      viewportTag: document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!.content,
      touchAction: getComputedStyle(document.querySelector('.app-shell')!).touchAction,
      header: { top: header.top, height: header.height }
    };
  });
  const onMap = await pageState();
  expect(onMap.overflow, 'nothing to scroll on the map tab').toBeLessThanOrEqual(0);
  expect(onMap.htmlOverflow).toBe('hidden');
  expect(onMap.gapUnderMap, 'the map reaches down to the bottom of the screen').toBeLessThan(48);
  expect(onMap.viewportTag).toContain('user-scalable=no');
  expect(onMap.touchAction, 'no page zoom or sideways pan').toBe('pan-y');

  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'waterloo');
  await expect(page.locator('.route-action-bar')).toBeVisible();
  expect((await pageState()).overflow, 'nor with the route bar showing').toBeLessThanOrEqual(0);

  for (const tab of ['Statistics', 'Settings']) {
    await page.getByRole('button', { name: tab }).click();
    const content = page.locator('main.page-scroll');
    await expect(content).toBeVisible();
    const before = await pageState();
    expect(before.overflow, `${tab}: the page itself doesn’t scroll`).toBeLessThanOrEqual(0);
    expect(before.htmlOverflow).toBe('hidden');
    expect(before.touchAction).toBe('pan-y');
    expect(before.header, `${tab}: the title bar matches the map tab’s`).toEqual(onMap.header);
    // The content scrolls in its own area, under the title and tabs.
    const scrolled = await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    if (scrolled > 0) expect((await pageState()).header, `${tab}: the title bar stays put while the content scrolls`).toEqual(onMap.header);
    await expect(page.getByRole('navigation')).toBeInViewport();
  }
});

test('a phone held sideways keeps the map usable with a route and its alternatives open', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-393', 'one phone project, rotated');
  await page.setViewportSize({ width: 852, height: 393 });
  await openMap(page);
  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'waterloo');
  await page.locator('.route-action-bar').getByRole('button', { name: 'Show alternative routes' }).click();
  const mapHeight = await page.locator('.tube-map-viewport').evaluate((element) => element.clientHeight);
  expect(mapHeight).toBeGreaterThan(150);
  await expectWithinViewport(page, page.locator('.route-action-bar').getByRole('button', { name: 'Hide alternative routes' }), 'hide alternatives button');
  await page.screenshot({ path: screenshotPath(testInfo, 'landscape-alternatives') });
});

test('a double tap on “Record route” keeps the journey, though Undo takes its place', async ({ page }, testInfo) => {
  test.skip(!['phone-393', 'iphone-webkit'].includes(testInfo.project.name), 'phones, where the undo bar floats where the route actions were');
  const errors = collectErrors(page);
  await openMap(page);
  const routeBar = page.locator('.route-action-bar');
  const undoBar = page.locator('[data-undo-bar]');
  const buttonAt = (x: number, y: number) => page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('button')?.textContent ?? null, [x, y]);
  for (const gap of [150, 500]) {
    await page.evaluate(`(async () => (await import('/src/lib/storage.ts')).resetStoredProgress())()`);
    await expect(undoBar).toHaveCount(0);
    // Kennington to Oval has one route, so there's no “alternative routes” row: Undo appears right where Record was.
    await selectStation(page, testInfo, 'kennington');
    await selectStation(page, testInfo, 'oval');
    const record = routeBar.getByRole('button', { name: 'Record route' });
    await expect(record).toBeVisible();
    await expect(routeBar.getByRole('button', { name: /alternative routes/ })).toHaveCount(0);
    const box = (await record.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];

    const firstTap = Date.now();
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(gap);
    await expect.poll(() => buttonAt(x, y), `the second tap (${gap} ms later) lands on Undo`).toBe('Undo');
    await page.touchscreen.tap(x, y);
    expect(Date.now() - firstTap, 'both taps fall within the guard').toBeLessThan(800);

    await page.waitForTimeout(300);
    await expect(undoBar).toBeVisible();
    await expect(undoBar).toHaveAccessibleName('Journey recorded');
    await expect(stationLabel(page, 'oval')).toHaveAttribute('data-app-state', 'entered');
    await expect(page.locator('[data-app-announcements]')).toHaveText('Journey recorded');
  }

  // A deliberate Undo, a moment later, still works.
  await page.waitForTimeout(900);
  await undoBar.getByRole('button', { name: 'Undo' }).tap();
  await expect(undoBar).toBeHidden();
  await expect(stationLabel(page, 'oval')).toHaveAttribute('data-app-state', 'neutral');
  expect(errors).toEqual([]);
});

test('the header lines up with the tabs and the map', async ({ page }) => {
  await openMap(page);
  const box = async (locator: ReturnType<typeof page.locator>) => {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error('Expected element to be rendered');
    return bounds;
  };
  const [title, themeButton, firstTab, card] = await Promise.all([
    box(page.getByRole('banner').getByRole('heading')),
    box(page.getByRole('banner').getByRole('button')),
    box(page.getByRole('navigation').getByRole('button').first()),
    box(page.locator('.map-card'))
  ]);
  expect(Math.abs(title.x - firstTab.x), 'title vs tabs').toBeLessThanOrEqual(1);
  expect(Math.abs(title.x - card.x), 'title vs map').toBeLessThanOrEqual(1);
  expect(Math.abs(themeButton.x + themeButton.width - (card.x + card.width)), 'theme button vs map').toBeLessThanOrEqual(1);
  // The logo is drawn straight onto the header, with no tile, so its background is the header's in either theme.
  const logo = page.getByRole('banner').locator('svg.app-logo');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await expect(logo).toBeVisible();
    await expect(logo).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(logo.locator('rect')).toHaveCount(0);
    for (const line of await logo.locator('path').all()) await expect(line).not.toHaveCSS('stroke', 'none');
  }
});
