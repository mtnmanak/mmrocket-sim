import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { groundWindAdvice, zeroDelayRecoveryAdvice, peakAirspeed, flightLimitAdvice } from './flightAdvisories.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import type { FlightResult } from '@online-openrocket/engine';

it.each([
  [INITIAL_UNITS, '8.95 m/s (29.364 ft/s)'],
  [IMPERIAL_UNITS, '20.021 mph (8.95 m/s)'],
] as const)('keeps wind and limit precision consistent in both systems (%j)', (units, text) => {
  expect(groundWindAdvice(8.95, units)).toContain(`average ${text} exceeds`);
});

it('keeps personal-limit comparisons distinct in the units actually rendered', () => {
  const result = { summary: { maxAltitude: 999, maxMachNumber: 0 }, series: { time: [0], mach: [1], Vs: [100.24 * 0.3048] },
    events: [{ type: 'APOGEE', time: 0 }] } as unknown as FlightResult;
  const notes = flightLimitAdvice(result, { maxAirspeedMs: 100.16 * 0.3048, armingAltitudeM: 1000 }, 'Test', undefined,
    { ...IMPERIAL_UNITS, altitude: 'km' });
  expect(notes[0]!.text).toContain('100.24 ft/s (30.6 m/s) exceeded your maximum of 100.16 ft/s (30.5 m/s)');
  expect(notes[1]!.text).toContain('0.999 km (3,277.6 ft) AGL is below');
  expect(notes[1]!.text).toContain('arming 1 km [3,280.8 ft]');
  result.summary.maxAltitude = 1040;
  const band = flightLimitAdvice(result, { armingAltitudeM: 1000, armingCautionBandM: 50 }, 'Test', undefined,
    { ...INITIAL_UNITS, altitude: 'km' });
  expect(band[0]!.text).toContain('1.04 km');
  result.summary.maxAltitude = 10.049;
  const roundedFeet = flightLimitAdvice(result, { armingAltitudeM: 10.051 }, 'Test', undefined, INITIAL_UNITS);
  expect(roundedFeet[0]!.text).toContain('10.049 m (33 ft)');
  expect(roundedFeet[0]!.text).toContain('arming 10.051 m [33 ft]');
});

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
  it.each(['ft/s', 'kt'])('keeps the defining 20 mph when wind is displayed in %s', windspeed => {
    const advice = groundWindAdvice(10, { ...IMPERIAL_UNITS, windspeed });
    expect(advice).toContain('20 mph');
    expect(advice).toContain('m/s)');
  });
  it.each([
    [INITIAL_UNITS, '10 m/s (32.808 ft/s)', '8.941 m/s (29.333 ft/s) (defined as 20 mph)'],
    [IMPERIAL_UNITS, '22.369 mph (10 m/s)', '20 mph (8.941 m/s)'],
  ] as const)('pairs the measured wind and the exact defining limit (%j)', (units, actual, limit) => {
    expect(groundWindAdvice(10, units)).toContain(`average ${actual} exceeds ${limit}`);
  });
  it('warns strictly above 20 mph (8.9408 m/s) with units and code scope', () => {
    expect(groundWindAdvice(8.9408, INITIAL_UNITS)).toBeNull();
    const advice = groundWindAdvice(8.94081, IMPERIAL_UNITS);
    expect(advice).toContain('20 mph');
    expect(advice).toContain('Tripoli');
    expect(advice).toContain('surface');
    expect(groundWindAdvice(NaN, INITIAL_UNITS)).toBeNull();
  });
  it.each([8.95, 8.94081, 8.940800000001])('does not round an above-limit wind %s down to the limit', (wind) => {
    const advice = groundWindAdvice(wind, IMPERIAL_UNITS)!;
    if (wind === 8.95) expect(advice).toContain('average 20.021 mph');
    else expect(advice).toContain('is just above 20 mph');
    expect(advice).not.toContain('average 20.0 mph exceeds 20 mph');
  });
});

it('N007 uses Mach times local sound speed, never ground speed; gaps stay unknown', () => {
  expect(peakAirspeed({ time: [0, 1], mach: [0.1, 0.5], Vs: [340, 330], velocity: [999, 999] })).toEqual({ value: 165, complete: true });
  expect(peakAirspeed({ time: [0, 1], mach: [0.1, 0.5], Vs: [340, null] })).toEqual({ value: 34, complete: false });
  expect(peakAirspeed({ time: [0], mach: [0.1] })).toEqual({ value: null, complete: false });
});
