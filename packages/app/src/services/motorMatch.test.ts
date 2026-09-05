import { describe, expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { findDbMotor, type MotorDbEntry } from './motorDb.js';
import type { OrkMotorRef } from './orkFile.js';
import {
  baseDesignation, loadCatalogueMotor, matchImportedMotor, mountMotorFromDb, refToExportMotor,
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
    // A delay with a propellant letter is not a bare delay — left whole.
    expect(baseDesignation('I224-15A')).toBe('i224-15a');
  });
});

describe('matchImportedMotor — the database, and nothing below it', () => {
  it('loads the database motor with its published curve', async () => {
    const estesC6 = dbEntry();
    const fetchSpec = vi.fn(async () => spec('C6', 5));
    const res = await matchImportedMotor(ref(), { findDb: () => estesC6, fetchSpec });
    expect(fetchSpec).toHaveBeenCalledOnce();
    expect(res.motor?.label).toBe('C6-5');
    expect(res.motor?.meta.manufacturer).toBe('Estes');
    expect(res.approximated).toBeUndefined();
    expect(res.note).toContain('loaded from the motor database');
  });

  it('passes the file’s manufacturer and diameter to the database lookup', async () => {
    const findDb = vi.fn(() => null);
    await matchImportedMotor(ref({ manufacturer: 'Public Missiles', designation: 'G80T', diameter: 0.029 }), { findDb });
    expect(findDb).toHaveBeenCalledWith('G80T', 29, undefined, 'Public Missiles');
  });

  it('omits the diameter for a RockSim ref, which carries none (0)', async () => {
    const findDb = vi.fn(() => null);
    await matchImportedMotor(ref({ diameter: 0 }), { findDb });
    expect(findDb).toHaveBeenCalledWith('C6', undefined, undefined, 'Estes');
  });

  // THE RULING OF 2026-09-05. Until then a curve that would not load fell back
  // to one of three hand-written approximations. Now nothing is loaded and the
  // note says exactly that. A wrong curve flown silently is the worse outcome.
  it('loads NOTHING when the curve cannot be had, and never substitutes', async () => {
    const res = await matchImportedMotor(ref(), {
      findDb: () => dbEntry(),
      fetchSpec: async () => { throw new Error('offline'); },
    });
    expect(res.motor).toBeUndefined();
    expect(res.approximated).toBeUndefined();
    expect(res.note).toContain('has no thrust curve');
  });

  it('loads NOTHING when the database has no such motor', async () => {
    const res = await matchImportedMotor(ref(), { findDb: () => null });
    expect(res.motor).toBeUndefined();
    expect(res.note).toContain("isn't in the motor database");
  });

  it('keeps the FILE’s ejection delay, plugged included', async () => {
    const seven = await matchImportedMotor(ref({ delay: 7 }), {
      findDb: () => dbEntry(), fetchSpec: async (_m, d) => spec('C6', d),
    });
    expect(seven.motor?.spec.ejectionDelay).toBe(7);
    expect(seven.motor?.label).toBe('C6-7');

    const plugged = await matchImportedMotor(ref({ delay: Infinity }), {
      findDb: () => dbEntry(), fetchSpec: async (_m, d) => spec('C6', d),
    });
    expect(plugged.motor?.spec.ejectionDelay).toBe(Infinity);
    expect(plugged.motor?.label).toBe('C6-P');
  });

  it('carries the file’s motor identity onto the meta for write-back', async () => {
    const res = await matchImportedMotor(
      ref({ manufacturer: 'Estes Industries', motorType: 'single', digest: 'abc' }),
      { findDb: () => dbEntry(), fetchSpec: async () => spec('C6', 5) },
    );
    expect(res.motor?.meta.orkManufacturer).toBe('Estes Industries');
    expect(res.motor?.meta.orkType).toBe('single');
    expect(res.motor?.meta.orkDigest).toBe('abc');
  });

  it('never re-exports the reader’s own sentinels as a manufacturer', async () => {
    for (const m of ['unknown', 'custom']) {
      const res = await matchImportedMotor(ref({ manufacturer: m }), {
        findDb: () => dbEntry(), fetchSpec: async () => spec('C6', 5),
      });
      expect(res.motor?.meta.orkManufacturer, m).toBeUndefined();
    }
  });

  it('carries the file’s ignition event and delay', async () => {
    const res = await matchImportedMotor(ref({ ignitionEvent: 'burnout', ignitionDelay: 1.5 }), {
      findDb: () => dbEntry(), fetchSpec: async () => spec('C6', 5),
    });
    expect(res.motor?.ignition).toEqual({ event: 'burnout', delay: 1.5 });
  });
});

describe('mountMotorFromDb / loadCatalogueMotor — the one place a mounted motor is built', () => {
  it('names the motor by common name and delay, P for plugged', () => {
    const ign = { event: 'automatic' as const, delay: 0 };
    expect(mountMotorFromDb(dbEntry(), spec('C6', 5), 5, ign).label).toBe('C6-5');
    expect(mountMotorFromDb(dbEntry(), spec('C6', Infinity), Infinity, ign).label).toBe('C6-P');
  });

  it('fills the meta from the catalogue entry', () => {
    const m = mountMotorFromDb(dbEntry({ propInfo: 'black powder', caseInfo: '' }), spec('C6', 5), 5,
      { event: 'automatic', delay: 0 });
    expect(m.meta.manufacturer).toBe('Estes');
    expect(m.meta.availableDelays).toEqual([3, 5, 7]);
    expect(m.meta.propellant).toBe('black powder');
    expect(m.meta.type).toBe('SU');
  });

  it('loads a named catalogue motor, or null when the catalogue lacks it', async () => {
    const fetchSpec = vi.fn(async (_m: MotorDbEntry, d: number) => spec('C6', d));
    const got = await loadCatalogueMotor('Estes', 'C6', 5, { findDb: () => dbEntry(), fetchSpec });
    expect(got?.label).toBe('C6-5');
    expect(fetchSpec).toHaveBeenCalledOnce();
    expect(await loadCatalogueMotor('Nobody', 'Z9', 1, { findDb: () => null, fetchSpec })).toBeNull();
  });

  it('asks the real catalogue for Estes C6 and gets Estes, not Apogee or Klima', () => {
    // The starter motor for a new design goes through this lookup; a
    // manufacturer-blind match here would be the day-one bug in a new coat.
    const db = findDbMotor('C6', undefined, undefined, 'Estes')!;
    expect(db.manufacturerAbbrev).toBe('Estes');
    expect(db.totImpulseNs).toBe(8.82);
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

  it('an Apogee C6 file flies Apogee’s 13 mm C6', async () => {
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
