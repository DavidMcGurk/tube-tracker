import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { openMap, selectStation } from './helpers';

/**
 * Touch panning is done in script, with a glide after a flick (map-glide.ts), so that a tap during a glide counts: on
 * iOS a tap while a native scroll glides never reaches the page. Raw touch input needs CDP, so this runs on one
 * Chromium phone project.
 */
test.beforeEach(({ }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-393', 'raw touch input (CDP) on one Chromium phone project');
});

/**
 * Sends a touch event stamped with a time (ms since the epoch; now unless `at` is given). A flick passes `at` to stamp
 * the event with when it should happen rather than when it arrives: the app measures a flick's speed from event times,
 * and a slow machine (e.g. CI) can deliver the lift long enough after the last move that it reads as the finger being
 * held still. Every event is stamped, so all of them share one clock: on Linux, Chrome's own stamps and given ones
 * can disagree, and a tap stamped earlier than the flick before it is lost.
 */
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number, at = Date.now()) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    timestamp: at / 1000
  });
}

/** Drags from (x, y) by (dx, dy) in `steps` moves 16 ms apart, lifting at once at the end (a flick). */
async function drag(page: Page, cdp: CDPSession, x: number, y: number, dx: number, dy: number, steps = 6) {
  const start = Date.now();
  await touch(cdp, 'touchStart', x, y, start);
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(16);
    await touch(cdp, 'touchMove', x + (dx * i) / steps, y + (dy * i) / steps, start + 16 * i);
  }
  await touch(cdp, 'touchEnd', x + dx, y + dy, start + 16 * steps);
}

const scrollOf = (page: Page) => page.evaluate(() => {
  const viewport = document.querySelector<HTMLElement>('.tube-map-viewport')!;
  return { left: viewport.scrollLeft, top: viewport.scrollTop, page: window.scrollY };
});

async function viewportCentre(page: Page) {
  const box = (await page.locator('.tube-map-viewport').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a flick keeps the map moving after the finger lifts, slowing to a stop', async ({ page }) => {
  await openMap(page);
  const cdp = await page.context().newCDPSession(page);
  const { x, y } = await viewportCentre(page);
  const start = await scrollOf(page);
  await drag(page, cdp, x, y, -150, 0);
  const lifted = await scrollOf(page);
  expect(start.left - lifted.left).toBeLessThan(0);
  await page.waitForTimeout(250);
  const gliding = await scrollOf(page);
  expect(gliding.left).toBeGreaterThan(lifted.left + 20);
  // It stops by itself.
  await page.waitForTimeout(2000);
  const stopped = await scrollOf(page);
  await page.waitForTimeout(300);
  expect(await scrollOf(page)).toEqual(stopped);
});

test('a slow drag doesn’t glide', async ({ page }) => {
  await openMap(page);
  const cdp = await page.context().newCDPSession(page);
  const { x, y } = await viewportCentre(page);
  await touch(cdp, 'touchStart', x, y);
  for (let i = 1; i <= 10; i++) {
    await page.waitForTimeout(40);
    await touch(cdp, 'touchMove', x - i * 5, y);
  }
  await page.waitForTimeout(150);
  await touch(cdp, 'touchEnd', x - 50, y);
  const lifted = await scrollOf(page);
  await page.waitForTimeout(300);
  expect(await scrollOf(page)).toEqual(lifted);
});

