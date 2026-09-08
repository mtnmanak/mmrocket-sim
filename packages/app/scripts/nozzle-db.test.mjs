import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDbMotor, MOTOR_DB } from '../src/services/motorDb.ts';

/**
 * The screen on the SHIPPED nozzle database. Runs in `npm test`, so a
 * regeneration that reads a drawing wrongly fails the deploy rather than
 * quietly feeding a wrong exit area to the thrust term.
 *
 * WHY THE BAR IS HERE (2026-09-08). Since v0.119 the nozzle exit diameter buys
 * THRUST: the kernel adds A_exit x (101,325 - P(h)) to the burning stage under
 * Rogers Kbf or the supersonic model. On MESOS that term is worth +75 % of
 * apogee. An exit that is wrong by a factor of two in diameter is wrong by four
 * in area, and the error lands entirely on the up side — a rocket that flies
 * lower than the sim says is a rocket whose recovery was sized for the wrong
 * altitude. So every geometric impossibility this file can name, it names.
 *
 * The bounds are physical, not tuned:
 *   - an exit diameter is positive and finite;
 *   - an exit is never NARROWER than its own throat (a converging-diverging
 *     nozzle diverges after the throat, by definition);
 *   - an exit never exceeds the CASING the motor is built in, read from
 *     motors.json — the nozzle comes out of the case, so the case bounds it;
 *   - one row per motorId, because the app will look a motor up by id;
 *   - every row says where its number came from.
 *
 * And the join is pinned against the app's OWN matcher. build-nozzle-db.mjs
 * has to duplicate `findDbMotor`'s ranking (motorDb.ts is TypeScript with a
 * JSON import, which plain node cannot load), so the duplicate is checked here
 * rather than trusted: every matched row is re-resolved through the real
 * function and must come back with the same motorId.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'src', 'data');
const db = JSON.parse(readFileSync(join(dataDir, 'nozzles.json'), 'utf8'));

const rows = db.motors;
const parts = db.nozzles;
const byId = new Map(MOTOR_DB.map((m) => [m.motorId, m]));

/** Millimetres of slop on the casing bound: drawings tolerance +/- .005 in. */
const CASING_SLOP_MM = 0.5;

