# Tube Tracker

Tube Tracker is a Progressive Web App for tracking progress across London's public-transport network. It keeps the original map-first product concept while replacing the native iOS architecture with a browser-based, installable app.

**Live app:** [https://davidmcgurk.github.io/tube-tracker/](https://davidmcgurk.github.io/tube-tracker/)  
**GitHub repository:** [github.com/DavidMcGurk/tube-tracker](https://github.com/DavidMcGurk/tube-tracker)

## Stack

- React + TypeScript
- Vite
- Tailwind CSS
- IndexedDB via Dexie
- Service Worker / PWA support
- Vitest (unit) and Playwright (end-to-end, across phone, tablet and desktop viewports)

## Project structure

- `src/App.tsx` — composes the tabs, theme, progress and route selection
- `src/components/` — `MapView` (map, toolbar, route bar), `StatsView`, `SettingsView`, `InstallPrompt` and smaller pieces
- `src/hooks/` — `useProgress` (load/save with error handling), `useRouteSelection`, `useTheme`, `useProgressStyle`, `useInstallPrompt`, `useMediaQuery`
- `src/map/` — everything that works on the inline SVG: binding stations to markers and labels (`station-binding`, `station-index`, `station-anchors`), tracing highlights along the drawn lines (`section-geometry`, `highlight-layer`), line-label backgrounds, and the viewport, gesture and pinch-zoom hooks
- `src/data/` — the network: `tfl-network-data.ts` (TfL stations and line sections), `walk-links.ts` (walking interchanges), `line-services.ts` (through-services on every branched line), entities (`station`, `track-section`, `walk-link`), `transit-network.ts` and `route-planner.ts` (journey planning: changes first, then distance)
- `src/lib/` — progress and statistics (`progress.ts`), persistence (`storage.ts`), route text (`route-format.ts`), zoom maths (`map-zoom.ts`), install-prompt logic
- `src/assets/reference-map-clean.svg` — the reference map SVG, embedded directly so its own station labels are interactive
- `e2e/` — Playwright specs: a viewport sweep with screenshots, map health checks (every section drawable, no geometry work on hover), interactions, pinch zoom and the install prompt
- `vite.config.ts` — Vite, Tailwind, PWA and Vitest configuration

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

## Testing

```bash
npm test        # unit tests (Vitest)
npm run e2e     # end-to-end tests (Playwright) across phone, tablet, laptop and widescreen viewports
```

The end-to-end tests use the locally installed Chrome, plus Playwright's WebKit build for the iPhone profile (`npx playwright install webkit`). Screenshots of every viewport, in light and dark mode, are written to `test-results/screens/`.

## App icons

The logo is defined once in `scripts/generate-icons.mjs`. The script writes `public/favicon.svg` and renders the PNG icons (manifest, maskable and Apple touch icon) to `public/` using the locally installed Chrome. Run it after changing the artwork and commit the results:

```bash
npm run icons
```

## Notes

- The app stores progress locally in IndexedDB and stays functional offline after the first successful load.
- The route graph contains 420 TfL stations and 577 adjacent line sections across the 19 mapped Underground, Overground, DLR and Elizabeth line services, plus the walking interchanges drawn on the map (out-of-station interchanges such as Camden Town–Camden Road, and in-station links such as Bank–Monument). Section distances are straight-line estimates between TfL stop coordinates; walking distances are approximate. Walks never count as track in the statistics.
- Journey suggestions are ordered by number of changes, then distance (walking weighted as slower than riding). Lines sharing track (e.g. Circle and Hammersmith & City) are offered as separate options without counting as a change, and every branched line is modelled as its real through-services, so switching branches counts as a change. See `src/data/route-planner.ts`.
- The map is a single inline SVG: the source map's own vectors and station labels are displayed and interacted with directly. There is no separate drawn network overlay.
- Travelled track is shown by default as the map's own lines at full width, with lines you haven't travelled drawn thinner (a copy of the line artwork, masked to the travelled track). Settings offers a yellow band beneath the lines instead. A selected journey's new track is drawn on top as an orange dashed line, and its walks as orange dots.
- On narrow screens the map opens zoomed into central London; pinch with two fingers (or use the zoom controls) for detail and drag to pan. On a computer, pinch on the trackpad or hold Ctrl and scroll to zoom about the pointer. The current pan and zoom are preserved on refresh and while switching tabs. Tap a start station and then an end station (name or marker) to choose a journey; press and hold a station to see its lines. Use the expand control for a full-screen map; iPhone safe-area insets are respected around the notch and home indicator.
- GitHub Pages deployment is configured with a relative `base` path to support repository sub-path hosting.
- The map SVG is adapted from work by [Sameboat](https://commons.wikimedia.org/wiki/User:Sameboat), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Station and network data are sourced from the [TfL Unified API](https://api.tfl.gov.uk/) under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). This project also references [Demianeen/tube-map](https://github.com/Demianeen/tube-map). Tube Tracker is not an official TfL service. See the full attribution in [`public/licenses/reference-map-LICENCE.txt`](public/licenses/reference-map-LICENCE.txt) and in the app's Settings.
