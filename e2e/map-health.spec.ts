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

  // Only the Weaver line's two tracks between Hackney Downs and Bethnal Green are drawn as parallel tracks.
  const doubled = await page.evaluate((selector) => {
    const counts = new Map<string, number>();
    for (const path of document.querySelectorAll(selector)) {
      const id = path.getAttribute('data-app-link-id')!;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort();
  }, TRAVELLED_LINE_PATHS);
  expect(doubled).toEqual(['weaver_bethnal_green_weaver_cambridge_heath', 'weaver_cambridge_heath_london_fields', 'weaver_hackney_downs_london_fields']);
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

const TRAVELLED_LINE_PATHS = '#app-travelled-lines [data-part="line"] path';

/** Where the bold-lines style draws travelled track of a line: a point halfway along a travelled section, in page pixels. */
async function travelledPointOnScreen(page: Page, lineClass: string) {
  const point = await page.evaluate((selector) => {
    const viewport = document.querySelector('.tube-map-viewport')!.getBoundingClientRect();
    for (const path of document.querySelectorAll<SVGPathElement>(selector)) {
      const middle = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(middle.x, middle.y).matrixTransform(path.getScreenCTM()!);
      if (screen.x > viewport.left + 20 && screen.x < viewport.right - 20 && screen.y > viewport.top + 20 && screen.y < viewport.bottom - 20) {
        return { x: screen.x, y: screen.y };
      }
    }
    return null;
  }, `${TRAVELLED_LINE_PATHS}.${lineClass}`);
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

test('by default, travelled track is drawn wide and solid in its line colour, and other lines are thinner', async ({ page }) => {
  const errors = collectErrors(page);
  await openMap(page);
  await seedTravelledSections(page, "['central', 'mildmay', 'circle', 'northern'].includes(section.lineId)");
  await page.reload();
  await openMap(page);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-progress-style', 'lines');
  await expect(page.locator(TRAVELLED_LINE_PATHS).first()).toBeAttached();

  // The legend shows both widths, with "Travelled" and "Not yet" set the same way.
  const legendStyles = await page.locator('.map-legend > span').evaluateAll((entries) => entries.slice(0, 2).map((entry) => {
    const style = getComputedStyle(entry);
    return { text: entry.firstChild?.nextSibling?.textContent?.trim(), font: `${style.fontSize} ${style.fontWeight}`, colour: style.color };
  }));
  expect(legendStyles.map((entry) => entry.text)).toEqual(['Travelled', 'Not yet']);
  expect(legendStyles[1]!.font).toBe(legendStyles[0]!.font);
  expect(legendStyles[1]!.colour).toBe(legendStyles[0]!.colour);

  const layerOrder = await page.evaluate(() => [...document.querySelector('#routes')!.parentElement!.children]
    .map((element) => element.id)
    .filter((id) => id.startsWith('app-') || id === 'routes'));
  expect(layerOrder).toEqual([
    'app-travelled-sections', 'app-highlight-casing', 'app-line-label-backgrounds', 'routes',
    'app-travelled-lines', 'app-route-preview-sections'
  ]);

  const drawing = await page.evaluate((selector) => {
    const style = (target: string) => getComputedStyle(document.querySelector(target)!);
    const travelled = (lineClass: string) => style(`${selector}.s${lineClass}`);
    return {
      untravelledWidth: style('#routes .me.scentral').strokeWidth,
      untravelledStripe: style('#routes .mes').display,
      travelledWidth: travelled('central').strokeWidth,
      // Each line keeps the map's own colour, with no white centre stripe on the Overground.
      colours: [travelled('central').stroke, travelled('mildmay').stroke, travelled('circle').stroke],
      // The pale Circle line keeps the darker edge the map gives it.
      circleCasing: style('#app-travelled-lines [data-part="casing"] path.bcircle').stroke,
      band: style('#app-travelled-sections path').display,
      linePaths: document.querySelectorAll(selector).length,
      trackPaths: document.querySelectorAll('#app-travelled-sections path:not(.app-walk-link)').length
    };
  }, TRAVELLED_LINE_PATHS);
  expect(drawing).toEqual({
    untravelledWidth: '2px', untravelledStripe: 'none', travelledWidth: '6px',
    colours: ['rgb(220, 36, 31)', 'rgb(55, 132, 199)', 'rgb(255, 206, 0)'],
    circleCasing: 'rgb(221, 153, 0)',
    band: 'none', linePaths: drawing.trackPaths, trackPaths: drawing.trackPaths
  });
  expect(drawing.trackPaths).toBeGreaterThan(50);

  // On screen, travelled track is far bolder: forgetting the Central line leaves only the thin line there.
  // Overlapping travelled lines stack in the map's own order (the Circle above the Central here), not recording order.
  const stacking = await page.evaluate((selector) => {
    const classes = [...document.querySelectorAll(selector)].map((path) => path.classList[1]);
    return { central: classes.lastIndexOf('scentral'), circle: classes.indexOf('scircle') };
  }, TRAVELLED_LINE_PATHS);
  expect(stacking.circle).toBeGreaterThan(stacking.central);

  // Black is invisible on the dark map, so travelled Northern track is drawn light, like the map's own Northern line.
  const northernColour = () => page.evaluate((selector) => getComputedStyle(document.querySelector(`${selector}.snorthern`)!).stroke, TRAVELLED_LINE_PATHS);
  expect(await northernColour()).toBe('rgb(0, 0, 0)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(northernColour).toBe('rgb(226, 232, 240)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(northernColour).toBe('rgb(0, 0, 0)');

  const point = await travelledPointOnScreen(page, 'scentral');
  const travelledRed = await countCentralRedPixels(page, point);
  await setTravelledSections(page, 'false');
  await expect(page.locator(TRAVELLED_LINE_PATHS)).toHaveCount(0);
  const untravelledRed = await countCentralRedPixels(page, point);
  expect(untravelledRed).toBeGreaterThan(0);
  expect(travelledRed).toBeGreaterThan(untravelledRed * 2);
  expect(errors).toEqual([]);
});

test('station ticks are thin until a travelled section of their line reaches the station', async ({ page }) => {
  await openMap(page);
  await seedTravelledSections(page, "section.lineId === 'central'");
  await page.reload();
  await openMap(page);
  await expect(page.locator('#station_nodes use[data-app-tick-travelled]').first()).toBeAttached();
  const ticks = await page.evaluate(() => {
    const href = (element: Element) => element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
    const travelled = [...document.querySelectorAll('#station_nodes use[data-app-tick-travelled]')];
    const centralTicks = [...document.querySelectorAll('#station_nodes use[id]')].filter((element) => /^#(st|term)central$/.test(href(element)));
    const transform = (id: string) => document.getElementById(id)!.getAttribute('transform');
    return {
      travelledLines: [...new Set(travelled.map((element) => href(element)))].sort(),
      travelledCount: travelled.length,
      centralTickCount: centralTicks.length,
      onTravelledCentral: transform('Northolt'),
      onUntravelledPiccadilly: transform('Turnpike_Lane'),
      placedByPosition: transform('Devons_Road')
    };
  });
  expect(ticks.travelledLines).toEqual(['#stcentral', '#termcentral']);
  expect(ticks.travelledCount, 'every Central line tick, and only those').toBe(ticks.centralTickCount);
  expect(ticks.centralTickCount).toBeGreaterThan(25);
  // Untravelled ticks are scaled across their width to match the 2-unit untravelled lines (5 × 0.4).
  expect(ticks.onTravelledCentral).toBe('translate(158,459.9)rotate(126.87)');
  expect(ticks.onUntravelledPiccadilly).toBe('translate(1335,74)rotate(126.87) scale(1 0.400)');
  // A tick placed by x and y is scaled about that point, so it stays where it is.
  expect(ticks.placedByPosition).toBe('translate(1900 488) scale(1 0.400) translate(-1900 -488)');

  // Untravelled lines are 2.5 units in dark mode, and ticks follow when the theme changes on the open map.
  const turnpikeLane = page.locator('#Turnpike_Lane');
  await page.getByRole('banner').getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(turnpikeLane).toHaveAttribute('transform', 'translate(1335,74)rotate(126.87) scale(1 0.500)');

  // Without thinning (the band style), every tick gets its own transform back.
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the app's modules at this path in the browser.
    const ticksModule = await import('/src/map/station-ticks.ts');
    ticksModule.applyTickProgress(document.querySelector('.tube-map-viewport svg')!, [], null);
  });
  await expect(turnpikeLane).toHaveAttribute('transform', 'translate(1335,74)rotate(126.87)');
  await expect(page.locator('#Devons_Road')).not.toHaveAttribute('transform', /./);
});

test('a travelled section drawn as two parallel tracks is bold on both; the selected route follows one', async ({ page }, testInfo) => {
  await openMap(page);
  // Between Hackney Downs and Bethnal Green the map draws the Weaver line twice, once per service, 10 units apart.
  await seedTravelledSections(page, "section.id === 'weaver_cambridge_heath_london_fields'");
  await page.reload();
  await openMap(page);
  const weaver = page.locator(`${TRAVELLED_LINE_PATHS}[data-app-link-id="weaver_cambridge_heath_london_fields"]`);
  await expect(weaver).toHaveCount(2);
  const xs = await weaver.evaluateAll((paths) => paths.map((path) => (path as SVGPathElement).getPointAtLength(0).x).sort((a, b) => a - b));
  expect(xs[1]! - xs[0]!, 'one path on each of the two tracks').toBeCloseTo(10, 0);

  await selectStation(page, testInfo, 'cambridge_heath');
  await selectStation(page, testInfo, 'london_fields');
  await expect(page.locator('#app-route-preview-sections [data-part="route"] path[data-app-link-id="weaver_cambridge_heath_london_fields"]')).toHaveCount(1);
});

test('travelled track keeps the white details the map draws over its lines', async ({ page }) => {
  await openMap(page);
  await seedTravelledSections(page, "['piccadilly', 'district', 'elizabeth'].includes(section.lineId)");
  await page.reload();
  await openMap(page);
  await expect(page.locator(TRAVELLED_LINE_PATHS).first()).toBeAttached();
  const drawing = await page.evaluate(() => {
    const layer = document.querySelector('#app-travelled-lines')!;
    const parts = [...layer.children].map((part) => part.getAttribute('data-part'));
    const overlays = [...layer.querySelectorAll('[data-part="map-overlays"] > *')].map((element) => element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? element.tagName);
    const partTime = [...layer.querySelectorAll('[data-part="part-time"] path')].map((path) => path.getAttribute('data-app-link-id'));
    return { parts, overlays, partTime: [...new Set(partTime)].sort() };
  });
  // The Heathrow loop's one-way arrows and the dividers sit above the travelled lines.
  expect(drawing.parts).toEqual(['casing', 'line', 'part-time', 'map-overlays']);
  expect(drawing.overlays).toEqual(['path', '#STRg', '#STRg', 'path']);
  // Part-time dashes are drawn on travelled Olympia branch track, and on no ordinary District or Piccadilly track.
  expect(drawing.partTime).toContain('district_earl_s_court_kensington_olympia');
  expect(drawing.partTime.every((id) => id!.startsWith('district_earl_s_court_kensington_olympia') || id!.startsWith('elizabeth_'))).toBe(true);
});

test('the Elizabeth line\'s Heathrow Terminal 5 branch starts close to the trunk', async ({ page }) => {
  await openMap(page);
  // Heathrow Terminals 2 & 3 is marked only by a Piccadilly tick, which the Elizabeth line is traced from.
  await seedTravelledSections(page, "section.lineId === 'elizabeth'");
  await page.reload();
  await openMap(page);
  const gap = await page.evaluate((selector) => {
    const ends = (id: string) => {
      const path = document.querySelector<SVGPathElement>(`${selector}[data-app-link-id="${id}"]`)!;
      return [path.getPointAtLength(0), path.getPointAtLength(path.getTotalLength())];
    };
    const branch = ends('elizabeth_heathrow_terminals_2_3_heathrow_terminal_5');
    const trunk = ends('elizabeth_hayes_harlington_heathrow_terminals_2_3');
    return Math.min(...branch.flatMap((a) => trunk.map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
  }, TRAVELLED_LINE_PATHS);
  expect(gap).toBeLessThan(9);
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
  await expect(page.locator('.map-legend')).not.toContainText('Not yet');
  const travelled = page.locator('#app-travelled-sections path');
  await expect(travelled.first()).toBeVisible();
  const travelledCount = await travelled.count();
  // A casing strip under every travelled line keeps yellow lines visible on the yellow band.
  await expect(page.locator('#app-highlight-casing path')).toHaveCount(travelledCount);
  const drawing = await page.evaluate(() => ({
    travelledLines: getComputedStyle(document.querySelector('#app-travelled-lines')!).display,
    lineWidth: getComputedStyle(document.querySelector('#routes .me.scircle')!).strokeWidth,
    thinnedTicks: [...document.querySelectorAll('#station_nodes use[id]')].filter((tick) => tick.getAttribute('transform')?.includes('scale(1 ')).length
  }));
  // The band style leaves the map's lines and ticks at their normal widths.
  expect(drawing).toEqual({ travelledLines: 'none', lineWidth: '5px', thinnedTicks: 0 });
});

test('the selected route is drawn as a dashed path over the lines, including track already travelled', async ({ page }, testInfo) => {
  await openMap(page);
  // Paddington to Angel goes by Circle (or H&C/Metropolitan) then Northern; the first leg is already travelled.
  await seedTravelledSections(page, "['circle', 'hammersmith_city', 'metropolitan'].includes(section.lineId)");
  await page.reload();
  await openMap(page);
  await selectStation(page, testInfo, 'paddington');
  await selectStation(page, testInfo, 'angel');
  const route = page.locator('#app-route-preview-sections [data-part="route"] path');
  await expect(route.first()).toBeAttached();
  const routeCount = await route.count();
  await expect(page.locator('#app-route-preview-sections [data-part="casing"] path')).toHaveCount(routeCount);
  const travelledIds = await page.evaluate(() => [...document.querySelectorAll('#app-travelled-sections path')].map((path) => path.getAttribute('data-app-link-id')));
  const routeIds = await route.evaluateAll((paths) => paths.map((path) => path.getAttribute('data-app-link-id')));
  expect(routeIds.filter((id) => travelledIds.includes(id)).length, 'travelled sections of the route are dashed too').toBeGreaterThan(0);
  expect(routeIds.filter((id) => !travelledIds.includes(id)).length, 'new sections of the route are dashed').toBeGreaterThan(0);
  const style = await route.first().evaluate((path) => {
    const computed = getComputedStyle(path);
    return { dashes: computed.strokeDasharray, width: computed.strokeWidth };
  });
  expect(style).toEqual({ dashes: '9px, 6px', width: '4.5px' });
  await page.locator('.tube-map-viewport').screenshot({ path: `test-results/screens/${testInfo.project.name}/preview-paddington-angel.png` });
});

test('each line of a two-line label gets a background that fits it, joined to the next without a notch', async ({ page }) => {
  await openMap(page);
  const report = await page.evaluate(() => {
    const labels = [...document.querySelectorAll<SVGTextElement>('#text #stname > .small text')];
    return ['Northern line', 'Hammersmith & City line', 'Elizabeth line (rush hour special)'].map((text) => {
      const index = labels.findIndex((label) => label.textContent === text && label.querySelector('tspan'));
      const label = labels[index]!;
      // Where each line's letters start and end, in the label's own coordinates.
      const letters = new Map<number, { left: number; right: number }>();
      for (let char = 0; char < label.getNumberOfChars(); char += 1) {
        if (/\s/.test(label.textContent![char]!)) continue;
        const extent = label.getExtentOfChar(char);
        const line = letters.get(Math.round(extent.y)) ?? { left: Infinity, right: -Infinity };
        letters.set(Math.round(extent.y), { left: Math.min(line.left, extent.x), right: Math.max(line.right, extent.x + extent.width) });
      }
      const lines = [...letters.entries()].sort(([a], [b]) => a - b).map(([, line]) => line);
      const backgrounds = [...document.querySelectorAll<SVGRectElement>(`#app-line-label-backgrounds rect[data-label="${index}"]`)];
      const boxes = backgrounds.filter((rect) => !rect.hasAttribute('data-join')).sort((a, b) => a.y.baseVal.value - b.y.baseVal.value);
      const edges = boxes.map((rect) => ({ left: rect.x.baseVal.value + 3, right: rect.x.baseVal.value + rect.width.baseVal.value - 3, top: rect.y.baseVal.value, bottom: rect.y.baseVal.value + rect.height.baseVal.value }));
      // Between the two lines, just inside the edge they share, the background is solid.
      const [upper, lower] = edges;
      const alignedRight = Math.abs(upper!.right - lower!.right) < 0.5;
      const probe = new DOMPoint(alignedRight ? upper!.right + 2.5 : upper!.left - 2.5, (upper!.bottom + lower!.top) / 2);
      return {
        text,
        offsets: edges.map((edge, line) => Math.max(Math.abs(edge.left - lines[line]!.left), Math.abs(edge.right - lines[line]!.right))),
        lineCount: lines.length,
        boxCount: boxes.length,
        joinedEdge: backgrounds.some((rect) => rect.isPointInFill(probe))
      };
    });
  });
  for (const label of report) {
    expect(label.boxCount, label.text).toBe(label.lineCount);
    expect(label.lineCount, label.text).toBe(2);
    // Each box spans its own line's letters (plus padding), so there's no empty white beside the shorter line.
    for (const offset of label.offsets) expect(offset, label.text).toBeLessThan(0.5);
    expect(label.joinedEdge, label.text).toBe(true);
  }
});

test('no travelled line touches the letters of a line name', async ({ page }) => {
  await openMap(page);
  await seedTravelledSections(page);
  await page.reload();
  await openMap(page);
  await expect(page.locator(TRAVELLED_LINE_PATHS).first()).toBeAttached();
  const touching = await page.evaluate((selector) => {
    const svg = document.querySelector<SVGSVGElement>('.tube-map-viewport svg')!;
    const toRoot = svg.getScreenCTM()!.inverse();
    const lines = [...svg.querySelectorAll<SVGPathElement>(selector)].map((path) => ({ path, box: path.getBBox() }));
    // Travelled lines are 6 units wide; test against 6.5 to leave a hairline gap.
    lines.forEach(({ path }) => { path.style.strokeWidth = '6.5px'; });
    const labels = [...svg.querySelectorAll<SVGTextElement>('#text #stname > .small text')];
    const canvas = document.createElement('canvas').getContext('2d')!;
    const font = getComputedStyle(labels[0]!);
    canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
    const found: string[] = [];
    for (const label of labels) {
      const toSvg = toRoot.multiply(label.getScreenCTM()!);
      const text = label.textContent!;
      const points: DOMPoint[] = [];
      // Each letter's own shape (its ink box), not its character cell, sampled on a grid.
      for (let char = 0; char < label.getNumberOfChars(); char += 1) {
        if (/\s/.test(text[char]!)) continue;
        const start = label.getStartPositionOfChar(char);
        const metrics = canvas.measureText(text[char]!);
        const left = start.x - metrics.actualBoundingBoxLeft;
        const right = start.x + metrics.actualBoundingBoxRight;
        const top = start.y - metrics.actualBoundingBoxAscent;
        const bottom = start.y + metrics.actualBoundingBoxDescent;
        for (let u = 0; u <= 4; u += 1) {
          for (let v = 0; v <= 4; v += 1) points.push(new DOMPoint(left + (u / 4) * (right - left), top + (v / 4) * (bottom - top)).matrixTransform(toSvg));
        }
      }
      const near = lines.filter(({ box }) => points.some((point) => point.x > box.x - 5 && point.x < box.x + box.width + 5 && point.y > box.y - 5 && point.y < box.y + box.height + 5));
      if (points.some((point) => near.some(({ path }) => path.isPointInStroke(point)))) found.push(`${text} @ ${label.getAttribute('transform') ?? `${label.getAttribute('x')},${label.getAttribute('y')}`}`);
    }
    lines.forEach(({ path }) => { path.style.strokeWidth = ''; });
    return found;
  }, TRAVELLED_LINE_PATHS);
  expect(touching).toEqual([]);
});

test('the Northern line name beside the bend at Lambeth North keeps its background clear of the line', async ({ page }) => {
  await openMap(page);
  const crossings = await page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>('.tube-map-viewport svg')!;
    const labels = [...svg.querySelectorAll('#text #stname > .small text')];
    const index = labels.findIndex((label) => label.textContent === 'Northern line' && label.querySelector('tspan'));
    const backgrounds = [...svg.querySelectorAll<SVGRectElement>(`#app-line-label-backgrounds rect[data-label="${index}"]`)];
    // Two lines plus the square piece joining them.
    // Against an 8-unit stroke: a 6-unit travelled line plus a 1-unit gap either side.
    const paths = [...svg.querySelectorAll<SVGPathElement>('#routes .sedgware path')];
    paths.forEach((path) => { path.style.strokeWidth = '8px'; });
    let hits = backgrounds.length === 3 ? 0 : -1;
    for (const background of backgrounds) {
      const toSvg = svg.getScreenCTM()!.inverse().multiply(background.getScreenCTM()!);
      const { x, y, width, height } = background.getBBox();
      for (let column = 0; column <= 20; column += 1) {
        for (let row = 0; row <= 10; row += 1) {
          const point = new DOMPoint(x + (column / 20) * width, y + (row / 10) * height).matrixTransform(toSvg);
          if (paths.some((path) => path.isPointInStroke(point))) hits += 1;
        }
      }
    }
    paths.forEach((path) => { path.style.strokeWidth = ''; });
    return hits;
  });
  expect(crossings).toBe(0);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`line-name labels have backgrounds and legible line colours (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openMap(page);
    const labelCount = await page.locator('#text #stname > .small text').count();
    expect(labelCount).toBeGreaterThan(50);
    // One background per line of text (the three two-line labels have two each, joined by a square piece).
    await expect(page.locator('#app-line-label-backgrounds rect:not([data-join])')).toHaveCount(labelCount + 3);
    await expect(page.locator('#app-line-label-backgrounds rect[data-join]')).toHaveCount(3);
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

/**
 * Scrolls each station's tap circle into the middle of the map and reports what a tap would land on: at its centre,
 * and on a 7 × 7 grid inside it (within 90% of the radius).
 */
function sweepTapCircles(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.tube-map-viewport')!;
    const view = viewport.getBoundingClientRect();
    const stationAt = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest('[data-app-station-id]')?.getAttribute('data-app-station-id') ?? null;
    const describe = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y);
      return element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.getAttribute('class') ? `.${element.getAttribute('class')}` : ''} in #${element.parentElement?.id ?? '?'}` : 'nothing';
    };
    const wrongCentres: string[] = [];
    const deadSpots = new Map<string, Set<string>>();
    for (const circle of document.querySelectorAll<SVGCircleElement>('#app-station-hit-areas circle')) {
      const stationId = circle.getAttribute('data-app-station-id')!;
      let box = circle.getBoundingClientRect();
      viewport.scrollLeft += box.x + box.width / 2 - (view.x + view.width / 2);
      viewport.scrollTop += box.y + box.height / 2 - (view.y + view.height / 2);
      box = circle.getBoundingClientRect();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const r = (box.width / 2) * 0.9;
      const centre = stationAt(cx, cy);
      if (centre !== stationId) wrongCentres.push(`${stationId} → ${centre ?? describe(cx, cy)}`);
      for (let i = -3; i <= 3; i++) {
        for (let j = -3; j <= 3; j++) {
          const x = cx + (i / 3) * r;
          const y = cy + (j / 3) * r;
          if (Math.hypot(x - cx, y - cy) > r || stationAt(x, y)) continue;
          deadSpots.set(stationId, (deadSpots.get(stationId) ?? new Set()).add(describe(x, y)));
        }
      }
    }
    return {
      circles: document.querySelectorAll('#app-station-hit-areas circle').length,
      wrongCentres,
      deadSpots: [...deadSpots].map(([stationId, covers]) => `${stationId}: ${[...covers].join(', ')}`)
    };
  });
}

