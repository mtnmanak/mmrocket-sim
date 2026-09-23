import { describe, expect, it } from 'vitest';
import { KERNEL_WIND_FROM_RAD } from './index.js';
import { OrkRocket, resetEngine, type ComponentNode, type MotorSpec, type RocketTree } from './orkEngine.js';

/**
 * THE ROD'S COMPASS DIRECTION (weather build, step 2: Rod aim).
 *
 * The kernel has always read `rodDirection` (OrkEngine.simulateJson,
 * `JsonLite.dbl(o, "rodDirection", Math.PI / 2)`) — it is in the committed
 * artifact — but the wrapper never sent it, so every flight leaned its rod at
 * π/2: due east, straight into the kernel's fixed east wind
 * (PinkNoiseWindModel's `direction = Math.PI / 2`, "from"). `launchRodDirection`
 * now reaches it. These are the claims the app's Rod aim field rests on, held
 * against the real kernel rather than stated:
 *
 *  - handing the kernel its own default is the same flight, byte for byte — so
 *    the app sending nothing at aim 0 and the kernel's default are one flight;
 *  - the direction genuinely reaches the stepper: a +5° rod aimed downwind
 *    (3π/2) flies as a −5° rod with no direction, which is the physical
 *    identity the Rod aim help quotes ("a negative Rod angle already leans the
 *    rod downwind, the same as adding 180° here"). Close, NOT `===`: the two
 *    build their launch quaternion from different sines and cosines, and the
 *    last bits differ — so it is checked in a steady wind, where a last-bit
 *    difference stays one.
 */

/** The reference C6 and "Chuted" test rocket the app's kernel tests fly (simReport.kernel.test.ts). */
const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};
const CHUTED: RocketTree = {
  name: 'Chuted',
  components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' } as ComponentNode,
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
        { type: 'parachute', diameter: 0.3 } as ComponentNode,
      ],
    } as ComponentNode,
  ],
};

const ROD_5 = (5 * Math.PI) / 180;
const BASE = {
  launchRodLength: 1, windAverage: 4, windStdDeviation: 1, randomSeed: 42, series: 'full' as const,
};

function rocket(): OrkRocket {
  const r = OrkRocket.buildTree(CHUTED);
  r.setMotorById('mount', C6);
  return r;
}

describe('launchRodDirection reaches the kernel', () => {
  it('is the kernel’s own wind direction, π/2 — the value a rod "into the wind" takes', () => {
    expect(KERNEL_WIND_FROM_RAD).toBe(Math.PI / 2);
  });

  it('flies its default, π/2, byte-identically to not sending it', () => {
    resetEngine();
    const r = rocket();
    const o = { ...BASE, launchRodAngle: ROD_5 };
    expect(JSON.stringify(r.simulate({ ...o, launchRodDirection: KERNEL_WIND_FROM_RAD })))
      .toBe(JSON.stringify(r.simulate(o)));
  }, 60000);

  it('flies a +5° rod aimed downwind (3π/2) as a −5° rod — the direction is really used', () => {
    resetEngine();
    const r = rocket();
    // Steady wind (σ 0): the gust model amplifies a last-bit difference in the
    // launch attitude chaotically — at σ 1 the same pair differs by 1.9e-6 in
    // apogee and 4.1e-6 in flight time (measured), which says nothing about
    // whether the direction was used. In a steady 4 m/s wind they agree to
    // 1e-13–4e-12.
    const steady = { ...BASE, windStdDeviation: 0 };
    const downwind = r.simulate({ ...steady, launchRodAngle: ROD_5, launchRodDirection: KERNEL_WIND_FROM_RAD + Math.PI });
    const negative = r.simulate({ ...steady, launchRodAngle: -ROD_5 });
    const intoWind = r.simulate({ ...steady, launchRodAngle: ROD_5 });
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
    for (const k of ['maxAltitude', 'maxVelocity', 'flightTime'] as const) {
      expect(rel(downwind.summary[k], negative.summary[k]), k).toBeLessThan(1e-9);
    }
    // …and it is a different flight from the rod leaning into the wind, so the
    // agreement above is not two ignored options agreeing with each other.
    expect(rel(downwind.summary.maxAltitude, intoWind.summary.maxAltitude)).toBeGreaterThan(1e-3);
  }, 60000);
});
