/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // React and Dexie change far less often than the app: in a chunk of their own, an app release doesn't make
          // every device download them again. Named packages only: a catch-all would also pull workbox-window, which
          // is loaded lazily, into this eagerly loaded chunk.
          groups: [{ name: 'vendor', test: /node_modules[\\/](react|react-dom|scheduler|dexie)[\\/]/ }]
        }
      }
    }
  },
  test: {
    // sync-server has its own vitest (Workers pool) and package.json.
    exclude: [...configDefaults.exclude, 'e2e/**', '.claude/**', 'sync-server/**'],
    // Storage tests run Dexie against an in-memory IndexedDB.
    setupFiles: ['src/test-setup.ts']
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Tube Tracker',
        short_name: 'Tube Tracker',
        description: 'Track your London transport network progress offline.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        scope: './',
        start_url: './',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png', purpose: 'any' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
        ]
      },
      workbox: {
        // txt: the licence notice linked from Settings; the web manifest is precached by the plugin itself.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,txt}'],
        navigateFallback: 'index.html'
      }
    })
  ]
});
