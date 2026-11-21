import { expect, test, type Page } from '@playwright/test';
import { collectErrors, openMap, seedTravelledSections, selectStation, stationLabel } from './helpers';

/**
 * Real-browser checks of the map's highlight geometry and interaction cost.
 * Runs once (desktop Chrome) because the geometry is viewport-independent.
 */
test.beforeEach(({ }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'map health checks run on one desktop project');
});

/** Sections that cannot be drawn on the map. Every track section should be drawable. */
const KNOWN_UNDRAWN_SECTIONS: string[] = [];

function collectUndrawnSections(page: Page) {
  const undrawn = new Set<string>();
  page.on('console', (message) => {
    if (message.type() !== 'warning') return;
    const match = /section "([^"]+)"/.exec(message.text());
    if (match?.[1]) undrawn.add(match[1]);
  });
  return undrawn;
}

test('every travelled track section can be drawn on the map', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await seedTravelledSections(page);
  const undrawn = collectUndrawnSections(page);
  await page.reload();
  await openMap(page);
  await expect(page.locator('#app-travelled-sections path').first()).toBeAttached();
  await page.waitForTimeout(500);

  expect([...undrawn].sort()).toEqual([...KNOWN_UNDRAWN_SECTIONS].sort());
  expect(errors).toEqual([]);
});

test('hovering a station does no route-geometry work', async ({ page }) => {
  await page.addInitScript(() => {
    const counter = window as unknown as { __pointAtLengthCalls: number };
    counter.__pointAtLengthCalls = 0;
    const original = SVGGeometryElement.prototype.getPointAtLength;
    SVGGeometryElement.prototype.getPointAtLength = function (this: SVGGeometryElement, distance: number) {
      counter.__pointAtLengthCalls += 1;
      return original.call(this, distance);
    };
  });
  await openMap(page);
  await seedTravelledSections(page, "section.lineId === 'central' || section.lineId === 'victoria'");
  await page.reload();
  await openMap(page);
  await expect(page.locator('#app-travelled-sections path').first()).toBeAttached();
  await page.waitForTimeout(500);

  await page.evaluate(() => { (window as unknown as { __pointAtLengthCalls: number }).__pointAtLengthCalls = 0; });
  await stationLabel(page, 'oxford_circus').hover();
  await page.waitForTimeout(300);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const calls = await page.evaluate(() => (window as unknown as { __pointAtLengthCalls: number }).__pointAtLengthCalls);
  expect(calls).toBe(0);
});

test('every walking interchange is drawn between its two stations', async ({ page }) => {
  await openMap(page);
  const problems = await page.evaluate(`(async () => {
    const { walkLinks } = await import('/src/data/network.ts');
    const { measureStationAnchors } = await import('/src/map/station-anchors.ts');
    const svg = document.querySelector('.tube-map-viewport svg');
    const anchors = measureStationAnchors(svg);
    const problems = [];
    for (const walk of walkLinks) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', walk.mapPath);
      svg.appendChild(path);
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      path.remove();
      const distanceTo = (point, stationId) => Math.min(...(anchors.get(stationId) ?? []).map((anchor) => Math.hypot(anchor.x - point.x, anchor.y - point.y)));
      const gap = Math.min(
        Math.max(distanceTo(start, walk.from), distanceTo(end, walk.to)),
        Math.max(distanceTo(start, walk.to), distanceTo(end, walk.from))
      );
      if (!(gap <= 12)) problems.push(walk.id + ' is ' + gap.toFixed(1) + ' units from a station');
    }
    return problems;
  })()`);
  expect(problems).toEqual([]);
});

test('recorded walks are highlighted as walks', async ({ page }) => {
  await openMap(page);
  await page.evaluate(`(async () => {
    const storage = await import('/src/lib/storage.ts');
    await storage.updateProgress(() => ({ travelledSegmentIDs: [], walkedLinkIDs: ['osi_camden_town_camden_road', 'isi_bank_monument'], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] }));
  })()`);
  await page.reload();
  await openMap(page);
  await expect(page.locator('#app-travelled-sections path.app-walk-link')).toHaveCount(2);
});

