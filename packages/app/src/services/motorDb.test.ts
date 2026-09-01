import { describe, expect, it } from 'vitest';
import {
  MOTOR_DB, allClasses, classLabel, classesFittingMount, diameterClass,
  displayDesignation, filterMotors, findDbMotor, impulseClassesForMount, impulseLetter,
  manufacturersForMount, nearestCommonClass, propellantsForMount, rangesForMount, sortMotors,
} from './motorDb.js';

describe('bundled motor database', () => {
  it('is present and substantial', () => {
    expect(MOTOR_DB.length).toBeGreaterThan(1000);
  });

  it('has both regular and OOP motors', () => {
    expect(MOTOR_DB.some((m) => m.availability === 'regular')).toBe(true);
    expect(MOTOR_DB.some((m) => m.availability === 'OOP')).toBe(true);
  });
});

describe('nearestCommonClass (the Scale tool\u2019s question)', () => {
  it('answers "what should I scale to", which diameterClass deliberately does not', () => {
    // diameterClass leaves an odd diameter alone on purpose (it classifies a
    // CATALOGUED motor); nearestCommonClass always names a real casing size.
    expect(diameterClass(45)).toBe(45);
    expect(nearestCommonClass(45)).toBe(38);
    // The Apogee worked example: 18 mm scaled 2.27x.
    expect(nearestCommonClass(40.86)).toBe(38);
  });

  it('rounds a TIE DOWN to the smaller class \u2014 the safe direction', () => {
    // 26.5 is exactly between 24 and 29. A mount slightly too small can be
    // opened out; one too big cannot be made smaller. This is the documented
    // rule and it had no test.
    expect(nearestCommonClass(26.5)).toBe(24);  // exact tie 24/29 -> down
    expect(nearestCommonClass(46)).toBe(38);    // exact tie 38/54 -> down
    expect(nearestCommonClass(46.5)).toBe(54);  // NOT a tie: 7.5 vs 8.5, so up
  });

  it('clamps to the ends rather than inventing a class', () => {
    expect(nearestCommonClass(1)).toBe(6);
    expect(nearestCommonClass(400)).toBe(152);
  });

  it('never returns a size the 75/76 rule would confuse', () => {
    expect(nearestCommonClass(76)).toBe(75);
    expect(classLabel(nearestCommonClass(76))).toBe('75/76');
  });
});

describe('diameter classes', () => {
  it('treats 75 and 76 mm as the same class (AeroTech vs Loki casings)', () => {
    expect(diameterClass(75)).toBe(75);
    expect(diameterClass(76)).toBe(75);
    expect(classLabel(75)).toBe('75/76');
  });

  it('snaps near-common diameters within tolerance', () => {
    expect(diameterClass(38)).toBe(38);
    expect(diameterClass(37.5)).toBe(38);
    expect(diameterClass(29.5)).toBe(29);
  });

  it('leaves genuinely odd diameters as their own class', () => {
    expect(diameterClass(10.5)).toBe(10.5);
    expect(diameterClass(32)).toBe(32);
    expect(diameterClass(64)).toBe(64);
  });

  it('adapter logic: a 38 mm mount fits 38/29/24… but never 54', () => {
    const classes = classesFittingMount(38.5);
    expect(classes).toContain(38);
    expect(classes).toContain(29);
    expect(classes).toContain(24);
    expect(classes).not.toContain(54);
  });

  it('a 75 mm mount accepts 76 mm-labelled motors', () => {
    const fits = filterMotors({
      manufacturers: new Set(), classes: new Set([75]), boreMm: 76,
      includeOOP: true, text: '',
    });
    expect(fits.some((m) => m.diameter === 76)).toBe(true);
    expect(fits.some((m) => m.diameter === 75)).toBe(true);
  });
});

