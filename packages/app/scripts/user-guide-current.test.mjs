/**
 * The committed packages/app/src/data/userGuide.ts must be exactly what
 * scripts/build-user-guide.mjs compiles from the markdown and the shipped motor
 * data TODAY (audit 2026-09-22, Tests row 526).
 *
 * WHY THE COMMITTED COPY MATTERS when every deploy recompiles it: the deploy runs
 * `npm test` BEFORE `npm run build`, so GuideDialog.test.tsx and anything else
 * that imports GUIDE_SECTIONS test whatever was last committed; and the guide's
 * {{TOKENS}} (motor counts, the catalogue date, the curve shares) are compiled
 * from motors.json and motorCurves.json, which the weekly refresh rewrites. A
 * refresh that committed only the JSON left the repo's guide quoting the
 * previous catalogue until some unrelated build happened to rewrite it. Since
 * 2026-10-01 the nozzle coverage comes from nozzles.json the same way, and that
 * file is rebuilt by hand on one machine, so a rebuild that skips the guide is
 * caught here too.
 *
 * NOT FLAKY BY CONSTRUCTION: the compile is a pure function of four committed
 * files (no clock, no network, no locale beyond the pinned 'en-US'), and the
 * comparison ignores only a Windows checkout's CRLF, which git's autocrlf adds
 * and removes and the generator never writes.
 *
 * The fix when this fails is always the same, and the message says it:
 *   node scripts/build-user-guide.mjs
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DATA, GuideError, OUT, SRC, compileGuide, motorCorrectionsSentence,
} from '../../../scripts/build-user-guide.mjs';
import { MOTOR_CORRECTIONS } from './motor-corrections.mjs';

const committed = () => readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');

describe('glossary anchors', () => {
  const markdown = '<a id="glossary"></a>\n## Glossary\n\n### A–F\n\n**Alpha (A)** — One.\n\n**Fin** — Two.\n\n**Flutter** — Three.\n\n## Table\nNotes.\n\n**Bold prose** without an entry separator.\n';
  it('generates stable entry anchors and first-entry letter links, with disabled absent letters', () => {
    const { ts } = compileGuide({ markdown });
    const html = JSON.parse(ts.match(/"html": (".*")/)[1]);
    expect(html).toContain('<p id="glossary-alpha-a" tabindex="-1"><strong>Alpha (A)</strong>');
    expect(html).toContain('<a href="#glossary-fin" aria-label="Glossary: F">F</a>');
    expect(html).not.toContain('href="#glossary-flutter"');
    expect(html).toContain('<span aria-disabled="true">B</span>');
    expect(html).not.toContain('glossary-table');
    expect(html).not.toContain('glossary-bold-prose');
    expect(compileGuide({ markdown: markdown.replace('**Fin**', '**Beta** — New.\n\n**Fin**') }).ts).toContain('glossary-fin');
    const other = compileGuide({ markdown: markdown.replace('id="glossary"', 'id="other"') }).ts;
    expect(other).not.toContain('guide-letters');
    expect(other).not.toContain('glossary-fin');
  });
  it('refuses empty and colliding glossary ids', () => {
    expect(() => compileGuide({ markdown: markdown.replace('Flutter', 'Fin!') })).toThrow(/duplicate glossary anchor/);
    expect(() => compileGuide({ markdown: markdown.replace('Flutter', '?!') })).toThrow(/empty or duplicate glossary anchor/);
    expect(() => compileGuide({ markdown: '<a id="glossary"></a>\n## Glossary\n' })).toThrow(/has no content/);
  });
});

describe('bare-figure check', () => {
  // A section needs its anchor; the current value of a count token is read back
  // through the compiler itself.
  const doc = (body) => `<a id="s"></a>\n## S\n\n${body}`;
  const tokenValue = (key) => {
    const { ts } = compileGuide({ markdown: doc(`X{{${key}}}Y`) });
    return JSON.parse(ts.match(/"html": (".*")/)[1]).match(/X([\d,]+)Y/)[1];
  };
  it('reads a figure glued to a letter as a designation, and still refuses the bare count', () => {
    const n = tokenValue('CURVE_MISSING');
    expect(() => compileGuide({ markdown: doc(`A makerless G${n} loads the other maker's motor.`) })).not.toThrow();
    expect(() => compileGuide({ markdown: doc(`${n} have no published curve.`) })).toThrow(/typed by hand/);
  });
});

describe('the committed userGuide.ts is current', () => {
  it('matches a fresh compile of user-guide.md and the shipped motor data, byte for byte', () => {
    const { ts } = compileGuide();
    // Not toBe(): a 50 kB string diff is unreadable, and the remedy is one command.
    if (ts !== committed()) {
      expect.fail('packages/app/src/data/userGuide.ts is stale: it is not what user-guide.md and the '
        + 'shipped motors.json / motorCurves.json / nozzles.json compile to. Run `node scripts/build-user-guide.mjs` '
        + 'and commit the result.');
    }
    expect(ts).toBe(committed());
  });

  it('is a pure function of its inputs: two compiles agree', () => {
    expect(compileGuide().ts).toBe(compileGuide().ts);
  });

  it('is recompiled by `npm run motors:refresh`, after both data files it quotes', () => {
    // Every "run `npm run motors:refresh`" remedy in the repo (check-upstream,
    // motor-db-age.test.mjs, motor-diff-summary) is a hand-run refresh. If the
    // script wrote only the JSON, committing its output as told would fail the
    // first test in this file on the deploy. The weekly workflow runs the same
    // script, so this is the one place the order lives.
    const pkg = JSON.parse(readFileSync(join(DATA, '..', '..', '..', '..', 'package.json'), 'utf8'));
    const steps = pkg.scripts['motors:refresh'].split('&&').map((s) => s.trim());
    expect(steps).toEqual([
      'node packages/app/scripts/fetch-motor-db.mjs',
      'node packages/app/scripts/fetch-motor-curves.mjs',
      'node scripts/build-user-guide.mjs',
    ]);
  });
});

describe('the check can see what it exists to see', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-current-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a catalogue refresh without a recompile reads as stale', () => {
    // The refresh stamps a new `generated` date into motors.json; the guide
    // prints it as {{MOTOR_DB_DATE}}. Nothing else changes, and that alone
    // must be enough to make the committed file stale.
    copyFileSync(join(DATA, 'motorCurves.json'), join(dir, 'motorCurves.json'));
    copyFileSync(join(DATA, 'nozzles.json'), join(dir, 'nozzles.json'));
    const motors = JSON.parse(readFileSync(join(DATA, 'motors.json'), 'utf8'));
    const refreshed = motors.generated === '2099-01-04' ? '2099-01-05' : '2099-01-04';
    writeFileSync(join(dir, 'motors.json'), JSON.stringify({ ...motors, generated: refreshed }));
    const { ts } = compileGuide({ dataDir: dir });
    expect(ts).not.toBe(committed());
    expect(ts).toContain(refreshed === '2099-01-04' ? '4 January 2099' : '5 January 2099');
  });

  it('an edited markdown without a recompile reads as stale', () => {
    const md = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const at = md.indexOf('\n## ', md.indexOf('<a id='));
    const edited = `${md.slice(0, at + 1)}## ${md.slice(at + 4).replace(/\n/, ' (edited)\n')}`;
    expect(compileGuide({ markdown: edited }).ts).not.toBe(committed());
  });

  it('refuses unsupported markdown by THROWING, so importing it never exits the test runner', () => {
    const md = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const bad = md.replace(/\n## /, '\n<div>raw html</div>\n\n## ');
    expect(() => compileGuide({ markdown: bad })).toThrow(GuideError);
    expect(() => compileGuide({ markdown: bad })).toThrow(/^build-user-guide: .*\n {2}at packages\/app\/user-guide\.md:\d+$/);
  });
});

/**
 * THE NOZZLE DATABASE'S FIGURES (board Tier 1 row 17). The guide's nozzle
 * section quoted counts out of nozzles.json by hand, and they went stale the way
 * the motor counts did: v0.133 fixed "278 motors you can load" to 279 and left
 * "221 of AeroTech's 272" one clause away, so the paragraph's own parts summed
 * to 275. Coverage now comes from the file at build time; the figures the prose
 * writes in words come with names and reasons no token can carry, so they are
 * checked against the file instead, and a rebuild that moves one fails the guide
 * build until the sentence is rewritten.
 */
