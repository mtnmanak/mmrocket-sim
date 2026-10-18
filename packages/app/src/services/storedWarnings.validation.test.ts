import { expect, it } from 'vitest';
import type { EngineWarning } from '@online-openrocket/engine';
import { boundedWarningEvidence, MAX_STORED_WARNINGS, restoredWarnings, storedWarnings } from './storedWarnings.js';
import { formatWarning } from './simWarnings.js';

it('S7a-4 drops malformed warning keys and messages while retaining valid evidence', () => {
  const good = { key: 'LargeAOA', message: 'kept' };
  const warnings = [null, [], {}, { key: 1 }, { key: 'LargeAOA', message: {} }, good,
    { key: 'Other' }] as unknown as EngineWarning[];
  expect(storedWarnings(warnings)).toEqual([good, { key: 'Other' }]);
  expect(storedWarnings([good])?.[0]).toBe(good);
});

it('bounds restored evidence while preserving stop and HIGH signals', () => {
  const warnings = Array.from({ length: MAX_STORED_WARNINGS + 1 }, () => ({ key: 'Joint', message: 'Gap' }));
  const critical = [{ key: 'SIM_ABORT' }, { key: 'Danger', message: 'Unsafe', priority: 'HIGH' as const }];
  const all = [...warnings, ...critical] as EngineWarning[];
  expect(storedWarnings(all)).toBe(all);
  expect(restoredWarnings(all)).toEqual([
    { key: 'SIM_ABORT', message: '' }, critical[1], expect.objectContaining({ key: 'StoredWarningsUnavailable' }),
  ]);
  expect(restoredWarnings([{ key: 'SIM_ABORT' } as EngineWarning])).toEqual([{ key: 'SIM_ABORT' }]);
});

it('S7a-4 formats a malformed message safely even before hydration', () => {
  expect(() => formatWarning({ key: 'LargeAOA', message: {} } as EngineWarning)).not.toThrow();
});

it('bounds critical fallback output and keeps a late stop signal', () => {
  const warnings: EngineWarning[] = Array.from({ length: MAX_STORED_WARNINGS + 1 }, (_, i) => ({
    key: 'Danger', message: 'Unsafe ' + i, priority: 'HIGH',
  }));
  warnings.push({ key: 'SIM_ABORT', message: 'Stopped' });
  const recovered = restoredWarnings(warnings)!;
  expect(recovered).toHaveLength(MAX_STORED_WARNINGS);
  expect(recovered[0]).toEqual({ key: 'SIM_ABORT', message: 'Stopped' });
  expect(recovered.at(-1)!.key).toBe('StoredWarningsUnavailable');
  expect(boundedWarningEvidence(recovered)).toBe(true);
  expect(restoredWarnings(recovered)).toBe(recovered);
});
