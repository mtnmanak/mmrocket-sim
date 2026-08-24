import { describe, expect, it } from 'vitest';
import {
  delayOptions, headerMasses, samplesToMotorSpec, repairSamples, pickSampleFile,
  type TcMotor, type TcSample,
} from './thrustcurve.js';

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

/**
 * Damaged thrust curves (issues-2026-08-23a.md, "New issues" #1).
 *
 * A tester loading Cesaroni L1115-P got a hard error that blanked the design
 * and disabled Launch:
 *
 *   Two thrust values for single time point, time[1]=0.01, thrust=45.46;
 *   time[2]=0.01, thrust=522.52
 *
 * thrown by the carved kernel's ThrustCurveMotor.Builder.build(), which
 * requires strictly increasing time points.
 *
 * All sample data below is VERBATIM from thrustcurve.org's download.json for
 * motorId 5f4294d2000231000000018d (probed 2026-08-23). The API returns THREE
 * files for this motor: a clean 26-point RockSim file and two manufacturer
 * RASP files, one of which has three samples stamped 0.01 s. The app preferred
 * RASP unconditionally, so it picked the damaged file over the good one
 * sitting beside it in the same response.
 */
const L1115_RASP_BROKEN: TcSample[] = [
  { time: 0.01, thrust: 45.46 },
  { time: 0.01, thrust: 522.52 },
  { time: 0.01, thrust: 984.04 },
  { time: 0.04, thrust: 1256.1 },
  { time: 0.05, thrust: 1389.85 },
  { time: 0.08, thrust: 1713.25 },
  { time: 0.24, thrust: 1515.65 },
  { time: 0.3, thrust: 1474.74 },
];

const L1115_ROCKSIM_CLEAN: TcSample[] = [
  { time: 0, thrust: 0 },
  { time: 0.01, thrust: 45.46 },
  { time: 0.05, thrust: 522.52 },
  { time: 0.08, thrust: 984.04 },
  { time: 0.1, thrust: 1256.1 },
  { time: 0.15, thrust: 1389.85 },
  { time: 0.18, thrust: 1713.25 },
  { time: 0.24, thrust: 1515.65 },
];

const strictlyIncreasing = (t: readonly number[]): boolean =>
  t.every((v, i) => i === 0 || v > t[i - 1]!);

const impulse = (s: readonly TcSample[]): number => {
  let total = 0;
  for (let i = 1; i < s.length; i++) {
    total += (s[i]!.time - s[i - 1]!.time) * (s[i]!.thrust + s[i - 1]!.thrust) / 2;
  }
  return total;
};

describe('repairSamples — damaged thrust curves', () => {
  it('leaves a sound curve completely alone', () => {
    const { samples, repairs } = repairSamples(L1115_ROCKSIM_CLEAN);
    expect(repairs).toEqual([]);
    expect(samples).toEqual(L1115_ROCKSIM_CLEAN);
  });

  it('makes the real L1115-P RASP curve strictly increasing without losing a point', () => {
    const { samples, repairs } = repairSamples(L1115_RASP_BROKEN);

    expect(strictlyIncreasing(samples.map((s) => s.time))).toBe(true);
    // Every thrust reading survives — nothing is thrown away.
    expect(samples.map((s) => s.thrust)).toEqual(L1115_RASP_BROKEN.map((s) => s.thrust));
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs.join(' ')).toMatch(/0\.01/);
  });

  it('preserves total impulse when it separates coincident points', () => {
    // Separating coincident samples by a microsecond shifts the integral by at
    // most nudge x (sum of the thrust steps it spans) — here about 1.2 mNs.
    // L1115-P is a 5015 Ns motor, so that is 2 parts in 10 million.
    const before = impulse(L1115_RASP_BROKEN);
    const after = impulse(repairSamples(L1115_RASP_BROKEN).samples);
    expect(Math.abs(after - before)).toBeLessThan(0.01);
    expect(Math.abs(after - before) / 5015).toBeLessThan(1e-5);
  });

  it('collapses a genuine duplicate point (same time AND thrust)', () => {
    // Desktop OpenRocket's AbstractMotorLoader.finalizeThrustCurve rule, for
    // files like the KBA K1750 its comment names.
    const { samples, repairs } = repairSamples([
      { time: 0, thrust: 0 },
      { time: 0.5, thrust: 100 },
      { time: 0.5, thrust: 100 },
      { time: 1.0, thrust: 0 },
    ]);
    expect(samples).toHaveLength(3);
    expect(repairs.join(' ')).toMatch(/duplicate/i);
  });

  it('drops the zero of two final points at the same time', () => {
    const { samples } = repairSamples([
      { time: 0, thrust: 0 },
      { time: 1, thrust: 100 },
      { time: 2, thrust: 0 },
      { time: 2, thrust: 80 },
    ]);
    expect(strictlyIncreasing(samples.map((s) => s.time))).toBe(true);
    expect(samples[samples.length - 1]).toEqual({ time: 2, thrust: 80 });
  });

  it('sorts an out-of-order curve', () => {
    const { samples } = repairSamples([
      { time: 0, thrust: 0 },
      { time: 0.5, thrust: 50 },
      { time: 0.2, thrust: 30 },
    ]);
    expect(samples.map((s) => s.time)).toEqual([0, 0.2, 0.5]);
  });
});

