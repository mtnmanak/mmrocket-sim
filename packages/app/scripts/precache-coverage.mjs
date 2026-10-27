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

// releases/: the public release-notes page (scripts/release-notes.mjs) — the
// whole changelog as one page, kept off every user's download on purpose.
// brand/: four vendored mmr-brand files the running app never loads — the sync
// manifest, the JSON copy of the tokens (the app reads the CSS; chartTheme.ts,
// Rocket3D.tsx and PlotImage.tsx import this file at BUILD time, through
// vite.config's virtual:mmr-brand-tokens, so Vite bundles the values and the
// app never fetches it),
// the two font licences and the icon sprite's usage note. They ship because
// sync-brand.mjs vendors the folder whole and --verify checks every file.
export const DELIBERATELY_UNCACHED = [
  /^sw\.js$/, /^workbox-[0-9a-f]+\.js$/, /^version\.json$/, /^releases\//,
  /^brand\/brand-manifest\.json$/, /^brand\/tokens\.json$/, /^brand\/fonts\/OFL-[A-Za-z]+\.txt$/, /^brand\/icons\/USAGE\.md$/,
];

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

/**
 * URLs the precache manifest lists more than once. Workbox's install puts each
 * entry into the cache, and a current Chrome (156, measured 2026-10-26) rejects
 * the second put of the same request ("Failed to execute 'put' on 'Cache':
 * Entry already exists"), so the whole install fails and a FIRST visit never
 * gets an offline copy. An update only re-puts changed entries, which is why an
 * already-installed worker kept working. vite-plugin-pwa adds includeAssets and
 * the manifest icons on top of globPatterns, so one file matched by both
 * appears twice.
 */
export function duplicatePrecacheUrls(swSource) {
  const seen = new Set();
  const dupes = new Set();
  for (const m of swSource.matchAll(/["']?\burl["']?\s*:\s*"([^"]+)"/g)) {
    const url = decodeURIComponent(m[1]);
    if (seen.has(url)) dupes.add(url);
    seen.add(url);
  }
  return [...dupes].sort();
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
