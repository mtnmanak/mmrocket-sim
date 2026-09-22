// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_MAX_FRACTION_OF_CASE, EXIT_MIN_FRACTION_OF_CASE, addExMotors, exToDbEntry, exitDiameterFromRse,
  getExMotor, impulseClassOf, parseEng, parseRse,
} from './exMotors.js';
import { defaultDelay, delayOptions } from './thrustcurve.js';

const ENG = `; AeroTech K550W
; converted from TMT test stand data
K550W 54 410 0 0.919744 1.48736 AT
   0.065 604.264
   0.196 642.625
   1.86 682.197
   3.28 563.626
   3.38 449.371
   3.4 0.0
`;

const ENG_MULTI = `; two little motors
A8 18 70 3-5-7 0.00312 0.01624 Estes
0.05 8.2
0.3 3.5
0.7 0.0
; next
B6 18 70 0-4-6 0.00624 0.01935 Estes
0.05 11.0
0.8 4.0
1.1 0.0
`;

const RSE = `<engine-database>
 <engine-list>
  <engine mfg="EX Labs" code="M1234-EX" Type="single-use" dia="75" len="620"
    initWt="4200" propWt="2400" delays="10,14,18" auto-calc-mass="0" auto-calc-cg="0">
   <comments>test motor</comments>
   <data>
     <eng-data t="0" f="0" m="4200" cg="310"/>
     <eng-data t="0.1" f="1400" m="4100" cg="310"/>
     <eng-data t="2.0" f="1300" m="2500" cg="310"/>
     <eng-data t="2.4" f="0" m="1800" cg="310"/>
   </data>
  </engine>
 </engine-list>
</engine-database>`;

describe('parseEng (RASP)', () => {
  it('parses a single motor with header metadata', () => {
    const [m] = parseEng(ENG);
    expect(m!.designation).toBe('K550W');
    expect(m!.realManufacturer).toBe('AT');
    expect(m!.diameter).toBe(54);
    expect(m!.length).toBe(410);
    expect(m!.totalWeightG).toBeCloseTo(1487.36);
    expect(m!.propWeightG).toBeCloseTo(919.744);
    expect(m!.delays).toBe('0');
    // Leading 0,0 point is added.
    expect(m!.samples[0]).toEqual({ time: 0, thrust: 0 });
    expect(m!.samples[m!.samples.length - 1]!.thrust).toBe(0);
  });

  it('parses multiple motors from one file and dash delays', () => {
    const motors = parseEng(ENG_MULTI);
    expect(motors.map((m) => m.designation)).toEqual(['A8', 'B6']);
    expect(motors[0]!.delays).toBe('3,5,7');
  });

  it('rejects garbage', () => {
    expect(() => parseEng('hello world')).toThrow(/RASP header/);
  });
});

describe('parseRse (RockSim)', () => {
  it('parses engine attributes and per-sample masses', () => {
    const [m] = parseRse(RSE);
    expect(m!.designation).toBe('M1234-EX');
    expect(m!.realManufacturer).toBe('EX Labs');
    expect(m!.diameter).toBe(75);
    expect(m!.delays).toBe('10,14,18');
    expect(m!.sampleMassesKg).toEqual([4.2, 4.1, 2.5, 1.8]);
    expect(m!.samples).toHaveLength(4);
  });

  it('rejects non-XML', () => {
    expect(() => parseRse('K550W 54 410 ...')).toThrow();
  });
});

describe('exToDbEntry', () => {
  it('computes impulse, class, burn time; manufacturer shows EX', () => {
    const [m] = parseRse(RSE);
    const entry = exToDbEntry(m!);
    expect(entry.manufacturerAbbrev).toBe('EX');
    expect(entry.motorId).toMatch(/^ex:/);
    // ~ (0.05*1400) + (1.9*1350) + (0.2*650) ≈ 2765 Ns → L class (2560–5120)
    expect(entry.totImpulseNs).toBeGreaterThan(2500);
    expect(entry.totImpulseNs).toBeLessThan(3000);
    expect(entry.impulseClass).toBe('L');
    expect(entry.burnTimeS).toBeCloseTo(2.4);
  });
});