describe('pickSampleFile — choosing among thrustcurve.org sim files', () => {
  /** The real three-file response for L1115-P (probed 2026-08-23). */
  const L1115_FILES = [
    { format: 'RockSim', source: 'user', samples: L1115_ROCKSIM_CLEAN },
    { format: 'RASP', source: 'mfr', samples: L1115_RASP_BROKEN },
    { format: 'RASP', source: 'mfr', samples: [{ time: 0.1, thrust: 1468.85 }] },
  ];

  it('takes the sound RockSim file over the damaged RASP one', () => {
    const picked = pickSampleFile(L1115_FILES);
    expect(picked?.samples).toEqual(L1115_ROCKSIM_CLEAN);
  });

  it('still prefers RASP when both formats are sound', () => {
    const rasp = [{ time: 0, thrust: 0 }, { time: 1, thrust: 10 }, { time: 2, thrust: 0 }];
    const rocksim = [{ time: 0, thrust: 0 }, { time: 1, thrust: 20 }, { time: 2, thrust: 0 }];
    const picked = pickSampleFile([
      { format: 'RockSim', samples: rocksim },
      { format: 'RASP', samples: rasp },
    ]);
    expect(picked?.samples).toEqual(rasp);
  });

  it('falls back to a repairable file when every candidate is damaged', () => {
    const picked = pickSampleFile([{ format: 'RASP', samples: L1115_RASP_BROKEN }]);
    expect(picked?.samples).toEqual(L1115_RASP_BROKEN);
  });

  it('returns null when nothing carries samples', () => {
    expect(pickSampleFile([{ format: 'RASP' }, { format: 'RockSim', samples: [] }])).toBeNull();
  });
});

