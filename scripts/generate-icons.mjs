/**
 * Generates every app icon from one artwork definition: public/favicon.svg (the rounded tile used in browser tabs)
 * and the PNGs that the web manifest and iOS need. The PNGs are rendered by the locally installed Chrome through
 * Playwright, so each file has exact pixel dimensions.
 *
 * Run `npm run icons` after changing the artwork and commit the results.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const PUBLIC_DIR = new URL('../public/', import.meta.url);

const TILE_COLOR = '#0f172a';
const TRAVELLED_COLOR = '#facc15';
const UNTRAVELLED_COLOR = '#475569';
const FRONTIER_COLOR = '#ffffff';

/*
 * Concept A, "travelled line": a yellow travelled segment meets a slate untravelled one at a white frontier dot.
 * Horizontal stroke edges sit on a 32-unit grid (of 512) so they stay crisp at 16 and 32 px.
 */
const ARTWORK = [
  `<path d="M256 256 L320 192 H416" fill="none" stroke="${UNTRAVELLED_COLOR}" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/>`,
  `<path d="M96 320 H192 L256 256" fill="none" stroke="${TRAVELLED_COLOR}" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/>`,
  `<circle cx="256" cy="256" r="40" fill="${FRONTIER_COLOR}"/>`
];

function iconSvg({ cornerRadius, artworkScale }) {
  const tile = `<rect width="512" height="512"${cornerRadius ? ` rx="${cornerRadius}"` : ''} fill="${TILE_COLOR}"/>`;
  const artwork = artworkScale === 1
    ? ARTWORK.map((element) => `  ${element}`)
    : [
      `  <g transform="translate(256 256) scale(${artworkScale}) translate(-256 -256)">`,
      ...ARTWORK.map((element) => `    ${element}`),
      '  </g>'
    ];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
    '  <title>Tube Tracker</title>',
    `  ${tile}`,
    ...artwork,
    '</svg>',
    ''
  ].join('\n');
}

/** Transparent outside the rounded corners: the tab icon and the manifest's "any" icons. */
const ROUNDED_TILE = iconSvg({ cornerRadius: 112, artworkScale: 1 });

/**
 * Square and opaque: iOS rounds the corners itself (and turns transparency black), and maskable icons can be cropped
 * to a circle of radius 40%, so the artwork is scaled to sit well inside that safe zone.
 */
const FULL_BLEED_TILE = iconSvg({ cornerRadius: 0, artworkScale: 0.9 });

const PNG_ICONS = [
  { file: 'pwa-64x64.png', size: 64, svg: ROUNDED_TILE },
  { file: 'pwa-192x192.png', size: 192, svg: ROUNDED_TILE },
  { file: 'pwa-512x512.png', size: 512, svg: ROUNDED_TILE },
  { file: 'maskable-icon-512x512.png', size: 512, svg: FULL_BLEED_TILE },
  { file: 'apple-touch-icon-180x180.png', size: 180, svg: FULL_BLEED_TILE }
];

const outputPath = (file) => fileURLToPath(new URL(file, PUBLIC_DIR));

await writeFile(outputPath('favicon.svg'), ROUNDED_TILE);

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const { file, size, svg } of PNG_ICONS) {
    // A fresh page per size: resizing one page between captures can leave stale tiles in the screenshot.
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<!doctype html><html><body style="margin:0"><img alt="" src="${source}" width="${size}" height="${size}" style="display:block"></body></html>`
    );
    await page.locator('img').evaluate((image) => image.decode());
    await page.screenshot({ path: outputPath(file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`public/${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