/** Where the bold-lines style reveals travelled track: a point halfway along a travelled section, in page pixels. */
async function travelledPointOnScreen(page: Page) {
  const point = await page.evaluate(() => {
    const viewport = document.querySelector('.tube-map-viewport')!.getBoundingClientRect();
    for (const path of document.querySelectorAll<SVGPathElement>('#app-travelled-mask path')) {
      const middle = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(middle.x, middle.y).matrixTransform(path.getScreenCTM()!);
      if (screen.x > viewport.left + 20 && screen.x < viewport.right - 20 && screen.y > viewport.top + 20 && screen.y < viewport.bottom - 20) {
        return { x: screen.x, y: screen.y };
      }
    }
    return null;
  });
  if (!point) throw new Error('No travelled section is on screen');
  return point;
}

/** Counts pixels of the Central line's red in a small square of the page. */
async function countCentralRedPixels(page: Page, centre: { x: number; y: number }) {
  const image = await page.screenshot({ clip: { x: centre.x - 10, y: centre.y - 10, width: 20, height: 20 } });
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index]! > 170 && data[index + 1]! < 90 && data[index + 2]! < 90) count += 1;
    }
    return count;
  }, image.toString('base64'));
}

async function setTravelledSections(page: Page, sectionFilter: string) {
  await page.evaluate(`(async () => {
    const network = await import('/src/data/network.ts');
    const storage = await import('/src/lib/storage.ts');
    const ids = network.sections.filter((section) => ${sectionFilter}).map((section) => section.id);
    await storage.updateProgress((current) => ({ ...current, travelledSegmentIDs: ids }));
  })()`);
}

test('by default, travelled track is the full-width line and other lines are thinner', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await seedTravelledSections(page, "section.lineId === 'central'");
  await page.reload();
  await openMap(page);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-progress-style', 'lines');
  await expect(page.locator('#app-travelled-mask path').first()).toBeAttached();

  const layerOrder = await page.evaluate(() => [...document.querySelector('#routes')!.parentElement!.children]
    .map((element) => element.id)
    .filter((id) => id.startsWith('app-') || id === 'routes'));
  expect(layerOrder).toEqual([
    'app-travelled-sections', 'app-highlight-casing', 'app-line-label-backgrounds', 'routes',
    'app-travelled-mask', 'app-travelled-routes', 'app-route-preview-sections'
  ]);

  const drawing = await page.evaluate(() => {
    const width = (selector: string) => getComputedStyle(document.querySelector(selector)!).strokeWidth;
    const display = (selector: string) => getComputedStyle(document.querySelector(selector)!).display;
    return {
      untravelledWidth: width('#routes .me.scentral'),
      travelledWidth: width('#app-travelled-routes .me.scentral'),
      stripe: display('#routes .mes'),
      travelledStripe: display('#app-travelled-routes .mes'),
      band: display('#app-travelled-sections path'),
      duplicateIds: document.querySelectorAll('#app-travelled-routes [id]').length,
      maskPaths: document.querySelectorAll('#app-travelled-mask path').length,
      trackPaths: document.querySelectorAll('#app-travelled-sections path:not(.app-walk-link)').length
    };
  });
  expect(drawing).toEqual({
    untravelledWidth: '2.5px', travelledWidth: '5px', stripe: 'none', travelledStripe: 'inline',
    band: 'none', duplicateIds: 0, maskPaths: drawing.trackPaths, trackPaths: drawing.trackPaths
  });
  expect(drawing.trackPaths).toBeGreaterThan(30);

  // The mask really reveals the full-width line: forgetting the Central line leaves only the thin line there.
  const point = await travelledPointOnScreen(page);
  const travelledRed = await countCentralRedPixels(page, point);
  await setTravelledSections(page, 'false');
  await expect(page.locator('#app-travelled-mask path')).toHaveCount(0);
  const untravelledRed = await countCentralRedPixels(page, point);
  expect(untravelledRed).toBeGreaterThan(0);
  expect(travelledRed).toBeGreaterThan(untravelledRed * 1.5);
  expect(errors).toEqual([]);
});

