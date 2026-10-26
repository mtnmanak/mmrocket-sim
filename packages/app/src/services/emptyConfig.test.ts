import { describe, expect, it } from 'vitest';
import { isLoneEmptyConfig } from './emptyConfig.js';

describe('empty configuration detection', () => {
  const empty = { id: 'c1', name: null, motors: {} };
  it('drops only a configuration with no content or result', () => {
    expect(isLoneEmptyConfig([empty], () => false)).toBe(true);
    expect(isLoneEmptyConfig([empty], () => true)).toBe(false);
  });
  it.each(['stageMassOverrides', 'nozzles', 'deployments', 'separations', 'ignitions'])(
    'keeps a motorless configuration owning %s', family => {
      expect(isLoneEmptyConfig([{ ...empty, [family]: { part: {} } }], () => false)).toBe(false);
    },
  );
});
