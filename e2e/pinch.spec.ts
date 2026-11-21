import { expect, test, type Page } from '@playwright/test';
import { collectErrors, openMap } from './helpers';

/**
 * Pinch zoom: a two-finger touch pinch (Chromium phone, synthesised through CDP) and ctrl+wheel, which is how Chrome
 * reports a trackpad pinch (desktop). Both must zoom the map about the pinch point and never the page.
 */
test.beforeEach(({ }, testInfo) => {
  test.skip(!['phone-393', 'laptop-1280'].includes(testInfo.project.name), 'pinch checks run on one touch and one mouse project');
});

/** Distance (CSS px) a map point may drift from under the fingers or cursor, allowing for rounding and edge clamping. */
const ANCHOR_TOLERANCE_PX = 6;

interface ClientPoint {
  x: number;
  y: number;
}

async function viewportCentre(page: Page): Promise<ClientPoint> {
  const box = await page.locator('.tube-map-viewport').boundingBox();
  if (!box) throw new Error('Expected the map viewport to be rendered');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** Reads the zoom state and converts a client point to map (SVG user) coordinates and back. */
async function readMap(page: Page, clientPoint: ClientPoint, mapPoint?: ClientPoint) {
  return page.evaluate(({ clientPoint, mapPoint }) => {
    const viewport = document.querySelector<HTMLElement>('.tube-map-viewport');
    const svg = viewport?.querySelector('svg');
    const matrix = svg?.getScreenCTM();
    const zoomIn = document.querySelector('button[aria-label="Zoom in"]');
    if (!viewport || !svg || !matrix || !zoomIn) throw new Error('Expected the map to be rendered');
    const pointUnder = new DOMPoint(clientPoint.x, clientPoint.y).matrixTransform(matrix.inverse());
    const tracked = mapPoint ? new DOMPoint(mapPoint.x, mapPoint.y).matrixTransform(matrix) : null;
    return {
      readout: document.querySelector('[data-map-zoom-readout]')?.textContent ?? '',
      svgWidth: svg.getBoundingClientRect().width,
      // The map is laid out at zoom × the viewport's content width.
      zoom: svg.getBoundingClientRect().width / viewport.clientWidth,
      transform: svg.style.transform,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      visualScale: window.visualViewport?.scale ?? 1,
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      toolbarButtonWidth: zoomIn.getBoundingClientRect().width,
      mapPointUnder: { x: pointUnder.x, y: pointUnder.y },
      trackedClientPoint: tracked ? { x: tracked.x, y: tracked.y } : null
    };
  }, { clientPoint, mapPoint });
}

const readoutZoom = (readout: string) => Number.parseFloat(readout);

function expectPageNotZoomed(before: Awaited<ReturnType<typeof readMap>>, after: Awaited<ReturnType<typeof readMap>>) {
  expect(after.visualScale, 'the page must not pinch-zoom').toBe(1);
  expect(after.devicePixelRatio, 'the browser must not zoom the page').toBe(before.devicePixelRatio);
  expect(after.innerWidth).toBe(before.innerWidth);
  expect(after.toolbarButtonWidth, 'the toolbar must not scale').toBeCloseTo(before.toolbarButtonWidth, 1);
}

function expectAnchored(after: Awaited<ReturnType<typeof readMap>>, anchor: ClientPoint) {
  expect(after.trackedClientPoint).not.toBeNull();
  if (!after.trackedClientPoint) return;
  expect(Math.abs(after.trackedClientPoint.x - anchor.x), 'map point under the pinch stays put horizontally').toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
  expect(Math.abs(after.trackedClientPoint.y - anchor.y), 'map point under the pinch stays put vertically').toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
}

/** Records the finger separation at the start and end of each two-finger touch, as the page saw it. */
async function recordFingerSpread(page: Page) {
  await page.evaluate(() => {
    const record = window as unknown as { __fingerSpread: { start: number; end: number } | null };
    const spread = (touches: TouchList) => {
      const [first, second] = Array.from(touches);
      return first && second ? Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY) : null;
    };
    record.__fingerSpread = null;
    window.addEventListener('touchstart', (event) => {
      const distance = spread(event.touches);
      if (distance !== null) record.__fingerSpread = { start: distance, end: distance };
    }, { capture: true });
    window.addEventListener('touchmove', (event) => {
      const distance = spread(event.touches);
      if (distance !== null && record.__fingerSpread) record.__fingerSpread.end = distance;
    }, { capture: true });
  });
}

async function readFingerRatio(page: Page) {
  const spread = await page.evaluate(() => (window as unknown as { __fingerSpread: { start: number; end: number } | null }).__fingerSpread);
  if (!spread) throw new Error('Expected a two-finger touch');
  return spread.end / spread.start;
}

