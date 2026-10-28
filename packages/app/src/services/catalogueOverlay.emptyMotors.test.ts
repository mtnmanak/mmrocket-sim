// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { catalogueFetch, daysAfter, manifestOf, publication } from './catalogueFixture.testSupport.js';

/**
 * H1: readSnapshotMotors refuses a motors file with no rows. The manifest
 * check already refuses a count of 0 (catalogueClient.test.ts), so this file
 * mocks the manifest read to let one through and reach the motors file's own
 * check. Its own file: the mock needs a fresh module registry.
 */

afterEach(() => { vi.doUnmock('./catalogueClient.js'); vi.resetModules(); localStorage.clear(); });

async function check(motors: object[], count: number): Promise<unknown> {
  vi.resetModules();
  vi.doMock('./catalogueClient.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./catalogueClient.js')>();
    return { ...real, fetchCatalogueManifest: async (opts: Parameters<typeof real.fetchCatalogueManifest>[0]) => {
      const current = await real.fetchCatalogueManifest(opts);
      return { ...current, motors: { ...current.motors, count } };
    } };
  });
  const { MOTOR_DB, MOTOR_DB_DATE } = await import('./motorDb.js');
  const overlay = await import('./catalogueOverlay.js');
  const generated = daysAfter(MOTOR_DB_DATE, 1);
  const row = { ...MOTOR_DB[0]!, motorId: 'h1-new' };
  const rows = motors.length ? [row] : [];
  // The manifest is published for one row (a valid count); the mock above
  // then hands the check the count the motors file states.
  const pub = await publication(`${generated}.2`, [row], {}, { motorsDoc: { generated, count: rows.length, motors: rows } });
  return overlay.checkForCatalogueUpdates({ force: true, fetchImpl: catalogueFetch(manifestOf(pub), [pub]) });
}

it('refuses an empty motors file even where a manifest let a count of 0 through', async () => {
  await expect(check([], 0)).rejects.toThrow(/motors file does not hold the number of motors it states/);
  expect(localStorage.length).toBe(0);
});

it('positive control: the same path with one row installs it', async () => {
  const result = await check([{}], 1) as { overlay: { added: { motorId: string }[] } };
  expect(result.overlay.added.map(m => m.motorId)).toEqual(['h1-new']);
});
