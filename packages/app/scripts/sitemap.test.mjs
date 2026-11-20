import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';
import { expect, it } from 'vitest';
import { SITEMAP_NAVIGATION, sitemapPlugin } from './sitemap.mjs';
import { compileGuide } from '../../../scripts/build-user-guide.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const description = 'Free rocket design and flight simulator that runs in your web browser — no install, works on Chromebooks and school computers. OpenRocket-derived physics.';

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
