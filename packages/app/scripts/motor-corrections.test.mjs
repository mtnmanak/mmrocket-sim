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
 *     with its URL — never from thrustcurve.org, where the error is — and STATED
 *     by two documents: a letter can be the one that is wrong, and a document
 *     that only bounds the figure is not a second statement of it. Eric's
 *     explicit N2700W-PS ruling is the one narrowly pinned exception below.
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

/** A figure as a source prints it, found whole: "375" in "54 x 375 |", never inside "1375", "375.5" or "3750". */
const printedIn = (printed, says) =>
  new RegExp(`(?<![\\d.])${printed.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(says.replace(/(?<=\d),(?=\d{3}\b)/g, ''));

/**
 * Whether a figure printed as `printed` can be `value` rounded: under one unit
 * of its last printed digit away, either way, which is where nearest, upward
 * and downward rounding all land (the NAR's list keeps whole millimetres, and
 * prints the K62N's 374.25 as 375). A hair under, so that float noise never
 * lets a figure a whole unit off through: 0.3 - 0.2 is 0.0999…98.
 */
const withinItsDigit = (printed, value) =>
  Math.abs(Number(printed) - value) < 10 ** -(printed.split('.')[1]?.length ?? 0) * (1 - 1e-9);

/**
 * TWO DOCUMENTS STATE EACH CORRECTED FIGURE, or this says why not ([] when
 * they do). A count of sources was not the rule: with the NAR's list taken out,
 * the K62N's letter and drawing passed one, though the drawing gives the case
 * alone, a floor under the length (verifier, 2026-10-01). A source that states a
 * figure names it in `states`, as it prints it, and seconds the correction only
 * if that agrees with it and rules out the known-bad figure, each to the
 * source's own last printed digit: AeroTech's "19 grams" for the B6W fits the
 * letter's 18.29 and the row's 19.3 alike, so it could second neither.
 */
function unseconded(c) {
  const problems = [];
  for (const s of c.sources) {
    for (const field of Object.keys(s.states ?? {})) {
      if (!Object.hasOwn(c.fields, field)) problems.push(`${s.by} states ${field}, which this entry does not correct`);
    }
  }
  for (const [field, figures] of Object.entries(c.fields)) {
    const seconding = [];
    for (const s of c.sources) {
      if (s.states?.[field] === undefined) continue;
      const problem = cannotSecond(s, field, figures);
      if (problem) problems.push(problem);
      else seconding.push(s);
    }
    if (new Set(seconding.map((s) => s.url)).size < 2) {
      problems.push(`${field}: one document is not enough to correct a row: a second has to state ${figures.good} too`);
    }
    if (!seconding.some((s) => Number(s.states[field]) === figures.good)) {
      problems.push(`${field}: no source prints ${figures.good} itself`);
    }
  }
  return problems;
}

/** Why the figure a source states cannot second a correction, or null when it can. */
function cannotSecond(s, field, { bad, good }) {
  const printed = s.states[field];
  if (typeof printed !== 'string' || !/^\d+(\.\d+)?$/.test(printed)) {
    return `${s.by}: ${field} ${JSON.stringify(printed)} is not a figure as printed, a string`;
  }
  if (!printedIn(printed, s.says)) return `${s.by} states ${field} ${printed}, which its quote does not print`;
  // A finer source may round to the chosen published figure: 74.57 N -> 74.6 N.
  const goodDigits = String(good).split('.')[1]?.length ?? 0;
  const roundsToGood = Number(Number(printed).toFixed(goodDigits)) === good;
  if (!withinItsDigit(printed, good) && !roundsToGood) return `${s.by} prints ${printed}, which is not ${good}`;
  if (withinItsDigit(printed, bad)) return `${s.by} prints ${printed}, which does not rule out the known-bad ${bad}`;
  return null;
}

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
    for (const s of c.sources) {
      expect(s.url).toMatch(/^https?:\/\//);
      expect(s.url, 'thrustcurve.org is where the error is, so it cannot source its own correction')
        .not.toMatch(/thrustcurve\.org/);
      expect(s.by.length).toBeGreaterThan(10);
      expect(s.read).toMatch(/^\d{4}-\d\d-\d\d$/);
    }
  });

  it.each(MOTOR_CORRECTIONS.map((c) => [`${c.manufacturer} ${c.designation}`, c]))(
    '%s: sources satisfy the two-document rule or the explicit N2700W-PS ruling', (_name, c) => {
      const problems = unseconded(c);
      if (c.motorId === '6623cf91f873440002ac6a28') {
        // Eric's explicit 2026-10-04 ruling, ONLY these two fields on this row.
        expect(c.fields).toEqual({ totImpulseNs: { bad: 10637, good: 10322 }, maxThrustN: { bad: 5553.5, good: 4624.6 } });
        expect(c.why).toContain('scoped exception to the two-document rule');
        expect(problems).toEqual([
          'totImpulseNs: one document is not enough to correct a row: a second has to state 10322 too',
          'maxThrustN: one document is not enough to correct a row: a second has to state 4624.6 too',
        ]);
        return;
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });

  it('refuses a second document that only bounds the figure, or cannot tell it from the known-bad one', () => {
    const k62n = MOTOR_CORRECTIONS.find((c) => c.designation === 'K62N');
    // The verifier's case: the letter and the drawing, the NAR's list taken out.
    expect(unseconded({ ...k62n, sources: k62n.sources.filter((s) => !s.by.startsWith('NAR')) }))
      .toEqual(['length: one document is not enough to correct a row: a second has to state 374.25 too']);
    // The B6W's two sources, were its letter ruled for (aerotech-certified.test.mjs, KNOWN).
    const b6w = {
      fields: { totalWeightG: { bad: 19.3, good: 18.29 } },
      sources: [
        {
          by: 'Tripoli Motor Testing certification letter for the Quest Q-Jet B6W, May 10, 2021',
          url: 'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/b6w%20cert%20letter_1656515965847.pdf',
          says: 'Loaded Mass 0.0403 lb 18.29 g',
          states: { totalWeightG: '18.29' },
        },
        {
          by: 'AeroTech, product page Q6123',
          url: 'https://aerotech-rocketry.com/products/product_8c4592e4-0080-de66-b83f-c7d806b6b954',
          says: 'Propellant Weight: 2.8 grams; Motor Weight: 19 grams',
          states: { totalWeightG: '19' },
        },
      ],
    };
    expect(unseconded(b6w)).toEqual([
      'AeroTech, product page Q6123 prints 19, which does not rule out the known-bad 19.3',
      'totalWeightG: one document is not enough to correct a row: a second has to state 18.29 too',
    ]);
  });

  it('reads a printed figure to its own last digit, either way, and never a whole unit off', () => {
    expect(withinItsDigit('375', 374.25)).toBe(true); // the NAR's whole millimetres, rounded up
    expect(withinItsDigit('112', 112.35)).toBe(true); // ... and down
    expect(withinItsDigit('375', 374)).toBe(false);
    expect(withinItsDigit('0.3', 0.2)).toBe(false); // 0.0999…98 apart in floating point: still a whole unit
    expect(withinItsDigit('374.25', 374.25)).toBe(true);
    expect(withinItsDigit('374.25', 374.2)).toBe(false);
    expect(printedIn('375', 'Dimensions (mm) 54 x 375 | Impulse')).toBe(true);
    expect(['1375 g', '375.5 mm', '3750'].map((says) => printedIn('375', says))).toEqual([false, false, false]);
    expect(printedIn('10322', '[10,322 N.s]')).toBe(true);
    const source = (printed) => ({ by: 'TMT', says: `${printed} N`, states: { maxThrustN: printed } });
    expect(cannotSecond(source('74.57'), 'maxThrustN', { bad: 64.33, good: 74.6 })).toBeNull();
    expect(cannotSecond(source('50.42'), 'maxThrustN', { bad: 43.51, good: 50.4 })).toBeNull();
    expect(cannotSecond(source('74.54'), 'maxThrustN', { bad: 64.33, good: 74.6 })).not.toBeNull();
    expect(cannotSecond(source('74.57'), 'maxThrustN', { bad: 74.57, good: 74.6 })).not.toBeNull();
  });
});

describe('Tier 0 row 57 rulings, 2026-10-04', () => {
  it.each([
    ['F52C', { maxThrustN: { bad: 64.33, good: 74.6 } }],
    ['H13ST', { maxThrustN: { bad: 43.51, good: 50.4 } }],
    ['N2700W-PS', { totImpulseNs: { bad: 10637, good: 10322 }, maxThrustN: { bad: 5553.5, good: 4624.6 } }],
  ])('%s corrects exactly the ruled fields', (designation, fields) => {
    const c = MOTOR_CORRECTIONS.find((c) => c.designation === designation);
    expect(c?.fields).toEqual(fields);
    const row = shipped.motors.find((m) => m.motorId === c.motorId);
    const before = { ...row, ...Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, v.bad])) };
    expect(correctMotorRow(before)).toEqual(row);
    expect(applyMotorCorrections([before]).applied).toHaveLength(Object.keys(fields).length);
  });

  it('keeps J99N and B6W unchanged when their conditions are not met', () => {
    expect(MOTOR_CORRECTIONS.some((c) => ['J99N', 'B6W'].includes(c.designation))).toBe(false);
    expect(shipped.motors.find((m) => m.designation === 'J99N')).toMatchObject({
      totImpulseNs: 945.2, maxThrustN: 151.95, propWeightG: 556, burnTimeS: 10.2,
    });
    expect(shipped.motors.find((m) => m.designation === 'B6W')).toMatchObject({ totalWeightG: 19.3 });
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