describe('filtering and sorting', () => {
  const base = {
    manufacturers: new Set<string>(), classes: new Set<number>(),
    boreMm: 39, includeOOP: false, text: '',
  };

  it('hides OOP unless toggled on', () => {
    const without = filterMotors(base);
    const withOOP = filterMotors({ ...base, includeOOP: true });
    expect(withOOP.length).toBeGreaterThan(without.length);
    expect(without.every((m) => m.availability === 'regular')).toBe(true);
  });

  it('manufacturer and class toggles narrow the list', () => {
    const only = filterMotors({
      ...base, manufacturers: new Set(['AeroTech']), classes: new Set([29, 38]),
    });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((m) => m.manufacturerAbbrev === 'AeroTech')).toBe(true);
    expect(only.every((m) => [29, 38].includes(diameterClass(m.diameter)))).toBe(true);
  });

  it('text search matches designation and common name', () => {
    const hits = filterMotors({ ...base, includeOOP: true, text: 'h128' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) =>
      m.designation.toLowerCase().includes('h128') || m.commonName.toLowerCase().includes('h128'),
    )).toBe(true);
  });

  it('sorts by burn time and impulse both directions', () => {
    const list = filterMotors({ ...base, includeOOP: true });
    const byBurn = sortMotors(list, 'burnTimeS', 1);
    expect(byBurn[0]!.burnTimeS).toBeLessThanOrEqual(byBurn[byBurn.length - 1]!.burnTimeS);
    const byImpulse = sortMotors(list, 'totImpulseNs', -1);
    expect(byImpulse[0]!.totImpulseNs).toBeGreaterThanOrEqual(byImpulse[byImpulse.length - 1]!.totImpulseNs);
  });

  it('manufacturersForMount lists only manufacturers with fitting motors', () => {
    const mfrs = manufacturersForMount(18.5, false);
    expect(mfrs.some((m) => m.abbrev === 'Estes')).toBe(true);
    for (const { count } of mfrs) expect(count).toBeGreaterThan(0);
  });

  it('every DB class is reachable through some mount size', () => {
    expect(classesFittingMount(200).length).toBe(allClasses().length);
  });

  it('the cached default answer cannot be corrupted by a caller', () => {
    // allClasses() is derived once for the default argument and handed back as
    // a COPY. Returning the cache itself would work perfectly until the day
    // some caller sorted or spliced the result in place, at which point every
    // later caller — the motor browser's filters, the Scale dialog's fit
    // check — would silently see the mangled list. Nothing mutates it today,
    // which is exactly why the contract needs a test rather than a habit.
    const first = allClasses();
    const expected = [...first];
    first.length = 0;
    first.push(-1);
    expect(allClasses()).toEqual(expected);
    // …and the cache is still the same answer as a fresh uncached derivation.
    expect(allClasses()).toEqual(allClasses(MOTOR_DB.slice()));
  });
});

describe('display designations (the owner\'s cleanup rules)', () => {
  it('strips the Cesaroni total-impulse prefix', () => {
    expect(displayDesignation('381I224-15A', 'Cesaroni')).toBe('I224-15A');
    expect(displayDesignation('10347N10000-P', 'Cesaroni')).toBe('N10000-P');
    expect(displayDesignation('107G83-14A', 'Cesaroni')).toBe('G83-14A');
  });

  it('leaves non-Cesaroni leading digits alone (Estes 1/2A etc.)', () => {
    expect(displayDesignation('1/2A6', 'Estes')).toBe('1/2A6');
    expect(displayDesignation('G80T', 'AeroTech')).toBe('G80T');
  });

  it('strips HP- prefixes regardless of manufacturer', () => {
    expect(displayDesignation('HP-I140W', 'AeroTech')).toBe('I140W');
    expect(displayDesignation('HP-G75M', 'Loki')).toBe('G75M');
  });

  it('every Cesaroni motor in the DB cleans to letter-first', () => {
    for (const m of MOTOR_DB.filter((m) => m.manufacturerAbbrev === 'Cesaroni')) {
      expect(displayDesignation(m.designation, 'Cesaroni')).toMatch(/^[A-O]\d/);
    }
  });
});

describe('findDbMotor (.ork motor matching)', () => {
  it('finds an exact designation (the G80T case from the owner\'s report)', () => {
    const m = findDbMotor('G80T');
    expect(m).not.toBeNull();
    expect(m!.manufacturerAbbrev).toBe('AeroTech');
  });

  it('finds Cesaroni motors by display designation', () => {
    const m = findDbMotor('I224-15A');
    expect(m?.designation).toBe('381I224-15A');
  });

  it('uses the file diameter to disambiguate', () => {
    const m = findDbMotor('G80T', 29);
    expect(m).not.toBeNull();
    expect(Math.abs(m!.diameter - 29)).toBeLessThanOrEqual(1.5);
  });

  it('returns null for fantasy motors', () => {
    expect(findDbMotor('Z9999-XX')).toBeNull();
    expect(findDbMotor('')).toBeNull();
  });
});

/**
 * v0.081 filters (owner, 2026-08-30): impulse class first — "often users want
 * to just be able to see H motors" — plus a fits-my-rocket length cut and
 * propellant, the last folded behind "All filters".
 */
describe('impulse-class filtering', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };

  it('reads the letter off the catalog class, ignoring case and padding', () => {
    expect(impulseLetter({ impulseClass: 'H' } as never)).toBe('H');
    expect(impulseLetter({ impulseClass: ' i ' } as never)).toBe('I');
    expect(impulseLetter({ impulseClass: '' } as never)).toBe('');
    expect(impulseLetter({} as never)).toBe('');
  });

  it('offers the classes that actually fit a 29 mm mount, with counts', () => {
    const cs = impulseClassesForMount(29, false);
    expect(cs.length).toBeGreaterThan(2);
    expect(cs.map((c) => c.letter)).toEqual([...cs.map((c) => c.letter)].sort());
    expect(cs.every((c) => c.count > 0)).toBe(true);
    // A 29 mm mount is squarely H/I territory.
    expect(cs.some((c) => c.letter === 'H' || c.letter === 'I')).toBe(true);
  });

  it('returns only the chosen class', () => {
    const got = filterMotors({ ...base, impulse: new Set(['H']), boreMm: 29, includeOOP: false });
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((m) => impulseLetter(m) === 'H')).toBe(true);
  });

  it('an empty class set means all of them', () => {
    const all = filterMotors({ ...base, boreMm: 29, includeOOP: false });
    const empty = filterMotors({ ...base, impulse: new Set(), boreMm: 29, includeOOP: false });
    expect(empty.length).toBe(all.length);
  });
});

