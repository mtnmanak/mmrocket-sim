import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  defaultDelay, delayOptions, fileImpulseNs, headerMasses, impulseNote, samplesToMotorSpec, repairSamples, pickSampleFile,
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
  });

  /**
   * Audit 2026-09-22: a field with nothing usable in it is NO options, not a
   * made-up 0 s (which fires the charge at burnout), and RASP/RockSim's "no
   * ejection charge" codes — 1000 and 100, 151 of the 891 motors in a tester's
   * rasp.eng — are plugged, not the "longest delay" the browser used to pick.
   */
  it('reads an unusable field as no options, never as a 0 s delay', () => {
    expect(delayOptions({ ...QUEST_C6, delays: undefined })).toEqual([]);
    expect(delayOptions({ ...QUEST_C6, delays: '' })).toEqual([]);
    expect(delayOptions({ ...QUEST_C6, delays: 'S,M,L' })).toEqual([]); // KBA K400S
    expect(delayOptions({ ...QUEST_C6, delays: '6,' })).toEqual([6]); // not [6, 0]
  });

  it('reads 90 s and over as plugged, the way desktop reads RockSim files', () => {
    expect(delayOptions({ ...QUEST_C6, delays: '1000' })).toEqual([Infinity]);
    expect(delayOptions({ ...QUEST_C6, delays: '100' })).toEqual([Infinity]);
    expect(delayOptions({ ...QUEST_C6, delays: '6,10,14,1000' })).toEqual([6, 10, 14, Infinity]);
    // One plugged option however many ways the field says it.
    expect(delayOptions({ ...QUEST_C6, delays: '5,P,1000' })).toEqual([5, Infinity]);
    expect(delayOptions({ ...QUEST_C6, delays: '89' })).toEqual([89]);
  });

  it('defaultDelay: longest prescribed, plugged only when alone, null when nothing is listed', () => {
    expect(defaultDelay(QUEST_C6)).toBe(5);
    expect(defaultDelay({ ...QUEST_C6, delays: '6,10,14,1000' })).toBe(14);
    expect(defaultDelay({ ...QUEST_C6, delays: '1000' })).toBe(Infinity);
    expect(defaultDelay({ ...QUEST_C6, delays: 'S,M,L' })).toBeNull();
    expect(defaultDelay({ ...QUEST_C6, delays: undefined })).toBeNull();
  });

  /**
   * Review of the audit 2026-09-22 fixes: "longest" was "last in file order".
   * A RASP file lists delays in whatever order its author typed — the tester's
   * rasp.eng has I115W, I215R and I117FJ as "6-10-14-0" and E6T as "2-4-8-0" —
   * and those defaulted to 0 s, a charge at burnout.
   */
  it('sorts the delays, so the longest is the longest whatever order the file lists them in', () => {
    expect(delayOptions({ ...QUEST_C6, delays: '6,10,14,0' })).toEqual([0, 6, 10, 14]);
    expect(delayOptions({ ...QUEST_C6, delays: '13,10,8,6,4' })).toEqual([4, 6, 8, 10, 13]);
    expect(delayOptions({ ...QUEST_C6, delays: 'P,7,4,1000,7' })).toEqual([4, 7, Infinity]);
    expect(defaultDelay({ ...QUEST_C6, delays: '6,10,14,0' })).toBe(14);
    expect(defaultDelay({ ...QUEST_C6, delays: '2,4,8,0' })).toBe(8);
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
    // Up to 1.9 s on the deploy runner (v0.138-v0.140): a kernel flight states
    // its budget, as the suite's other slow flights do (AUDIT row 528).
  }, 60000);
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

  /**
   * THE IMPULSE-AGREEMENT TERM (owner's ruling 2026-09-07, from his own WM 4"
   * Extreme flight). The AeroTech J460T is certified at 805.5 N·s; its cert
   * RASP file integrates to 848 (+5.3 %) and its RockSim/user file to 813
   * (+0.9 %). Provenance alone chose the cert file, so the motor was flown 5 %
   * hotter than rated. Files below are the J460T in miniature: same burn time,
   * one 5 % hot, one right.
   */
  describe('impulse agreement (v0.116)', () => {
    const J460T = { motorId: 'j460t', designation: 'J460T', totImpulseNs: 805.5, burnTimeS: 1.81 } as TcMotor;
    // A 1.81 s triangle whose area is exactly the target impulse: ½ × 1.81 × peak.
    const PEAK = 805.5 * 2 / 1.81;
    const tri = (peak: number) => [{ time: 0, thrust: 0 }, { time: 0.905, thrust: peak }, { time: 1.81, thrust: 0 }];
    const right = { format: 'RockSim', source: 'user', samples: tri(PEAK) };     // 805.5 N·s
    const hot = { format: 'RASP', source: 'cert', samples: tri(PEAK * 1.053) }; // +5.3 %

    it('measures a file the way the census did', () => {
      expect(fileImpulseNs(right)).toBeCloseTo(805.5, 6);
      expect(fileImpulseNs(hot) / 805.5 - 1).toBeCloseTo(0.053, 6);
    });

    it('takes the file that delivers the certified impulse over the cert file that does not', () => {
      expect(pickSampleFile([hot, right], J460T)).toBe(right);
      expect(pickSampleFile([right, hot], J460T)).toBe(right);
    });

    it('still prefers the cert file when both are inside 3 %', () => {
      const certOk = { format: 'RASP', source: 'cert', samples: tri(PEAK * 1.02) }; // +2 %
      expect(pickSampleFile([right, certOk], J460T)).toBe(certOk);
    });

    it('is neutral when the catalogue has no total to compare against', () => {
      const noTotal = { ...J460T, totImpulseNs: 0 } as TcMotor;
      expect(pickSampleFile([right, hot], noTotal)).toBe(hot); // cert wins, as before
      expect(pickSampleFile([right, hot])).toBe(hot);
    });

    it('ranks below burn-time agreement: a wrong loading is a different motor', () => {
      // A file that delivers the certified impulse in HALF the burn is another
      // loading (the Estes A8-0 case); impulse agreement must not rescue it.
      const wrongLoading = { format: 'RASP', source: 'user', samples: [{ time: 0, thrust: 0 }, { time: 0.4525, thrust: PEAK * 2 }, { time: 0.905, thrust: 0 }] };
      expect(fileImpulseNs(wrongLoading)).toBeCloseTo(805.5, 6);
      expect(pickSampleFile([wrongLoading, hot], J460T)).toBe(hot);
    });

    /**
     * The J460T's REAL situation: its agreeing file is damaged (a duplicated
     * t=0 sample), so soundness ranks it last and the hot cert file wins
     * anyway. The gate cannot help that user; the note has to.
     */
    it('cannot rescue a motor whose only agreeing file is damaged — the note says so instead', () => {
      const damagedRight = { format: 'RockSim', source: 'user', samples: [{ time: 0, thrust: 0 }, ...tri(PEAK)] };
      expect(pickSampleFile([damagedRight, hot], J460T)).toBe(hot);
      const note = impulseNote(J460T, hot.samples)!;
      expect(note).toMatch(/integrates to 848 N·s/);
      expect(note).toMatch(/\+5\.3 % against the 805\.5 N·s/);
      expect(note).toMatch(/read high/);
    });

    it('says nothing inside 5 %, and nothing when the catalogue has no total', () => {
      expect(impulseNote(J460T, tri(PEAK * 1.04))).toBeNull();
      expect(impulseNote(J460T, tri(PEAK * 0.96))).toBeNull();
      expect(impulseNote(J460T, tri(PEAK * 0.94))).toMatch(/read low/);
      expect(impulseNote({ designation: 'X', totImpulseNs: 0 }, hot.samples)).toBeNull();
    });
  });

  /**
   * A CERTIFICATION LETTER THE OTHER SOURCES CONTRADICT (board Tier 1 row 8 (c),
   * 2026-10-01). The AeroTech F52C's and H13ST's Tripoli Motor Testing letters,
   * undated drafts from one test day, put total impulse, peak and average thrust
   * 15.9 % over thrustcurve.org's rows, and on total impulse AeroTech's own pages,
   * the NAR's list and the propellant's specific impulse all side with the rows
   * (scripts/aerotech-certified.test.mjs, KNOWN). Taking the letters' figures put
   * "-13.6 % ... expect apogee to read low" on every F52C (-12.2 % on the H13ST),
   * for a shortfall no other source shows. Until that is ruled the rows ship as
   * listed, and their curves, which deliver what the rows say, load with no note.
   * On the shipped catalogue and bundle, as a user gets them.
   */
  describe('a certification letter the other sources contradict', () => {
    for (const designation of ['F52C', 'H13ST']) {
      it(`${designation}: ships the total its maker publishes, so loading it says nothing about its impulse`, async () => {
        const { MOTOR_DB } = await import('./motorDb.js');
        const { fetchMotorSpec, isImpulseNote } = await import('./thrustcurve.js');
        const shipped = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'AeroTech' && m.designation === designation)!;
        const spec = await fetchMotorSpec(shipped, 5);
        expect(spec.curveRepairs?.filter(isImpulseNote) ?? []).toEqual([]);
      });
    }
  });

  /**
   * Audit 2026-09-30 and the 1 October curve research (§8 item 2): the gate
   * integrated the RAW file, but a file whose first sample comes after t = 0
   * FLIES with a ramp up from (0, 0) in front — impulse the raw integral leaves
   * out. The gate exists to compare the curve the app flies with the
   * certification, so it measures that one.
   */
  describe('the impulse gate measures the curve flown', () => {
    const MOTOR = { motorId: 'm', designation: 'M100', totImpulseNs: 100, burnTimeS: 2 } as TcMotor;
    /** Starts at (0, 0), so raw and flown are one curve: a triangle of `area` N·s over 2 s. */
    const fromZero = (area: number) => ({ format: 'RASP', source: 'user',
      samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: area }, { time: 2, thrust: 0 }] });
    /** A cert file whose first sample is (0.2 s, f N): 1.4 f raw, 1.5 f flown with its ramp. */
    const lateStart = (f: number) => ({ format: 'RASP', source: 'cert',
      samples: [{ time: 0.2, thrust: f }, { time: 1.2, thrust: f }, { time: 2, thrust: 0 }] });
    const flownImpulse = (file: { samples: TcSample[] }): number => {
      const spec = samplesToMotorSpec(MOTOR, file.samples, 5, { totalWeightG: 100, propWeightG: 50 });
      return fileImpulseNs({ samples: spec.times.map((time, i) => ({ time, thrust: spec.thrusts[i]! })) });
    };

    it('the premise: a late first sample flies more impulse than its raw samples hold', () => {
      expect(fileImpulseNs(lateStart(70))).toBeCloseTo(98, 9);
      expect(flownImpulse(lateStart(70))).toBeCloseTo(105, 9);
    });

    it('no longer passes a cert file whose flown curve is 5 % hot', () => {
      // Raw it read 98 N·s (−2 %), passed, and the cert flag then beat a file
      // that delivers the certified 100 exactly. It flies 105 (+5 %).
      const exact = fromZero(100);
      const hot = lateStart(70);
      expect(pickSampleFile([hot, exact], MOTOR)).toBe(exact);
      expect(pickSampleFile([exact, hot], MOTOR)).toBe(exact);
    });

    it('passes a cert file whose raw samples read low but whose flown curve agrees', () => {
      // Raw 95.2 N·s (−4.8 %) failed, so a +2 % user file won; it flies 102
      // (+2 %), inside the gate, and the cert flag decides as it should.
      const low = lateStart(68);
      expect(fileImpulseNs(low)).toBeCloseTo(95.2, 9);
      expect(flownImpulse(low)).toBeCloseTo(102, 9);
      const user = fromZero(102);
      expect(pickSampleFile([user, low], MOTOR)).toBe(low);
      expect(pickSampleFile([low, user], MOTOR)).toBe(low);
    });
  });
});

