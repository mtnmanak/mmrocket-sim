// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { exToDbEntry, impulseClassOf, parseEng, parseRse } from './exMotors.js';

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

  it('keeps per-sample masses when they are all really there', () => {
    const xml = rse(
      'code="EX-MASS" mfg="Home" dia="29" len="120" initWt="100" propWt="50" delays="5"',
      '<eng-data t="0" f="0" m="100"/><eng-data t="0.5" f="60" m="75"/><eng-data t="1" f="0" m="50"/>',
    );
    const [m] = parseRse(xml);
    expect(m!.sampleMassesKg).toEqual([0.1, 0.075, 0.05]);
  });

  it('refuses a file with no initial mass instead of importing a 0 g motor', () => {
    const xml = rse(
      'code="EX-NOINIT" mfg="Home" dia="29" len="120" propWt="50" delays="5"',
      '<eng-data t="0" f="0"/><eng-data t="1" f="0"/>',
    );
    expect(() => parseRse(xml)).toThrow(/initial mass/i);
  });
});