describe('the "only motors that fit" length cut', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };

  it('drops motors longer than the stated room, keeping the rest', () => {
    const all = filterMotors({ ...base, boreMm: 29, includeOOP: false });
    const fits = filterMotors({ ...base, boreMm: 29, includeOOP: false, maxLengthM: 0.15 });
    expect(fits.length).toBeGreaterThan(0);
    expect(fits.length).toBeLessThan(all.length);
    // Catalog lengths are millimetres.
    expect(fits.every((m) => m.length <= 150 + 1e-6)).toBe(true);
  });

  it('null means no length filtering at all — the browser flags instead', () => {
    const all = filterMotors({ ...base, boreMm: 29, includeOOP: false });
    const nulled = filterMotors({ ...base, boreMm: 29, includeOOP: false, maxLengthM: null });
    expect(nulled.length).toBe(all.length);
  });

  it('keeps a motor exactly at the limit', () => {
    const one = filterMotors({ ...base, boreMm: 29, includeOOP: false })
      .reduce((a, b) => (a.length > b.length ? a : b));
    const got = filterMotors({ ...base, boreMm: 29, includeOOP: false, maxLengthM: one.length / 1000 });
    expect(got.some((m) => m.designation === one.designation)).toBe(true);
  });
});

describe('propellant filtering', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };

  it('offers propellants commonest first', () => {
    const ps = propellantsForMount(29, false);
    expect(ps.length).toBeGreaterThan(1);
    for (let i = 1; i < ps.length; i++) expect(ps[i - 1]!.count).toBeGreaterThanOrEqual(ps[i]!.count);
  });

  it('returns only the chosen propellant', () => {
    const top = propellantsForMount(29, false)[0]!;
    const got = filterMotors({ ...base, propellants: new Set([top.name]), boreMm: 29, includeOOP: false });
    expect(got.length).toBe(top.count);
    expect(got.every((m) => (m.propInfo ?? '').trim() === top.name)).toBe(true);
  });
});

/**
 * Burn-time and impulse windows (owner, 2026-08-30b): "show me motors that
 * have a burn time from 0.0sec - 2.4sec". Typed bounds rather than sliders —
 * the impulse span for one mount runs three orders of magnitude, which no
 * two-ended slider handles usefully.
 */
describe('burn-time and impulse windows', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };
  const all = () => filterMotors({ ...base, boreMm: 29, includeOOP: false });

  it("reports the span the mount's motors actually cover", () => {
    const r = rangesForMount(29, false)!;
    expect(r).not.toBeNull();
    expect(r.burnS[0]).toBeGreaterThan(0);
    expect(r.burnS[1]).toBeGreaterThan(r.burnS[0]);
    expect(r.impulseNs[1]).toBeGreaterThan(r.impulseNs[0]);
  });

  it('keeps only motors inside a burn-time window, inclusive', () => {
    const got = filterMotors({ ...base, boreMm: 29, includeOOP: false, burnS: { min: 0, max: 2.4 } });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(all().length);
    expect(got.every((m) => m.burnTimeS <= 2.4 + 1e-9)).toBe(true);
  });

  it('takes one bound on its own', () => {
    const lo = filterMotors({ ...base, boreMm: 29, includeOOP: false, burnS: { min: 3, max: null } });
    expect(lo.every((m) => m.burnTimeS >= 3 - 1e-9)).toBe(true);
    expect(lo.length).toBeGreaterThan(0);
    const hi = filterMotors({ ...base, boreMm: 29, includeOOP: false, impulseNs: { min: null, max: 200 } });
    expect(hi.every((m) => m.totImpulseNs <= 200 + 1e-9)).toBe(true);
  });

  it('two null bounds filter nothing', () => {
    const got = filterMotors({
      ...base, boreMm: 29, includeOOP: false,
      burnS: { min: null, max: null }, impulseNs: { min: null, max: null },
    });
    expect(got.length).toBe(all().length);
  });

  it('combines with the class filter rather than replacing it', () => {
    const got = filterMotors({
      ...base, boreMm: 29, includeOOP: false,
      impulse: new Set(['H']), burnS: { min: 0, max: 1.5 },
    });
    expect(got.every((m) => impulseLetter(m) === 'H' && m.burnTimeS <= 1.5 + 1e-9)).toBe(true);
  });
});
