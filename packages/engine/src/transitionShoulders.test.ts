import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode } from './orkEngine.js';

// K15: requires rebuilding the Java bridge into vendor/orkengine.mjs.
// Intentionally active: the stale kernel must fail, never silently skip this gate.
const density = 680;
const radius = 0.0145;
const length = 0.03;
const thickness = 0.002;
const mass = (extra: Partial<ComponentNode>) => OrkRocket.buildTree({
  name: 'K15', components: [{ type: 'transition', length: 0.08, shape: 'conical',
    foreRadius: 0.025, aftRadius: 0.015, thickness: 0.001, density, ...extra }],
}).staticInfo().mass;

describe('K15 shoulder mass after the kernel rebuild', () => {
  for (const side of ['fore', 'aft']) {
    it.each([false, true])(`${side} 30 mm shoulder adds its analytic mass (capped: %s)`, (capped) => {
      const geometry = { [`${side}ShoulderRadius`]: radius, [`${side}ShoulderLength`]: length,
        [`${side}ShoulderCapped`]: capped };
      const baseline = mass(geometry);
      const withWall = mass({ ...geometry, [`${side}ShoulderThickness`]: thickness });
      const inner = radius - thickness;
      const ringVolume = Math.PI * (radius ** 2 - inner ** 2) * length;
      const capVolume = capped ? Math.PI * inner ** 2 * thickness : 0;
      const expected = (ringVolume + capVolume) * density;
      expect(withWall).toBeGreaterThan(baseline);
      expect(Math.abs((withWall - baseline) - expected) / expected).toBeLessThan(1e-6);
    });

    it(`${side} omitted thickness stays identical to explicit zero, even capped`, () => {
      const geometry = { [`${side}ShoulderRadius`]: radius, [`${side}ShoulderLength`]: length,
        [`${side}ShoulderCapped`]: true };
      expect(mass(geometry)).toBe(mass({ ...geometry, [`${side}ShoulderThickness`]: 0 }));
    });
  }
});