/**
 * The 1 October curve research (§8 item 1): the picker's last word was a
 * file's POSITION in the list it was given, so v0.143's refresh changed the
 * Hypertek 2800CCRGLFX-L625FX's loaded mass from 5,706.2 g to 5,116.2 g only
 * because thrustcurve.org returned the same two files in the other order. A
 * flight must not depend on the order a server lists files in.
 */
describe('pickSampleFile — the last word is the file, never its place in the list', () => {
  const MOTOR = { motorId: 'm', designation: 'M100', totImpulseNs: 100, burnTimeS: 2,
    totalWeightG: 200, propWeightG: 100 } as TcMotor;
  const curve = [{ time: 0, thrust: 0 }, { time: 1, thrust: 100 }, { time: 2, thrust: 0 }];
  const file = (over: object) => ({ format: 'RASP', source: 'cert', samples: curve, ...over });

  it('prefers, between otherwise-equal files, the one whose masses agree with the catalogue', () => {
    const off = file({ simfileId: 'a', bundledMasses: { totalWeightG: 180, propWeightG: 100 } });
    const on = file({ simfileId: 'b', bundledMasses: { totalWeightG: 200, propWeightG: 100 } });
    expect(pickSampleFile([off, on], MOTOR)).toBe(on);
    expect(pickSampleFile([on, off], MOTOR)).toBe(on);
    // A file stating no masses flies the catalogue's, which agree by definition.
    const none = file({ simfileId: 'c' });
    expect(pickSampleFile([off, none], MOTOR)).toBe(none);
    // Float noise in a stated mass is not a disagreement: the id decides.
    const noisy = file({ simfileId: 'd', bundledMasses: { totalWeightG: 200.00000000000003, propWeightG: 100 } });
    const exact = file({ simfileId: 'e', bundledMasses: { totalWeightG: 200, propWeightG: 100 } });
    expect(pickSampleFile([exact, noisy], MOTOR)).toBe(noisy);
  });

  it('then takes the lower thrustcurve.org id, whichever order the files come in', () => {
    const a = file({ simfileId: '5f4294d20002e900000000cb' });
    const b = file({ simfileId: '5f4294d20002e900000000f3' });
    expect(pickSampleFile([a, b], MOTOR)).toBe(a);
    expect(pickSampleFile([b, a], MOTOR)).toBe(a);
    // A file with no id comes after every file that has one…
    const anon = file({});
    expect(pickSampleFile([anon, b], MOTOR)).toBe(b);
    // …and two with none are told apart by what they hold, not where they sit.
    const p = file({ samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 100 }, { time: 2, thrust: 0 }] });
    const q = file({ samples: [{ time: 0, thrust: 0 }, { time: 0.9, thrust: 101 }, { time: 2, thrust: 0 }] });
    expect(pickSampleFile([p, q], MOTOR)).toBe(pickSampleFile([q, p], MOTOR));
  });

  it('never changes its pick when a motor’s files are shuffled — every bundled motor, seeded', async () => {
    const { MOTOR_DB } = await import('./motorDb.js');
    const { bundledSimFiles } = await import('./thrustcurve.js');
    // mulberry32: a fixed seed, so a failure names a motor and reproduces.
    let seed = 0x2026_1001;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const shuffled = <T,>(list: readonly T[]): T[] => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    let withChoice = 0;
    for (const m of MOTOR_DB) {
      const files = await bundledSimFiles(m.motorId);
      if (files.length < 2) continue;
      withChoice++;
      const pick = pickSampleFile(files, m);
      expect(pickSampleFile([...files].reverse(), m), `${m.manufacturerAbbrev} ${m.designation}`).toBe(pick);
      for (let k = 0; k < 6; k++) {
        expect(pickSampleFile(shuffled(files), m), `${m.manufacturerAbbrev} ${m.designation}`).toBe(pick);
      }
    }
    expect(withChoice).toBeGreaterThan(700); // 810 motors have two or more files in the 2026-09-30 bundle
  });
});

