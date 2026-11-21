import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, openMap, selectStation, stationLabel } from './helpers';

/** Interaction behaviours, checked on one desktop (mouse) and one phone (touch, WebKit) project. */
test.beforeEach(({ }, testInfo) => {
  test.skip(!['laptop-1280', 'iphone-webkit'].includes(testInfo.project.name), 'interaction checks run on two representative projects');
});

async function centreOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected element to be rendered');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function recordJourney(page: Page, testInfo: Parameters<typeof selectStation>[1], from: string, to: string) {
  await selectStation(page, testInfo, from);
  await selectStation(page, testInfo, to);
  await page.locator('.route-action-bar').getByRole('button', { name: /record route|already explored/i }).click();
  await expect(page.locator('.route-action-bar')).toBeHidden();
}

test('a chosen alternative keeps its number after hiding the alternatives', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await openMap(page);
  await selectStation(page, testInfo, 'baker_street');
  await selectStation(page, testInfo, 'aldgate');
  const routeBar = page.locator('.route-action-bar');
  await routeBar.getByRole('button', { name: 'Show alternative routes' }).click();
  await routeBar.getByRole('group', { name: 'Choose the route you travelled' }).getByRole('button').nth(2).click();
  await expect(routeBar.locator('.route-primary-action')).toContainText('Route 3:');
  await routeBar.getByRole('button', { name: 'Hide alternative routes' }).click();
  await expect(routeBar.locator('.route-primary-action')).toContainText('Route 3:');
  expect(errors).toEqual([]);
});

test('selection and recorded progress survive switching tabs; reset clears them', async ({ page }, testInfo) => {
  await openMap(page);
  await recordJourney(page, testInfo, 'paddington', 'waterloo');
  await selectStation(page, testInfo, 'bank');
  await expect(stationLabel(page, 'bank')).toHaveAttribute('data-app-selected', 'true');

  await page.getByRole('button', { name: 'Statistics' }).click();
  await expect(page.getByText(/^0\.0 km$/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Map' }).click();
  await expect(stationLabel(page, 'bank')).toHaveAttribute('data-app-selected', 'true');
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Statistics' }).click();
  await expect(page.getByText(/^0\.0 km$/)).toBeVisible();
});

test('recorded progress and the chosen theme persist across reloads', async ({ page }, testInfo) => {
  await openMap(page);
  await recordJourney(page, testInfo, 'paddington', 'waterloo');
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole('banner').getByRole('button', { name: /switch to/i }).click();
  const chosenTheme = initialTheme === 'dark' ? 'light' : 'dark';
  await expect(page.locator('html')).toHaveAttribute('data-theme', chosenTheme);

  await page.reload();
  await openMap(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', chosenTheme);
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');
  await expect(page.locator('#app-travelled-sections path').first()).toBeAttached();
});

test('long-press inspects a station and drag selects a journey (mouse)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'mouse gestures');
  await openMap(page);

  const paddington = await centreOf(stationLabel(page, 'paddington'));
  await page.mouse.move(paddington.x, paddington.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator('.map-inspection-panel')).toContainText('Paddington');
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-selected', 'false');

  const waterloo = await centreOf(stationLabel(page, 'waterloo'));
  await page.mouse.move(paddington.x, paddington.y);
  await page.mouse.down();
  await page.mouse.move(waterloo.x, waterloo.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.route-action-bar')).toContainText('Paddington → Waterloo');
  await expect(page.locator('.map-inspection-panel')).toBeHidden();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`station labels show their journey state colour consistently (${colorScheme})`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'laptop-1280', 'computed style check runs on one project');
    await page.emulateMedia({ colorScheme });
    await openMap(page);
    await recordJourney(page, testInfo, 'paddington', 'waterloo');

    const expected = colorScheme === 'light'
      ? { entered: 'rgb(21, 128, 61)', changed: 'rgb(180, 83, 9)' }
      : { entered: 'rgb(74, 222, 128)', changed: 'rgb(251, 191, 36)' };
    const readFills = () => page.evaluate(() => {
      const fillOf = (element: Element | null) => (element ? getComputedStyle(element).fill : null);
      const label = (stationId: string) => document.querySelector(`#text text[data-app-station-id="${stationId}"]`);
      const changed = [...document.querySelectorAll('#text text[data-app-state="changed"]')];
      return {
        entered: fillOf(label('paddington')),
        neutral: fillOf(label('upminster')),
        changed: changed.map((text) => [fillOf(text), ...[...text.querySelectorAll('tspan')].map(fillOf)])
      };
    });
    // Label fills animate briefly, so wait for them to settle.
    await expect.poll(async () => (await readFills()).entered).toBe(expected.entered);
    const fills = await readFills();
    expect(fills.neutral).not.toBe(expected.entered);
    expect(fills.changed.length).toBeGreaterThan(0);
    for (const labelFills of fills.changed) expect(new Set(labelFills)).toEqual(new Set([expected.changed]));
  });
}