test('choosing the end station responds at once: finding and drawing the route come after', async ({ page }) => {
  await openMap(page);
  await stationLabel(page, 'heathrow_terminal_5').click();
  await stationLabel(page, 'shenfield').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const w = window as unknown as { clickProcessing?: number };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.name === 'click') w.clickProcessing = entry.processingEnd - entry.processingStart;
      }
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  });
  // The first drawing of the Elizabeth line (and finding a cross-London route) is the slowest case.
  await stationLabel(page, 'shenfield').click();
  await expect(page.locator('.route-action-bar')).toContainText('Heathrow Terminal 5 → Shenfield');
  await expect(stationLabel(page, 'shenfield')).toHaveAttribute('data-app-selected', 'true');
  // Event timing entries arrive after the next paint; give a slow click's entry time to be delivered. (Only events
  // that took 16 ms or more are reported, so a quick click may never be.)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))));
  const clickProcessing = await page.evaluate(() => (window as unknown as { clickProcessing?: number }).clickProcessing ?? 0);
  expect(clickProcessing).toBeLessThan(50);
});

test('a tap on the middle of any station’s drawing selects that station', async ({ page }) => {
  await openMap(page);
  const sweep = await sweepTapCircles(page);
  expect(sweep.circles).toBeGreaterThan(400);
  expect(sweep.wrongCentres).toEqual([]);
});

test('nothing drawn over a station’s tap target swallows the tap (line names, connectors, the Bank/Monument hub)', async ({ page }) => {
  await openMap(page);
  const sweep = await sweepTapCircles(page);
  expect(sweep.deadSpots).toEqual([]);
});

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
