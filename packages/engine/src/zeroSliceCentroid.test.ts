import { describe, expect, it } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketTree } from './orkEngine.js';

// OR #3161 / PR #3202 (engine-java/patches/LEDGER.md, tumble release T1): SymmetricComponent
// integrates a shape in 128 slices and divided each slice's first moment by its material volume
// dV. A slice with NO material gave 0/0 = NaN, and that NaN became the whole component's CG and
// longitudinal inertia - then the rocket's - and the flight threw "Simulation resulted in
// not-a-number (NaN) value for structureMass.getCenterOfMass()". The fix gives an empty slice the
// midpoint centroid (it carries no moment either way), and ONLY an exactly empty one.
//
// Its guards were JUnit only (ZeroSliceCentroidTest, `gradlew test`), which neither `npm test`
// nor the deploy gate runs. This is the same reproducer - upstream's Banshee Mk2 tail - through
// the shipped bridge: a flipped POWER nose cone with shape parameter 0, 1 mm long, 11 mm radius,
// 2 mm wall. POWER with parameter 0 has radius 0 for x <= 1e-5 m, so its last slice is empty.

const LEN = 0.001;
const RAD = 0.011;
const WALL = 0.002;
const RHO = 1000;

const tree: RocketTree = {
  name: 'Banshee zero slice',
  components: [
    { type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
          motorMount: true, position: { method: 'bottom', offset: 0 } },
        { type: 'parachute', diameter: 0.3, deployEvent: 'ejection', deployDelay: 0 },
        {
          type: 'podset', instanceCount: 1, radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0,
          position: { method: 'bottom', offset: 0 },
          children: [
            { type: 'nosecone', shape: 'haack', shapeParameter: 0, length: 0.15, aftRadius: RAD, thickness: 0.002 },
            { type: 'nosecone', id: 'tail', shape: 'power', shapeParameter: 0, length: LEN, aftRadius: RAD,
              thickness: WALL, density: RHO, flipped: true },
          ],
        },
      ],
    },
  ],
} as unknown as RocketTree;

const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};

describe('a zero-material slice keeps a finite centroid (OR #3161)', () => {
  it('the tail cone has its analytic volume and a CG inside its length', () => {
    const tail = OrkRocket.buildTree(tree).componentInfo('tail');
    // 128 slices of l: 126 hollow cylinders (R, R - wall), one solid cone R -> 0, one empty slice.
    const l = LEN / 128;
    const cyl = Math.PI * (RAD ** 2 - (RAD - WALL) ** 2) * 126 * l;
    const cone = Math.PI * RAD ** 2 * l / 3;
    expect(Math.abs(tail.mass / (RHO * (cyl + cone)) - 1), 'tail mass = density x volume').toBeLessThan(1e-9);
    expect(Number.isFinite(tail.cgX), `tail CG ${tail.cgX}`).toBe(true);
    expect(tail.cgX).toBeGreaterThanOrEqual(0);
    expect(tail.cgX).toBeLessThanOrEqual(LEN);
    // The true first moment; the kernel takes a tiny slice's centroid at its midpoint, which can
    // only be off by the cone's share of a quarter slice.
    const trueCG = (cyl * 63 * l + cone * (126 * l + l / 4)) / (cyl + cone);
    expect(Math.abs(tail.cgX - trueCG)).toBeLessThanOrEqual((cone / (cyl + cone)) * (l / 4) + 1e-12);
  });

  it('the assembled rocket has a finite CG and inertia, and flies to apogee without an abort', () => {
    const r = OrkRocket.buildTree(tree);
    const info = r.staticInfo();
    for (const [k, v] of Object.entries({ cg: info.cg, cgEmpty: info.cgEmpty, mass: info.mass,
      pitch: info.longitudinalInertia, roll: info.rotationalInertia })) {
      expect(Number.isFinite(v), `${k} = ${v}`).toBe(true);
    }
    r.setMotorById('mount', C6);
    const res = r.simulate({ launchRodLength: 1 });
    expect(res.events.some((e) => e.type === 'SIM_ABORT'), 'aborted').toBe(false);
    expect(res.events.some((e) => e.type === 'APOGEE'), 'reached apogee').toBe(true);
    expect(res.summary.maxAltitude).toBeGreaterThan(10);
    expect(res.series.cgLocation.every((x) => x === null || Number.isFinite(x))).toBe(true);
  }, 60_000);
});