test('a two-finger pinch zooms the map about the fingers, not the page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-393', 'touch pinch');
  const errors = collectErrors(page);
  await openMap(page);
  await recordFingerSpread(page);
  const anchor = await viewportCentre(page);
  const cdp = await page.context().newCDPSession(page);
  // Chrome's synthetic pinch moves the fingers a little further than scaleFactor (touch slop), so the expected zoom
  // is worked out from the finger separation the page actually saw.
  const pinch = (scaleFactor: number) => cdp.send('Input.synthesizePinchGesture', {
    x: anchor.x,
    y: anchor.y,
    scaleFactor,
    relativeSpeed: 600,
    gestureSourceType: 'touch'
  });

  const start = await readMap(page, anchor);
  expect(start.readout).toBe('4×');

  await pinch(1.1);
  const zoomInRatio = await readFingerRatio(page);
  expect(zoomInRatio).toBeGreaterThan(1.1);
  const expectedIn = Math.min(6, 4 * zoomInRatio);
  await expect.poll(async () => (await readMap(page, anchor)).zoom).toBeCloseTo(expectedIn, 1);
  const zoomedIn = await readMap(page, anchor, start.mapPointUnder);
  expect(readoutZoom(zoomedIn.readout)).toBeCloseTo(expectedIn, 0);
  expect(zoomedIn.transform, 'the preview transform is cleared on commit').toBe('');
  expectPageNotZoomed(start, zoomedIn);
  expectAnchored(zoomedIn, anchor);

  await pinch(0.8);
  const zoomOutRatio = await readFingerRatio(page);
  expect(zoomOutRatio).toBeLessThan(0.8);
  const expectedOut = Math.max(1, zoomedIn.zoom * zoomOutRatio);
  await expect.poll(async () => (await readMap(page, anchor)).zoom).toBeCloseTo(expectedOut, 1);
  const zoomedOut = await readMap(page, anchor, zoomedIn.mapPointUnder);
  expect(zoomedOut.svgWidth).toBeLessThan(zoomedIn.svgWidth);
  expectPageNotZoomed(start, zoomedOut);
  expectAnchored(zoomedOut, anchor);

  // Neither finger may select or inspect the station it lands on.
  await expect(page.locator('[data-app-selected="true"]')).toHaveCount(0);
  await expect(page.locator('.map-inspection-panel')).toHaveCount(0);

  // The buttons step onto the 0.25 grid from a pinched zoom.
  const nextGridZoom = (Math.floor(zoomedOut.zoom / 0.25 + 1e-3) + 1) * 0.25;
  await page.getByRole('button', { name: 'Zoom in' }).tap();
  await expect.poll(async () => (await readMap(page, anchor)).zoom).toBeCloseTo(nextGridZoom, 2);
  expect(errors).toEqual([]);
});

test('a second finger on a station never selects or inspects it, and a tap afterwards still selects', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-393', 'touch pinch');
  const errors = collectErrors(page);
  await openMap(page);
  const centreOf = async (stationId: string) => {
    const box = await page.locator(`#text text[data-app-station-id="${stationId}"]`).first().boundingBox();
    if (!box) throw new Error(`Expected ${stationId} to be on screen`);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  const first = await centreOf('oxford_circus');
  const second = await centreOf('bond_street');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: Array<{ x: number; y: number; id: number }>) => (
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints })
  );

  // Hold one finger on a station, add a second on another, and keep both down past the long-press delay.
  await touch('touchStart', [{ ...first, id: 0 }]);
  await page.waitForTimeout(200);
  await touch('touchStart', [{ ...first, id: 0 }, { ...second, id: 1 }]);
  await page.waitForTimeout(700);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  await expect(page.locator('[data-app-selected="true"]')).toHaveCount(0);
  await expect(page.locator('.map-inspection-panel')).toHaveCount(0);
  await expect(page.locator('.route-action-bar')).toHaveCount(0);

  await page.touchscreen.tap(first.x, first.y);
  await expect(page.locator('#text text[data-app-station-id="oxford_circus"]').first()).toHaveAttribute('data-app-selected', 'true');
  expect(errors).toEqual([]);
});

test('ctrl+wheel (trackpad pinch) zooms the map about the cursor; a plain wheel scrolls it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'mouse wheel');
  const errors = collectErrors(page);
  await openMap(page);
  const anchor = await viewportCentre(page);
  await page.mouse.move(anchor.x, anchor.y);
  const start = await readMap(page, anchor);
  expect(start.readout).toBe('2×');

  await page.keyboard.down('Control');
  for (let step = 0; step < 3; step += 1) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect.poll(async () => readoutZoom((await readMap(page, anchor)).readout)).toBeGreaterThan(3.5);
  await expect.poll(async () => (await readMap(page, anchor)).transform).toBe('');
  const zoomedIn = await readMap(page, anchor, start.mapPointUnder);
  expect(zoomedIn.svgWidth).toBeGreaterThan(start.svgWidth * 1.7);
  expectPageNotZoomed(start, zoomedIn);
  expectAnchored(zoomedIn, anchor);

  const beforeOut = await readMap(page, anchor);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await readMap(page, anchor)).svgWidth).toBeLessThan(beforeOut.svgWidth * 0.85);
  await expect.poll(async () => (await readMap(page, anchor)).transform).toBe('');
  const zoomedOut = await readMap(page, anchor, beforeOut.mapPointUnder);
  expectPageNotZoomed(start, zoomedOut);
  expectAnchored(zoomedOut, anchor);

  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await readMap(page, anchor)).scrollTop).toBeGreaterThan(zoomedOut.scrollTop);
  expect((await readMap(page, anchor)).readout).toBe(zoomedOut.readout);
  expect(errors).toEqual([]);
});
