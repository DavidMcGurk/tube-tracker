# Tube Tracker PWA

Tube Tracker is a Progressive Web App for tracking progress across London's public-transport network. It keeps the original map-first product concept while replacing the native iOS architecture with a browser-based, installable app.

**Live app:** [https://davidmcgurk.github.io/tube_tracker/](https://davidmcgurk.github.io/tube_tracker/)

## Stack

- React + TypeScript
- Vite
- Tailwind CSS
- IndexedDB via Dexie
- Service Worker / PWA support
- Vitest for route and progress validation

## Project structure

- `src/data/network.ts` — configured station graph and public network exports
- `src/data/station.ts`, `src/data/track-section.ts`, `src/data/transit-network.ts` — graph entities, validation, connections, and route finding
- `src/data/tfl-network-data.ts` — checked-in TfL route-sequence data for the mapped network
- `src/lib/progress.ts` — progress semantics, distance calculations, and statistics
- `src/lib/storage.ts` — local persistence and theme storage
- `src/App.tsx` — map, stats, and settings interface
- `src/assets/reference-map-clean.svg` — the reference map SVG, embedded directly so its own station labels are interactive
- `vite.config.ts` — Vite, Tailwind, and PWA configuration

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
npm test
```

## Notes

- The app stores progress locally in IndexedDB and stays functional offline after the first successful load.
- The route graph contains 420 TfL stations and 577 adjacent line sections across the 19 mapped Underground, Overground, DLR, and Elizabeth line services, plus the Bank–Monument interchange. It is checked in as static data; section distances are straight-line estimates between TfL stop coordinates. `Station` instances own their connections, and `TransitNetwork` validates sections and provides route finding.
- The map is a single inline SVG: the source map's own vectors and station labels are displayed and interacted with directly. There is no separate drawn network overlay.
- On narrow screens the map opens zoomed into central London; use the zoom controls for detail and drag empty map space to pan. The current pan and zoom are preserved on refresh and while switching tabs. Station names and markers can both be tapped to select stations. Use the expand control for a full-screen map; iPhone safe-area insets are respected around the notch and home indicator.
- The cloud backup and device-transfer interfaces are scaffolded in the app architecture to match the product requirements while keeping the frontend functional without account-based login.
- GitHub Pages deployment is configured with a relative `base` path to support repository sub-path hosting.
- The map SVG is adapted from work by [Sameboat](https://commons.wikimedia.org/wiki/User:Sameboat), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Station and network data are sourced from the [TfL Unified API](https://api.tfl.gov.uk/) under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). This project also references [Demianeen/tube-map](https://github.com/Demianeen/tube-map). Tube Tracker is not an official TfL service. See the full attribution in [`public/licenses/reference-map-LICENCE.txt`](public/licenses/reference-map-LICENCE.txt) and in the app's Settings.
