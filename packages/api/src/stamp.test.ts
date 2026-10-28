import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { worker } from './index.js';
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

it('builds every Worker response through the stamped helper', () => {
  // A later route or error that builds its own Response would ship unstamped.
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/Response\.json\(|new Response\(/);
});
