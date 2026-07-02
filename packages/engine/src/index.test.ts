import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, G0, ISA_SEA_LEVEL } from './index.js';

describe('engine package', () => {
  it('exports engine version', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('uses SI constants', () => {
    expect(G0).toBeCloseTo(9.80665);
    expect(ISA_SEA_LEVEL.temperatureK).toBeCloseTo(288.15);
    expect(ISA_SEA_LEVEL.pressurePa).toBe(101325);
  });
});
