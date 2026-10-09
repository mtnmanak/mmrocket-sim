import { afterEach, describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, setEngineLengthUnit, type RocketTree } from './orkEngine.js';

// Requires rebuilding the Java bridge into vendor/orkengine.mjs (OrkEngine.setLengthUnit).
//
// THE AIRFRAME-STEP WARNING ROUNDS IN THE USER'S UNIT. The kernel decides a
// diameter discontinuity by comparing the two diameters as display strings in
// UnitGroup.UNITS_LENGTH's default unit (BarrowmanCalculator), as desktop does in
// its own. The engine started in cm and the app never changed it, so an inch user
// on a 4 in airframe was warned only at a step several times larger than desktop
// set to inches warns at (openrocket/openrocket#3285).
const tree = (stepM: number): RocketTree => ({
  name: 'Step',
  components: [{
    type: 'stage', id: 's', name: 'Sustainer', children: [
      { type: 'nosecone', id: 'n', name: 'Nose', length: 0.3, aftRadius: 0.0508 - stepM / 2, thickness: 0.002, shape: 'ogive' },
      { type: 'bodytube', id: 'b', name: 'Tube', length: 0.8, outerRadius: 0.0508, thickness: 0.001 },
    ],
  }],
} as unknown as RocketTree);

const discontinuities = (stepM: number): number => {
  const info = OrkRocket.buildTree(tree(stepM)).staticInfo();
  resetEngine();
  return info.warningTexts.filter((t) => /DISCONTINUITY/.test(t)).length;
};

describe('airframe-step warning unit', () => {
  afterEach(() => setEngineLengthUnit('cm'));

  it('warns an inch user at a 0.03 mm step on a 4 in airframe, as desktop in inches does', () => {
    setEngineLengthUnit('cm');
    expect(discontinuities(0.00003)).toBe(0);
    setEngineLengthUnit('in');
    expect(discontinuities(0.00003)).toBe(1);
  });

  it('rounds mm as cm does, so a metric user sees no change', () => {
    for (const step of [0.00003, 0.0002, 0.002]) {
      setEngineLengthUnit('cm');
      const cm = discontinuities(step);
      setEngineLengthUnit('mm');
      expect(discontinuities(step), `step ${step} m`).toBe(cm);
    }
  });

  it('ignores an unknown unit', () => {
    setEngineLengthUnit('in');
    setEngineLengthUnit('furlong');
    expect(discontinuities(0.00003)).toBe(1);
  });
});
