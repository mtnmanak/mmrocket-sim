import { describe, expect, it } from 'vitest';
import { MOTOR_DB, findDbMotor } from './motorDb.js';
import {
  bundledSimFiles, fetchMotorSpec, headerMasses, pickSampleFile, type TcMotor, type TcSimFile,
} from './thrustcurve.js';

/**
 * The shipped thrust-curve bundle (src/data/motorCurves.json) and the file
 * choice it goes through.
 *
 * Both exist because of the same day (2026-09-05). For two months the only
 * motors that flew offline were three thrust curves written by hand, and the
 * importer preferred them over the real database. Removing them meant the real
 * curves had to ship instead — and measuring the real curves turned up a second
 * fault in how one is chosen from thrustcurve.org's several files per motor.
 */

const ramp = (burn: number, peak: number, n = 8) => Array.from({ length: n }, (_, i) => {
  const t = (burn * i) / (n - 1);
  // A spike then a sustain, roughly the shape of a black-powder curve.
  const f = i === 0 ? 0 : i === n - 1 ? 0 : i === 1 ? peak : peak * 0.35;
  return { time: t, thrust: f };
});

/** The real Estes A8 catalogue figures (motors.json, 2026-09-05). */
const ESTES_A8: TcMotor = {
  motorId: '5f4294d2000231000000000b', manufacturerAbbrev: 'Estes', designation: 'A8',
  commonName: 'A8', impulseClass: 'A', diameter: 18, length: 70,
  avgThrustN: 3.18, maxThrustN: 9.73, totImpulseNs: 2.5, burnTimeS: 0.73,
  totalWeightG: 16.3, propWeightG: 3.3, delays: '0,3,5', availability: 'regular',
};

describe('pickSampleFile — agreement with the catalogue beats point count', () => {
  // The exact shape of the Estes A8 case: thrustcurve.org files the A8-0
  // BOOSTER's curve (0.534 s, no delay) under the same motor record as the
  // A8-3/5 (0.73 s), and the booster file has two more points.
  const booster: TcSimFile = { source: 'cert', format: 'RASP', samples: ramp(0.534, 9.55, 25) };
  const flight: TcSimFile = { source: 'cert', format: 'RASP', samples: ramp(0.73, 9.73, 23) };

  it('picks the file whose burn matches the catalogue, not the longer one', () => {
    expect(pickSampleFile([booster, flight], ESTES_A8)).toBe(flight);
    // Order in the response must not matter.
    expect(pickSampleFile([flight, booster], ESTES_A8)).toBe(flight);
  });

  it('with no catalogue figure to agree with, the old rule stands (richer file wins)', () => {
    expect(pickSampleFile([booster, flight])).toBe(booster);
  });

  it('a certified file beats a user upload of the same loading', () => {
    const user: TcSimFile = { source: 'user', format: 'RASP', samples: ramp(0.73, 11.6, 30) };
    expect(pickSampleFile([user, flight], ESTES_A8)).toBe(flight);
  });

  it('but a user upload that agrees beats a certified file of another loading', () => {
    const user: TcSimFile = { source: 'user', format: 'RockSim', samples: ramp(0.73, 9.7, 24) };
    expect(pickSampleFile([booster, user], ESTES_A8)).toBe(user);
  });

  it('a sound file still beats an out-of-order one whatever else is true', () => {
    const scrambled: TcSimFile = {
      source: 'cert', format: 'RASP',
      samples: [{ time: 0, thrust: 0 }, { time: 0.4, thrust: 9 }, { time: 0.3, thrust: 5 }, { time: 0.73, thrust: 0 }],
    };
    const userSound: TcSimFile = { source: 'user', format: 'RASP', samples: ramp(0.73, 9.7, 12) };
    expect(pickSampleFile([scrambled, userSound], ESTES_A8)).toBe(userSound);
  });
});

describe('the shipped curve bundle', () => {
  it('carries a curve for the great majority of the catalogue', async () => {
    let withCurve = 0;
    for (const m of MOTOR_DB) {
      if ((await bundledSimFiles(m.motorId)).length > 0) withCurve++;
    }
    // 1075 of 1155 on 2026-09-05. The 80 without are motors thrustcurve.org
    // publishes no simulator file for at all (largely out-of-production
    // Gorilla loads and the new Jambol line); they could not fly online either.
    expect(withCurve / MOTOR_DB.length).toBeGreaterThan(0.9);
    expect(MOTOR_DB.length - withCurve).toBeLessThan(120);
  });

  it('returns [] for a motor it does not know, and never throws', async () => {
    expect(await bundledSimFiles('no-such-motor')).toEqual([]);
  });

  it('expands to the same shape a live download has, masses included', async () => {
    const files = await bundledSimFiles(ESTES_A8.motorId);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      expect(typeof f.format).toBe('string');
      expect(f.samples!.every((s) => Number.isFinite(s.time) && Number.isFinite(s.thrust))).toBe(true);
    }
    // At least one A8 file states its own masses, and headerMasses honours the
    // bundled pair exactly as it would the raw header they were read from.
    const withMasses = files.find((f) => f.bundledMasses);
    expect(withMasses).toBeDefined();
    expect(headerMasses(withMasses!)).toEqual(withMasses!.bundledMasses);
  });

  it('flies the Estes C6 with no network, at the certified impulse', async () => {
    const c6 = findDbMotor('C6', 18, undefined, 'Estes')!;
    expect(c6.manufacturerAbbrev).toBe('Estes');
    // No fetch is stubbed and none is reachable from a unit test: this only
    // resolves if the bundle answered.
    const spec = await fetchMotorSpec(c6, 5);
    let impulse = 0;
    for (let i = 1; i < spec.times.length; i++) {
      impulse += ((spec.thrusts[i]! + spec.thrusts[i - 1]!) / 2) * (spec.times[i]! - spec.times[i - 1]!);
    }
    // Certified 8.82 Ns. The hand-written curve this replaced integrated to 10.40.
    expect(impulse).toBeCloseTo(8.8, 1);
    expect(impulse).toBeLessThan(9.2);
    expect(spec.ejectionDelay).toBe(5);
  });

  it('flies the Estes A8 on the flight loading, not the booster', async () => {
    const a8 = findDbMotor('A8', 18, undefined, 'Estes')!;
    const spec = await fetchMotorSpec(a8, 3);
    // 0.73 s is the A8-3/5; the A8-0 booster file ends at 0.534 s and, before
    // pickSampleFile learned to check the catalogue, won on point count.
    expect(spec.times[spec.times.length - 1]).toBeCloseTo(0.73, 2);
  });
});
