/**
 * precache-coverage.mjs is the post-build check that the offline service worker
 * precaches every file the build ships (vite.config.ts runs it after each
 * `vite build`). Its failure mode would be silence — a check that passes
 * everything — so these pin that it reports a gap, reads both manifest shapes
 * workbox writes, and refuses to answer from a manifest it cannot read.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDist, precachedUrls, uncachedFiles } from './precache-coverage.mjs';

// The shape of the shipped sw.js (minified by workbox), cut to three entries.
const SW_MIN = 'define(["./workbox-9c191d2f"],function(e){"use strict";self.skipWaiting(),'
  + 'e.clientsClaim(),e.precacheAndRoute([{url:"index.html",revision:"670f93746ee9d9471ade235d6a6ef449"},'
  + '{url:"assets/index-C7tKBouI.js",revision:null},'
  + '{url:"assets/rajdhani-latin-600-normal-CXCVEoA9.woff2",revision:null}],{})});';

describe('precache coverage — every built file is offline, or deliberately not', () => {
  it('reads the manifest of a minified sw.js, and of an unminified one', () => {
    expect([...precachedUrls(SW_MIN)]).toEqual([
      'index.html', 'assets/index-C7tKBouI.js', 'assets/rajdhani-latin-600-normal-CXCVEoA9.woff2',
    ]);
    const dev = 'workbox.precacheAndRoute([{\n  "url": "index.html",\n  "revision": "abc"\n}], {});';
    expect([...precachedUrls(dev)]).toEqual(['index.html']);
  });

  it('names a built file of a type the glob does not cover', () => {
    // The failure this exists for: an .svg (or .wasm, or .json chunk) ships and
    // works online, and is missing offline at the field.
    expect(uncachedFiles([
      'index.html', 'assets/index-C7tKBouI.js', 'assets/rajdhani-latin-600-normal-CXCVEoA9.woff2',
      'assets/logo-Ab12Cd34.svg',
    ], SW_MIN)).toEqual(['assets/logo-Ab12Cd34.svg']);
  });

  it('leaves out the service worker, its runtime and version.json on purpose', () => {
    expect(uncachedFiles(['index.html', 'sw.js', 'workbox-9c191d2f.js', 'version.json'], SW_MIN)).toEqual([]);
    // Only the runtime's own name: an app chunk that merely starts "workbox-"
    // (vite names one workbox-window.prod.es5-<hash>.js) is still checked.
    expect(uncachedFiles(['workbox-window.prod.es5-BqEJf4Xk.js'], SW_MIN))
      .toEqual(['workbox-window.prod.es5-BqEJf4Xk.js']);
  });

  it('refuses to pass anything when it cannot read the manifest at all', () => {
    expect(() => uncachedFiles(['index.html'], 'self.skipWaiting();')).toThrow(/no precache entries/);
  });

  it('walks a real dist directory, subfolders included', () => {
    const dist = mkdtempSync(join(tmpdir(), 'precache-'));
    try {
      mkdirSync(join(dist, 'assets'));
      writeFileSync(join(dist, 'sw.js'), SW_MIN);
      writeFileSync(join(dist, 'workbox-9c191d2f.js'), '');
      for (const f of ['index.html', 'assets/index-C7tKBouI.js',
        'assets/rajdhani-latin-600-normal-CXCVEoA9.woff2', 'assets/engine-0a1b2c3d.wasm']) {
        writeFileSync(join(dist, f), '');
      }
      expect(checkDist(dist)).toEqual(['assets/engine-0a1b2c3d.wasm']);
      rmSync(join(dist, 'sw.js'));
      expect(() => checkDist(dist)).toThrow(/no sw\.js/);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