/**
 * The user guide (Motors → The database and browser) is where a user finds out
 * why a motor flies the file it does. Until 2026-10-01 it named five of the
 * sort's terms: not RASP over RockSim, nor the two that decide between files
 * equal on everything else, so it could not explain the AeroTech H242T's file
 * (chosen on its masses) or the Hypertek L625FX's +11.5 % in loaded mass.
 */
describe('pickSampleFile — the guide states its order', () => {
  it('names every term the sort applies, in the order it applies them', () => {
    const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'user-guide.md'), 'utf8');
    let rest = guide.split('\n').find((l) => l.includes('When a motor has several published files')) ?? '';
    expect(rest).not.toBe('');
    // One phrase per term of the sort at the end of pickSampleFile, best first.
    for (const term of [
      'time points all run forward', // sound
      'burn time agrees', // agrees
      'total impulse is within 3 %', // impulseAgrees
      'certification-body file', // cert
      'the richer one', // samples.length
      'RASP `.eng` file over a RockSim', // format
      'masses are closer to the catalogue', // massGap
      "thrustcurve.org's own id", // identity
      'never the order', // index: reached only by files that hold the same thing
    ]) {
      const at = rest.indexOf(term);
      expect(at, term).toBeGreaterThanOrEqual(0);
      rest = rest.slice(at + term.length);
    }
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

  /**
   * Audit 2026-09-22: the refusal checked the CATALOGUE pair even when the file
   * pair — the one that flies — was good. 116 of the 157 catalogue rows with no
   * usable weight carry good file masses, 14 of them in production.
   */
  it('flies a motor the catalogue gives no weight when its file states a good pair', () => {
    const noCatalogMass = { ...QUEST_C6, totalWeightG: undefined as unknown as number };
    const spec = samplesToMotorSpec(noCatalogMass, SAMPLES, 5, { totalWeightG: 20.5, propWeightG: 9.6 });
    expect(spec.masses[0]).toBeCloseTo(0.0205, 12);
    expect(spec.masses[spec.masses.length - 1]).toBeCloseTo(0.0205 - 0.0096, 12);
    const inverted = { ...QUEST_C6, totalWeightG: 52, propWeightG: 104 };
    expect(samplesToMotorSpec(inverted, SAMPLES, 5, { totalWeightG: 20.5, propWeightG: 9.6 })
      .masses[0]).toBeCloseTo(0.0205, 12);
  });

  it('still refuses when neither the file nor the catalogue has a usable pair', () => {
    const noCatalogMass = { ...QUEST_C6, totalWeightG: undefined as unknown as number };
    expect(() => samplesToMotorSpec(noCatalogMass, SAMPLES, 5, null)).toThrow(/publishes no loaded/);
    // An impossible file pair is no pair: it neither flies nor rescues the catalogue.
    expect(() => samplesToMotorSpec(noCatalogMass, SAMPLES, 5, { totalWeightG: 5, propWeightG: 9 }))
      .toThrow(/publishes no loaded/);
  });

  /**
   * Audit 2026-09-30 (and the 1 October curve research, §8 item 2): the note
   * integrated the RAW file, not the curve flown — which is repaired and, when
   * the file's first sample is after t = 0, starts with a (0, 0) point the
   * kernel needs. 387 picked files gain that point. Two real motors show it.
   */
  it('AeroTech E16W: no impulse note — the curve flown IS the certified 37.67 N·s', async () => {
    const { MOTOR_DB } = await import('./motorDb.js');
    const { fetchMotorSpec, isImpulseNote } = await import('./thrustcurve.js');
    const e16w = MOTOR_DB.find((x) => x.manufacturerAbbrev === 'AeroTech' && x.designation === 'E16W')!;
    const spec = await fetchMotorSpec(e16w, 4);
    expect(fileImpulseNs({ samples: spec.times.map((time, i) => ({ time, thrust: spec.thrusts[i]! })) }))
      .toBeCloseTo(37.67, 1);
    // The raw file starts at 0.132 s and 32.22 N, so it integrates 2.1 N·s short:
    // "−5.6 % … expect apogee to read low" for a motor that flies exactly right.
    expect(spec.curveRepairs?.filter(isImpulseNote) ?? []).toEqual([]);
  });

  it('AeroTech J570W: says it flies 6.2 % over its certification, which the raw file hid', async () => {
    const { MOTOR_DB } = await import('./motorDb.js');
    const { fetchMotorSpec, isImpulseNote } = await import('./thrustcurve.js');
    const j570w = MOTOR_DB.find((x) => x.manufacturerAbbrev === 'AeroTech' && x.designation === 'J570W')!;
    const notes = (await fetchMotorSpec(j570w, 10)).curveRepairs?.filter(isImpulseNote) ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^The thrust curve flown for J570W integrates to 1034 N·s, \+6\.2 % against the 973\.1 N·s/);
    expect(notes[0]).toMatch(/read high/);
  });

  it('AeroTech I65W: flies the file that delivers its certified 630.5 N·s, not a cert file flying +4.7 %', async () => {
    // Its cert RASP file starts at (0.18 s, 125.41 N): raw it reads 648.63
    // N·s (+2.88 %) and passed the 3 % gate, where it won on provenance;
    // flown it is 659.92 (+4.67 %). The user RockSim file flies 630.51.
    const { MOTOR_DB } = await import('./motorDb.js');
    const { fetchMotorSpec } = await import('./thrustcurve.js');
    const i65w = MOTOR_DB.find((x) => x.manufacturerAbbrev === 'AeroTech' && x.designation === 'I65W')!;
    const spec = await fetchMotorSpec(i65w, 10);
    expect(fileImpulseNs({ samples: spec.times.map((time, i) => ({ time, thrust: spec.thrusts[i]! })) }))
      .toBeCloseTo(630.51, 1);
    expect(spec.masses[0]).toBeCloseTo(0.7761, 6); // that file's loaded mass, 776.1 g
  });

  it('Hypertek 2800CCRGLFX-L625FX: flies its catalogue loaded mass, 5,706.2 g, whatever order its files arrive in', async () => {
    // Two cert RASP files with the same curve; one states 5,706.18 g loaded
    // (the catalogue's figure), the other 5,116.16 g. v0.143's refresh listed
    // them the other way round and the app flew the light one (-10.3 %).
    const { MOTOR_DB } = await import('./motorDb.js');
    const { fetchMotorSpec } = await import('./thrustcurve.js');
    const l625 = MOTOR_DB.find((x) => x.manufacturerAbbrev === 'Hypertek' && x.designation === '2800CCRGLFX-L625FX')!;
    const spec = await fetchMotorSpec(l625, Infinity);
    expect(spec.masses[0]).toBeCloseTo(5.70618, 6);
  });

  it('Estes 1/2A6 — no catalogue weight, good bundled file — now loads from the shipped data', async () => {
    const { MOTOR_DB, hasMassData } = await import('./motorDb.js');
    const { fetchMotorSpec } = await import('./thrustcurve.js');
    const m = MOTOR_DB.find((x) => x.manufacturerAbbrev === 'Estes' && x.designation === '1/2A6')!;
    expect(hasMassData(m)).toBe(false); // the premise
    const spec = await fetchMotorSpec(m, 2);
    expect(spec.masses.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
  });
});
