import { describe, expect, it } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketSpec } from './orkEngine.js';

/**
 * Reference rocket + C6-class motor — the same design as engine-java's
 * golden harness. Expected values are the JVM golden outputs
 * (engine-java difftest); tolerances cover accumulated JS-Math ULP drift.
 */
const REFERENCE_ROCKET: RocketSpec = {
  noseCone: { length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
  bodyTube: { length: 0.3, outerRadius: 0.012, thickness: 0.0003, materialDensity: 950 },
  fins: { count: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
  motorMount: { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 },
  parachute: { diameter: 0.3 },
};

const C6_MOTOR: MotorSpec = {
  designation: 'C6',
  diameter: 0.018,
  length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035,
  ejectionDelay: 5.0,
};

describe('OrkRocket (real OpenRocket kernel via TeaVM)', () => {
  it('computes static info matching the JVM goldens', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const info = rocket.staticInfo();

    expect(info.length).toBeCloseTo(0.37, 12);
    expect(info.mass).toBeCloseTo(0.051335792158092, 9);
    expect(info.cg).toBeCloseTo(0.2594577950655922, 9);
    expect(info.cp).toBeCloseTo(0.29101225022147875, 9);
    expect(info.stabilityCalibers).toBeGreaterThan(1.0); // stable design
    expect(info.warnings).toBe(0);
  });

  it('flies the full C6 flight matching the JVM goldens', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });

    // JVM goldens: 331.76687245462836 m apogee, 116.16566819089638 m/s, etc.
    expect(result.summary.maxAltitude).toBeCloseTo(331.766872454628, 6);
    expect(result.summary.maxVelocity).toBeCloseTo(116.165668190896, 6);
    expect(result.summary.maxAcceleration).toBeCloseTo(227.494097892678, 6);
    expect(result.summary.timeToApogee).toBeCloseTo(6.848273507164, 6);
    expect(result.summary.groundHitVelocity).toBeCloseTo(3.385373780151, 6);

    const types = result.events.map((e) => e.type);
    expect(types).toEqual([
      'LAUNCH', 'IGNITION', 'LIFTOFF', 'LAUNCHROD', 'BURNOUT',
      'APOGEE', 'EJECTION_CHARGE', 'RECOVERY_DEVICE_DEPLOYMENT',
      'GROUND_HIT', 'SIMULATION_END',
    ]);

    expect(result.series.time.length).toBe(721);
    expect(result.series.altitude.length).toBe(721);
    // Monotonic time, sane altitude bounds.
    for (let i = 1; i < result.series.time.length; i++) {
      expect(result.series.time[i]!).toBeGreaterThanOrEqual(result.series.time[i - 1]!);
    }
    expect(Math.max(...result.series.altitude)).toBeCloseTo(result.summary.maxAltitude, 9);
  });

  it('builds arbitrary component trees with identical physics (P2.1)', () => {
    const rocket = OrkRocket.buildTree({
      name: 'Ref',
      components: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
        {
          type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
            { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
            { type: 'parachute', diameter: 0.3 },
          ],
        },
      ],
    });
    rocket.setMotorById('mount', C6_MOTOR);

    const info = rocket.staticInfo();
    expect(info.mass).toBeCloseTo(0.051335792158092, 9); // same as fixed-shape build
    expect(info.warningTexts).toEqual([]);

    const result = rocket.simulate({});
    expect(result.summary.maxAltitude).toBeCloseTo(331.766872454628, 5);
  });

  it('supports the extended component set (transition, rings, streamer, ...)', () => {
    const rocket = OrkRocket.buildTree({
      components: [
        { type: 'nosecone', length: 0.1, aftRadius: 0.0125, thickness: 0.002, shape: 'haack' },
        {
          type: 'bodytube', length: 0.35, outerRadius: 0.0125, thickness: 0.0005, density: 950,
          children: [
            { type: 'ellipticalfinset', finCount: 4, rootChord: 0.06, height: 0.04, thickness: 0.003 },
            { type: 'launchlug', length: 0.05, outerRadius: 0.0025, thickness: 0.0004, position: { method: 'middle', offset: 0 } },
            { type: 'innertube', id: 'mount', length: 0.08, outerRadius: 0.012, thickness: 0.0005, motorMount: true },
            { type: 'centeringring', length: 0.002, position: { method: 'bottom', offset: -0.01 } },
            { type: 'streamer', stripLength: 0.6, stripWidth: 0.05, position: { method: 'top', offset: 0.02 } },
            { type: 'shockcord', cordLength: 0.4, position: { method: 'top', offset: 0.01 } },
            { type: 'masscomponent', mass: 0.015, length: 0.02, radius: 0.006, position: { method: 'top', offset: 0.05 } },
          ],
        },
        { type: 'transition', length: 0.04, foreRadius: 0.0125, aftRadius: 0.009, thickness: 0.001, shape: 'conical', density: 680 },
      ],
    });
    const info = rocket.staticInfo();
    expect(info.length).toBeCloseTo(0.49, 9);
    expect(info.mass).toBeGreaterThan(0.05);
    expect(Number.isFinite(info.cp)).toBe(true);
  });

  it('rejects unknown component types with a clear message', () => {
    expect(() =>
      OrkRocket.buildTree({ components: [{ type: 'warpdrive' as never }] }),
    ).toThrow(/Unknown component type/);
  });

  it('reports unstable designs via warnings/behavior rather than crashing', () => {
    const noFins: RocketSpec = { ...REFERENCE_ROCKET, fins: { ...REFERENCE_ROCKET.fins, count: 3, height: 0.001 } };
    const rocket = OrkRocket.build(noFins);
    rocket.setMotor(C6_MOTOR);
    const info = rocket.staticInfo();
    expect(info.stabilityCalibers).toBeLessThan(1.0);
  });
});