test('the yellow band can be chosen in Settings instead, and the choice is remembered', async ({ page }) => {
  await openMap(page);
  await seedTravelledSections(page, "section.lineId === 'circle' || section.lineId === 'lioness'");
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const band = page.getByRole('radio', { name: /Yellow highlight/ });
  await expect(page.getByRole('radio', { name: /Bold lines/ })).toBeChecked();
  await band.check();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-progress-style', 'band');

  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-progress-style', 'band');
  await openMap(page);
  await expect(page.locator('.map-legend')).toContainText('track is highlighted in yellow');
  const travelled = page.locator('#app-travelled-sections path');
  await expect(travelled.first()).toBeVisible();
  const travelledCount = await travelled.count();
  // A casing strip under every travelled line keeps yellow lines visible on the yellow band.
  await expect(page.locator('#app-highlight-casing path')).toHaveCount(travelledCount);
  const drawing = await page.evaluate(() => ({
    copy: getComputedStyle(document.querySelector('#app-travelled-routes')!).display,
    lineWidth: getComputedStyle(document.querySelector('#routes .me.scircle')!).strokeWidth
  }));
  expect(drawing).toEqual({ copy: 'none', lineWidth: '5px' });
});

test('the selected route is drawn as a dashed path over the lines', async ({ page }, testInfo) => {
  await openMap(page);
  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'angel');
  const route = page.locator('#app-route-preview-sections [data-part="route"] path');
  await expect(route.first()).toBeAttached();
  const routeCount = await route.count();
  await expect(page.locator('#app-route-preview-sections [data-part="casing"] path')).toHaveCount(routeCount);
  const style = await route.first().evaluate((path) => {
    const computed = getComputedStyle(path);
    return { dashes: computed.strokeDasharray, width: computed.strokeWidth };
  });
  expect(style).toEqual({ dashes: '9px, 6px', width: '4.5px' });
  await page.locator('.tube-map-viewport').screenshot({ path: `test-results/screens/${testInfo.project.name}/preview-paddington-angel.png` });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`line-name labels have backgrounds and legible line colours (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openMap(page);
    const labelCount = await page.locator('#text #stname > .small text').count();
    expect(labelCount).toBeGreaterThan(50);
    await expect(page.locator('#app-line-label-backgrounds rect')).toHaveCount(labelCount);
    await expect.poll(() => page.evaluate(() => {
      const style = (text: string) => {
        const label = [...document.querySelectorAll('#text #stname > .small text')].find((element) => element.textContent === text)!;
        const computed = getComputedStyle(label);
        return `${computed.fill} ${computed.fontWeight}`;
      };
      return [style('Lioness line'), style('Liberty line'), style('Jubilee line')];
    })).toEqual(['rgb(196, 137, 38) 700', 'rgb(94, 104, 103) 700', 'rgb(119, 119, 119) 700']);
    // Light mode puts a white background behind each name; dark mode outlines the letters in white instead.
    const treatment = await page.evaluate(() => {
      const label = document.querySelector('#text #stname > .small text')!;
      const background = document.querySelector('#app-line-label-backgrounds rect')!;
      return { background: getComputedStyle(background).display, outline: getComputedStyle(label).stroke };
    });
    expect(treatment).toEqual(colorScheme === 'light'
      ? { background: 'inline', outline: 'none' }
      : { background: 'none', outline: 'rgb(255, 255, 255)' });
  });
}

test('station tap targets do not overlap their neighbours', async ({ page }) => {
  await openMap(page);
  const overlaps = await page.evaluate(() => {
    const circles = [...document.querySelectorAll('#app-station-hit-areas circle')].map((circle) => ({
      stationId: circle.getAttribute('data-app-station-id'),
      x: Number(circle.getAttribute('cx')),
      y: Number(circle.getAttribute('cy')),
      r: Number(circle.getAttribute('r'))
    }));
    const found: string[] = [];
    circles.forEach((a, i) => circles.slice(i + 1).forEach((b) => {
      const gap = Math.hypot(a.x - b.x, a.y - b.y);
      // Only stations further apart than twice the minimum radius can be kept fully apart.
      if (a.stationId !== b.stationId && gap >= 12 && gap < a.r + b.r - 0.01) found.push(`${a.stationId}/${b.stationId}`);
    }));
    return { count: circles.length, found };
  });
  expect(overlaps.count).toBeGreaterThan(400);
  expect(overlaps.found).toEqual([]);
});
