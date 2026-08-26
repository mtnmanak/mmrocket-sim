import { describe, expect, it } from 'vitest';
import { boosterBranches, DEFAULT_TIME_STEP_S, ENGINE_VERSION, G0, ISA_SEA_LEVEL, type FlightBranch, type FlightResult } from './index.js';

describe('engine package', () => {
  it('exports engine version', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('uses SI constants', () => {
    expect(G0).toBeCloseTo(9.80665);
    expect(ISA_SEA_LEVEL.temperatureK).toBeCloseTo(288.15);
    expect(ISA_SEA_LEVEL.pressurePa).toBe(101325);
  });

  it('exports the default time step (0.05 s, desktop parity)', () => {
    // The app's clamp, caution copy and session migration all derive from
    // this — a retune here is a product decision, not a refactor.
    expect(DEFAULT_TIME_STEP_S).toBe(0.05);
  });
});

describe('boosterBranches', () => {
  const branch = (name: string): FlightBranch =>
    ({ name, events: [], series: {} as FlightBranch['series'] });

  it('skips branch 0 — it duplicates the top-level events/series', () => {
    const result = {
      branches: [branch('Sustainer'), branch('Booster'), branch('Booster 2')],
    } as FlightResult;
    expect(boosterBranches(result).map((b) => b.name)).toEqual(['Booster', 'Booster 2']);
  });

  it('a single-branch (unstaged) flight has no boosters', () => {
    expect(boosterBranches({} as FlightResult)).toEqual([]);
    expect(boosterBranches({ branches: [branch('Sustainer')] } as FlightResult)).toEqual([]);
  });
});