describe('impulseClassOf', () => {
  it('maps total impulse to NAR letters', () => {
    expect(impulseClassOf(2.4)).toBe('A');
    expect(impulseClassOf(4.9)).toBe('B');
    expect(impulseClassOf(10)).toBe('C');
    expect(impulseClassOf(640)).toBe('I');
    expect(impulseClassOf(641)).toBe('J');
  });
});

describe('.rse files with missing mass data', () => {
  const rse = (engAttrs: string, dataPoints: string) =>
    `<engine-database><engine-list><engine ${engAttrs}><data>${dataPoints}</data></engine></engine-list></engine-database>`;

  it('does not treat an absent m attribute as a zero mass', () => {
    // Number(null) === 0 and 0 is finite, so this used to yield an all-zero
    // mass curve that was PREFERRED over the impulse-proportional fallback —
    // the motor then flew weighing nothing, silently, and the flight came out
    // optimistic with no warning anywhere.
    const xml = rse(
      'code="EX-NOMASS" mfg="Home" dia="29" len="120" initWt="100" propWt="50" delays="5"',
      '<eng-data t="0" f="0"/><eng-data t="0.5" f="60"/><eng-data t="1" f="0"/>',
    );
    const [m] = parseRse(xml);
    expect(m).toBeDefined();
    expect(m!.sampleMassesKg).toBeUndefined(); // falls back to impulse-proportional
  });

  it('keeps per-sample masses when the file turns RockSim’s mass model off and they are all there', () => {
    const xml = rse(
      'code="EX-MASS" mfg="Home" dia="29" len="120" initWt="100" propWt="50" delays="5" auto-calc-mass="0"',
      '<eng-data t="0" f="0" m="100"/><eng-data t="0.5" f="60" m="75"/><eng-data t="1" f="0" m="50"/>',
    );
    const [m] = parseRse(xml);
    expect(m!.sampleMassesKg).toEqual([0.1, 0.075, 0.05]);
  });

  /**
   * RockSim's `m` is the PROPELLANT aboard (the first point equals propWt in
   * 1,239 of the 1,275 corpus records, initWt in none), and auto-calc-mass —
   * on in every one of them, and on unless a file says "0" — tells desktop to
   * rebuild the curve from initWt/propWt instead (audit 2026-09-22). Read as
   * the motor's total mass, the points put it in the air lighter by its case.
   */
  it('flies the mass model, not the points, when auto-calc-mass is on or absent', () => {
    const pts = '<eng-data t="0" f="0" m="50"/><eng-data t="0.5" f="60" m="25"/><eng-data t="1" f="0" m="1"/>';
    const attrs = 'code="EX-AUTO" mfg="Home" dia="29" len="120" initWt="100" propWt="50" delays="5"';
    expect(parseRse(rse(attrs, pts))[0]!.sampleMassesKg).toBeUndefined();
    expect(parseRse(rse(`${attrs} auto-calc-mass="1"`, pts))[0]!.sampleMassesKg).toBeUndefined();
  });

  it('reads points that start at propWt as propellant aboard, and adds the case', () => {
    const [m] = parseRse(rse(
      'code="EX-PROP" mfg="Home" dia="29" len="120" initWt="100" propWt="50" delays="5" auto-calc-mass="0"',
      '<eng-data t="0" f="0" m="50"/><eng-data t="0.5" f="60" m="25"/><eng-data t="1" f="0" m="0"/>',
    ));
    expect(m!.sampleMassesKg).toEqual([0.1, 0.075, 0.05]); // 50 g of case under each
  });

  it('flies the model, and says so, when the points match neither mass', () => {
    const notes: string[] = [];
    const [m] = parseRse(rse(
      'code="EX-ODD" mfg="Home" dia="29" len="120" initWt="100" propWt="50" delays="5" auto-calc-mass="0"',
      '<eng-data t="0" f="0" m="80"/><eng-data t="0.5" f="60" m="40"/><eng-data t="1" f="0" m="20"/>',
    ), notes);
    expect(m!.sampleMassesKg).toBeUndefined();
    expect(notes[0]).toMatch(/EX-ODD: .*neither its loaded mass/);
  });

  it('refuses a file with no initial mass instead of importing a 0 g motor', () => {
    const xml = rse(
      'code="EX-NOINIT" mfg="Home" dia="29" len="120" propWt="50" delays="5"',
      '<eng-data t="0" f="0"/><eng-data t="1" f="0"/>',
    );
    expect(() => parseRse(xml)).toThrow(/initial mass/i);
  });

  it('skips only the bad engine in a multi-engine file, and names it (audit 2026-09-22)', () => {
    const good = '<engine code="OK1" mfg="Home" dia="29" len="120" initWt="100" propWt="50" delays="5">'
      + '<data><eng-data t="0" f="0"/><eng-data t="0.5" f="60"/><eng-data t="1" f="0"/></data></engine>';
    const heavy = '<engine code="HEAVY" mfg="Home" dia="29" len="120" initWt="100" propWt="150" delays="5">'
      + '<data><eng-data t="0" f="0"/><eng-data t="0.5" f="60"/><eng-data t="1" f="0"/></data></engine>';
    const notes: string[] = [];
    const motors = parseRse(`<engine-database><engine-list>${heavy}${good}</engine-list></engine-database>`, notes);
    expect(motors.map((m) => m.designation)).toEqual(['OK1']);
    expect(notes).toEqual([expect.stringMatching(/skipped 1 motor — Motor HEAVY: more propellant \(150 g\)/)]);
  });
});

