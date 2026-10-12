import { expect, it } from 'vitest';
import type { EngineWarning } from '@online-openrocket/engine';
import { storedWarnings } from './storedWarnings.js';
import { formatWarning } from './simWarnings.js';

it('S7a-4 drops malformed warning keys and messages while retaining valid evidence', () => {
  const good = { key: 'LargeAOA', message: 'kept' };
  const warnings = [null, [], {}, { key: 1 }, { key: 'LargeAOA', message: {} }, good,
    { key: 'Other' }] as unknown as EngineWarning[];
  expect(storedWarnings(warnings)).toEqual([good, { key: 'Other' }]);
  expect(storedWarnings([good])?.[0]).toBe(good);
});

it('S7a-4 formats a malformed message safely even before hydration', () => {
  expect(() => formatWarning({ key: 'LargeAOA', message: {} } as EngineWarning)).not.toThrow();
});
