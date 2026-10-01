/**
 * motor-corrections.mjs: the sourced corrections to thrustcurve.org catalogue
 * rows (board Tier 1 row 6), and the three things that have to stay true of it.
 *
 *  1. It SHIPS TO BROWSERS — src/services/catalogueOverlay.ts imports it to
 *     correct a live pull the way the shipped catalogue is corrected — so it must
 *     import nothing, the same constraint and the same reasons as
 *     manufacturers.mjs (see manufacturers.browserSafe.test.mjs): vitest runs it
 *     under Node, tsc reads only the hand-written .d.mts, and vite externalises a
 *     node: import with a warning nobody reads. And the .d.mts is the only type
 *     surface the app sees, so the two must declare the same exports.
 *  2. EVERY FIGURE IS SOURCED from the manufacturer or a certifying body, quoted,
 *     with its URL — never from thrustcurve.org, where the error is.
 *  3. THE SHIPPED FILE AGREES WITH THE TABLE: motors.json holds every corrected
 *     figure, so the table can never describe a correction nobody applied.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mod from './motor-corrections.mjs';
import { MOTOR_CORRECTIONS, applyMotorCorrections, correctMotorRow } from './motor-corrections.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const IMPL = readFileSync(here('./motor-corrections.mjs'), 'utf8');
const DECL = readFileSync(here('./motor-corrections.d.mts'), 'utf8');
const code = IMPL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const shipped = JSON.parse(readFileSync(here('../src/data/motors.json'), 'utf8'));

describe('motor-corrections.mjs is browser-safe (catalogueOverlay.ts bundles it)', () => {
  it('imports nothing at all — static, dynamic or require', () => {
    expect([...code.matchAll(/^\s*import\b[^\n]*/gm)].map((m) => m[0].trim())).toEqual([]);
    expect([...code.matchAll(/\bimport\s*\(/g)]).toEqual([]);
    expect([...code.matchAll(/\brequire\s*\(/g)]).toEqual([]);
  });

  it('touches no Node-only global', () => {
    expect(/\bprocess\s*\./.test(code), 'process is undefined in the browser bundle').toBe(false);
    expect(/\b__dirname\b|\b__filename\b|\bBuffer\s*\./.test(code)).toBe(false);
  });

  it('has the app consumer it is documented as having', () => {
    // If this import goes away, the browser constraint goes with it.
    expect(readFileSync(here('../src/services/catalogueOverlay.ts'), 'utf8'))
      .toMatch(/from '\.\.\/\.\.\/scripts\/motor-corrections\.mjs'/);
  });

  it('declares in motor-corrections.d.mts exactly what it exports', () => {
    const declared = [...DECL.matchAll(/^export\s+(?:declare\s+)?(?:const|function|let|var)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1]).sort();
    expect(declared).toEqual(Object.keys(mod).sort());
  });
});

describe('every correction is sourced, and none from thrustcurve.org', () => {
  it.each(MOTOR_CORRECTIONS.map((c) => [`${c.manufacturer} ${c.designation}`, c]))('%s', (_name, c) => {
    expect(c.motorId).toMatch(/^[0-9a-f]{24}$/);
    expect(Object.keys(c.fields).length).toBeGreaterThan(0);
    for (const { bad, good } of Object.values(c.fields)) {
      expect(Number.isFinite(bad) && Number.isFinite(good) && bad !== good).toBe(true);
    }
    expect(c.why.length).toBeGreaterThan(40);
    expect(c.sources.length).toBeGreaterThan(0);
    for (const s of c.sources) {
      expect(s.url).toMatch(/^https?:\/\//);
      expect(s.url, 'thrustcurve.org is where the error is, so it cannot source its own correction')
        .not.toMatch(/thrustcurve\.org/);
      expect(s.by.length).toBeGreaterThan(10);
      expect(s.read).toMatch(/^\d{4}-\d\d-\d\d$/);
    }
    // Each corrected figure is printed in at least one source's quoted text, as printed: a letter's "16.10 N" is
    // the 16.1 the table holds. Trailing zeros only after a decimal point, where they change nothing.
    for (const { good } of Object.values(c.fields)) {
      const figure = String(good).replace('.', '\\.') + (String(good).includes('.') ? '0*' : '');
      expect(c.sources.some((s) => new RegExp(`(?<![\\d.])${figure}(?![\\d])`).test(s.says)),
        `no source quotes ${good}`).toBe(true);
    }
  });
});

describe('the shipped catalogue carries every correction', () => {
  it('holds the corrected figure on the row each entry names', () => {
    const byId = new Map(shipped.motors.map((m) => [m.motorId, m]));
    for (const c of MOTOR_CORRECTIONS) {
      const row = byId.get(c.motorId);
      expect(row, `${c.manufacturer} ${c.designation} (${c.motorId}) is not in motors.json: retire its entry from `
        + "motor-corrections.mjs, or move it to the motor's new id (a refresh refuses to write without it)").toBeDefined();
      expect([row.manufacturerAbbrev, row.designation]).toEqual([c.manufacturer, c.designation]);
      for (const [field, { good }] of Object.entries(c.fields)) expect(row[field], `${c.designation} ${field}`).toBe(good);
    }
  });

  it('is what applying the table to it again gives: nothing left to apply', () => {
    const again = applyMotorCorrections(shipped.motors);
    expect(again.applied).toEqual([]);
    expect(again.unexpected).toEqual([]);
    expect(again.missing).toEqual([]);
  });
});

describe('the contract: idempotent, and loud on surprise', () => {
  const [c] = MOTOR_CORRECTIONS;
  const [field, { bad, good }] = Object.entries(c.fields)[0];
  const row = (value) => ({ motorId: c.motorId, manufacturerAbbrev: c.manufacturer, designation: c.designation, [field]: value });

  it('corrects the known-bad figure, as a copy', () => {
    const input = row(bad);
    const out = correctMotorRow(input);
    expect(out[field]).toBe(good);
    expect(input[field]).toBe(bad);
  });

  it('returns the very row when nothing applies: the corrected figure, a third one, or another motor', () => {
    for (const r of [row(good), row(bad + 1), { motorId: 'another', [field]: bad }]) expect(correctMotorRow(r)).toBe(r);
  });

  it('reports each case for the refresh to judge', () => {
    const other = { motorId: 'another', [field]: bad };
    expect(applyMotorCorrections([row(bad), other])).toMatchObject({
      applied: [`${c.manufacturer} ${c.designation} ${field}: ${bad} -> ${good}`], already: [], unexpected: [],
    });
    expect(applyMotorCorrections([row(good)]).already).toHaveLength(1);
    const third = applyMotorCorrections([row(bad + 1)]);
    expect(third.unexpected).toEqual([
      `${c.manufacturer} ${c.designation} ${field} = ${bad + 1}, expected the known-bad ${bad} or the corrected ${good}`,
    ]);
    expect(third.motors[0][field]).toBe(bad + 1);
    expect(applyMotorCorrections([other]).missing).toHaveLength(MOTOR_CORRECTIONS.length);
  });
});