describe('.eng header mass columns', () => {
  // The header check tested only the two DIMENSION columns (diameter, length)
  // and left the two MASS columns to `Number()`, which returns NaN for junk.
  // A motor then imported with propWeightG: NaN, survived to fly time, and
  // failed there with "thrustcurve.org publishes no loaded/propellant weight
  // for M1297" — naming a remote service for a file read off the user's own
  // disk. Found by the 2026-09-08 audit.
  const bad = (propKg: string, totKg: string) => `; experimental
M1297 75 1000 P ${propKg} ${totKg} Loki
  0.05 1200.0
  1.50 1250.0
  1.55 0.0
`;

  it('refuses an unparseable propellant mass rather than importing NaN', () => {
    expect(() => parseEng(bad('notanum', '3.5'))).toThrow(/mass must be numbers/i);
  });

  it('refuses an unparseable total mass', () => {
    expect(() => parseEng(bad('1.8', 'oops'))).toThrow(/mass must be numbers/i);
  });

  it('still accepts a well-formed header', () => {
    const [m] = parseEng(bad('1.8', '3.5'));
    expect(m!.propWeightG).toBeCloseTo(1800, 6);
    expect(m!.totalWeightG).toBeCloseTo(3500, 6);
  });

  // Audit 2026-09-22: masses checked for finiteness only, so a motor with more
  // propellant than it weighs imported and failed at fly time — and a bad
  // header sank every other motor in the file with it.
  it('refuses a header with more propellant than loaded mass', () => {
    expect(() => parseEng(bad('3.9', '3.5'))).toThrow(/more propellant \(3900 g\) than loaded mass \(3500 g\)/);
  });

  it('skips only the bad motor in a multi-motor file, and names it', () => {
    const notes: string[] = [];
    const motors = parseEng(`${ENG_MULTI.replace('0.00624 0.01935', '0.02 0.01935')}\n${bad('notanum', '3.5')}`, notes);
    expect(motors.map((m) => m.designation)).toEqual(['A8']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/skipped 2 motors .*B6: more propellant.*mass must be numbers/);
  });
});

