import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, isTouchProject, openMap, selectStation, stationLabel } from './helpers';

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

const undoBar = (page: Page) => page.locator('[data-undo-bar]');

/** Undo ignores presses in its first 800 ms (UNDO_GUARD_MS: a double tap on “Record route” would land on it). */
const waitOutUndoGuard = (page: Page) => page.waitForTimeout(900);

test('a recorded journey can be undone: only what it added goes, and its stations are selected again', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await openMap(page);
  await recordJourney(page, testInfo, 'paddington', 'waterloo');
  const bar = undoBar(page);
  await expect(bar).toHaveAccessibleName('Journey recorded');
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');

  await waitOutUndoGuard(page);
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect(bar).toBeHidden();
  await expect(page.locator('[data-app-announcements]')).toHaveText('Journey removed');
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'neutral');
  await expect(page.locator('#app-travelled-sections path')).toHaveCount(0);
  // Its start and end are selected again, so the right route can be picked straight away.
  const routeBar = page.locator('.route-action-bar');
  await expect(routeBar).toContainText('Paddington → Waterloo');

  // Record it again and keep it: dismissing the bar ends the window.
  await routeBar.getByRole('button', { name: 'Record route' }).click();
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Dismiss' }).click();
  await expect(bar).toBeHidden();
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');

  // A longer journey over the same line: undoing it leaves the first one as it was.
  await recordJourney(page, testInfo, 'paddington', 'elephant_castle');
  await expect(stationLabel(page, 'elephant_castle')).toHaveAttribute('data-app-state', 'entered');
  await waitOutUndoGuard(page);
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect(bar).toBeHidden();
  await expect(stationLabel(page, 'elephant_castle')).toHaveAttribute('data-app-state', 'neutral');
  for (const stationId of ['paddington', 'waterloo']) await expect(stationLabel(page, stationId)).toHaveAttribute('data-app-state', 'entered');
  await routeBar.getByRole('button', { name: 'Clear selection' }).click();

  // Recording an already-explored journey ends the window of the one before, and offers no undo of its own.
  await recordJourney(page, testInfo, 'bank', 'stratford');
  await expect(bar).toBeVisible();
  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'waterloo');
  await routeBar.getByRole('button', { name: 'Already explored' }).click();
  await routeBar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(routeBar).toBeHidden();
  await expect(bar).toHaveCount(0);
  await expect(stationLabel(page, 'stratford')).toHaveAttribute('data-app-state', 'entered');
  expect(errors).toEqual([]);
});

test('focus moves with the bar under the map: Record → Undo → Record again, and Dismiss → the map', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await openMap(page);
  // The laptop uses the keyboard (Enter on the focused button); the phone taps.
  const press = async (control: Locator) => {
    if (isTouchProject(testInfo)) {
      await control.tap();
    } else {
      await control.focus();
      await page.keyboard.press('Enter');
    }
  };
  const routeBar = page.locator('.route-action-bar');
  const record = routeBar.getByRole('button', { name: 'Record route' });
  const bar = undoBar(page);
  const undo = bar.getByRole('button', { name: 'Undo' });
  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'waterloo');

  // Recording swaps the route actions for the undo bar: focus goes to Undo, not back to the top of the page.
  await press(record);
  await expect(bar).toBeVisible();
  await expect(undo).toBeFocused();

  // Undoing brings the route actions back, ready to record the right route.
  await waitOutUndoGuard(page);
  await press(undo);
  await expect(bar).toBeHidden();
  await expect(record).toBeFocused();

  // Dismissing keeps the journey; focus goes to the map the bar was under.
  await press(record);
  await expect(undo).toBeFocused();
  await press(bar.getByRole('button', { name: 'Dismiss' }));
  await expect(bar).toBeHidden();
  await expect(page.getByRole('region', { name: /^Interactive London transport map/ })).toBeFocused();
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');
  expect(errors).toEqual([]);
});

test('the undo bar goes by itself after five minutes, keeping the journey', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await page.clock.install();
  await openMap(page);
  await recordJourney(page, testInfo, 'paddington', 'waterloo');
  const bar = undoBar(page);
  await expect(bar).toBeVisible();
  // Out of sight on another tab, the window keeps running.
  await page.getByRole('navigation').getByRole('button', { name: 'Statistics' }).click();
  await page.clock.fastForward('04:50');
  await page.getByRole('navigation').getByRole('button', { name: 'Map' }).click();
  await expect(bar).toBeVisible();

  await page.clock.fastForward('00:11');
  await expect(bar).toBeHidden();
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');
  const undone = await page.evaluate(`(async () => (await (await import('/src/lib/storage.ts')).undoLastJourney()).outcome)()`);
  expect(undone).toBe('expired');

  // Nor does it come back after a reload.
  await page.reload();
  await openMap(page);
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-state', 'entered');
  await expect(bar).toHaveCount(0);
  expect(errors).toEqual([]);
});

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
  const resetButton = page.getByRole('button', { name: 'Reset progress' });
  await resetButton.click();
  // A modal dialog: Cancel first, focus stays inside, Escape closes it and focus goes back to the button.
  const resetDialog = page.getByRole('dialog', { name: 'Reset all progress?' });
  await expect(resetDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  if (!isTouchProject(testInfo)) {
    // The page behind is inert: Tab moves between the dialog's buttons (and the browser's own controls), never behind it.
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => {
        const focused = document.activeElement;
        return !focused || focused === document.body || focused.closest('dialog') !== null;
      }), `focus after ${step + 1} Tab presses`).toBe(true);
    }
  }
  await page.keyboard.press('Escape');
  await expect(resetDialog).toBeHidden();
  await expect(resetButton).toBeFocused();
  await resetButton.click();
  await resetDialog.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(resetButton).toBeFocused();
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

test('long-press inspects a station; dragging from a station pans the map instead of selecting (mouse)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'mouse gestures');
  await openMap(page);

  const paddington = await centreOf(stationLabel(page, 'paddington'));
  await page.mouse.move(paddington.x, paddington.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator('.map-inspection-panel')).toContainText('Paddington');
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-selected', 'false');

  const viewport = page.locator('.tube-map-viewport');
  const before = await viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]);
  const start = await centreOf(stationLabel(page, 'paddington'));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 120, start.y - 60, { steps: 8 });
  await page.mouse.up();
  const after = await viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]);
  expect(after[0]! - before[0]!).toBeGreaterThan(100);
  expect(after[1]! - before[1]!).toBeGreaterThan(40);
  await expect(stationLabel(page, 'paddington')).toHaveAttribute('data-app-selected', 'false');
  await expect(page.locator('.route-action-bar')).toBeHidden();

  // A plain click still selects.
  await stationLabel(page, 'waterloo').click();
  await expect(stationLabel(page, 'waterloo')).toHaveAttribute('data-app-selected', 'true');
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
    // Stations only passed through are not marked: same colour as stations never visited.
    expect(fills.passedThrough).toBe(fills.neutral);
    // Only names are coloured: no station marker glows, whatever its journey state.
    expect(fills.glows).toEqual({ entered: 'none', changed: 'none', passedThrough: 'none', neutral: 'none' });
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
