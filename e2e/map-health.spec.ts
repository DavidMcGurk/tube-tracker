import { expect, test, type Page } from '@playwright/test';
import { collectErrors, openMap, seedTravelledSections, stationLabel } from './helpers';

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
    await storage.saveProgress({ travelledSegmentIDs: [], walkedLinkIDs: ['osi_camden_town_camden_road', 'isi_bank_monument'], stationsEnteredOrExitedIDs: [], stationsChangedAtIDs: [] });
  })()`);
  await page.reload();
  await openMap(page);
  await expect(page.locator('#app-travelled-sections path.app-walk-link')).toHaveCount(2);
});

test('travelled track gets a casing strip so lines stay visible on the highlight', async ({ page }) => {
  await openMap(page);
  await seedTravelledSections(page, "section.lineId === 'circle' || section.lineId === 'lioness'");
  await page.reload();
  await openMap(page);
  const travelled = page.locator('#app-travelled-sections path');
  await expect(travelled.first()).toBeAttached();
  const travelledCount = await travelled.count();
  await expect(page.locator('#app-highlight-casing [data-source="travelled"] path')).toHaveCount(travelledCount);
  const layerOrder = await page.evaluate(() => [...document.querySelector('#routes')!.parentElement!.children]
    .map((element) => element.id)
    .filter((id) => ['app-route-preview-sections', 'app-travelled-sections', 'app-highlight-casing', 'app-line-label-backgrounds', 'routes'].includes(id)));
  expect(layerOrder).toEqual(['app-route-preview-sections', 'app-travelled-sections', 'app-highlight-casing', 'app-line-label-backgrounds', 'routes']);
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
  });
}