const shippedNozzles = () => JSON.parse(readFileSync(join(DATA, 'nozzles.json'), 'utf8'));
const coverageSum = (db, maker, key) => Object.values(db.coverage.byManufacturer[maker].byCasingDiameterMm)
  .reduce((s, e) => s + e[key], 0);
/** Every section's html, joined: a sentence can be in any of them. */
const allHtml = (ts) => [...ts.matchAll(/"html": (".*")/g)].map((m) => JSON.parse(m[1])).join('\n');

describe('the nozzle database figures the guide quotes', () => {
  const doc = (body) => `<a id="s"></a>\n## S\n\n${body}`;

  it("compiles Loki's coverage from the file's own per-casing counts", () => {
    const db = shippedNozzles();
    const { ts } = compileGuide({ markdown: doc('X{{NOZZLE_LOKI_WITH_EXIT}}Y{{NOZZLE_LOKI_IN_PRODUCTION}}Z') });
    expect(allHtml(ts)).toContain(`X${coverageSum(db, 'Loki', 'withExitDiameter')}Y${coverageSum(db, 'Loki', 'inProduction')}Z`);
  });

  it('refuses a coverage figure typed by hand, whatever the number', () => {
    expect(() => compileGuide({ markdown: doc('Loki: 54 of their 58 in production.') })).toThrow(/hand-typed nozzle coverage/);
    expect(() => compileGuide({ markdown: doc("AeroTech: 222 of AeroTech's 272 motors in production.") }))
      .toThrow(/hand-typed nozzle coverage/);
    // A count of something else that happens to say "of the" is not coverage.
    expect(() => compileGuide({ markdown: doc('30 of the 72 hours had a gust.') })).not.toThrow();
  });

  it('is stated in the shipped guide, every figure the build checks, so no check is vacuous', () => {
    const md = readFileSync(SRC, 'utf8');
    expect(md).toContain('{{NOZZLE_LOKI_WITH_EXIT}} of their {{NOZZLE_LOKI_IN_PRODUCTION}} in production');
    expect(md).toMatch(/\b[A-Za-z]+ AeroTech motors have two published nozzles\b/);
    expect(md).toMatch(/\b[A-Za-z]+ Loki motors are short\b/);
    expect(md).toMatch(/\b[A-Za-z]+ 29 mm DMS motors have the nozzle moulded into the case\b/);
    expect(md).toMatch(/K1100T's two options differ by \d+ % in area/);
    expect(md).toMatch(/\bcarry a row with no number on purpose\b/);
    expect(md).toMatch(/\bthe [A-Z]\d+[A-Z]* is an aerospike\b/);
    expect(md).toMatch(/\bthe [A-Z]\d+[A-Z]*(?:-[A-Z]+)?'s machined nozzle is drawn with its outside diameter and no exit\b/);
    expect(md).toMatch(/\b[A-Za-z]+ has a nozzle the sheet says was cut shorter than the mould\b/);
  });
});

describe('a nozzle-database rebuild the guide has not caught up with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-nozzles-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(DATA, 'motors.json'), join(dir, 'motors.json'));
  copyFileSync(join(DATA, 'motorCurves.json'), join(dir, 'motorCurves.json'));
  /** The shipped nozzles.json with one edit, as a data directory to compile against. */
  const rebuilt = (edit) => {
    const db = shippedNozzles();
    edit(db);
    writeFileSync(join(dir, 'nozzles.json'), JSON.stringify(db));
    return dir;
  };
  const row = (db, designation) => db.motors.find((m) => m.designation === designation);
  const loki = (db, mm) => db.coverage.byManufacturer.Loki.byCasingDiameterMm[mm];
  /** A loadable 54 mm AeroTech reload with one published exit, to take that exit away from. */
  const anOrdinaryReload = (db) => db.motors.find((m) => m.manufacturer === 'AeroTech' && m.motorId
    && m.exitDiameterM !== undefined && m.casingDiameterMm === 54 && m.docFamily === 'reloadable' && !m.exitAmbiguous);

  it('reads as stale when the coverage it quotes moves', () => {
    // A new in-production 38 mm Loki motor with a published exit: one more of one
    // more, and the four short ones are still four, so no prose check objects.
    const { ts } = compileGuide({
      dataDir: rebuilt((db) => {
        const e = loki(db, '38');
        e.inProduction += 1; e.withNozzleRow += 1; e.withExitDiameter += 1;
      }),
    });
    expect(ts).not.toBe(committed());
    const db = shippedNozzles();
    expect(allHtml(ts)).toContain(`${coverageSum(db, 'Loki', 'withExitDiameter') + 1} of their `
      + `${coverageSum(db, 'Loki', 'inProduction') + 1} in production`);
  });

  it('refuses to compile when fewer Loki motors are short than the guide says, or others are', () => {
    // The owner measures the two 54/4000 one-time-use nozzles: two short, not four.
    const measured = rebuilt((db) => {
      Object.assign(loki(db, '54'), { withNozzleRow: 16, withExitDiameter: 16, missing: [] });
    });
    expect(() => compileGuide({ dataDir: measured })).toThrow(/says four Loki motors are short; nozzles\.json has two/);
    // The same count, a different motor: the sentence would name the wrong one.
    const renamed = rebuilt((db) => { loki(db, '54').missing = ['L2050LW', 'K9999LW']; });
    expect(() => compileGuide({ dataDir: renamed })).toThrow(/does not name K9999/);
  });

  it('refuses to compile when the two-nozzle, moulded-case or K1100T figures move', () => {
    const fewer = rebuilt((db) => { delete row(db, 'K550W-L').exitAmbiguous; });
    expect(() => compileGuide({ dataDir: fewer })).toThrow(/AeroTech motors have two published nozzles.*eight/);
    const exitFound = rebuilt((db) => { row(db, 'G125T-14A').exitDiameterM = 0.0079; });
    expect(() => compileGuide({ dataDir: exitFound })).toThrow(/29 mm DMS.*three/);
    const altered = rebuilt((db) => { row(db, 'K1100T-L').alternatives[0].exitDiameterIn = 1.0; });
    expect(() => compileGuide({ dataDir: altered })).toThrow(/K1100T.*56 %/);
  });

  it('refuses to compile when a row the guide gives as having no exit on purpose gets one', () => {
    // The K76WN-P's cut-down exit is resolved: AeroTech's 54 mm coverage and the
    // file's counts gain one, which the guide quotes nowhere, so without a check on
    // the sentence it compiled byte for byte and still said one motor's nozzle was
    // cut shorter than the mould.
    const resolved = rebuilt((db) => {
      Object.assign(row(db, 'K76WN-P'), { exitDiameterM: 0.019, exitDiameterIn: 0.748 });
      db.coverage.byManufacturer.AeroTech.byCasingDiameterMm['54'].withExitDiameter += 1;
      db.counts.motorsWithExit += 1;
      db.counts.motorsLoadableWithExit += 1;
    });
    expect(() => compileGuide({ dataDir: resolved }))
      .toThrow(/says "one has a nozzle the sheet says was cut shorter than the mould"; .* are none/);
    const spike = rebuilt((db) => { row(db, 'J615ST-20A').exitDiameterM = 0.02; });
    expect(() => compileGuide({ dataDir: spike })).toThrow(/says "the J615ST is an aerospike"; .* are none/);
    const machined = rebuilt((db) => { row(db, 'I40N-P').exitDiameterM = 0.02; });
    expect(() => compileGuide({ dataDir: machined })).toThrow(/says "the I40N-P's machined nozzle .* are none/);
    // A rebuild that adds a second aerospike, after the J615ST: the sentence names
    // one, so it would leave the new one out.
    const twoSpikes = rebuilt((db) => {
      db.motors.push({ motorId: 'f'.repeat(24), manufacturer: 'AeroTech', designation: 'K950ST-14A',
        casingDiameterMm: 54, docFamily: 'reloadable', provenance: { lomDescription: 'AEROSPIKE NOZZLE W/-4 ANNULAR RING' } });
    });
    expect(() => compileGuide({ dataDir: twoSpikes }))
      .toThrow(/says "the J615ST is an aerospike"; .* are two: J615ST-20A, K950ST-14A/);
  });

  it('refuses to compile when a loadable row has no exit for a reason the guide does not give', () => {
    const unexplained = rebuilt((db) => {
      const r = anOrdinaryReload(db);
      delete r.exitDiameterM;
      delete r.exitDiameterIn;
      r.provenance = { ...r.provenance, lomDescription: '54MM NOZZLE, EXIT NOT DIMENSIONED' };
    });
    expect(() => compileGuide({ dataDir: unexplained }))
      .toThrow(/with no exit that user-guide\.md's sentence on the rows with no number on purpose does not account for: \S+ \("54MM NOZZLE, EXIT NOT DIMENSIONED"\)/);
  });

  it('compiles the shipped file unchanged, so each refusal above is the edit and not the copy', () => {
    expect(compileGuide({ dataDir: rebuilt(() => {}) }).ts).toBe(compileGuide().ts);
  });
});

/**
 * THE CATALOGUE ROWS THE APP CORRECTS (board Tier 1 row 6). The guide says the
 * app bundles thrustcurve.org's motors "as pulled", and since 2026-10-01 two rows
 * are not: motor-corrections.mjs replaces figures no motor can have. The sentence
 * that says so is phrased FROM that table, so retiring an entry there retires
 * its words here, and a correction to a field the guide has no wording for stops
 * the build rather than going unmentioned.
 */
describe('the motor-catalogue corrections the guide states', () => {
  const motors = JSON.parse(readFileSync(join(DATA, 'motors.json'), 'utf8')).motors;
  const n = (v) => v.toLocaleString('en-US');

  it('names every corrected figure, and the figure thrustcurve.org gives, in the shipped guide', () => {
    expect(readFileSync(SRC, 'utf8')).toContain('{{MOTOR_CORRECTIONS}}');
    const html = allHtml(compileGuide().ts);
    for (const c of MOTOR_CORRECTIONS) {
      for (const { bad, good } of Object.values(c.fields)) {
        expect(html).toMatch(new RegExp(`${c.manufacturer} ${c.designation}[^;.]*\\b${n(good).replace('.', '\\.')} [^;]*thrustcurve\\.org lists ${n(bad)}\\b`));
      }
    }
  });

  it('is phrased from the table, field by field, and refuses a field it has no words for', () => {
    const [c] = MOTOR_CORRECTIONS;
    expect(motorCorrectionsSentence([c], motors)).toMatch(new RegExp(`^the ${c.manufacturer} ${c.designation} `));
    const unworded = { ...c, fields: { avgThrustN: { bad: 1, good: 2 } } };
    expect(() => motorCorrectionsSentence([unworded], motors)).toThrow(/no wording for .*avgThrustN/);
    expect(motorCorrectionsSentence([], motors)).toBe('');
  });

  it('joins several corrections with semicolons, since each carries its own comma', () => {
    const one = motorCorrectionsSentence(MOTOR_CORRECTIONS.slice(0, 1), motors);
    const both = motorCorrectionsSentence(MOTOR_CORRECTIONS, motors);
    expect(MOTOR_CORRECTIONS.length).toBeGreaterThan(1);
    expect(both.startsWith(`${one}; and `)).toBe(true);
  });

  it('refuses to print the sentence once the table has nothing in it', () => {
    const doc = '<a id="s"></a>\n## S\n\nCorrected: {{MOTOR_CORRECTIONS}}.';
    expect(() => compileGuide({ markdown: doc })).not.toThrow();
    expect(() => compileGuide({ markdown: doc, corrections: [] })).toThrow(/\{\{MOTOR_CORRECTIONS\}\} renders nothing/);
  });
});
