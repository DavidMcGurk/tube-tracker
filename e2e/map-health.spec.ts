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
