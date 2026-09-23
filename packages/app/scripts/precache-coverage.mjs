/**
 * Does the service worker precache everything the build ships?
 *
 * WHY. The app is used at launch sites with no signal, and it works there only
 * because the sw.js vite-plugin-pwa generates precaches the whole build. WHAT it
 * precaches is decided by a glob in vite.config.ts (workbox.globPatterns), and
 * that glob names file EXTENSIONS. A build output of a type it does not name — an
 * .svg icon, a .wasm module, a .json data chunk — ships, works online, and is
 * silently missing offline, so the feature that needs it fails at the field,
 * where nobody can report it. The same goes for a file workbox SKIPS for being
 * over maximumFileSizeToCacheInBytes (6 MB; the entry chunk is 2.9 MB and grows
 * with every release) — a build warning nobody reads in CI. Nothing checked
 * either (audit 2026-09-22); now vite.config.ts runs checkDist after every
 * `vite build` and fails the build on a gap.
 *
 * NOT PRECACHED, ON PURPOSE:
 *   sw.js, workbox-<hash>.js  the service worker and its runtime: the browser's
 *                             own update check fetches them, never the precache
 *   version.json              the update check must reach the server, not a
 *                             cached copy of itself (services/versionCheck.ts);
 *                             it is copied into dist after the build today, and
 *                             is named here so moving it into public/ cannot
 *                             turn a deliberate exclusion into a failed build
 *
 * Node-only (it reads the disk); imported by vite.config.ts, typed for it by
 * precache-coverage.d.mts beside it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DELIBERATELY_UNCACHED = [/^sw\.js$/, /^workbox-[0-9a-f]+\.js$/, /^version\.json$/];

/**
 * The URLs a generated sw.js precaches: the `url` of every entry in workbox's
 * precacheAndRoute manifest. Minified output writes `url:"…"`, development
 * output `"url": "…"`; both are read.
 */
export function precachedUrls(swSource) {
  return new Set([...swSource.matchAll(/["']?\burl["']?\s*:\s*"([^"]+)"/g)]
    .map((m) => decodeURIComponent(m[1])));
}

/**
 * The files (dist-relative, forward slashes) the service worker would NOT have
 * offline. Throws on a manifest with no entries at all: that is a sw.js whose
 * format this parser no longer reads, and an empty answer would pass everything.
 */
export function uncachedFiles(files, swSource) {
  const cached = precachedUrls(swSource);
  if (cached.size === 0) {
    throw new Error('sw.js lists no precache entries — has workbox changed its output format?');
  }
  return files.filter((f) => !cached.has(f) && !DELIBERATELY_UNCACHED.some((re) => re.test(f)));
}

/** uncachedFiles for a built dist/ directory: every file under it, against its sw.js. */
export function checkDist(distDir) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(distDir, path).split(sep).join('/'));
    }
  };
  walk(distDir);
  if (!files.includes('sw.js')) {
    throw new Error(`no sw.js in ${distDir} — the PWA plugin did not generate a service worker`);
  }
  return uncachedFiles(files.sort(), readFileSync(join(distDir, 'sw.js'), 'utf8'));
}
