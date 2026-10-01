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

  it('refuses it in the shapes the guide writes it: bold, hyphenated, with or without "their"', () => {
    for (const said of [
      'Loki: **54** of their 58 in production.', // the bold the old guide used
      "Together that is **221** of AeroTech's 272 in production.",
      '222 of their 272 in-production motors have an exit.',
      'Loki: 54 of 58 in production.',
      'Loki: 54 out of their 58 in production.',
      '222 of the 272 AeroTech motors in production.',
      '*54* of their *58* in production.',
    ]) {
      expect(() => compileGuide({ markdown: doc(said) }), said).toThrow(/hand-typed nozzle coverage/);
    }
  });

  it('refuses a catalogue count in bold as it does in plain text', () => {
    // A stale figure, so no token's current value can be what catches it.
    expect(() => compileGuide({ markdown: doc('The app bundles 1,129 motors.') })).toThrow(/hand-typed catalogue count/);
    expect(() => compileGuide({ markdown: doc('The app bundles **1,129** motors.') })).toThrow(/hand-typed catalogue count/);
    expect(() => compileGuide({ markdown: doc('**1,129 bundled** motors.') })).toThrow(/hand-typed catalogue count/);
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
    expect(md).toMatch(/\b[A-Za-z]+ has a nozzle the sheet says was cut shorter than the mould\b/);
    expect(md).toMatch(/\d*\.\d+″ against the standard \d*\.\d+″ is \d+ % more area, and against the \d*\.\d+″ band it is \d+ %/);
    expect(md).toMatch(/\bMost are single-use hobby motors of \d+ mm to \d+ mm\b.*\bthe rest are [A-Za-z]+ reload kits and [A-Za-z]+ larger single-use motors\b/);
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
    // The I40N-P's machined nozzle went the other way: part 01600's exit was published
    // (2026-10-01) and the guide stopped giving a reason for it to have none. Losing it
    // again is a row with no reason the guide gives, not one it already explains.
    const machined = rebuilt((db) => { const r = row(db, 'I40N-P'); delete r.exitDiameterM; delete r.exitDiameterIn; });
    expect(() => compileGuide({ dataDir: machined }))
      .toThrow(/does not account for: I40N-P \("38MM NOZZLE MACHINED 1\.25" O\.D\. X \.156" DT"\)/);
    // A rebuild that adds a second aerospike, after the J615ST: the sentence names
    // one, so it would leave the new one out.
    const twoSpikes = rebuilt((db) => {
      db.motors.push({ motorId: 'f'.repeat(24), manufacturer: 'AeroTech', designation: 'K950ST-14A',
        casingDiameterMm: 54, docFamily: 'reloadable', provenance: { lomDescription: 'AEROSPIKE NOZZLE W/-4 ANNULAR RING' } });
    });
    expect(() => compileGuide({ dataDir: twoSpikes }))
      .toThrow(/says "the J615ST is an aerospike"; .* are two: J615ST-20A, K950ST-14A/);
  });

  it("refuses to compile when Loki's 76 mm bands or their machined-out exit move", () => {
    const loki76 = (db) => db.motors.filter((m) => m.manufacturer === 'Loki' && m.casingDiameterMm === 76);
    // A rebuild that reads the 76/3600 band as 1.550 in: the guide's 1.500 and its 78 % go stale together.
    const band = rebuilt((db) => { for (const r of loki76(db)) if (r.exitDiameterIn === 1.5) r.exitDiameterIn = 1.55; });
    expect(() => compileGuide({ dataDir: band })).toThrow(/76 mm Loki exits are 1\.818 and 1\.55 in/);
    // A third band: the sentence names two.
    const third = rebuilt((db) => { row(db, 'M3464LB').exitDiameterIn = 1.9; });
    expect(() => compileGuide({ dataDir: third })).toThrow(/76 mm Loki exits are 1\.9, 1\.818 and 1\.5 in/);
    // Loki machine their 76 mm exits out further.
    const further = rebuilt((db) => {
      for (const r of loki76(db)) r.customExitNote = r.customExitNote.replace('out to 2.0 in', 'out to 2.1 in');
    });
    expect(() => compileGuide({ dataDir: further })).toThrow(/machined out to 2\.0″; nozzles\.json's 76 mm Loki rows say 2\.1 in/);
  });

  it('refuses to compile when the 76 mm percentages are not the areas of their own diameters', () => {
    const md = readFileSync(SRC, 'utf8');
    expect(md).toContain('1.818″ is 21 % more area');
    // 21 % is the area; the diameter is 10 % wider, the shape v0.133's note got wrong.
    expect(() => compileGuide({ markdown: md.replace('1.818″ is 21 % more area', '1.818″ is 10 % more area') }))
      .toThrow(/against 1\.818″ says 10 %; the area grows 21 %/);
    expect(() => compileGuide({ markdown: md.replace('1.500″ band it is 78 %', '1.500″ band it is 33 %') }))
      .toThrow(/against 1\.500″ says 33 %; the area grows 78 %/);
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

  it('refuses to compile when what AeroTech have left uncovered moves', () => {
    // The sentence said "the older single-use line — motors with neither a reload kit nor
    // a DMS design sheet" by hand, and 12 of the 40 it described were reload kits or DMS
    // motors (board Tier 1 row 13, 2026-10-01). It now states the catalogue's own split.
    const missing = (db) => db.coverage.byManufacturer.AeroTech.missingByType;
    /** A row for the first uncovered motor of this type in a casing `inSize` accepts. */
    const covered = (type, inSize) => (db) => {
      const byMm = missing(db)[type];
      const mm = Object.keys(byMm).find((k) => inSize(Number(k)));
      byMm[mm] = byMm[mm].slice(1);
      if (byMm[mm].length === 0) delete byMm[mm];
    };
    // AeroTech post one of the reload kits' assembly drawings.
    expect(() => compileGuide({ dataDir: rebuilt(covered('reload', () => true)) }))
      .toThrow(/says eight reload kits remain uncovered; nozzles\.json has seven/);
    // A larger single-use motor gets a row.
    expect(() => compileGuide({ dataDir: rebuilt(covered('SU', (mm) => mm > 29)) }))
      .toThrow(/says four larger single-use motors remain uncovered; nozzles\.json has three/);
    // Both 18 mm motors get one: the sizes the sentence gives no longer start at 18 mm.
    expect(() => compileGuide({ dataDir: rebuilt((db) => { delete missing(db).SU['18']; }) }))
      .toThrow(/hobby motors run 18 mm to 29 mm; in nozzles\.json they run 24 mm to 29 mm/);
    // All but one at each end get one: the sizes and the other counts still hold, "most" does not.
    expect(() => compileGuide({ dataDir: rebuilt((db) => { missing(db).SU = { ...missing(db).SU, 18: ['D10W'], 24: [], 29: ['G11'] }; }) }))
      .toThrow(/says most of what AeroTech have left uncovered are single-use hobby motors; nozzles\.json has two of 14/);
    // A type the sentence has no words for.
    expect(() => compileGuide({ dataDir: rebuilt((db) => { missing(db).hybrid = { 54: ['K999H'] }; }) }))
      .toThrow(/does not account for K999H \(hybrid\)/);
    // A file built before the split existed cannot vouch for the sentence.
    expect(() => compileGuide({ dataDir: rebuilt((db) => { delete db.coverage.byManufacturer.AeroTech.missingByType; }) }))
      .toThrow(/nozzles\.json has no coverage\.byManufacturer\.AeroTech\.missingByType/);
  });

  it('compiles the shipped file unchanged, so each refusal above is the edit and not the copy', () => {
    expect(compileGuide({ dataDir: rebuilt(() => {}) }).ts).toBe(compileGuide().ts);
  });
});

/**
 * THE CATALOGUE ROWS THE APP CORRECTS (board Tier 1 rows 6 and 8 (c)). The guide
 * says the app bundles thrustcurve.org's motors "as pulled", and since 2026-10-01
 * some rows are not: motor-corrections.mjs replaces figures no motor can have, and
 * figures a motor's certification letter contradicts. The sentence that says so
 * is phrased FROM that table, so retiring an entry there retires its words here,
 * and a correction to a field the guide has no wording for stops the build
 * rather than going unmentioned.
 */
describe('the motor-catalogue corrections the guide states', () => {
  const motors = JSON.parse(readFileSync(join(DATA, 'motors.json'), 'utf8')).motors;
  const n = (v) => v.toLocaleString('en-US');
  const figure = (v) => new RegExp(`(?<![\\d.,])${n(v).replace(/[.,]/g, '\\$&')}(?![\\d])`);

  it('names every corrected figure, and the figure thrustcurve.org gives, in the shipped guide', () => {
    expect(readFileSync(SRC, 'utf8')).toContain('{{MOTOR_CORRECTIONS}}');
    const html = allHtml(compileGuide().ts);
    for (const c of MOTOR_CORRECTIONS) {
      // One clause a motor, from its name to the next clause: what is right, then what thrustcurve.org lists.
      const at = html.indexOf(`the ${c.manufacturer} ${c.designation} `);
      expect(at, `${c.manufacturer} ${c.designation} is not in the guide`).toBeGreaterThanOrEqual(0);
      const [right, listed] = html.slice(at).split(/;|\.\s|<\/p>/)[0].split('where thrustcurve.org lists');
      for (const { bad, good } of Object.values(c.fields)) {
        expect(right, `${c.designation}: ${good}`).toMatch(figure(good));
        expect(listed, `${c.designation}: thrustcurve.org's ${bad}`).toMatch(figure(bad));
      }
    }
  });

  it('is phrased from the table, motor by motor, and refuses a field it has no words for', () => {
    const [c] = MOTOR_CORRECTIONS;
    expect(motorCorrectionsSentence([c], motors)).toMatch(new RegExp(`^the ${c.manufacturer} ${c.designation} `));
    const unworded = { ...c, fields: { burnTimeS: { bad: 1, good: 2 } } };
    expect(() => motorCorrectionsSentence([unworded], motors)).toThrow(/no wording for .*burnTimeS/);
    expect(motorCorrectionsSentence([], motors)).toBe('');
  });

  it('says a motor\'s certified figures in one phrase, naming it once', () => {
    const certified = { ...MOTOR_CORRECTIONS[0], manufacturer: 'AeroTech', designation: 'X1', fields: {
      totImpulseNs: { bad: 66.2, good: 76.73 }, maxThrustN: { bad: 64.33, good: 74.57 }, avgThrustN: { bad: 52.65, good: 61.04 },
    } };
    expect(motorCorrectionsSentence([certified], motors)).toBe('the AeroTech X1 is certified at 76.73 N·s of total '
      + 'impulse, 74.57 N peak thrust and 61.04 N average thrust, where thrustcurve.org lists 66.2 N·s, 64.33 N and 52.65 N');
  });

  it('joins several corrections with semicolons, since each carries its own comma', () => {
    const each = MOTOR_CORRECTIONS.map((c) => motorCorrectionsSentence([c], motors));
    expect(MOTOR_CORRECTIONS.length).toBeGreaterThan(1);
    expect(motorCorrectionsSentence(MOTOR_CORRECTIONS, motors)).toBe(`${each.slice(0, -1).join('; ')}; and ${each.at(-1)}`);
  });

  it('refuses to print the sentence once the table has nothing in it', () => {
    const doc = '<a id="s"></a>\n## S\n\nCorrected: {{MOTOR_CORRECTIONS}}.';
    expect(() => compileGuide({ markdown: doc })).not.toThrow();
    expect(() => compileGuide({ markdown: doc, corrections: [] })).toThrow(/\{\{MOTOR_CORRECTIONS\}\} renders nothing/);
  });
});
