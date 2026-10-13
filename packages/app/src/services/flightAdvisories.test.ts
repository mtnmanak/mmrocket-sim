import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { groundWindAdvice, zeroDelayRecoveryAdvice, peakAirspeed } from './flightAdvisories.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';

const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
  { type: 'bodytube', id: 'mount' },
  { type: 'parachute', id: 'chute', name: 'Main', deployEvent: 'ejection' },
  { type: 'podset', id: 'pod', children: [{ type: 'innertube', id: 'pod-mount' }] },
] }] };

describe('zero-delay advice at selection (N003)', () => {
  it('names recovery in the same assembly and the burnout consequence', () => {
    expect(zeroDelayRecoveryAdvice(tree, 'mount', 0)).toContain('Main');
    expect(zeroDelayRecoveryAdvice(tree, 'mount', 0)).toContain('burnout');
  });
  it('does not warn for staging, another assembly, electronics, plugged or Auto', () => {
    expect(zeroDelayRecoveryAdvice(tree, 'pod-mount', 0)).toBeNull();
    expect(zeroDelayRecoveryAdvice(tree, 'mount', Infinity)).toBeNull();
    expect(zeroDelayRecoveryAdvice(tree, 'mount', 5)).toBeNull();
    expect(zeroDelayRecoveryAdvice(tree, 'mount', 0, true)).toBeNull();
    for (const event of ['apogee', 'altitude', 'never', 'APOGEE', 'Altitude']) {
      const electronic = structuredClone(tree);
      electronic.components[0]!.children![1]!.deployEvent = event;
      expect(zeroDelayRecoveryAdvice(electronic, 'mount', 0)).toBeNull();
    }
    const staged = structuredClone(tree);
    staged.components.push({ type: 'stage', id: 'booster', children: [{ type: 'innertube', id: 'booster-mount' }] });
    expect(zeroDelayRecoveryAdvice(staged, 'booster-mount', 0)).toBeNull();
  });
  it('uses the bridge fallback for unknown recovery events', () => {
    const unknown = structuredClone(tree);
    unknown.components[0]!.children![1]!['deployEvent'] = 'lowerstageseparation';
    expect(zeroDelayRecoveryAdvice(unknown, 'mount', 0)).toContain('burnout');
  });
  it('does not confuse a delayed recovery event with immediate opening', () => {
    const delayed = structuredClone(tree);
    delayed.components[0]!.children![1]!.deployDelay = 3;
    expect(zeroDelayRecoveryAdvice(delayed, 'mount', 0)).toContain('3 s');
  });
});

describe('surface-wind advice (N004)', () => {
  it('warns strictly above 20 mph (8.9408 m/s) with units and code scope', () => {
    expect(groundWindAdvice(8.9408, INITIAL_UNITS)).toBeNull();
    const advice = groundWindAdvice(8.94081, IMPERIAL_UNITS);
    expect(advice).toContain('20 mph');
    expect(advice).toContain('Tripoli');
    expect(advice).toContain('surface');
    expect(groundWindAdvice(NaN, INITIAL_UNITS)).toBeNull();
  });
});

it('N007 uses Mach times local sound speed, never ground speed; gaps stay unknown', () => {
  expect(peakAirspeed({ time: [0, 1], mach: [0.1, 0.5], Vs: [340, 330], velocity: [999, 999] })).toEqual({ value: 165, complete: true });
  expect(peakAirspeed({ time: [0, 1], mach: [0.1, 0.5], Vs: [340, null] })).toEqual({ value: 34, complete: false });
  expect(peakAirspeed({ time: [0], mach: [0.1] })).toEqual({ value: null, complete: false });
});
