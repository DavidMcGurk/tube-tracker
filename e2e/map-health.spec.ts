import { expect, test, type Page } from '@playwright/test';
import { collectErrors, openMap, seedTravelledSections, stationLabel } from './helpers';

/**
 * Real-browser checks of the map's highlight geometry and interaction cost.
 * Runs once (desktop Chrome) because the geometry is viewport-independent.
 */
test.beforeEach(({ }, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1280', 'map health checks run on one desktop project');
});

/**
 * Sections that cannot currently be drawn on the map. Phase 2 / F1 empties this list.
 * Causes: Northern Edgware/Charing Cross/Battersea branches use the SVG class `sedgware`; Bank, Monument and
 * Aldgate have no `use[id]` marker; Bow Church–Devons Road spans two DLR path elements.
 */
const KNOWN_UNDRAWN_SECTIONS: string[] = [
  'central_bank_liverpool_street', 'central_st_paul_s_bank',
  'circle_aldgate_liverpool_street', 'circle_aldgate_tower_hill', 'circle_monument_cannon_street', 'circle_monument_tower_hill',
  'district_monument_cannon_street', 'district_monument_tower_hill',
  'dlr_bank_shadwell', 'dlr_bow_church_devons_road',
  'metropolitan_aldgate_liverpool_street',
  'northern_bank_london_bridge', 'northern_bank_moorgate', 'northern_battersea_power_station_nine_elms',
  'northern_belsize_park_chalk_farm', 'northern_belsize_park_hampstead', 'northern_brent_cross_golders_green',
  'northern_brent_cross_hendon_central', 'northern_burnt_oak_colindale', 'northern_burnt_oak_edgware',
  'northern_chalk_farm_camden_town', 'northern_colindale_hendon_central', 'northern_embankment_charing_cross',
  'northern_embankment_waterloo', 'northern_golders_green_hampstead', 'northern_goodge_street_tottenham_court_road',
  'northern_goodge_street_warren_street', 'northern_kennington_nine_elms', 'northern_kennington_waterloo',
  'northern_leicester_square_charing_cross', 'northern_leicester_square_tottenham_court_road', 'northern_warren_street_euston',
  'waterloo_city_bank_waterloo'
];

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
  test.fail(true, 'Phase 1 step 5 removes geometry work from hover; until then every hover re-samples the route paths');
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
