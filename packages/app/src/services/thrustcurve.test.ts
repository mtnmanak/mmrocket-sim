import { describe, expect, it } from 'vitest';
import { delayOptions, samplesToMotorSpec, type TcMotor } from './thrustcurve.js';

/** Real thrustcurve.org catalog entry (Quest C6, probed 2026-07-02). */
const QUEST_C6: TcMotor = {
  motorId: '5f4294d20002310000000016',
  manufacturerAbbrev: 'Quest',
  designation: 'C6',
  commonName: 'C6',
  impulseClass: 'C',
  diameter: 18,
  length: 70,
  avgThrustN: 3.45,
  maxThrustN: 15.46,
  totImpulseNs: 8.76,
  burnTimeS: 2.54,
  totalWeightG: 21,
  propWeightG: 12,
  delays: '0,3,5',
  availability: 'regular',
};

const SAMPLES = [
  { time: 0.05, thrust: 3.8 },
  { time: 0.1, thrust: 6.5 },
  { time: 0.15, thrust: 11.75 },
  { time: 0.4, thrust: 4.0 },
  { time: 1.0, thrust: 3.2 },
  { time: 2.0, thrust: 3.0 },
  { time: 2.5, thrust: 0 },
];

describe('thrustcurve transforms', () => {
  it('parses delay options', () => {
    expect(delayOptions(QUEST_C6)).toEqual([0, 3, 5]);
    expect(delayOptions({ ...QUEST_C6, delays: undefined })).toEqual([0]);
  });

  it('builds an SI MotorSpec with an impulse-proportional mass curve', () => {
    const spec = samplesToMotorSpec(QUEST_C6, SAMPLES, 5);

    expect(spec.designation).toBe('C6');
    expect(spec.diameter).toBeCloseTo(0.018, 12); // mm -> m
    expect(spec.length).toBeCloseTo(0.07, 12);
    expect(spec.cgX).toBeCloseTo(0.035, 12); // length/2
    expect(spec.ejectionDelay).toBe(5);

    // t=0 sample prepended.
    expect(spec.times[0]).toBe(0);
    expect(spec.thrusts[0]).toBe(0);
    expect(spec.times.length).toBe(SAMPLES.length + 1);

    // Mass starts at total weight, ends at burnout weight (total - propellant).
    expect(spec.masses[0]).toBeCloseTo(0.021, 12);
    expect(spec.masses[spec.masses.length - 1]!).toBeCloseTo(0.009, 12);

    // Monotonically non-increasing mass.
    for (let i = 1; i < spec.masses.length; i++) {
      expect(spec.masses[i]!).toBeLessThanOrEqual(spec.masses[i - 1]!);
    }
  });

  it('flies through the engine end-to-end', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const rocket = OrkRocket.build({
      noseCone: { length: 0.07, aftRadius: 0.012, thickness: 0.002 },
      bodyTube: { length: 0.3, outerRadius: 0.012, thickness: 0.0003, materialDensity: 950 },
      fins: { count: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
      motorMount: { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 },
      parachute: { diameter: 0.3 },
    });
    rocket.setMotor(samplesToMotorSpec(QUEST_C6, SAMPLES, 5));
    const result = rocket.simulate({});

    expect(result.summary.maxAltitude).toBeGreaterThan(50);
    expect(result.events.map((e) => e.type)).toContain('APOGEE');
    expect(result.events.map((e) => e.type)).toContain('GROUND_HIT');
  });
});
