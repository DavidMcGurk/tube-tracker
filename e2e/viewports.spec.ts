import { expect, test } from '@playwright/test';
import {
  collectErrors,
  expectNoHorizontalPageOverflow,
  expectWithinViewport,
  openMap,
  screenshotPath,
  selectStation
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