describe('.eng motor boundaries', () => {
  // Audit 2026-09-22: a motor ended at its FIRST zero-thrust sample, so a
  // two-pulse curve was cut at the gap and its second pulse then read as a
  // header — refusing the whole file. It ends at the next header now.
  const DUAL = `; two-pulse research motor
DP-54 54 600 P 1.2 2.6 EX
0.05 900
1.00 850
1.05 0
2.00 0
2.05 700
3.00 650
3.05 0
`;

  it('reads a two-pulse motor as one motor, both pulses', () => {
    const [m, ...rest] = parseEng(DUAL);
    expect(rest).toEqual([]);
    expect(m!.samples.map((s) => s.thrust)).toEqual([0, 900, 850, 0, 0, 700, 650, 0]);
    expect(m!.samples[m!.samples.length - 1]!.time).toBe(3.05);
  });

  it('still ends a motor at the next header, with or without a comment between', () => {
    const noComment = ENG_MULTI.replace('; next\n', '');
    expect(parseEng(noComment).map((m) => m.designation)).toEqual(['A8', 'B6']);
    expect(parseEng(noComment)[0]!.samples.at(-1)).toEqual({ time: 0.7, thrust: 0 });
  });

  it('keeps one zero after the burn and drops a trailing run of them', () => {
    const [m] = parseEng(`${ENG}   3.5 0.0\n   3.6 0.0\n`);
    expect(m!.samples.at(-1)).toEqual({ time: 3.4, thrust: 0 });
  });
});

describe('addExMotors — motors that share a maker and name', () => {
  // Audit 2026-09-22: the id is maker + name. Two in one batch both went in and
  // every lookup answered with the first; a tester's rasp.eng lists AMW K475WW
  // twice, with a 0 s and a 100 (no charge) delay.
  const twin = (delay: string) => `K475WW 54 403 ${delay} 0.7286 1.4925 AMW
0.05 600
1.5 500
1.6 0
`;
  afterEach(() => { localStorage.clear(); });

  it('keeps a different motor under a taken id as <id>~2, and says which', () => {
    const w = addExMotors(parseEng(`${twin('0')}${twin('100')}`));
    expect(w.motors.map((m) => m.motorId)).toEqual(['ex:amw-k475ww', 'ex:amw-k475ww~2']);
    expect(w.duplicates).toEqual(['K475WW']);
    expect(getExMotor('ex:amw-k475ww~2')!.delays).toBe('100');
  });

  it('drops an exact repeat, and re-importing lands on the same ids — reported as replaced', () => {
    addExMotors(parseEng(`${twin('0')}${twin('100')}`));
    const again = addExMotors(parseEng(`${twin('0')}${twin('0')}${twin('100')}`));
    expect(again.motors.map((m) => m.motorId)).toEqual(['ex:amw-k475ww', 'ex:amw-k475ww~2']);
    expect(again.duplicates).toEqual(['K475WW']);
    expect(again.replaced).toEqual(['K475WW', 'K475WW']);
  });
});

describe('plugged (-P) .eng motors', () => {
  // The normal header shape for a high-power EX motor: no ejection charge at
  // all. RASP writes 'P' in the delay field.
  const ENG_PLUGGED = `; plugged experimental motor
MyEX-K600 54 410 P 0.900 1.650 EX
  0.05 620.0
  1.50 640.0
  1.55 0.0
`;

  it('keeps the plugged marker instead of emptying the delay field', () => {
    const [m] = parseEng(ENG_PLUGGED);
    expect(m!.delays).toBe('P');
  });

  it('offers plugged — not a bogus 0 s delay — through the motor browser', () => {
    // The failure this pins: an emptied delay string made exToDbEntry emit
    // `delays: undefined`, delayOptions returned [0], and the kernel fired an
    // ejection charge at burnout on a motor that has none.
    const [m] = parseEng(ENG_PLUGGED);
    const entry = exToDbEntry(m!);
    expect(entry.delays).toBe('P');
    expect(delayOptions(entry)).toEqual([Infinity]);
    expect(delayOptions(entry)).not.toContain(0);
  });

  it('still lists the prescribed delays when a motor offers both', () => {
    const engMixed = ENG_PLUGGED.replace(' P 0.900', ' 5-10-P 0.900');
    const [m] = parseEng(engMixed);
    expect(m!.delays).toBe('5,10,P');
    expect(delayOptions(exToDbEntry(m!))).toEqual([5, 10, Infinity]);
  });

  it('a delay list typed out of order still defaults to its longest, not to its last', () => {
    // The tester's rasp.eng lists I115W, I215R and I117FJ as "6-10-14-0"; read
    // in file order the "longest" was 0 s, a charge at burnout.
    const [m] = parseEng(ENG_PLUGGED.replace(' P 0.900', ' 6-10-14-0 0.900'));
    expect(m!.delays).toBe('6,10,14,0');
    const entry = exToDbEntry(m!);
    expect(delayOptions(entry)).toEqual([0, 6, 10, 14]);
    expect(defaultDelay(entry)).toBe(14);
  });
});

