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
