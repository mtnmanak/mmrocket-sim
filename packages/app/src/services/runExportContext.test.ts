// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { runExportContext, validRunExportContext } from './runExportContext.js';
import { loadRuns } from './simStore.js';

beforeEach(() => localStorage.clear());

it.each([undefined, []].map(levels => [levels]))('refuses orphan wind provenance when levels are %j', windLevels => {
  const context = runExportContext(DEFAULT_CONDITIONS);
  const damaged = { ...context, launch: { ...context.launch, windLevels, windProfileSource: { kind: 'ork' } } };
  expect(validRunExportContext(damaged)).toBe(false);
});

it('preserves a valid saved context and drops corrupt contexts without dropping their runs', () => {
  const context = runExportContext(DEFAULT_CONDITIONS);
  expect(validRunExportContext(context)).toBe(true);
  const invalid = [null, [], { ...context, launch: {} }, { ...context, weather: {} },
    { ...context, launch: { ...context.launch, windLevels: 'bad' } },
    { ...context, launch: { ...context.launch, geodeticMethod: { toString: null } } }];
  localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([
    { id: 'valid', exportContext: context }, ...invalid.map((exportContext, i) => ({ id: String(i), exportContext })),
  ]));
  const runs = loadRuns();
  expect(runs).toHaveLength(7);
  expect(runs[0]!.exportContext).toEqual(context);
  expect(runs.slice(1).every(r => r.exportContext === undefined)).toBe(true);
});