/**
 * The nozzle exit an .rse can carry (Eric, 2026-09-21). It is worth almost
 * nothing for catalogue motors and everything for a home-written EX file: of
 * 1,275 engine records in the local .rse corpus, 1,274 state exitDia="0." and
 * the one that does not is the Klima B2 reproduced below, byte for byte from
 * G:/Documents/Dropbox/Rocksim Engine Files/Klima.rse. An EX motor matches
 * nothing in the nozzle database, so the file is the only source it has.
 */
describe('a .rse nozzle exit diameter', () => {
  const rse = (attrs: string) => `<engine-database><engine-list>
  <engine mfg="Klima" code="B2" Type="single-use" dia="18." len="70." initWt="17."
    propWt="6." delays="0,4" ${attrs}>
   <data>
     <eng-data t="0" f="0" m="17"/>
     <eng-data t="0.5" f="2" m="14"/>
     <eng-data t="2.5" f="0" m="11"/>
   </data>
  </engine>
 </engine-list></engine-database>`;

  it('reads the real Klima B2 value, in MILLIMETRES', () => {
    // 5 mm on an 18 mm case. Inches would be a 5-inch exit on an 18 mm motor
    // and metres would be 5 m; only mm is physical, which is what settles the
    // unit the whole feature waited on.
    const [m] = parseRse(rse('throatDia="3.6" exitDia="5."'));
    expect(m!.exitDiameterM).toBeCloseTo(0.005, 9);
  });

  it('reads NOTHING from the 1,274 files that state zero', () => {
    const [m] = parseRse(rse('throatDia="0." exitDia="0."'));
    expect(m!.exitDiameterM).toBeUndefined();
  });

  it('reads nothing when the attribute is absent, as every .eng is', () => {
    const [m] = parseRse(rse(''));
    expect(m!.exitDiameterM).toBeUndefined();
  });

  it('REFUSES a value too small to be an exit plane — the inches case', () => {
    // A file meaning 1.5 INCHES on a 29 mm motor, read as 1.5 mm, is 1/645th
    // of the true area. It fails safe in the thrust term, but it is still
    // wrong, and a one-sided "smaller than the case" bound would pass it.
    const [m] = parseRse(rse('exitDia="1.5"'));
    expect(m!.exitDiameterM).toBeUndefined();
  });

  it('REFUSES a value that looks like the case diameter — the over-credit case', () => {
    // The only way a wrong number can ADD thrust it should not: the case OD
    // typed into the exit field.
    const [m] = parseRse(rse('exitDia="18."'));
    expect(m!.exitDiameterM).toBeUndefined();
  });

  it('takes the whole measured band and nothing outside it', () => {
    // The band is the shipped nozzle database’s own range, 0.1664 to 0.7094
    // of the case, with a little air either side.
    expect(exitDiameterFromRse(18 * EXIT_MIN_FRACTION_OF_CASE, 18))
      .toEqual({ exitDiameterM: 18 * EXIT_MIN_FRACTION_OF_CASE / 1000 });
    expect(exitDiameterFromRse(18 * EXIT_MAX_FRACTION_OF_CASE, 18))
      .toEqual({ exitDiameterM: 18 * EXIT_MAX_FRACTION_OF_CASE / 1000 });
    expect(exitDiameterFromRse(18 * 0.14, 18)).toHaveProperty('rejected');
    expect(exitDiameterFromRse(18 * 0.76, 18)).toHaveProperty('rejected');
  });

  it('says WHY it refused, so the number is not silently dropped', () => {
    const low = exitDiameterFromRse(1.5, 29) as { rejected: string };
    expect(low.rejected).toContain('too small');
    expect(low.rejected).toContain('inches');
    const high = exitDiameterFromRse(29, 29) as { rejected: string };
    expect(high.rejected).toContain('case diameter');
  });

  it('says so when it refuses one — the note the v0.137 notes and the guide promise', () => {
    // Audit 2026-09-22: the reason was built and thrown away, so an
    // inches-denominated file lost its exit with nothing said.
    const notes: string[] = [];
    const [m] = parseRse(rse('exitDia="1.5"'), notes);
    expect(m!.exitDiameterM).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^B2: its nozzle exit, exitDia 1\.5 \(only 8% of the 18 mm case.*inches.*was not used\.$/);
    const high: string[] = [];
    parseRse(rse('exitDia="18."'), high);
    expect(high[0]).toMatch(/case diameter/);
    // A believable exit, or none at all, has nothing to say.
    const none: string[] = [];
    parseRse(rse('throatDia="3.6" exitDia="5."'), none);
    parseRse(rse('exitDia="0."'), none);
    expect(none).toEqual([]);
  });

  it('ignores a throat entirely — nothing in the app reads one', () => {
    const [m] = parseRse(rse('throatDia="3.6" exitDia="5."'));
    expect(Object.keys(m!)).not.toContain('throatDiameterM');
    expect(JSON.stringify(m)).not.toMatch(/throat/i);
  });
});