test('a tap during a glide stops it and still chooses the station', async ({ page }, testInfo) => {
  // The page's clock, so the glide can be held mid-flight while the test waits, finds a label and taps it.
  await page.clock.install();
  await openMap(page);
  await selectStation(page, testInfo, 'paddington');
  const cdp = await page.context().newCDPSession(page);
  const { x, y } = await viewportCentre(page);
  await drag(page, cdp, x, y, -150, 0);
  const lifted = await scrollOf(page);
  await page.waitForTimeout(150);
  // Paused a moment ahead (it can't pause in the past); the glide's frames are capped at 50 ms, so the jump is small.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  // Chrome on Linux runs a fling of its own after a flick, and a tap while that fling lasts (about half a second after
  // a fast flick) only stops it: no click. The glide is held, so it is still under way once Chrome's fling is over.
  await page.waitForTimeout(1000);
  // The station label nearest the middle of the map, mid-glide.
  const target = await page.evaluate(([px, py]) => {
    const view = document.querySelector('.tube-map-viewport')!.getBoundingClientRect();
    const labels = [...document.querySelectorAll<SVGTextElement>('#text text[data-app-station-id]')].map((label) => {
      const box = label.getBoundingClientRect();
      return { id: label.getAttribute('data-app-station-id')!, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }).filter((label) => label.id !== 'paddington' && label.x > view.left + 40 && label.x < view.right - 40 && label.y > view.top + 20 && label.y < view.bottom - 20);
    labels.sort((a, b) => Math.hypot(a.x - px!, a.y - py!) - Math.hypot(b.x - px!, b.y - py!));
    return labels[0]!;
  }, [x, y]);
  const atTap = await scrollOf(page);
  // Still gliding when the tap lands.
  expect(atTap.left).toBeGreaterThan(lifted.left + 10);
  await touch(cdp, 'touchStart', target.x, target.y);
  await touch(cdp, 'touchEnd', target.x, target.y);
  // The tap counted: a second station is chosen, and the glide stopped there.
  await expect(page.locator('.route-action-bar')).toContainText('Paddington →');
  const afterTap = await scrollOf(page);
  expect(afterTap.left - atTap.left).toBeLessThan(40);
  await page.clock.resume();
  await page.waitForTimeout(300);
  expect(await scrollOf(page)).toEqual(afterTap);
});

test('dragging past the bottom of the map scrolls the page on', async ({ page }, testInfo) => {
  await openMap(page);
  // With a route chosen the page has room to scroll (for the bar under the map).
  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'waterloo');
  await expect(page.locator('.route-action-bar')).toBeVisible();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const viewport = document.querySelector<HTMLElement>('.tube-map-viewport')!;
    viewport.scrollTop = viewport.scrollHeight;
  });
  const cdp = await page.context().newCDPSession(page);
  const { x, y } = await viewportCentre(page);
  // Slowly, so there's no glide.
  await touch(cdp, 'touchStart', x, y);
  for (let i = 1; i <= 10; i++) {
    await page.waitForTimeout(40);
    await touch(cdp, 'touchMove', x, y - i * 10);
  }
  await page.waitForTimeout(150);
  await touch(cdp, 'touchEnd', x, y - 100);
  expect((await scrollOf(page)).page).toBeGreaterThan(50);
});

test('a slow drag in fractional steps keeps the map under the finger', async ({ page }) => {
  await openMap(page);
  const cdp = await page.context().newCDPSession(page);
  const { x, y } = await viewportCentre(page);
  await touch(cdp, 'touchStart', x, y);
  // Past the drag threshold, then 0.4 px at a time (Android reports sub-pixel touch positions).
  await touch(cdp, 'touchMove', x - 12, y);
  const start = await scrollOf(page);
  for (let i = 1; i <= 100; i++) await touch(cdp, 'touchMove', x - 12 - i * 0.4, y);
  const moved = (await scrollOf(page)).left - start.left;
  await page.waitForTimeout(150);
  await touch(cdp, 'touchEnd', x - 52, y);
  expect(Math.abs(moved - 40)).toBeLessThanOrEqual(1);
});

test('a quick short flick glides', async ({ page }) => {
  await openMap(page);
  const cdp = await page.context().newCDPSession(page);
  const { x, y } = await viewportCentre(page);
  // One move under the drag threshold, then one past it, then lift.
  const start = Date.now();
  await touch(cdp, 'touchStart', x, y, start);
  await page.waitForTimeout(16);
  await touch(cdp, 'touchMove', x - 6, y, start + 16);
  await page.waitForTimeout(16);
  await touch(cdp, 'touchMove', x - 50, y, start + 32);
  await touch(cdp, 'touchEnd', x - 50, y, start + 32);
  const lifted = await scrollOf(page);
  await page.waitForTimeout(250);
  expect((await scrollOf(page)).left).toBeGreaterThan(lifted.left + 10);
});

test('zooming during a glide stops it, keeping the zoom’s view', async ({ page }) => {
  await openMap(page);
  const cdp = await page.context().newCDPSession(page);
  const { x, y } = await viewportCentre(page);
  await drag(page, cdp, x, y, -150, 0);
  await page.waitForTimeout(50);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  // Let the zoom lay out, then check nothing moves the map afterwards.
  await page.waitForTimeout(150);
  const zoomed = await scrollOf(page);
  await page.waitForTimeout(400);
  expect(await scrollOf(page)).toEqual(zoomed);
});
