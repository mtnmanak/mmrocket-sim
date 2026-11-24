import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';
import { expect, it } from 'vitest';
import { SITEMAP_NAVIGATION, sitemapPlugin } from './sitemap.mjs';
import { compileGuide } from '../../../scripts/build-user-guide.mjs';
import { CHANGELOG, PRE_VERSIONING_NOTE } from '../src/changelog.ts';
import { releaseNotesPlugin } from './release-notes.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const description = 'Free rocket design and flight simulator that runs in your web browser — no install, works on Chromebooks and school computers. OpenRocket-derived physics.';

it('gives every served HTML page exactly one canonical equal to its sitemap URL', () => {
  const assets = [];
  const context = { emitFile: asset => assets.push(asset) };
  releaseNotesPlugin(CHANGELOG, PRE_VERSIONING_NOTE).generateBundle.call(context);
  sitemapPlugin().generateBundle.call(context);
  const sitemap = assets.find(asset => asset.fileName === 'sitemap.xml').source;
  const pages = new Map([['index.html', read('../index.html')]]);
  for (const asset of assets.filter(asset => asset.fileName.endsWith('.html'))) pages.set(asset.fileName, asset.source);
  const publicRoot = new URL('../public/', import.meta.url);
  for (const path of readdirSync(publicRoot, { recursive: true })) {
    if (path.endsWith('.html')) pages.set(path.replaceAll('\\', '/'), readFileSync(new URL(path.replaceAll('\\', '/'), publicRoot), 'utf8'));
  }
  const canonicalUrls = [];
  for (const [path, html] of pages) {
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
    const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]);
    const canonicals = links.filter(tag => /\brel=["']canonical["']/i.test(tag));
    expect(canonicals, path).toHaveLength(1);
    const href = canonicals[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const expected = `https://mmrsim.mountainmanrockets.com/${path.replace(/index\.html$/, '')}`;
    expect(href, path).toBe(expected);
    canonicalUrls.push(href);
  }
  expect([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]).sort()).toEqual(canonicalUrls.sort());
});

it('describes the same free educational browser app in metadata, manifest and JSON-LD', () => {
  const html = read('../index.html');
  const config = read('../vite.config.ts');
  for (const attribute of ['name="description"', 'property="og:description"']) {
    expect(html).toContain(`<meta ${attribute} content="${description}"`);
  }
  expect(config).toContain(`description: '${description}'`);
  const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  expect(json).toBeDefined();
  expect(JSON.parse(json)).toEqual({
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'MMRocket Sim',
    url: 'https://mmrsim.mountainmanrockets.com/', applicationCategory: 'EducationalApplication',
    operatingSystem: 'Any (web browser)', isAccessibleForFree: true, description,
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
  });
});

it('compiles classroom guidance with the drafted capabilities', () => {
  const markdown = read('../user-guide.md');
  expect(markdown).toContain('### For classrooms');
  for (const phrase of ['Chromebooks', 'After the first visit it also works offline.', 'save their designs as .ork files to hand in or reopen later.']) {
    expect(markdown).toContain(phrase);
  }
  expect(compileGuide({ markdown }).ts).toContain('For classrooms');
});

it('registers the sitemap and keeps service-worker navigation away from XML', () => {
  const config = read('../vite.config.ts');
  expect(config).toMatch(/\bsitemapPlugin\(\)/);
  expect(config).toMatch(/navigateFallbackDenylist: \[RELEASES_NAVIGATION, SITEMAP_NAVIGATION\]/);
  expect(config).toContain("globIgnores: ['releases/**', 'sitemap.xml']");
  for (const path of ['/sitemap.xml', '/sitemap.xml?crawler=1']) expect(SITEMAP_NAVIGATION.test(path)).toBe(true);
  for (const path of ['/', '/sitemap.xmlx', '/sitemap.xml/other']) expect(SITEMAP_NAVIGATION.test(path)).toBe(false);
  // No repository-generated robots.txt: Cloudflare owns it.
  expect(existsSync(new URL('../public/robots.txt', import.meta.url))).toBe(false);
});

it('builds and serves a real XML sitemap with the build date rather than the SPA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mmr-sitemap-'));
  let server;
  try {
    writeFileSync(join(root, 'index.html'), '<p>SPA fallback</p>');
    const before = new Date().toISOString().slice(0, 10);
    await build({ configFile: false, root, logLevel: 'silent', plugins: [sitemapPlugin()] });
    const after = new Date().toISOString().slice(0, 10);
    server = await preview({ configFile: false, root, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
    const address = server.httpServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/sitemap.xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/(?:application|text)\/xml/);
    const xml = await response.text();
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1])).toEqual([
      'https://mmrsim.mountainmanrockets.com/', 'https://mmrsim.mountainmanrockets.com/releases/',
    ]);
    const dates = [...xml.matchAll(/<lastmod>(.*?)<\/lastmod>/g)].map(match => match[1]);
    expect(dates).toHaveLength(2);
    for (const date of dates) expect([before, after]).toContain(date);
  } finally {
    if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
