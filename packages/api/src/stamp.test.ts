import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import { SimulateDesignError, simulateFile } from '../../app/src/headless/index.js';

// Distinct non-date sentinels: on main the two catalogue dates are equal, so only these tell them apart.
vi.mock('../../app/src/headless/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../app/src/headless/index.js')>();
  return { ...actual, simulateFile: vi.fn(), APP_VERSION: 'sentinel-app-version',
    MOTORS_GENERATED: 'sentinel-motors-snapshot', CURVES_GENERATED: 'sentinel-curves-snapshot' };
});
beforeEach(() => { vi.mocked(simulateFile).mockReset(); });
const ctx = { waitUntil: () => undefined };

it.each([
  ['/health', 'GET', 200],
  ['/unknown', 'GET', 404],
  ['/experimental/fly?filename=test.ork', 'POST', 422],
] as const)('%s stamps each constant under its own key', async (path, method, status) => {
  vi.mocked(simulateFile).mockRejectedValue(new SimulateDesignError('no-motor', 'No motor.'));
  const response = await worker.fetch(new Request(`http://local${path}`, { method, body: method === 'POST' ? 'x' : undefined }), undefined, ctx);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ appVersion: 'sentinel-app-version',
    engine: { appVersion: 'sentinel-app-version' },
    catalogue: { motorsGenerated: 'sentinel-motors-snapshot', curvesGenerated: 'sentinel-curves-snapshot' } });
});

/** Every production module of the Worker: not a test, not test support. */
const productionModules = (root = new URL('.', import.meta.url)) => readdirSync(root, { recursive: true, encoding: 'utf8' })
  .map(name => name.replace(/\\/g, '/'))
  .filter(name => /\.[cm]?[jt]sx?$/.test(name) && !/\.(?:test|testSupport)\.[cm]?[jt]sx?$/.test(name));
const RESPONSE_BUILDER = /Response\.json\(|new Response\(|Response\.redirect\(|Response\.error\(/g;

it('scans nested modules of every source extension and excludes tests and support', () => {
  const root = mkdtempSync(join(tmpdir(), 'stamp-modules-'));
  const modules = ['index.ts', ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map(ext => 'routes/nested/route.' + ext)];
  try {
    mkdirSync(join(root, 'routes/nested'), { recursive: true });
    for (const name of [...modules, 'routes/nested/route.test.mts', 'routes/nested/route.testSupport.js', 'routes/readme.md']) {
      writeFileSync(join(root, name), 'new Response();', 'utf8');
    }
    expect(productionModules(pathToFileURL(root + '/')).sort()).toEqual(modules.sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('builds every Worker response through the stamped helper', () => {
  // A later route, error or module that builds its own Response would ship unstamped.
  const modules = productionModules();
  expect(modules).toContain('index.ts');
  expect(modules).toContain('stamp.ts');
  for (const name of modules) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    const builders = source.match(RESPONSE_BUILDER) ?? [];
    if (name === 'stamp.ts') expect(builders, name).toEqual(['Response.json(']);
    else expect(builders, name).toEqual([]);
  }
});

it('/health is its own keys, then the stamp, byte for byte', async () => {
  const response = await worker.fetch(new Request('http://local/health'), undefined, ctx);
  expect(await response.text()).toBe('{"ok":true,"api":"s1","appVersion":"sentinel-app-version",'
    + '"engine":{"openRocket":"24.12","appVersion":"sentinel-app-version"},'
    + '"catalogue":{"motorsGenerated":"sentinel-motors-snapshot","curvesGenerated":"sentinel-curves-snapshot"}}');
});

it('an error body is `error` first, then the stamp, byte for byte', async () => {
  const response = await worker.fetch(new Request('http://local/unknown'), undefined, ctx);
  expect(await response.text()).toBe('{"error":{"code":"NOT_FOUND","message":"Unknown endpoint."},'
    + '"appVersion":"sentinel-app-version","engine":{"openRocket":"24.12","appVersion":"sentinel-app-version"},'
    + '"catalogue":{"motorsGenerated":"sentinel-motors-snapshot","curvesGenerated":"sentinel-curves-snapshot"}}');
});
