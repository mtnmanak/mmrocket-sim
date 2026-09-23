import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { checkDist } from './scripts/precache-coverage.mjs';

/**
 * Fails `vite build` when the offline precache misses a built file (audit
 * 2026-09-22): globPatterns below names extensions, so an output of a new type
 * would ship, work online, and be missing at a field with no signal. Runs after
 * VitePWA has written sw.js — `order: 'post'` plus `sequential` puts it behind
 * the plugin's own closeBundle, which generates the service worker. The check
 * and its deliberate exclusions live in scripts/precache-coverage.mjs.
 */
function precacheCoversBuild(): Plugin {
  let outDir = '';
  return {
    name: 'precache-covers-build',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const missing = checkDist(outDir);
        if (missing.length > 0) {
          throw new Error(`the service worker does not precache ${missing.length} built file(s), `
            + `so they would be missing offline: ${missing.join(', ')}. Add the extension to `
            + 'workbox.globPatterns in vite.config.ts, or, if it must never be cached, to '
            + 'DELIBERATELY_UNCACHED in scripts/precache-coverage.mjs with the reason.');
        }
      },
    },
  };
}

// base './' keeps built asset URLs relative so the same build works
// standalone AND embedded in a WordPress page or iframe.
export default defineConfig({
  plugins: [
    react(),
    // PWA/offline: remote launch sites (Black Rock…) have no internet, so the
    // ENTIRE build precaches — 24 files, about 6 MB (precacheCoversBuild, the
    // last plugin, fails the build if one is left out): the engine, the parts
    // catalogue, the nozzle database, three.js and the exporters, the fonts, and
    // the bundled thrust curves. Everything lazy-loaded is precached too, so a
    // feature the user never opened online still works offline.
    //
    // The curve line here used to read "fetched from thrustcurve.org … persist in
    // localStorage, so PREVIOUSLY-LOADED motors also work offline". That is
    // pre-v0.107 and it was false for a month: v0.107 bundled every published
    // curve (1,948 files, 1,075 of 1,155 motors), so a motor flies offline whether
    // or not it was ever flown online. It had already propagated into the user
    // guide in two places, which is what a stale comment does (2026-09-15).
    //
    // ONE DELIBERATE EXCLUSION: version.json. globPatterns below has no `json`, so
    // the update check always reaches the real server instead of reading a cached
    // copy of itself — see services/versionCheck.ts.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'MMRocket Sim',
        short_name: 'MMRocket Sim',
        description: 'Design model rockets and simulate flights — the real OpenRocket physics engine in your browser, offline-capable.',
        theme_color: '#101623',
        background_color: '#101623',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // woff/woff2: the self-hosted Rajdhani display face must work offline.
        globPatterns: ['**/*.{js,css,html,png,webmanifest,woff,woff2}'],
        // The main chunk is 2.68 MB (measured 2026-09-15; it carries the TeaVM kernel
        // AND the React app, so it grows with both) — well over workbox's 2 MB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
    precacheCoversBuild(),
  ],
  base: './',
  // The engine is a linked workspace package (entry imports the ESM artifact
  // vendor/orkengine.mjs). Prebundle it so dev mode resolves it like prod.
  optimizeDeps: {
    include: ['@online-openrocket/engine'],
  },
});
