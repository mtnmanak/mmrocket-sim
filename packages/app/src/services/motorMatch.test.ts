// @vitest-environment happy-dom
// happy-dom because motorMatch imports `builtInMeta` from components/MotorPicker,
// whose module graph reaches the React components and PrefsContext. Nothing here
// touches the DOM; this only keeps the import graph loadable.
import { describe, expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { findDbMotor, type MotorDbEntry } from './motorDb.js';
import type { OrkMotorRef } from './orkFile.js';
import {
  baseDesignation, builtInAllowedFor, builtInMatch, matchImportedMotor, refToExportMotor,
} from './motorMatch.js';

/** A .ork <motor> block as the importer hands it over. SI: metres, seconds. */
const ref = (over: Partial<OrkMotorRef> = {}): OrkMotorRef => ({
  designation: 'C6',
  manufacturer: 'Estes',
  diameter: 0.018,
  length: 0.07,
  delay: 5,
  ...over,
});

/** The three shipped built-ins, all 18 mm, as motors.ts declares them. */
const BUILT_INS: Record<string, MotorSpec> = {
  'A8-3': {
    designation: 'A8-3', diameter: 0.018, length: 0.07,
    times: [0, 0.5], thrusts: [0, 0], masses: [0.0163, 0.013], cgX: 0.035, ejectionDelay: 3,
  },
  'C6-5': {
    designation: 'C6-5', diameter: 0.018, length: 0.07,
    times: [0, 2], thrusts: [0, 0], masses: [0.024, 0.0132], cgX: 0.035, ejectionDelay: 5,
  },
};

const dbEntry = (over: Partial<MotorDbEntry> = {}): MotorDbEntry => ({
  motorId: 'x', manufacturerAbbrev: 'Estes', designation: 'C6', commonName: 'C6',
  impulseClass: 'C', diameter: 18, length: 70, type: 'SU',
  avgThrustN: 4.7, maxThrustN: 14.1, totImpulseNs: 8.82, burnTimeS: 1.86,
  totalWeightG: 25.5, propWeightG: 12.5, delays: '3,5,7', availability: 'regular',
  ...over,
});

const spec = (designation: string, ejectionDelay: number): MotorSpec => ({
  designation, diameter: 0.018, length: 0.07,
  times: [0, 1], thrusts: [0, 0], masses: [0.02, 0.01], cgX: 0.035, ejectionDelay,
});

describe('baseDesignation', () => {
  it('drops a bare delay suffix and nothing else', () => {
    expect(baseDesignation('C6-5')).toBe('c6');
    expect(baseDesignation('C6')).toBe('c6');
    expect(baseDesignation('H220-P')).toBe('h220');
    expect(baseDesignation(' B6-4 ')).toBe('b6');
    // A delay with a propellant letter is not a bare delay — left whole, which
    // simply means no built-in matches it. That is the safe direction.
    expect(baseDesignation('I224-15A')).toBe('i224-15a');
  });
});

describe('builtInAllowedFor', () => {
  it('accepts Estes, and the sentinels that name nobody', () => {
    expect(builtInAllowedFor('Estes')).toBe(true);
    expect(builtInAllowedFor('Estes Industries')).toBe(true);
    expect(builtInAllowedFor(undefined)).toBe(true);
    expect(builtInAllowedFor('unknown')).toBe(true);
    expect(builtInAllowedFor('custom')).toBe(true);
  });

  it('refuses every other vendor — the built-ins are Estes-class approximations', () => {
    for (const m of ['Apogee', 'Quest', 'Klima', 'AeroTech']) {
      expect(builtInAllowedFor(m), m).toBe(false);
    }
  });
});

describe('builtInMatch — the gates the old prefix test skipped', () => {
  it('matches an Estes C6 of either delay', () => {
    expect(builtInMatch(ref({ designation: 'C6' }), BUILT_INS)?.key).toBe('C6-5');
    expect(builtInMatch(ref({ designation: 'C6-7' }), BUILT_INS)?.key).toBe('C6-5');
  });

  /**
   * The shipped catalog has FOUR C6s: Apogee at 13 mm / 9.98 Ns and three
   * 18 mm ones (Estes 8.82, Klima 10, Quest 8.76). The built-in C6-5's own
   * curve integrates to 10.40 Ns, so before this gate an Apogee C6 file flew
   * a motor 5 mm too fat and 4 % hot — and was re-exported at 18 mm / 70 mm,
   * because the writer takes the substituted spec's dimensions.
   */
  it('refuses a built-in whose diameter is not the file’s', () => {
    expect(builtInMatch(ref({ designation: 'C6', diameter: 0.013 }), BUILT_INS)).toBeNull();
  });

  it('refuses a built-in when the file names another manufacturer', () => {
    expect(builtInMatch(ref({ designation: 'C6', manufacturer: 'Apogee' }), BUILT_INS)).toBeNull();
    expect(builtInMatch(ref({ designation: 'C6', manufacturer: 'Klima' }), BUILT_INS)).toBeNull();
  });

  it('matches on the BASE designation, not a prefix', () => {
    // 'C60' used to match 'C6-5' via key.startsWith(ref.designation) being
    // read the other way round; both directions of accident are closed.
    expect(builtInMatch(ref({ designation: 'C60' }), BUILT_INS)).toBeNull();
    expect(builtInMatch(ref({ designation: 'A' }), BUILT_INS)).toBeNull();
  });

  it('takes the file’s diameter default (18 mm) when the file carried none', () => {
    // orkFile's reader defaults <diameter> to 0.018 — the Estes case.
    expect(builtInMatch(ref({ designation: 'A8-3' }), BUILT_INS)?.key).toBe('A8-3');
  });
});

describe('matchImportedMotor — precedence', () => {
  it('takes the DATABASE motor, not the built-in approximation', async () => {
    const estesC6 = dbEntry();
    const fetchSpec = vi.fn(async () => spec('C6', 5));
    const res = await matchImportedMotor(ref(), {
      findDb: () => estesC6,
      fetchSpec,
      builtIns: BUILT_INS,
    });
    expect(fetchSpec).toHaveBeenCalledOnce();
    expect(res.motor?.label).toBe('C6-5');
    expect(res.motor?.meta.manufacturer).toBe('Estes');
    expect(res.approximated).toBeUndefined();
    expect(res.note).toContain('loaded from the motor database');
  });

  it('passes the file’s manufacturer and diameter to the database lookup', async () => {
    const findDb = vi.fn(() => null);
    await matchImportedMotor(ref({ manufacturer: 'Public Missiles', designation: 'G80T', diameter: 0.029 }), {
      findDb, builtIns: BUILT_INS,
    });
    expect(findDb).toHaveBeenCalledWith('G80T', 29, undefined, 'Public Missiles');
  });

  it('omits the diameter for a RockSim ref, which carries none (0)', async () => {
    const findDb = vi.fn(() => null);
    await matchImportedMotor(ref({ diameter: 0 }), { findDb, builtIns: BUILT_INS });
    expect(findDb).toHaveBeenCalledWith('C6', undefined, undefined, 'Estes');
  });

  it('falls back to the built-in when the curve will not download, and SAYS so', async () => {
    const res = await matchImportedMotor(ref(), {
      findDb: () => dbEntry(),
      fetchSpec: async () => { throw new Error('offline'); },
      builtIns: BUILT_INS,
    });
    expect(res.motor?.label).toBe('C6-5');
    expect(res.approximated).toBe(true);
    expect(res.note).toContain('approximation');
  });

  it('reports nothing loaded when the curve fails and no built-in may stand in', async () => {
    const res = await matchImportedMotor(ref({ manufacturer: 'Apogee', diameter: 0.013 }), {
      findDb: () => dbEntry({ manufacturerAbbrev: 'Apogee', diameter: 13 }),
      fetchSpec: async () => { throw new Error('offline'); },
      builtIns: BUILT_INS,
    });
    expect(res.motor).toBeUndefined();
    expect(res.note).toContain("couldn't be downloaded");
  });

  it('uses the built-in when the database has nothing at all', async () => {
    const res = await matchImportedMotor(ref(), { findDb: () => null, builtIns: BUILT_INS });
    expect(res.motor?.label).toBe('C6-5');
    expect(res.note).toContain('matched built-in');
    expect(res.approximated).toBeUndefined();
  });

  it('keeps the FILE’s ejection delay, plugged included', async () => {
    const five = await matchImportedMotor(ref({ delay: 7 }), {
      findDb: () => null, builtIns: BUILT_INS,
    });
    expect(five.motor?.spec.ejectionDelay).toBe(7);
    expect(five.motor?.label).toBe('C6-7');

    const plugged = await matchImportedMotor(ref({ delay: Infinity }), {
      findDb: () => null, builtIns: BUILT_INS,
    });
    expect(plugged.motor?.spec.ejectionDelay).toBe(Infinity);
    expect(plugged.motor?.label).toBe('C6-P');
  });

  it('carries the file’s motor identity onto the meta for write-back', async () => {
    const res = await matchImportedMotor(
      ref({ manufacturer: 'Estes Industries', motorType: 'single', digest: 'abc' }),
      { findDb: () => null, builtIns: BUILT_INS },
    );
    expect(res.motor?.meta.orkManufacturer).toBe('Estes Industries');
    expect(res.motor?.meta.orkType).toBe('single');
    expect(res.motor?.meta.orkDigest).toBe('abc');
  });

  it('never re-exports the reader’s own sentinels as a manufacturer', async () => {
    for (const m of ['unknown', 'custom']) {
      const res = await matchImportedMotor(ref({ manufacturer: m }), {
        findDb: () => null, builtIns: BUILT_INS,
      });
      expect(res.motor?.meta.orkManufacturer, m).toBeUndefined();
    }
  });

  it('carries the file’s ignition event and delay', async () => {
    const res = await matchImportedMotor(ref({ ignitionEvent: 'burnout', ignitionDelay: 1.5 }), {
      findDb: () => null, builtIns: BUILT_INS,
    });
    expect(res.motor?.ignition).toEqual({ event: 'burnout', delay: 1.5 });
  });
});

/**
 * The same three references against the REAL shipped catalog, because the whole
 * point of the reordering is which published curve a file ends up flying.
 * `fetchSpec` is stubbed — only the catalog choice is under test here.
 */
describe('matchImportedMotor against the shipped catalog', () => {
  const chosen = async (r: OrkMotorRef): Promise<string> => {
    let picked = '';
    await matchImportedMotor(r, {
      fetchSpec: async (m) => { picked = `${m.manufacturerAbbrev} ${m.totImpulseNs}`; return spec(m.designation, 5); },
    });
    return picked;
  };

  it('an Apogee C6 file flies Apogee’s 13 mm C6, not an 18 mm built-in', async () => {
    expect(await chosen(ref({ manufacturer: 'Apogee', diameter: 0.013, length: 0.083 })))
      .toBe('Apogee 9.98');
  });

  it('an Estes C6 file flies Estes’ published 8.82 Ns curve', async () => {
    expect(await chosen(ref())).toBe('Estes 8.82');
  });

  it('a Klima C6 file flies Klima’s, not Estes’, at the same 18 mm', async () => {
    expect(await chosen(ref({ manufacturer: 'Klima' }))).toBe('Klima 10');
  });
});

describe('findDbMotor with the file’s manufacturer', () => {
  /**
   * 18 designation+diameter groups in the shipped catalog span more than one
   * vendor, and the in-production entry won every one of them.
   */
  it('prefers the vendor the file names over the in-production tie-break', () => {
    expect(findDbMotor('G80T', 29)!.manufacturerAbbrev).toBe('AeroTech');
    expect(findDbMotor('G80T', 29, undefined, 'Public Missiles')!.manufacturerAbbrev).toBe('PML');
    expect(findDbMotor('E6', 24, undefined, 'AeroTech')!.manufacturerAbbrev).toBe('AeroTech');
    expect(findDbMotor('E6', 24, undefined, 'Apogee')!.manufacturerAbbrev).toBe('Apogee');
  });

  it('an unknown or absent manufacturer reproduces the old ordering exactly', () => {
    for (const m of [undefined, 'unknown', 'custom', 'Nobody Rocket Works']) {
      expect(findDbMotor('G80T', 29, undefined, m)!.manufacturerAbbrev, String(m))
        .toBe(findDbMotor('G80T', 29)!.manufacturerAbbrev);
    }
  });

  it('still ranks the designation match above the manufacturer', () => {
    // A manufacturer that names nothing in this group must not promote a worse
    // designation match from elsewhere.
    expect(findDbMotor('C6', 18, undefined, 'Quest')!.manufacturerAbbrev).toBe('Quest');
    expect(findDbMotor('C6', 18, undefined, 'Quest')!.designation.toLowerCase()).toBe('c6');
  });
});

describe('refToExportMotor', () => {
  it('writes the reference back whole', () => {
    expect(refToExportMotor(ref({
      designation: 'K550W', manufacturer: 'AeroTech', diameter: 0.054, length: 0.41,
      delay: 10, digest: 'deadbeef', motorType: 'reload',
      ignitionEvent: 'burnout', ignitionDelay: 2,
    }))).toEqual({
      designation: 'K550W', manufacturer: 'AeroTech', type: 'reload', digest: 'deadbeef',
      diameter: 0.054, length: 0.41, delay: 10, ignitionEvent: 'burnout', ignitionDelay: 2,
    });
  });

  it('drops the sentinel manufacturers rather than writing them into the file', () => {
    expect(refToExportMotor(ref({ manufacturer: 'unknown' })).manufacturer).toBeUndefined();
    expect(refToExportMotor(ref({ manufacturer: 'custom' })).manufacturer).toBeUndefined();
  });

  it('keeps a plugged delay as Infinity for the writer to render as "none"', () => {
    expect(refToExportMotor(ref({ delay: Infinity })).delay).toBe(Infinity);
  });
});