describe('samplesToMotorSpec — end to end on the damaged curve', () => {
  const L1115: TcMotor = {
    ...QUEST_C6,
    motorId: '5f4294d2000231000000018d',
    designation: '5015L1115-P',
    commonName: 'L1115',
    impulseClass: 'L',
    diameter: 75,
    length: 621,
    totalWeightG: 4404,
    propWeightG: 2394,
  };

  it('produces a curve the kernel will accept', () => {
    const spec = samplesToMotorSpec(L1115, L1115_RASP_BROKEN, Infinity);
    expect(strictlyIncreasing(spec.times)).toBe(true);
    expect(spec.times[0]).toBe(0);
    // Masses stay monotonically non-increasing through the repaired curve.
    expect(spec.masses.every((m, i) => i === 0 || m <= spec.masses[i - 1]! + 1e-12)).toBe(true);
  });

  it('says out loud that it repaired the file', () => {
    const spec = samplesToMotorSpec(L1115, L1115_RASP_BROKEN, Infinity);
    expect(spec.curveRepairs?.length).toBeGreaterThan(0);
    // A sound curve reports nothing, so the UI stays silent for normal motors.
    expect(samplesToMotorSpec(L1115, L1115_ROCKSIM_CLEAN, Infinity).curveRepairs)
      .toBeUndefined();
  });

  it('actually loads into the kernel — the exact case that blanked the design', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const rocket = OrkRocket.build({
      noseCone: { length: 0.3, aftRadius: 0.0375, thickness: 0.002 },
      bodyTube: { length: 1.8, outerRadius: 0.0375, thickness: 0.0015, materialDensity: 950 },
      fins: { count: 3, rootChord: 0.3, tipChord: 0.15, sweep: 0.12, height: 0.12, thickness: 0.005 },
      motorMount: { length: 0.621, outerRadius: 0.0375, thickness: 0.0005 },
      parachute: { diameter: 2.0 },
    });
    // Before the repair this threw:
    //   "Two thrust values for single time point, time[1]=0.01, thrust=45.46;
    //    time[2]=0.01, thrust=522.52"
    // and every stat, both Launch buttons and all the exports went with it.
    expect(() => rocket.setMotor(samplesToMotorSpec(L1115, L1115_RASP_BROKEN, Infinity)))
      .not.toThrow();

    const result = rocket.simulate({});
    expect(result.summary.maxAltitude).toBeGreaterThan(100);
    expect(result.events.map((e) => e.type)).toContain('APOGEE');
  });
});

describe('motor masses come from the data file, the way desktop reads them', () => {
  /**
   * thrustcurve.org publishes two different claims about the same motor: the
   * CATALOG metadata, and the header of the data file the curve itself came
   * from. Desktop OpenRocket reads the file. We read the catalog, which mixed a
   * curve from one document with masses from another — on the AeroTech K480W
   * that is 2078/1292 g against the file's 2059/1232 g, and it put us 0.84 %
   * under desktop's apogee on a tester's own design. Verified same physical
   * file: OpenRocket's MotorDigest over it is 29901e68bb1b086809b21978a1776a3b,
   * byte-identical to the digest that tester's .ork stores.
   */
  const RSE = `<engine-database><engine-list>
    <engine mfg="AeroTech" code="K480W" Type="reloadable" dia="54." len="568."
      initWt="2059." propWt="1232." delays="0" auto-calc-mass="1" auto-calc-cg="1">
      <data><eng-data t="0." f="0." m="1232." cg="284."/></data>
    </engine></engine-list></engine-database>`;
  const ENG = `; a comment line
J1026 38 625.5 P 0.616 1.172 Loki
   0.019 62.798
   1.297 0.0`;

  it('reads initWt/propWt out of a RockSim .rse header', () => {
    expect(headerMasses({ format: 'RockSim', data: btoa(RSE) }))
      .toEqual({ totalWeightG: 2059, propWeightG: 1232 });
  });

  it('reads the kilogram pair out of a RASP .eng header, skipping comments', () => {
    expect(headerMasses({ format: 'RASP', data: btoa(ENG) }))
      .toEqual({ totalWeightG: 1172, propWeightG: 616 });
  });

  it('returns null when there is no file to read', () => {
    expect(headerMasses({ format: 'RASP' })).toBeNull();
    expect(headerMasses({ format: 'RASP', data: btoa('nonsense') })).toBeNull();
  });

  it('the file header wins over the catalog when both are available', () => {
    const catalog: TcMotor = { ...QUEST_C6, totalWeightG: 2078, propWeightG: 1292 };
    const spec = samplesToMotorSpec(catalog, SAMPLES, 5, { totalWeightG: 2059, propWeightG: 1232 });
    expect(spec.masses[0]).toBeCloseTo(2.059, 12);
    expect(spec.masses[spec.masses.length - 1]).toBeCloseTo(2.059 - 1.232, 12);
  });

  it('falls back to the catalog when the file carries no masses', () => {
    const catalog: TcMotor = { ...QUEST_C6, totalWeightG: 2078, propWeightG: 1292 };
    expect(samplesToMotorSpec(catalog, SAMPLES, 5).masses[0]).toBeCloseTo(2.078, 12);
  });
});
