/**
 * The public release-notes page, `releases/index.html` in the built app
 * (https://mmrsim.mountainmanrockets.com/releases/), rendered from the app's
 * own CHANGELOG (src/changelog.ts) during `vite build` by the plugin in
 * vite.config.ts. Eric, 2026-10-02: the TRF posts had grown to three posts a
 * release, so the forum gets one short post and links here for the detail.
 *
 * ONE SOURCE. The page is the same text as the in-app What's new dialog
 * (components/ChangelogDialog.tsx), which the release-note claim check reads
 * before every release; nothing here is written by hand, so the two cannot
 * drift. Every release has an anchor, `#v<version>` (`#v0.151`), so a forum
 * post can link straight to its own release.
 *
 * NOT OFFLINE, ON PURPOSE. The changelog is ~560 KB of text, which App.tsx
 * already keeps out of the startup chunk (scripts/lazy-chunks.mjs); precaching
 * this page would put it on every user's download. vite.config.ts leaves it
 * out of the precache (globIgnores), lists it in DELIBERATELY_UNCACHED
 * (scripts/precache-coverage.mjs), and keeps the service worker's navigation
 * fallback away from /releases/, which would otherwise answer the page's URL
 * with the app itself for anyone who has the app installed.
 *
 * Static HTML with no script: escaped text only (escapeHtml), so nothing in a
 * changelog entry can become markup.
 */

const SOURCE_URL = 'https://github.com/mtnmanak/mmrocket-sim';

/** HTML-escape text for an element body or a double-quoted attribute. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The anchor a release's section carries: `v0.151`. */
export function releaseAnchor(version) {
  return `v${version}`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--panel:#ffffff;--text:#0b0b0b;--text2:#52514e;--muted:#6d6b63;--border:#dedbd2;--accent:#b8511d}
@media (prefers-color-scheme:dark){:root{--bg:#101623;--panel:#161e2e;--text:#f0efec;--text2:#c9c7c1;--muted:#9a978e;--border:#2a3448;--accent:#f08a4b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--accent)}
h1{font-size:1.6rem;margin:0 0 4px}
.lead{color:var(--text2);margin:0 0 20px}
nav.toc{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:28px}
nav.toc summary{cursor:pointer;font-weight:600}
nav.toc ol{list-style:none;margin:10px 0 0;padding:0;max-height:360px;overflow:auto}
nav.toc li{margin:2px 0;font-size:.92rem}
nav.toc .d{color:var(--muted);margin:0 6px}
section.release{border-top:1px solid var(--border);padding-top:18px;margin-top:18px}
section.release h2{font-size:1.25rem;margin:0}
section.release h2 .d{font-size:.85rem;font-weight:400;color:var(--muted);margin-left:8px}
.title{color:var(--text2);margin:4px 0 10px}
section.release li{margin-bottom:8px}
.pre{color:var(--muted);white-space:pre-line;border-top:1px solid var(--border);margin-top:28px;padding-top:14px;font-size:.92rem}
footer{color:var(--muted);font-size:.85rem;margin-top:32px}
`.trim();

/**
 * The whole page. `changelog` is CHANGELOG (newest first, as the dialog shows
 * it), `preNote` is PRE_VERSIONING_NOTE. A pure function of its inputs, so the
 * page a build writes is reproducible and a test can pin it.
 */
export function renderReleaseNotes(changelog, preNote) {
  if (!Array.isArray(changelog) || changelog.length === 0) {
    throw new Error('release notes: the changelog is empty, so there is no page to write');
  }
  const seen = new Set();
  for (const e of changelog) {
    if (!e || typeof e.version !== 'string' || !Array.isArray(e.items)) {
      throw new Error(`release notes: a changelog entry has no version or items (${JSON.stringify(e).slice(0, 80)})`);
    }
    if (seen.has(e.version)) throw new Error(`release notes: v${e.version} appears twice, so its anchor would too`);
    seen.add(e.version);
  }
  const newest = changelog[0];
  const toc = changelog.map((e) => `<li><a href="#${escapeHtml(releaseAnchor(e.version))}">v${escapeHtml(e.version)}</a>`
    + `<span class="d">${escapeHtml(e.date)}</span>${escapeHtml(e.title)}</li>`).join('\n');
  const sections = changelog.map((e) => [
    `<section class="release" id="${escapeHtml(releaseAnchor(e.version))}">`,
    `<h2><a href="#${escapeHtml(releaseAnchor(e.version))}">v${escapeHtml(e.version)}</a><span class="d">${escapeHtml(e.date)}</span></h2>`,
    `<p class="title">${escapeHtml(e.title)}</p>`,
    '<ul>',
    ...e.items.map((item) => `<li>${escapeHtml(item)}</li>`),
    '</ul>',
    '</section>',
  ].join('\n')).join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>MMRocket Sim release notes</title>',
    `<meta name="description" content="Every release of MMRocket Sim, newest first. Latest: v${escapeHtml(newest.version)}, ${escapeHtml(newest.date)}.">`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>MMRocket Sim release notes</h1>',
    `<p class="lead">Every release of the app, newest first. The latest is <a href="#${escapeHtml(releaseAnchor(newest.version))}">v${escapeHtml(newest.version)}</a> (${escapeHtml(newest.date)}). `
      + 'The same notes are in the app: click the version badge in its header. '
      + '<a href="../">Open the app</a>.</p>',
    '<nav class="toc" aria-label="Releases">',
    '<details open><summary>All releases</summary>',
    '<ol>',
    toc,
    '</ol>',
    '</details>',
    '</nav>',
    sections,
    `<p class="pre">${escapeHtml(preNote)}</p>`,
    `<footer>MMRocket Sim is free software under the GPL v3 or later, derived from OpenRocket. <a href="${SOURCE_URL}">Source code</a>.</footer>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Where an installed app's service worker must NOT answer a navigation with
 * the app: the page's own address, with or without the trailing slash, and
 * with a query (`/releases?utm_source=forum` — Workbox matches the denylist
 * against path + query, so a bare `$` would miss it: Codex review, 2026-10-02).
 * vite.config.ts hands this to workbox.navigateFallbackDenylist.
 */
export const RELEASES_NAVIGATION = /\/releases(?:\/|\?|$)/;

/** The page's path inside the built app. */
export const RELEASES_FILE = 'releases/index.html';

/**
 * The Vite plugin that writes the page during `vite build` (and only then).
 * Lives here, not in vite.config.ts, so release-notes.test.mjs can run the
 * real thing: a plugin quietly switched off (`apply: 'serve'`) or writing the
 * wrong file would otherwise pass every assertion about the renderer.
 */
export function releaseNotesPlugin(changelog, preNote) {
  return {
    name: 'release-notes-page',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: RELEASES_FILE, source: renderReleaseNotes(changelog, preNote) });
    },
  };
}
