import { describe, expect, it } from 'vitest';
import {
  MOTOR_DB, allClasses, classLabel, classesFittingMount, diameterClass,
  filterMotors, manufacturersForMount, sortMotors,
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
});
