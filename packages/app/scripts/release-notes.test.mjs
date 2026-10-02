import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHANGELOG, PRE_VERSIONING_NOTE } from '../src/changelog.ts';
import { APP_VERSION } from '../src/version.ts';
import { DELIBERATELY_UNCACHED } from './precache-coverage.mjs';
import {
  escapeHtml, releaseAnchor, releaseNotesPlugin, RELEASES_FILE, RELEASES_NAVIGATION, renderReleaseNotes,
} from './release-notes.mjs';

/**
 * The public release-notes page (releases/index.html, 2026-10-02): one page,
 * rendered from CHANGELOG, every release anchored so a TRF post can link to
 * its own. These pin what the page must carry and that the service worker
 * leaves it alone.
 */

const page = renderReleaseNotes(CHANGELOG, PRE_VERSIONING_NOTE);
const HERE = dirname(fileURLToPath(import.meta.url));

describe('the release-notes page', () => {
  it('opens on the release this build is, and names it as the latest', () => {
    expect(CHANGELOG[0].version).toBe(APP_VERSION);
    expect(page).toContain(`The latest is <a href="#v${APP_VERSION}">v${APP_VERSION}</a>`);
  });

  it('carries every release once, newest first, each with its own anchor and contents link', () => {
    let last = -1;
    for (const e of CHANGELOG) {
      const id = releaseAnchor(e.version);
      const at = page.indexOf(`<section class="release" id="${id}">`);
      expect(at, `v${e.version}`).toBeGreaterThan(last);
      expect(page.split(`id="${id}"`).length - 1, `v${e.version} anchored once`).toBe(1);
      expect(page, `v${e.version} in the contents`).toContain(`<li><a href="#${id}">v${e.version}</a>`);
      last = at;
    }
  });

  it('carries every item and title word for word (escaped), and the note from before versioning', () => {
    for (const e of CHANGELOG) {
      expect(page).toContain(`<p class="title">${escapeHtml(e.title)}</p>`);
      for (const item of e.items) expect(page).toContain(`<li>${escapeHtml(item)}</li>`);
    }
    expect(page).toContain(escapeHtml(PRE_VERSIONING_NOTE));
  });

  it('lets no changelog text become markup', () => {
    const html = renderReleaseNotes([{
      version: '9.999', date: '2099-01-01', title: 'A <b>title</b> & "quotes"',
      items: ['<script>alert(1)</script> and <img src=x onerror=alert(1)>'],
    }], 'pre <i>note</i>');
    expect(html).not.toMatch(/<script|<img|<b>|<i>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &lt;b&gt;title&lt;/b&gt; &amp; &quot;quotes&quot;');
  });

  it('refuses an empty changelog and a version that appears twice', () => {
    expect(() => renderReleaseNotes([], '')).toThrow(/empty/);
    const e = { version: '1.0', date: 'd', title: 't', items: [] };
    expect(() => renderReleaseNotes([e, e], '')).toThrow(/twice/);
  });

  it('is plain HTML with no script, and links back to the app and its source', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain('<a href="../">Open the app</a>');
    expect(page).toContain('https://github.com/mtnmanak/mmrocket-sim');
  });
});

describe('the build writes the page (the real plugin)', () => {
  it('runs on build only, and emits releases/index.html with the rendered page', () => {
    const plugin = releaseNotesPlugin(CHANGELOG, PRE_VERSIONING_NOTE);
    // Codex review, 2026-10-02: a plugin switched to 'serve' passed every
    // assertion about the renderer while production builds wrote no page.
    expect(plugin.apply).toBe('build');
    const emitted = [];
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'asset', fileName: 'releases/index.html' });
    expect(RELEASES_FILE).toBe('releases/index.html');
    expect(emitted[0].source).toBe(page);
  });
});

describe('the service worker leaves the page alone (it is not offline, on purpose)', () => {
  const config = readFileSync(join(HERE, '..', 'vite.config.ts'), 'utf8');

  it('the build registers the plugin, and the precache skips the page', () => {
    expect(config).toMatch(/releaseNotesPlugin\(CHANGELOG, PRE_VERSIONING_NOTE\)/);
    expect(config).toMatch(/globIgnores: \['releases\/\*\*'\]/);
    expect(DELIBERATELY_UNCACHED.some((re) => re.test(RELEASES_FILE))).toBe(true);
  });

  it('the navigation fallback does not answer the page address with the app, slash, query or not', () => {
    expect(config).toMatch(/navigateFallbackDenylist: \[RELEASES_NAVIGATION\]/);
    // Workbox tests the denylist against path + query.
    for (const url of ['/releases', '/releases/', '/releases/index.html', '/releases?utm_source=forum',
      '/releases/?utm_source=forum', '/releases/#v0.151'.split('#')[0]]) {
      expect(RELEASES_NAVIGATION.test(url), url).toBe(true);
    }
    for (const url of ['/', '/index.html', '/releasesX', '/?d=1']) expect(RELEASES_NAVIGATION.test(url), url).toBe(false);
  });
});
