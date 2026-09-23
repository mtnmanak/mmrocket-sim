/// <reference types="vitest/config" />
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
  // The browsers the build is written for: vite 5's 'modules' default, stated
  // (AUDIT row 528, vite 5 -> 8). Vite 7 and 8 raised the default (now Chrome
  // 111, Firefox 114, Safari 16.4), so the same source built with the ES2021
  // and ES2022 syntax these targets lower — `||=`, which Firefox 78 cannot
  // parse, and class fields — and Lightning CSS dropped the -webkit- and -moz-
  // prefixes they keep. With this list every chunk parses as ES2020 again, as
  // it did. A tester's older iPad or ESR Firefox is not something to drop as a
  // side effect of a toolchain upgrade; raising it is its own decision.
  build: {
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
  },
  // The engine is a linked workspace package (entry imports the ESM artifact
  // vendor/orkengine.mjs). Prebundle it so dev mode resolves it like prod.
  optimizeDeps: {
    include: ['@online-openrocket/engine'],
  },
  // Vitest reads this file too (there is no vitest.config.ts). All three
  // settings keep the suite what it was under vitest 2 (AUDIT row 528,
  // vitest 2 -> 5):
  test: {
    // Vitest 4 cut its default exclude to node_modules and .git. This is
    // vitest 2's own list, so exactly the same files are collected — dist/
    // included, and the `*.config.*` rule that
    // scripts/eslint-config.guards.test.mjs is named around.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
    // Vitest 5 clears every mock's calls before each test by default. Vitest 2
    // did not, and a `not.toHaveBeenCalled()` written against the old
    // behaviour could only get easier to pass; each file resets what it means
    // to (restoreAllMocks and friends in its own hooks).
    clearMocks: false,
    // Vitest 5 picks its 'minimal' reporter when it detects an AI agent
    // (CLAUDECODE, AI_AGENT), and that one swallows what a passing test
    // prints — the numbers a measurement driver such as
    // services/lemivSweep.test.ts exists to print. Vitest 2's choice, which is
    // also what CI still gets: 'default', plus 'github-actions' there.
    reporters: process.env['GITHUB_ACTIONS'] === 'true' ? ['default', 'github-actions'] : ['default'],
  },
});