/**
 * A full browser storage (audit 2026-09-22). `persist` swallowed the quota
 * error, the notice promised the motors "survive reloads", and every reader —
 * fetchMotorSpec's getExMotor among them — went back to storage, so the motor
 * could not fly even in the same session. A tester's 891-motor rasp.eng is
 * 753 KB of JSON; a near-full origin refuses it.
 */
describe('the EX library on a full storage', () => {
  /** A Map-backed localStorage whose setItem refuses the library key `refusals` times. */
  const quotaStorage = (refusals: number) => {
    const map = new Map<string, string>();
    let left = refusals;
    const store = {
      get length() { return map.size; },
      key: (i: number): string | null => [...map.keys()][i] ?? null,
      getItem: (k: string): string | null => map.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        if (k === 'online-openrocket.ex-motors.v1' && left > 0) {
          left--;
          const err = new Error('The quota has been exceeded.');
          err.name = 'QuotaExceededError';
          throw err;
        }
        map.set(k, v);
      },
      removeItem: (k: string): void => { map.delete(k); },
      clear: (): void => map.clear(),
    };
    vi.stubGlobal('localStorage', store);
    return map;
  };
  /** exMotors with its session state fresh — `unstored` is module-level by design. */
  const fresh = async () => { vi.resetModules(); return import('./exMotors.js'); };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('empties the downloaded-curve cache and tries again, and says it stored', async () => {
    const map = quotaStorage(1);
    map.set('tc:samples:v5:abc', '{"samples":[]}');
    map.set('tc:samples:v4:old', '{}');
    map.set('online-openrocket.session.v1', 'the user’s design');
    const ex = await fresh();
    const w = ex.addExMotors(parseEng(ENG));
    expect(w.stored).toBe(true);
    expect([...map.keys()].filter((k) => k.startsWith('tc:'))).toEqual([]);
    expect(map.get('online-openrocket.session.v1')).toBe('the user’s design'); // only the cache goes
    expect(ex.getExMotor(w.motors[0]!.motorId)).toBeDefined();
  });

  it('says stored: false when it still will not fit — and the motor still flies this session', async () => {
    quotaStorage(Infinity);
    const ex = await fresh();
    const w = ex.addExMotors(parseEng(ENG));
    expect(w.stored).toBe(false);
    const id = w.motors[0]!.motorId;
    // What fetchMotorSpec does for an ex: id — it used to find nothing here.
    expect(ex.getExMotor(id)?.designation).toBe('K550W');
    const { fetchMotorSpec } = await import('./thrustcurve.js');
    const spec = await fetchMotorSpec(ex.exToDbEntry(ex.getExMotor(id)!), 0);
    expect(spec.designation).toBe('K550W');
  });
});
