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
  const networkTrack = page.getByRole('progressbar', { name: 'Whole network track travelled' });
  expect(Number(await networkTrack.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Map' }).click();
  await expect(stationLabel(page, 'bank')).toHaveAttribute('data-app-selected', 'true');
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Statistics' }).click();
  await expect(page.getByRole('progressbar', { name: 'Whole network track travelled' })).toHaveAttribute('aria-valuenow', '0');
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
    // Elizabeth line then Jubilee, changing at Bond Street.
    await recordJourney(page, testInfo, 'paddington', 'london_bridge');

    const expected = colorScheme === 'light'
      ? { entered: 'rgb(22, 101, 52)', changed: 'rgb(109, 40, 217)' }
      : { entered: 'rgb(74, 222, 128)', changed: 'rgb(196, 181, 253)' };
    const readFills = () => page.evaluate(() => {
      const fillOf = (element: Element | null) => (element ? getComputedStyle(element).fill : null);
      const label = (stationId: string) => document.querySelector(`#text text[data-app-station-id="${stationId}"]`);
      const changed = [...document.querySelectorAll('#text text[data-app-state="changed"]')];
      const glowOf = (stationId: string) => getComputedStyle(document.querySelector(`#station_nodes use[data-app-station-id="${stationId}"]`)!).filter;
      return {
        entered: fillOf(label('paddington')),
        neutral: fillOf(label('upminster')),
        passedThrough: fillOf(label('westminster')),
        changed: changed.map((text) => [fillOf(text), ...[...text.querySelectorAll('tspan')].map(fillOf)]),
        glows: { entered: glowOf('paddington'), changed: glowOf('bond_street'), passedThrough: glowOf('westminster'), neutral: glowOf('upminster') }
      };
    });
    // Label fills animate briefly, so wait for them to settle.
    await expect.poll(async () => (await readFills()).entered).toBe(expected.entered);
    const fills = await readFills();
    expect(fills.neutral).not.toBe(expected.entered);
    // Stations only passed through are not marked: same colour and no glow, like stations never visited.
    expect(fills.passedThrough).toBe(fills.neutral);
    expect(fills.glows.passedThrough).toBe('none');
    expect(fills.glows.neutral).toBe('none');
    expect(fills.glows.entered).toContain('drop-shadow');
    expect(fills.glows.changed).toContain('drop-shadow');
    expect(fills.glows.changed).not.toBe(fills.glows.entered);
    expect(fills.changed.length).toBeGreaterThan(0);
    for (const labelFills of fills.changed) expect(new Set(labelFills)).toEqual(new Set([expected.changed]));
  });
}

test('quickly tapping two stations selects both instead of opening station details', async ({ page }, testInfo) => {
  await openMap(page);
  await selectStation(page, testInfo, 'golders_green');
  await selectStation(page, testInfo, 'camden_road');
  await expect(page.locator('.route-action-bar')).toContainText('Golders Green → Camden Road');
  await expect(page.locator('.map-inspection-panel')).toBeHidden();
});

test('double-clicking a station shows its details and keeps the current selection', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'mouse double click');
  await openMap(page);
  await stationLabel(page, 'bank').click();
  // The two clicks toggle Bank off and on again, so the selection is unchanged and its details open.
  await stationLabel(page, 'bank').dblclick();
  await expect(page.locator('.map-inspection-panel')).toContainText('Bank');
  await expect(stationLabel(page, 'bank')).toHaveAttribute('data-app-selected', 'true');
});

test('the Clear button stands out only when there is something to clear', async ({ page }, testInfo) => {
  await openMap(page);
  const clear = page.locator('.map-toolbar').getByRole('button', { name: /clear|nothing to clear/i });
  const weight = () => clear.evaluate((element) => Number(getComputedStyle(element).fontWeight));
  await expect(clear).toBeDisabled();
  expect(await weight()).toBeLessThan(600);

  await selectStation(page, testInfo, 'bank');
  await expect(clear).toBeEnabled();
  expect(await weight()).toBeGreaterThanOrEqual(600);
  await clear.click();
  await expect(clear).toBeDisabled();
  await expect(stationLabel(page, 'bank')).toHaveAttribute('data-app-selected', 'false');
});

test('double-clicking an already selected station keeps the journey as it was', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'mouse double click');
  await openMap(page);
  await stationLabel(page, 'oxford_circus').click();
  await stationLabel(page, 'holborn').click();
  await expect(page.locator('.route-action-bar')).toContainText('Oxford Circus → Holborn');
  await stationLabel(page, 'oxford_circus').dblclick();
  await expect(page.locator('.map-inspection-panel')).toContainText('Oxford Circus');
  await expect(page.locator('.route-action-bar')).toContainText('Oxford Circus → Holborn');
});

test('station details stay visible above the route bar on phones', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-393', 'phone layout');
  await openMap(page);
  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'waterloo');
  // Long-press Oxford Circus.
  const label = stationLabel(page, 'oxford_circus');
  await label.scrollIntoViewIfNeeded();
  const { x, y } = await centreOf(label);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const panel = page.locator('.map-inspection-panel');
  await expect(panel).toContainText('Oxford Circus');
  const [panelBox, barBox] = await Promise.all([panel.boundingBox(), page.locator('.route-action-bar').boundingBox()]);
  expect(panelBox && barBox && panelBox.y + panelBox.height <= barBox.y + 1).toBe(true);
  await expect(panel.getByRole('button', { name: 'Close map details' })).toBeVisible();
});

test('the map view is kept when reloading from another tab', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'one project');
  await openMap(page);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const viewport = page.locator('.tube-map-viewport');
  await viewport.evaluate((element) => { element.scrollLeft = 900; element.scrollTop = 500; });
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Statistics' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.tube-map-viewport svg')).toBeVisible();
  await expect(page.locator('.map-toolbar')).toContainText('2.5×');
  expect(await viewport.evaluate((element) => [element.scrollLeft, element.scrollTop])).toEqual([900, 500]);
});

test('two open copies of the app never overwrite each other’s journeys', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'one project');
  const other = await context.newPage();
  await openMap(page);
  await openMap(other);
  await recordJourney(page, testInfo, 'paddington', 'waterloo');
  await recordJourney(other, testInfo, 'brixton', 'stockwell');
  for (const copy of [page, other]) {
    await expect(stationLabel(copy, 'paddington')).toHaveAttribute('data-app-state', 'entered');
    await expect(stationLabel(copy, 'brixton')).toHaveAttribute('data-app-state', 'entered');
  }
  await page.reload();
  await openMap(page);
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');
  await expect(stationLabel(page, 'brixton')).toHaveAttribute('data-app-state', 'entered');
});

test('the saved theme is applied before the app has loaded', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'one project');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('tube-tracker-theme', 'dark'));
  // Block the app's script: only index.html's own bootstrap can set the theme.
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