describe('the shipped nozzle database', () => {
  it('is not empty and names its catalogue', () => {
    expect(rows.length).toBeGreaterThan(150);
    expect(parts.length).toBeGreaterThan(50);
    // `catalogueGenerated` is PROVENANCE — which catalogue these rows were
    // keyed against — and nothing more.
    //
    // It used to be asserted EQUAL to motors.json's own `generated`, and that
    // was a self-inflicted CI break waiting for the next Monday (2026-09-08,
    // from review). `.github/workflows/motors-refresh.yml` runs weekly, stamps
    // today's date into motors.json and then runs `npm test` as its gate — so
    // every refresh would have failed that gate, and the only way to clear it
    // is to re-run build-nozzle-db.mjs, which needs `docs/RCS Schematics`:
    // LOCAL-ONLY, gitignored, and absent from CI and from the laptop.
    //
    // What the pin was FOR — "these rows still describe motors this catalogue
    // has" — is covered exactly, and better, by the three join tests below:
    // every motorId resolves, every designation agrees, and every row
    // re-resolves through the app's own findDbMotor. A date is a proxy for
    // that; those are the thing itself.
    expect(db.catalogueGenerated, 'nozzles.json must record which catalogue it was keyed against')
      .toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(db.generated).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it('gives the same diameter in both units on every row and part', () => {
    // The file offers the inch figure as "the number a reader can check against
    // the drawing" and the app flies the metres. Nothing compared them, so a
    // hand edit or a botched regeneration could put two different diameters in
    // one row and every other test would pass (2026-09-08, from review).
    const IN_PER_M = 39.3700787401575;
    const round6 = (v) => Math.round(v * 1e6) / 1e6;
    const bad = [];
    for (const [what, xs] of [['motor', rows], ['part', parts]]) {
      for (const r of xs) {
        for (const [field, inches, metres] of [
          ['exit', r.exitDiameterIn, r.exitDiameterM],
          ['throat', r.throatDiameterIn, r.throatDiameterM],
        ]) {
          if (inches === undefined && metres === undefined) continue;
          if (inches === undefined || metres === undefined) {
            bad.push(`${what} ${r.designation ?? r.partNo}: ${field} has one unit and not the other`);
          } else if (Math.abs(metres - round6(inches / IN_PER_M)) > 5e-7) {
            bad.push(`${what} ${r.designation ?? r.partNo}: ${field} ${inches} in is `
              + `${round6(inches / IN_PER_M)} m, file says ${metres} m`);
          }
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('keeps every exit inside the expansion ratio this line actually builds', () => {
    // THE MAGNITUDE CHECK THE CASING BOUND IS NOT. Measured on the shipped
    // file, the casing bound leaves a median 2.6x of headroom in DIAMETER and
    // 144 of 192 rows tolerate a doubled exit — 4x in AREA, and area is the
    // whole of v0.119's pressure-thrust term — undetected. A doubled
    // N1000W-P (1.750 -> 3.500 in) is 88.9 mm in a 98 mm case and passes.
    //
    // Expansion ratio does catch it. Every AeroTech row in this set sits in
    // 1.96-7.55, so a bound of [1.0, 9.0] is loose enough not to be a tuned
    // number and tight enough that a doubled diameter (4x the ratio) cannot
    // hide. 1.0 is the floor because a converging-diverging nozzle diverges.
    //
    // `throat-bored-through` is exempt BY CONSTRUCTION: those rows are motors
    // whose throat was bored wider than the moulded exit, so the exit plane IS
    // the bore and the ratio is exactly 1 by definition, not by measurement.
    const bad = rows
      .filter((r) => r.exitSource !== 'throat-bored-through')
      .filter((r) => r.exitDiameterIn !== undefined && r.throatDiameterIn > 0)
      .map((r) => ({ r, ratio: (r.exitDiameterIn / r.throatDiameterIn) ** 2 }))
      .filter(({ ratio }) => !(ratio >= 1 && ratio <= 9))
      .map(({ r, ratio }) => `${r.designation} (${r.nozzlePartNo}): exit ${r.exitDiameterIn} in over `
        + `throat ${r.throatDiameterIn} in is an area ratio of ${ratio.toFixed(2)}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('takes each motor exit from the part it names, or says why not', () => {
    // The ONE tie between the two tables in this file, and the check that
    // would have caught a doubled exit on a row whose part still said 1.750.
    // Four sources legitimately differ from the part's own figure and each
    // states itself: a Medusa's exit depends on which throats the motor's
    // sheet opens, a bored-through throat replaces the exit, an assembly
    // description states the motor's own, and a contradicted sheet falls back
    // to the base mould (L400W-PS).
    const own = new Set(['medusa-open-throats', 'throat-bored-through', 'assembly-description',
      'base-spec-page', 'none']);
    const byPart = new Map(parts.map((p) => [p.partNo, p]));
    const bad = rows
      .filter((r) => !own.has(r.exitSource) && r.exitDiameterIn !== undefined)
      .filter((r) => byPart.get(r.nozzlePartNo)?.exitDiameterIn !== r.exitDiameterIn)
      .map((r) => `${r.designation}: row says ${r.exitDiameterIn} in, part ${r.nozzlePartNo} says `
        + `${byPart.get(r.nozzlePartNo)?.exitDiameterIn}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('gives every exit diameter as a positive, finite number of metres', () => {
    const bad = rows
      .filter((r) => r.exitDiameterM !== undefined)
      .filter((r) => !(Number.isFinite(r.exitDiameterM) && r.exitDiameterM > 0))
      .map((r) => `${r.designation}: exit ${r.exitDiameterM}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('never has an exit narrower than its own throat', () => {
    const bad = rows
      .filter((r) => r.exitDiameterM !== undefined && r.throatDiameterM !== undefined)
      .filter((r) => r.exitDiameterM < r.throatDiameterM)
      .map((r) => `${r.designation} (${r.nozzlePartNo}): exit ${r.exitDiameterM} m < throat ${r.throatDiameterM} m`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('never has an exit wider than the casing the motor is built in', () => {
    const bad = rows
      .filter((r) => r.exitDiameterM !== undefined && r.casingDiameterMm)
      .filter((r) => r.exitDiameterM * 1000 > r.casingDiameterMm + CASING_SLOP_MM)
      .map((r) => `${r.designation}: exit ${(r.exitDiameterM * 1000).toFixed(1)} mm in a ${r.casingDiameterMm} mm case`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('carries at most one row per motorId', () => {
    const seen = new Map();
    const dupes = [];
    for (const r of rows) {
      if (!r.motorId) continue;
      if (seen.has(r.motorId)) dupes.push(`${r.motorId}: ${seen.get(r.motorId)} and ${r.designation}`);
      seen.set(r.motorId, r.designation);
    }
    expect(dupes, dupes.join('\n')).toEqual([]);
  });

  it('records provenance on every row — no anonymous numbers', () => {
    const bad = rows
      .filter((r) => !r.provenance
        || !Array.isArray(r.provenance.assemblyDrawings) || r.provenance.assemblyDrawings.length === 0
        || !r.provenance.lomDescription
        || (r.exitDiameterM !== undefined && !r.provenance.exitFrom)
        || !r.exitSource || !r.exitConfidence)
      .map((r) => `${r.designation} (${r.nozzlePartNo})`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('labels every exit with a known source and confidence', () => {
    const sources = new Set(['spec-page', 'base-spec-page', 'drawing-title', 'assembly-description',
      'medusa-open-throats', 'medusa', 'throat-bored-through', 'none']);
    const confidences = new Set(['high', 'medium', 'low', 'none', 'per-motor']);
    const bad = rows
      .filter((r) => !sources.has(r.exitSource) || !confidences.has(r.exitConfidence))
      .map((r) => `${r.designation}: ${r.exitSource}/${r.exitConfidence}`);
    expect(bad, bad.join('\n')).toEqual([]);
    // A drawing CALLOUT is an unlabelled leader-line number and must never be
    // the answer — it is only ever a cross-check (`exitOnDrawing` on a part).
    expect(rows.some((r) => r.exitSource === 'drawing-callout')).toBe(false);
  });

  it('has no exit without a source, and no source without an exit', () => {
    const bad = rows
      .filter((r) => (r.exitDiameterM === undefined) !== (r.exitSource === 'none'))
      .map((r) => `${r.designation}: exit ${r.exitDiameterM} but source ${r.exitSource}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('keeps both published nozzles when a motor has two, and says so', () => {
    // AeroTech publish two nozzle options for nine motors (K1100T single-throat
    // vs Medusa, M650W "New Single-Throat" vs "Older Medusa", ...). Picking one
    // silently would be a 43 % error in exit AREA on K1100T.
    const bad = rows
      .filter((r) => r.exitAmbiguous)
      .filter((r) => !Array.isArray(r.alternatives) || r.alternatives.length === 0
        || r.alternatives.some((a) => a.exitDiameterM === r.exitDiameterM))
      .map((r) => `${r.designation}: exitAmbiguous with no distinct alternative`);
    expect(bad, bad.join('\n')).toEqual([]);
    expect(rows.filter((r) => r.exitAmbiguous).length).toBeGreaterThan(0);
    // And the GRADE has to say so too. `exitConfidence` is the field a consumer
    // filters on; leaving it at "high" while `exitAmbiguous` was set let one of
    // two published numbers be picked up as settled — 43 % of the exit area
    // apart on K1100T, 2.47x on I300T (2026-09-08, from review).
    const graded = rows.filter((r) => r.exitAmbiguous && r.exitConfidence === 'high')
      .map((r) => `${r.designation}: ambiguous but graded high`);
    expect(graded, graded.join('\n')).toEqual([]);
    // Each one records HOW the primary was picked, and the strongest evidence
    // — the sheet's own dated revision block naming the nozzle — is used
    // wherever AeroTech printed one.
    const unexplained = rows.filter((r) => r.exitAmbiguous
      && !['dated-revision', 'sheet-label', 'majority-of-sheets'].includes(r.exitPickedBy))
      .map((r) => `${r.designation}: exitPickedBy ${r.exitPickedBy}`);
    expect(unexplained, unexplained.join('\n')).toEqual([]);
    expect(rows.filter((r) => r.exitPickedBy === 'dated-revision').length).toBeGreaterThan(0);
  });

  it('never carries a part-specific exit onto a sheet that drills a narrower throat', () => {
    // A dash number DRILLS, and drilling only enlarges. So a sheet stating a
    // throat SMALLER than its own part's drawing moulds is not describing that
    // mould, and the exit off that mould is not this motor's exit. L400W-PS
    // shipped 1.750 in at "high" this way while its own sheet said .500"
    // DRILLED against a net-moulded .734 in part — 3.78x too much exit AREA,
    // all of it on the up side of apogee (2026-09-08, from review).
    const byPart = new Map(parts.map((p) => [p.partNo, p]));
    const bad = rows
      .filter((r) => r.exitSource === 'drawing-title' || r.exitSource === 'spec-page')
      .filter((r) => {
        const moulded = byPart.get(r.nozzlePartNo)?.throatDiameterIn;
        return moulded !== undefined && r.throatDiameterIn !== undefined
          && r.throatDiameterIn < moulded - 0.002;
      })
      .map((r) => `${r.designation} (${r.nozzlePartNo}): sheet ${r.throatDiameterIn} in vs mould `
        + `${byPart.get(r.nozzlePartNo).throatDiameterIn} in, exit ${r.exitDiameterIn} in`);
    expect(bad, bad.join('\n')).toEqual([]);
    // And the one that DID contradict is downgraded and says so, rather than
    // being dropped silently.
    const l400 = rows.find((r) => r.designation === 'L400W-PS');
    expect(l400.exitDiameterIn).toBeCloseTo(0.9, 4);
    expect(l400.exitConfidence).toBe('low');
    expect(l400.confidenceNote).toMatch(/only ever enlarges a throat/);
  });
});

describe('the join into the motor catalogue', () => {
  it('only names motorIds the shipped catalogue actually has', () => {
    const bad = rows.filter((r) => r.motorId && !byId.has(r.motorId))
      .map((r) => `${r.designation}: ${r.motorId}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('agrees with the catalogue about what the motor is called', () => {
    const bad = rows.filter((r) => r.motorId)
      .filter((r) => byId.get(r.motorId).designation !== r.catalogDesignation)
      .map((r) => `${r.designation}: says ${r.catalogDesignation}, catalogue says ${byId.get(r.motorId).designation}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('resolves through the app\'s own findDbMotor to the same motor', () => {
    const bad = [];
    for (const r of rows) {
      if (!r.motorId) continue;
      const hit = findDbMotor(r.provenance.matchedVia, r.casingDiameterMm, undefined, 'AeroTech');
      if (hit?.motorId !== r.motorId) {
        bad.push(`${r.designation} via "${r.provenance.matchedVia}": build says ${r.catalogDesignation}, findDbMotor says ${hit?.designation ?? 'nothing'}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('keeps the raw designation even where nothing matched, so no motor is lost', () => {
    const bad = rows.filter((r) => !r.designation || !r.caseFamily)
      .map((r) => JSON.stringify(r).slice(0, 120));
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('the nozzle part table', () => {
  it('gives every part a number, a manufacturer and provenance', () => {
    const bad = parts
      .filter((p) => !p.partNo || !p.manufacturer || !p.provenance)
      .map((p) => JSON.stringify(p).slice(0, 120));
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('never has a part exit narrower than its own throat', () => {
    const bad = parts
      .filter((p) => p.exitDiameterM !== undefined && p.throatDiameterM !== undefined)
      .filter((p) => p.exitDiameterM < p.throatDiameterM)
      .map((p) => `${p.partNo}: exit ${p.exitDiameterIn} in < throat ${p.throatDiameterIn} in`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('never names a part after a throat the part does not have', () => {
    // `name` came from `exact?.title ?? baseSpec?.title`, so 01880-4 was called
    // "98mm Nozzle, 1.000 Throat" while its own throat is 1.219 and 01800-3
    // was named after a mould it is not (2026-09-08, from review). A store
    // page title may only name the part it is a page FOR; the base part's
    // title is kept as `basePartName`, which says what it is.
    const bad = parts
      .filter((p) => p.name !== undefined && p.throatDiameterIn !== undefined)
      .filter((p) => {
        const stated = /([\d.]+)"?\s*Throat/i.exec(p.name);
        return stated && Math.abs(Number(stated[1]) - p.throatDiameterIn) > 0.002;
      })
      .map((p) => `${p.partNo}: named "${p.name}" but throat ${p.throatDiameterIn} in`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('never points provenance at a drawing that contradicts the row', () => {
    // 01800-3M's provenance.drawing used to be the BASE 01800 sheet, whose own
    // dash table prints ".900 De" against the row's 1.750 in — a reader
    // following the citation landed on a document that disagrees with it. The
    // base sheet may only stand in where the exit actually came off the base
    // mould (2026-09-08, from review).
    const bad = parts
      .filter((p) => p.basePartNo && p.provenance.drawing)
      .filter((p) => /rcs_0\d{4}_nozzle/i.test(p.provenance.drawing))
      .filter((p) => {
        const base = parts.find((q) => q.partNo === p.basePartNo);
        return base?.exitDiameterIn !== undefined && p.exitDiameterIn !== undefined
          && Math.abs(base.exitDiameterIn - p.exitDiameterIn) > 0.002;
      })
      .map((p) => `${p.partNo}: exit ${p.exitDiameterIn} in cites ${p.provenance.drawing}, `
        + `the base ${p.basePartNo} sheet`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('is sorted by part number, so a regeneration diffs cleanly', () => {
    const sorted = [...parts].map((p) => p.partNo).sort((a, b) => a.localeCompare(b));
    expect(parts.map((p) => p.partNo)).toEqual(sorted);
  });

  it('keeps the 98 mm second mould apart from its base part', () => {
    // The one documented exception to the dash-number rule, and the one place
    // a blind carry-across would be badly wrong: 01800 exits at 0.900 in, and
    // 01800-3/-3M/-4(M)/-5(M)/-6(M)/01800M-1 all exit at 1.750 in. Pinned
    // because it is the failure this whole resolution order exists to prevent.
    const exit = (no) => parts.find((p) => p.partNo === no)?.exitDiameterIn;
    expect(exit('01800')).toBeCloseTo(0.9, 4);
    for (const no of ['01800-3', '01800-3M', '01800-4(M)', '01800-5(M)', '01800-6(M)', '01800M-1']) {
      expect(exit(no), `${no} must carry the 1.750 in mould`).toBeCloseTo(1.75, 4);
    }
    // And the base part's own dash numbers keep the base exit.
    expect(exit('01800-1')).toBeCloseTo(0.9, 4);
    expect(exit('01800-2')).toBeCloseTo(0.9, 4);
  });
});

describe('the independent Tripoli cross-check', () => {
  const tripoli = db.crossCheck?.tripoli ?? [];

  it('is recorded, and is a comparison rather than an input', () => {
    expect(tripoli.length).toBeGreaterThan(0);
    expect(db.crossCheck.note).toMatch(/never an input/i);
    // No row may take its number from a certification letter — those letters
    // are 1997-2001 tests on hardware AeroTech redesigned in 2003.
    expect(rows.some((r) => /cert|tripoli/i.test(r.exitSource))).toBe(false);
  });

  it('still agrees with the certifying body about the THROATS', () => {
    // The throats are what proves the LIST OF MATERIAL descriptions are being
    // read correctly, and they are independent of the 2003 exit redesign. Two
    // of the nine comparable motors changed nozzle part since their 1998 test
    // (K650T .692 -> .594, M1419W .734 -> .813), so the bar is 70 %, not 100.
    // If this drops, the description parsing has broken, not the data.
    // NINE of the twelve, not twelve: three are Kosdon-by-AeroTech motors with
    // no row in this database, so there is nothing to compare them against.
    const comparable = tripoli.filter((t) => t.throatAgrees !== undefined);
    expect(tripoli.length).toBe(12);
    expect(comparable.length).toBe(9);
    const agree = comparable.filter((t) => t.throatAgrees).length;
    const disagreeing = comparable.filter((t) => !t.throatAgrees)
      .map((t) => `${t.designation}: cert ${t.certThroatIn} in vs db ${t.dbThroatIn} in (${t.dbNozzlePartNo})`);
    expect(agree / comparable.length, disagreeing.join('\n')).toBeGreaterThanOrEqual(0.7);
  });
});

describe('the gaps are stated rather than left blank', () => {
  it('names Loki and Cesaroni and keeps a place for measured data', () => {
    expect(db.gaps.Loki).toMatch(/measure/i);
    expect(db.gaps.Cesaroni).toMatch(/no published/i);
    expect(Array.isArray(db.measured)).toBe(true);
  });

  it('applies the same physical bounds to any measured row that is added', () => {
    const bad = db.measured
      .filter((m) => !(m.exitDiameterIn > 0) || !m.measuredBy || !m.manufacturer
        || (m.throatDiameterIn !== undefined && m.exitDiameterIn < m.throatDiameterIn))
      .map((m) => JSON.stringify(m));
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
