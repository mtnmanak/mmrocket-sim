import { describe, expect, it } from 'vitest';
import { normalizeFlightAdvisories } from './flightAdvisories.js';

describe('optional flight advice preferences (N007/N010)', () => {
  it('keeps valid SI limits, including zero AGL and a zero band', () => {
    expect(normalizeFlightAdvisories({ maxAirspeedMs: 100, maxMach: 0.8,
      armingAltitudeM: 0, armingCautionBandM: 0 })).toEqual({ maxAirspeedMs: 100,
      maxMach: 0.8, armingAltitudeM: 0, armingCautionBandM: 0 });
  });
  it.each([null, [], 5, '100', undefined])('drops malformed shapes %j', value => {
    expect(normalizeFlightAdvisories(value)).toBeUndefined();
  });
  it('drops invalid fields independently and leaves old stores off', () => {
    expect(normalizeFlightAdvisories({ maxAirspeedMs: '100', maxMach: Infinity,
      armingAltitudeM: -1, armingCautionBandM: NaN })).toBeUndefined();
    expect(normalizeFlightAdvisories({ maxAirspeedMs: 0, maxMach: 1,
      armingAltitudeM: 100, armingCautionBandM: -2, extra: 5 })).toEqual({ maxMach: 1, armingAltitudeM: 100 });
  });
});
