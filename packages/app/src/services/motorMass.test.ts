import { expect, it } from 'vitest';
import { usableMotorMasses } from './motorMass.js';
import { hasMassData, MOTOR_DB } from './motorDb.js';
import { samplesToMotorSpec } from './thrustcurve.js';
import { screenEntry } from './catalogueOverlay.js';

it('J4 S1c-g3 rejects zero propellant and unbounded weights at every catalogue boundary', () => {
  for (const [totalWeightG, propWeightG] of [[100, 0], [0, 0], [1e307, 10]]) {
    const row = { ...MOTOR_DB[0]!, totalWeightG: totalWeightG!, propWeightG: propWeightG! };
    expect(usableMotorMasses(totalWeightG, propWeightG)).toBe(false);
    expect(hasMassData(row)).toBe(false);
    expect(screenEntry(row)).not.toBeNull();
    expect(() => samplesToMotorSpec(row, [{ time: 0, thrust: 0 }, { time: 0.5, thrust: 10 }, { time: 1, thrust: 0 }], 5)).toThrow();
  }
  expect(hasMassData({ totalWeightG: 100, propWeightG: 100 + Number.EPSILON * 100 })).toBe(true);
});
