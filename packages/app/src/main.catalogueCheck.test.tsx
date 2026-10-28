// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { CATALOGUE_BASE } from './services/catalogueClient.js';
import { MOTOR_DB, MOTOR_DB_DATE } from './services/motorDb.js';
import { catalogueFetch, daysAfter, manifestOf, publication } from './services/catalogueFixture.testSupport.js';

/**
 * The entry point starts the automatic catalogue check (row 110) exactly once
 * a page, and it asks nothing until App's restore of the stored overlay has
 * run — which, as under StrictMode, may run twice. The other main.*.test.tsx
 * files mount no App, so their restore never runs and they make no catalogue
 * request; each says so.
 */
vi.mock('virtual:pwa-register', () => ({ registerSW: () => async () => {} }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: () => {} }) }));
vi.mock('./root.js', () => ({ AppRoot: () => null }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); localStorage.clear(); });

it('starts the check once: nothing before the restore, one manifest request after two restores', async () => {
  vi.resetModules();
  localStorage.clear();
  const pub = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.2`, MOTOR_DB);
  const fetcher = vi.fn(catalogueFetch(manifestOf(pub), [pub]));
  vi.stubGlobal('fetch', fetcher);
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  try {
    await import('./main.js');
    await new Promise(r => setTimeout(r, 20));
    expect(fetcher).not.toHaveBeenCalled();
    // App's mount effect, twice — as StrictMode runs it in development.
    const { restoreCatalogueOverlay } = await import('./services/catalogueOverlay.js');
    restoreCatalogueOverlay();
    restoreCatalogueOverlay();
    await vi.waitFor(() => expect(fetcher.mock.calls.map(c => String(c[0]))).toContain(`${CATALOGUE_BASE}${pub.entry.motors.path}`));
    await new Promise(r => setTimeout(r, 20));
    expect(fetcher.mock.calls.filter(c => String(c[0]) === `${CATALOGUE_BASE}manifest.json`)).toHaveLength(1);
    // And again from anywhere else, it does not start a second time.
    const { startCatalogueAutoCheck } = await import('./services/catalogueAutoCheck.js');
    expect(await startCatalogueAutoCheck()).toBe('already-started');
  } finally {
    root.remove();
  }
});
