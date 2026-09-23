import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDbMotor, MOTOR_DB } from '../src/services/motorDb.ts';
import {
  ASSEMBLY_FOLDER, IN_PER_M as BUILD_IN_PER_M, inToM, mergeMeasured, readSpecPage, round6 as buildRound6,
  sourceDocuments,
} from './nozzle-db-helpers.mjs';

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
 * And the join is checked against the app's OWN matcher. build-nozzle-db.mjs
 * has to duplicate `findDbMotor`'s ranking (motorDb.ts is TypeScript with a
 * JSON import, which plain node cannot load), so the duplicate is checked here
 * rather than trusted: every matched row is re-resolved through the real
 * function and must come back with the same motorId.
 *
 * THE JOIN CHECKS ARE NOT ALL HARD GATES, and `judgeAgainstCatalogue` below
 * says why: half of what they compare belongs to thrustcurve.org, which moves
 * weekly, and this file can only be rebuilt on one machine.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'src', 'data');
const db = JSON.parse(readFileSync(join(dataDir, 'nozzles.json'), 'utf8'));

const rows = db.motors;
const parts = db.nozzles;
const byId = new Map(MOTOR_DB.map((m) => [m.motorId, m]));

/**
 * THE CATALOGUE THIS FILE WAS KEYED AGAINST — and why a disagreement with the
 * catalogue is sometimes a FAILURE and sometimes only a REPORT.
 *
 * (2026-09-08, from review.) The join checks below read thrustcurve.org's own
 * designations and motorIds out of the shipped motors.json. Upstream renames
 * motors, retires them and re-issues ids continuously, and
 * `.github/workflows/motors-refresh.yml` pulls that in every Monday and gates
 * its pull request on `npm test` — the deploy gate, verbatim. So one upstream
 * rename would have turned the refresh PR red, and the only thing that can
 * clear it is a re-run of build-nozzle-db.mjs, which needs `docs/RCS
 * Schematics` (local-only, gitignored), Python and PyMuPDF: none of which
 * exist on CI or on the laptop. That is a gate nobody present can open, and it
 * would block the MOTOR data — which does move users' numbers — over nozzle
 * data that has not changed at all. This suite already dropped its
 * `catalogueGenerated` date pin for that exact reason and then kept the same
 * coupling through these three assertions.
 *
 * So the date decides the verdict:
 *   - `catalogueGenerated` === motors.json's `generated`: both files describe
 *     the SAME catalogue, so a disagreement is a defect in this repo — the
 *     matcher build-nozzle-db.mjs duplicates, or a hand edit of a generated
 *     file — and it FAILS, on the machine that can regenerate.
 *   - they differ: the catalogue has moved on under a committed artifact.
 *     Drift is then expected and is nobody's mistake, so it is REPORTED with
 *     every affected row named, for whoever next regenerates.
 * Nothing goes silent either way; only the verdict changes.
 *
 * `scripts/check-upstream.mjs` §5 reports the same drift before a release,
 * which is this project's standing mechanism for third-party movement (Eric,
 * 2026-08-31: "maintain vigilance on anything we rely on from third party
 * sources").
 */
// The raw catalogue, read the way build-nozzle-db.mjs reads it — `MOTOR_DB`
// above is the app's own view of the same file and carries only the fields the
// app needs.
const catalogue = JSON.parse(readFileSync(join(dataDir, 'motors.json'), 'utf8'));
const catalogueGenerated = catalogue.generated;
const sameCatalogue = db.catalogueGenerated === catalogueGenerated;

function judgeAgainstCatalogue(bad, what, howToClear) {
  if (bad.length === 0) return;
  const detail = bad.join('\n  ');
  if (sameCatalogue) {
    expect(bad, `${what} — and nozzles.json says it was keyed against this very catalogue `
      + `(${db.catalogueGenerated}), so this is a defect here, not upstream drift.\n  ${detail}\n  ${howToClear}`)
      .toEqual([]);
    return;
  }
  console.warn(`\n[nozzles.json] ${what} — ${bad.length} of them.\n`
    + `  The nozzle data was keyed against the ${db.catalogueGenerated} catalogue and motors.json is now `
    + `${catalogueGenerated}, so this is upstream drift, not a defect — reported, not failed, because only a `
    + `regeneration can clear it and that needs docs/RCS Schematics.\n  ${detail}\n  ${howToClear}\n`);
}

/**
 * This file's own inch factor, stated independently of the builder's so the
 * both-units check is not an echo of the code it checks; the helpers' pin below
 * compares the two.
 */
const IN_PER_M_CHECK = 39.3700787401575;

/** Millimetres of slop on the casing bound: drawings tolerance +/- .005 in. */
const CASING_SLOP_MM = 0.5;

/**
 * THE ROW SCREENS THAT A MEASURED ROW MUST PASS, as functions over a set of rows
 * (audit 2026-09-22), so they run twice: on the shipped file, and on the shipped
 * file plus a synthetic measured row made by the builder's own `mergeMeasured`.
 *
 * WHY. `MEASURED_NOZZLES` is where the owner's caliper readings of L2050LW and
 * M1378LR are to land, and until this change the screen REJECTED the very
 * `exitSource: 'measured'` the builder writes for them — in the source set, the
 * part-tie exemption set, and every one of the Loki checks, all of which assume
 * a Loki row came off Loki's published tables. So the first real measurement
 * would have turned `npm test` red and blocked every deploy, and the easy "fix"
 * in that moment would have been to loosen the Loki band check, which guards a
 * field that buys thrust. A measured row is routed to its own checks instead,
 * and the synthetic one below proves the route before it is needed rather than
 * on the day it is.
 */
const EXIT_SOURCES = new Set(['spec-page', 'base-spec-page', 'drawing-title', 'assembly-description',
  'medusa-open-throats', 'medusa', 'throat-bored-through', 'none',
  // Loki: the motor's own instruction sheet named the nozzle, or Loki's
  // published "Commercial Nozzle throat" column for that case did.
  'loki-sheet', 'loki-case-table',
  // A caliper on the part in hand (MEASURED_NOZZLES), for a motor nobody publishes.
  'measured']);
const EXIT_CONFIDENCES = new Set(['high', 'medium', 'low', 'none', 'per-motor']);

function unlabelledExits(rowSet) {
  return rowSet
    .filter((r) => !EXIT_SOURCES.has(r.exitSource) || !EXIT_CONFIDENCES.has(r.exitConfidence))
    .map((r) => `${r.designation}: ${r.exitSource}/${r.exitConfidence}`);
}

/**
 * Sources whose exit legitimately differs from the part table's figure, each for
 * a stated reason (see the test that uses this). `measured` is here because a
 * measured nozzle is a part NO table holds: the caliper reading is its only
 * exit, and there is no published part for it to be tied to.
 */
const OWN_EXIT_SOURCES = new Set(['medusa-open-throats', 'throat-bored-through', 'assembly-description',
  'base-spec-page', 'none', 'loki-sheet', 'loki-case-table', 'measured']);

function exitsOffTheirPart(rowSet) {
  const byPart = new Map(parts.map((p) => [p.partNo, p]));
  return rowSet
    .filter((r) => !OWN_EXIT_SOURCES.has(r.exitSource) && r.exitDiameterIn !== undefined)
    .filter((r) => byPart.get(r.nozzlePartNo)?.exitDiameterIn !== r.exitDiameterIn)
    .map((r) => `${r.designation}: row says ${r.exitDiameterIn} in, part ${r.nozzlePartNo} says `
      + `${byPart.get(r.nozzlePartNo)?.exitDiameterIn}`);
}

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
    // has" — is covered exactly, and better, by the join tests below: every
    // motorId resolves, every designation agrees, and every row re-resolves
    // through the app's own findDbMotor. A date is a proxy for that; those are
    // the thing itself.
    //
    // The date did not disappear, though: those tests READ it, to tell a defect
    // in this repo from a catalogue that has moved on since. It decides the
    // verdict instead of being the check (2026-09-08, from review — the same
    // coupling had survived inside the three assertions).
    expect(db.catalogueGenerated, 'nozzles.json must record which catalogue it was keyed against')
      .toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(db.generated).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it('gives the same diameter in both units on every row and part', () => {
    // The file offers the inch figure as "the number a reader can check against
    // the drawing" and the app flies the metres. Nothing compared them, so a
    // hand edit or a botched regeneration could put two different diameters in
    // one row and every other test would pass (2026-09-08, from review).
    const IN_PER_M = IN_PER_M_CHECK;
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
    // PER MANUFACTURER since 2026-09-13, because LOKI GENUINELY BUILD A 9.04.
    // Loki mould one exit per casing per band of nozzle numbers and drill the
    // throat to suit, so the SMALLEST throat in a band gets the largest ratio
    // the band can produce: their 38 mm #10 (0.1563 in) opens into the
    // 0.470 in exit that serves #10 through #15. Their published range is
    // 3.63-9.04 across 55 rows, so 10.0 keeps the same margin over the real
    // data that 9.0 gives AeroTech, and a doubled Loki exit (>= 14.5) is still
    // caught. Widening AeroTech's to fit Loki would have been the wrong move:
    // it is the tightest bound each maker's own hardware allows that makes the
    // check worth running.
    //
    // `throat-bored-through` is exempt BY CONSTRUCTION: those rows are motors
    // whose throat was bored wider than the moulded exit, so the exit plane IS
    // the bore and the ratio is exactly 1 by definition, not by measurement.
    const MAX_RATIO = { AeroTech: 9, Loki: 10 };
    const bad = rows
      .filter((r) => r.exitSource !== 'throat-bored-through')
      .filter((r) => r.exitDiameterIn !== undefined && r.throatDiameterIn > 0)
      .map((r) => ({ r, ratio: (r.exitDiameterIn / r.throatDiameterIn) ** 2 }))
      .filter(({ r, ratio }) => !(ratio >= 1 && ratio <= (MAX_RATIO[r.manufacturer] ?? 9)))
      .map(({ r, ratio }) => `${r.designation} (${r.nozzlePartNo}): exit ${r.exitDiameterIn} in over `
        + `throat ${r.throatDiameterIn} in is an area ratio of ${ratio.toFixed(2)}`);
    expect(bad, bad.join('\n')).toEqual([]);
    // Every manufacturer in the file has a bound, so a third one cannot arrive
    // and silently inherit AeroTech's.
    const unbounded = [...new Set(rows.map((r) => r.manufacturer))].filter((m) => !(m in MAX_RATIO));
    expect(unbounded, `no expansion-ratio bound stated for ${unbounded.join(', ')}`).toEqual([]);
  });

  it('takes each motor exit from the part it names, or says why not', () => {
    // The ONE tie between the two tables in this file, and the check that
    // would have caught a doubled exit on a row whose part still said 1.750.
    // Four sources legitimately differ from the part's own figure and each
    // states itself: a Medusa's exit depends on which throats the motor's
    // sheet opens, a bored-through throat replaces the exit, an assembly
    // description states the motor's own, and a contradicted sheet falls back
    // to the base mould (L400W-PS).
    //
    // The two Loki sources are exempt for a different reason: Loki publish no
    // nozzle PART NUMBERS at all, so there is no parts table for them to be
    // tied to. The engraved number is the part's identity and the exit follows
    // from Loki's published band for the casing — which is checked, below, by
    // re-deriving it from the band table rather than by looking it up here. A
    // measured nozzle is exempt for the same reason (OWN_EXIT_SOURCES).
    const bad = exitsOffTheirPart(rows);
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
    const bad = unlabelledExits(rows);
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
  const REGENERATE = 'Regenerate with `node packages/app/scripts/build-nozzle-db.mjs` on the machine '
    + 'that holds docs/RCS Schematics.';

  it('carries everything a join needs on every matched row', () => {
    // THE HALF OF THE JOIN THAT UPSTREAM CANNOT MOVE, so it is always a hard
    // failure: a row that claims a motorId must also carry the catalogue name
    // it matched, the casing it matched in, and the string it matched on.
    // Those three come out of this repo's own build, not out of thrustcurve.
    const bad = rows.filter((r) => r.motorId)
      .filter((r) => !r.catalogDesignation || !r.casingDiameterMm || !r.provenance?.matchedVia)
      .map((r) => `${r.designation}: ${r.motorId} with catalogDesignation ${r.catalogDesignation}, `
        + `casing ${r.casingDiameterMm}, matchedVia ${r.provenance?.matchedVia}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('only names motorIds the shipped catalogue actually has', () => {
    const bad = rows.filter((r) => r.motorId && !byId.has(r.motorId))
      .map((r) => `${r.designation}: ${r.motorId}`);
    judgeAgainstCatalogue(bad, 'a row names a motorId the shipped catalogue no longer has (a motor '
      + 'thrustcurve.org retired or re-issued)', REGENERATE);
  });

  it('agrees with the catalogue about what the motor is called', () => {
    const bad = rows.filter((r) => r.motorId && byId.has(r.motorId))
      .filter((r) => byId.get(r.motorId).designation !== r.catalogDesignation)
      .map((r) => `${r.designation}: says ${r.catalogDesignation}, catalogue says ${byId.get(r.motorId).designation}`);
    judgeAgainstCatalogue(bad, 'a row disagrees with the catalogue about a motor\'s designation (an '
      + 'upstream rename)', REGENERATE);
  });

  it('resolves through the app\'s own findDbMotor to the same motor', () => {
    // The reason this one exists at all: build-nozzle-db.mjs has to duplicate
    // findDbMotor's ranking, because motorDb.ts is TypeScript with a JSON
    // import and plain node cannot load it. So the duplicate is checked rather
    // than trusted — but it is checked against a catalogue that moves, and a
    // newly certified motor can outrank an old one on the same string without
    // anything here being wrong.
    const bad = [];
    const divergent = [];
    for (const r of rows) {
      if (!r.motorId) continue;
      // The row's OWN manufacturer, not a hard-coded 'AeroTech' (2026-09-13).
      // The string is the tie-break in findDbMotor's ranking, and Loki's rows
      // match on `commonName` — "H100", which several makers also use — so
      // passing AeroTech here would have resolved Loki's H100-SF to AeroTech's
      // H100W_DMS and reported it as a broken join.
      const hit = findDbMotor(r.provenance.matchedVia, r.casingDiameterMm, undefined, r.manufacturer);
      if (hit?.motorId === r.motorId) continue;
      // A DMS ROW MAY LEGITIMATELY DIVERGE, and only a DMS row (2026-09-13).
      // `findDbMotor` has no notion of which document family a nozzle row came
      // from, and the catalogue carries BOTH forms of some motors: H550ST is
      // the RMS-38/360 reload, HP-H550ST the same motor as a DMS single-use.
      // The 38mm/H550ST-14A sheet is in "DMS Motor Designs", so the build is
      // right to attach it to HP-H550ST; the app, given the bare designation,
      // returns the reload. Neither is a defect.
      //
      // It is BOUNDED, though. The divergence may only be to the same motor in
      // another form — same common name, same diameter — never to an unrelated
      // one, and the build separately refuses to write the file at all if a DMS
      // row lands on a motor the catalogue does not call single-use.
      const mine = byId.get(r.motorId);
      // `commonName` must be a real string on BOTH sides: two undefineds
      // compare equal, which would have admitted an unrelated motor as "the
      // same motor in another form" (2026-09-13, from review).
      if (r.docFamily === 'dms' && hit && mine
        && typeof mine.commonName === 'string' && mine.commonName.length > 0
        && hit.commonName === mine.commonName && hit.diameter === mine.diameter) {
        divergent.push(`${r.designation}: build ${r.catalogDesignation} (DMS single-use), findDbMotor ${hit.designation}`);
        continue;
      }
      bad.push(`${r.designation} via "${r.provenance.matchedVia}": build says ${r.catalogDesignation}, findDbMotor says ${hit?.designation ?? 'nothing'}`);
    }
    judgeAgainstCatalogue(bad, 'a row no longer re-resolves through the app\'s own findDbMotor to the '
      + 'motor the build matched it to', REGENERATE);
    // Reported, never silent: each entry is a motor whose nozzle a user's FILE
    // will not find by name, even though the browser will.
    if (divergent.length > 0) {
      console.warn(`\n[nozzles.json] ${divergent.length} DMS row(s) resolve to the OTHER FORM of the same `
        + 'motor through the app\'s own matcher, which cannot know the drawing was a single-use one:\n  '
        + `${divergent.join('\n  ')}\n`);
    }
    // PINNED TO THE KNOWN SET, not to a ceiling (2026-09-13, from review). A
    // `toBeLessThan(5)` let three new mis-joins appear as a console.warn nobody
    // reads in CI. There is exactly one motor the catalogue carries in both a
    // reloadable and a DMS form whose DMS sheet we hold; if a second appears
    // that is worth a human looking, not a silent pass.
    //
    // ROUTED THROUGH THE DRIFT ESCAPE HATCH (2026-09-14, from review). The pin was a bare
    // `expect(...).toEqual([...])`, which is a HARD gate on a set that upstream can change
    // without us touching anything: this set is derived by joining our rows to
    // `motors.json` through the app's own matcher, so a thrustcurve.org rename, or a second
    // motor gaining both a reloadable and a DMS form, moves it. `.github/workflows/
    // motors-refresh.yml` runs on a cron ('17 9 * * 1'), stamps a new date into motors.json
    // and runs `npm test` as its gate — so that rename would have hard-failed the weekly
    // workflow, and every deploy after it, with NO WAY TO CLEAR IT IN CI: clearing needs a
    // regeneration, and regeneration needs the local-only `docs/RCS Schematics`.
    //
    // This is the exact break this file removed on 2026-09-08 and then reintroduced five
    // days later in a different check. Every other join check already goes through
    // `judgeAgainstCatalogue`, which fails hard while the catalogue is the one we were keyed
    // against and downgrades to a warning once it is not. There is no reason for this one to
    // be the exception.
    const unexpected = divergent.map((d) => d.split(':')[0]).sort()
      .filter((d) => d !== 'H550ST-14A');
    judgeAgainstCatalogue(unexpected,
      'the set of DMS rows that resolve to the OTHER FORM of their motor has changed — only '
      + 'H550ST-14A is known to do this', REGENERATE);
    // The known member must still BE there while the catalogue is unchanged; if it vanishes
    // the join has changed shape and the pin above would silently pass on an empty set.
    if (sameCatalogue) {
      expect(divergent.map((d) => d.split(':')[0]).sort(),
        'H550ST-14A no longer resolves to the other form of its motor, against the very '
        + 'catalogue these rows were keyed to — the join has changed shape')
        .toEqual(['H550ST-14A']);
    }
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

/**
 * THE SCREEN ON THE LOKI ROWS (2026-09-13).
 *
 * Loki's half of this file is not read off a drawing that states an exit for a
 * part. It is a two-step derivation — nozzle number, then that number's band in
 * Loki's published table — and both steps are transcriptions from a web page
 * and 21 instruction sheets. Nothing in the file itself could contradict a
 * transcription error, which is the same hole the AeroTech half's parts-table
 * tie was written to close.
 *
 * So the BAND TABLE IS RESTATED HERE, independently of the builder, and every
 * Loki exit is re-derived from the nozzle number the row itself carries. A band
 * mistyped in one place now disagrees with the other. That is the whole point:
 * if this block is ever "fixed" by copying the builder's constant, it stops
 * being a check and becomes an echo.
 *
 * Verbatim from https://lokiresearch.com/page/Tech_Info, read 2026-09-13.
 */
const LOKI_BANDS = {
  38: [[10, 15, 0.470], [16, 18, 0.630], [19, 24, 0.780], [25, Infinity, 0.900]],
  54: [[19, 23, 0.850], [24, 28, 1.000], [29, Infinity, 1.250]],
  76: [[28, 39, 1.255], [40, 51, 1.500], [52, Infinity, 1.818]],
};

/**
 * The Loki rows these checks are ABOUT: every Loki row read off Loki's published
 * tables, which is every Loki row but a measured one. A measured nozzle is the
 * case those tables do not cover — L2050LW and M1378LR's 54/4000 commercial
 * throat cell reads "Single Use" — so it carries no engraved `#n`, and its
 * caliper reading is not required to land on a band. It is screened by
 * `measuredRowProblems` instead. Routed out here and nowhere else, so each
 * check below still sees every published row.
 */
const publishedLoki = (rowSet) => rowSet.filter((r) => r.manufacturer === 'Loki' && r.exitSource !== 'measured');

function lokiPartNumberProblems(rowSet) {
  return publishedLoki(rowSet).filter((r) => !/^#\d+$/.test(r.nozzlePartNo ?? ''))
    .map((r) => `${r.designation}: nozzlePartNo ${r.nozzlePartNo}`);
}

function lokiThroatProblems(rowSet) {
  return publishedLoki(rowSet)
    .filter((r) => Math.abs(r.throatDiameterIn - Number(r.nozzlePartNo.slice(1)) / 64) > 0.0001)
    .map((r) => `${r.designation}: ${r.nozzlePartNo} is ${(Number(r.nozzlePartNo.slice(1)) / 64).toFixed(4)} in, row says ${r.throatDiameterIn}`);
}

function lokiBandProblems(rowSet) {
  const bad = [];
  for (const r of publishedLoki(rowSet)) {
    const no = Number(r.nozzlePartNo.slice(1));
    const band = (LOKI_BANDS[r.casingDiameterMm] ?? []).find(([lo, hi]) => no >= lo && no <= hi);
    const want = band?.[2];
    if (want === undefined) {
      // No band published for this casing — the row must then carry NO exit.
      // Loki's 98 mm hardware is the only case, and shipping a number for it
      // would be an invention rather than a reading.
      if (r.exitDiameterM !== undefined) {
        bad.push(`${r.designation}: ${r.casingDiameterMm} mm has no published band, but the row has an exit`);
      }
      continue;
    }
    if (r.exitDiameterIn !== want) {
      bad.push(`${r.designation} (${r.nozzlePartNo}, ${r.casingDiameterMm} mm): row says ${r.exitDiameterIn} in, `
        + `Loki's published band says ${want} in`);
    }
  }
  return bad;
}

function lokiSourceProblems(rowSet) {
  const loki = publishedLoki(rowSet);
  return {
    bad: loki
      .filter((r) => !(r.exitSource === 'loki-sheet' && r.exitConfidence === 'high')
        && !(r.exitSource === 'loki-case-table' && r.exitConfidence === 'medium')
        && !(r.exitSource === 'none' && r.exitConfidence === 'none' && r.exitDiameterM === undefined))
      .map((r) => `${r.designation}: ${r.exitSource}/${r.exitConfidence}`),
    // A row taken from the per-case column instead of the motor's own sheet
    // has to SAY so, because that is the one step of inference in the chain.
    silent: loki.filter((r) => r.exitSource === 'loki-case-table' && !r.confidenceNote)
      .map((r) => r.designation),
  };
}

function lokiCustomExitProblems(rowSet) {
  return {
    wrong: rowSet.filter((r) => r.customExitNote)
      .filter((r) => r.manufacturer !== 'Loki' || r.casingDiameterMm !== 76
        || r.exitDiameterIn === undefined || r.exitSource === 'measured')
      .map((r) => `${r.designation}: ${r.manufacturer} ${r.casingDiameterMm} mm, exit ${r.exitDiameterIn}, `
        + `source ${r.exitSource}`),
    // The note quotes Loki's STANDARD exit for the row's band, so it belongs on
    // the published rows and not on a measured one, whose exit is not a band's.
    missing: publishedLoki(rowSet)
      .filter((r) => r.casingDiameterMm === 76 && r.exitDiameterIn !== undefined)
      .filter((r) => !r.customExitNote)
      .map((r) => r.designation),
  };
}

/**
 * A measured row's own screen. It has to say it is measured, by whom and when,
 * in every place a published row says where its number came from — so it can
 * never pass, downstream, as a figure off a drawing — and it takes no part in
 * Loki's band cautions. The physical bounds (exit >= throat, exit inside the
 * casing, one row per motorId) are the shipped-file checks above, which run on
 * it unchanged.
 */
function measuredRowProblems(rowSet) {
  return rowSet.filter((r) => r.exitSource === 'measured')
    .flatMap((r) => {
      const why = [];
      if (r.exitConfidence !== 'high') why.push(`confidence ${r.exitConfidence}, not "high"`);
      if (!(r.exitDiameterIn > 0) || !(r.exitDiameterM > 0)) why.push('no exit');
      if (!/^Measured from the hardware by \S/.test(r.confidenceNote ?? '')) why.push('the note does not name who measured it');
      if (!/^Measured: \S.*, \d{4}-\d\d-\d\d$/.test(r.provenance?.exitFrom ?? '')) {
        why.push(`provenance.exitFrom "${r.provenance?.exitFrom}" does not name a measurer and a date`);
      }
      if (!r.motorId) why.push('no motorId — a measurement is only ever made for a catalogued motor');
      if (r.customExitNote) why.push('carries Loki\'s band caution, which describes a published exit');
      if (r.exitAmbiguous) why.push('marked ambiguous — one caliper reading is one number');
      return why.map((w) => `${r.designation} (${r.nozzlePartNo}): ${w}`);
    });
}

describe('the Loki rows, derived from Loki\'s own published tables', () => {
  it('is here at all, and every row names the engraved nozzle number', () => {
    expect(publishedLoki(rows).length).toBeGreaterThan(50);
    const bad = lokiPartNumberProblems(rows);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('gives every throat as the n/64 inch its engraved number means', () => {
    // Loki's own definition: "Every nozzle is engraved with a number indicating
    // the throat size in 64ths of an inch." So the throat is not an
    // independent reading and must be exactly the number over 64 — a row whose
    // throat drifted from its own label would mean the two were entered apart.
    const bad = lokiThroatProblems(rows);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('re-derives every exit from the published band for its casing', () => {
    const bad = lokiBandProblems(rows);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('says which of the two published sources each row came from', () => {
    const { bad, silent } = lokiSourceProblems(rows);
    expect(bad, bad.join('\n')).toEqual([]);
    expect(silent, silent.join(', ')).toEqual([]);
  });

  it("carries Loki's own custom-exit caution on exactly the 76 mm rows", () => {
    // Eric's ruling (b), 2026-09-13. Loki publish: "76mm nozzle exits up to
    // 2.0\" are available upon request for an additional machining fee." It
    // names no other casing, so a 38 or 54 mm row carrying it would be a
    // caution about an option that flyer cannot buy.
    expect(rows.filter((r) => r.customExitNote).length).toBeGreaterThan(0);
    // And EVERY 76 mm Loki row with an exit has it — a note on some of them
    // would be worse than none, because its absence would read as "not this one".
    const { wrong, missing } = lokiCustomExitProblems(rows);
    expect(wrong, wrong.join('\n')).toEqual([]);
    expect(missing, missing.join(', ')).toEqual([]);
  });

  it("states an area increase the row's own numbers actually give", () => {
    // THE NUMBER IN THE SENTENCE, checked against the number in the row. A
    // caution whose arithmetic is wrong is worse than no caution: it is a
    // figure a flyer may act on, in a field that buys thrust. 2.0 in against
    // 1.818 is +21 %; against the 1.500 band it is +78 %, and the note is
    // generated per row precisely so both are right.
    const bad = [];
    for (const r of rows.filter((x) => x.customExitNote)) {
      const m = /([\d.]+) in is (\d+) % more exit AREA/.exec(r.customExitNote);
      if (!m) { bad.push(`${r.designation}: the note states no area figure`); continue; }
      const want = Math.round(((Number(m[1]) / r.exitDiameterIn) ** 2 - 1) * 100);
      if (Number(m[2]) !== want) {
        bad.push(`${r.designation}: note says ${m[2]} %, ${m[1]} in over ${r.exitDiameterIn} in gives ${want} %`);
      }
      // And the standard figure it quotes must be the row's own.
      if (!r.customExitNote.includes(`STANDARD ${r.exitDiameterIn} in`)) {
        bad.push(`${r.designation}: the note does not quote this row's own ${r.exitDiameterIn} in`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('records the two documents agreeing, and lets neither be empty', () => {
    // The cross-check the whole section rests on: each instruction sheet read
    // against Loki's own per-case commercial-throat column. A build that wrote
    // an EMPTY comparison would pass a naive "no disagreements" test while
    // having checked nothing at all.
    const x = db.crossCheck?.lokiSheetAgainstCaseTable;
    expect(x?.rows?.length, 'the sheet-against-case-table comparison must not be empty').toBeGreaterThan(20);
    const bad = x.rows.filter((r) => !r.agrees)
      .map((r) => `${r.commonName} (${r.caseInfo}): sheet #${r.sheetNozzleNo}, table #${r.caseTableNozzleNo}`);
    expect(bad, bad.join('\n')).toEqual([]);
    // And every compared row has to name the sheet it was read from, or the
    // comparison cannot be traced back to paper.
    const anon = x.rows.filter((r) => !Array.isArray(r.sheets) || r.sheets.length === 0)
      .map((r) => r.commonName);
    expect(anon, anon.join(', ')).toEqual([]);
  });
});

describe('the coverage this file claims about itself', () => {
  // WHY THIS BLOCK EXISTS (2026-09-08, from review). v0.120's release note said
  // this database covers "every 98 mm motor". It does not: AeroTech have 32
  // in-production 98 mm motors in the bundled catalogue and 28 of them have a
  // row — M1305M, M1340W, N1975W-PS and O5500X-PS have none, because their
  // paperwork is not the reload-kit assembly drawing this database is built
  // from. That claim was written by hand from a spot check and
  // nothing in the repo could contradict it. build-nozzle-db.mjs now COUNTS
  // coverage per casing diameter and names what is short; this is the check
  // that the counting is honest, so the next claim can be read off the file.
  // PER MANUFACTURER since 2026-09-13, when Loki's 60 motors arrived. Keyed by
  // casing diameter alone, AeroTech's 38 mm motors and Loki's would have been
  // added together and the figure would have described neither.
  const byMaker = db.coverage?.byManufacturer ?? {};
  const allCoverage = Object.entries(byMaker)
    .flatMap(([maker, c]) => Object.entries(c.byCasingDiameterMm ?? {}).map(([mm, e]) => [maker, mm, e]));

  it('states, per manufacturer and casing diameter, how much of the catalogue it covers', () => {
    expect(Object.keys(byMaker).sort()).toEqual(['AeroTech', 'Loki']);
    expect(allCoverage.length).toBeGreaterThan(0);
    const bad = allCoverage
      .filter(([, , e]) => !(e.inProduction > 0) || !(e.withNozzleRow >= 0)
        || e.withNozzleRow > e.inProduction
        // A row is not a number: `withExitDiameter` counts the rows that carry
        // the figure the app needs, and it can only ever be a subset.
        || !(e.withExitDiameter >= 0) || e.withExitDiameter > e.withNozzleRow
        || !Array.isArray(e.missing) || e.missing.length !== e.inProduction - e.withNozzleRow)
      .map(([maker, mm, e]) => `${maker} ${mm} mm: ${e.withNozzleRow} rows / ${e.withExitDiameter} exits `
        + `of ${e.inProduction}, ${e.missing?.length} named as missing`);
    expect(bad, bad.join('\n')).toEqual([]);
    // The 98 mm AeroTech line is the one a release note quoted, so its presence
    // is pinned; its numbers are checked against the catalogue below.
    expect(byMaker.AeroTech.byCasingDiameterMm['98'], 'the 98 mm coverage figure must be stated').toBeDefined();
  });

  it('names every motor it counts as missing in `uncovered` too', () => {
    // Both blocks are computed in the same run from the same catalogue, so
    // they cannot legitimately disagree — and `uncovered` is where a reader
    // looks for the names behind a coverage figure.
    const named = new Set(Object.values(db.uncovered).flat());
    const bad = allCoverage
      .flatMap(([maker, mm, e]) => (e.missing ?? []).filter((d) => !named.has(d))
        .map((d) => `${maker} ${mm} mm ${d}: counted as missing but not named in \`uncovered\``));
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('counts that coverage from the shipped catalogue rather than from memory', () => {
    const byRow = new Map(rows.filter((r) => r.motorId).map((r) => [r.motorId, r]));
    const bad = [];
    for (const maker of Object.keys(byMaker)) {
      const stated = byMaker[maker].byCasingDiameterMm ?? {};
      const recomputed = new Map();
      for (const m of catalogue.motors) {
        if (m.manufacturerAbbrev !== maker || m.availability === 'OOP') continue;
        const mm = String(m.diameter);
        if (!recomputed.has(mm)) {
          recomputed.set(mm, { inProduction: 0, withNozzleRow: 0, withExitDiameter: 0, missing: [] });
        }
        const e = recomputed.get(mm);
        e.inProduction++;
        const row = byRow.get(m.motorId);
        if (row) {
          e.withNozzleRow++;
          if (row.exitDiameterM !== undefined) e.withExitDiameter++;
        } else e.missing.push(m.designation);
      }
      for (const [mm, e] of recomputed) {
        const said = stated[mm];
        if (!said) { bad.push(`${maker} ${mm} mm: catalogue has ${e.inProduction} in production, file states nothing`); continue; }
        if (said.inProduction !== e.inProduction || said.withNozzleRow !== e.withNozzleRow
          || said.withExitDiameter !== e.withExitDiameter) {
          bad.push(`${maker} ${mm} mm: file says ${said.withNozzleRow} rows / ${said.withExitDiameter} exits of `
            + `${said.inProduction}, catalogue gives ${e.withNozzleRow} / ${e.withExitDiameter} of ${e.inProduction}`);
        }
        const missing = [...(said.missing ?? [])].sort().join(' ');
        if (missing !== [...e.missing].sort().join(' ')) {
          bad.push(`${maker} ${mm} mm: file names [${missing}] as missing, catalogue gives [${[...e.missing].sort().join(' ')}]`);
        }
      }
      for (const mm of Object.keys(stated)) {
        if (!recomputed.has(mm)) bad.push(`${maker} ${mm} mm: stated, but the catalogue has no in-production ${maker} motor that size`);
      }
    }
    // Same verdict rule as the join: a stale count against a catalogue that
    // has moved on is a report, because only a regeneration can clear it.
    judgeAgainstCatalogue(bad, 'the stated coverage no longer matches the shipped catalogue',
      'Regenerate with `node packages/app/scripts/build-nozzle-db.mjs` on the machine that holds '
      + 'docs/RCS Schematics and docs/Loki Data, and correct any coverage figure quoted in a release note.');
  });
});

describe('the gaps are stated rather than left blank', () => {
  it('names what is still short for Loki and Cesaroni, and keeps a place for measured data', () => {
    // Loki went from "no published geometry at all" to 55 of 60 motors on
    // 2026-09-13, so what this note has to carry is no longer "we will measure
    // it" but WHICH FIVE ARE STILL SHORT — and each of those has to be a motor
    // the file really has no row for, checked against the rows rather than
    // against the sentence.
    expect(db.gaps.Loki).toMatch(/Loki/);
    expect(db.gaps.Cesaroni).toMatch(/no published/i);
    expect(Array.isArray(db.measured)).toBe(true);
    const lokiWithExit = new Set(rows
      .filter((r) => r.manufacturer === 'Loki' && r.exitDiameterM !== undefined)
      .map((r) => r.designation));
    const named = [...db.gaps.Loki.matchAll(/\b([A-Z]+-?\d{2,4}[A-Z-]*)\b/g)].map((m) => m[1]);
    const wrong = named.filter((d) => lokiWithExit.has(d));
    expect(wrong, `gaps.Loki names ${wrong.join(', ')} as short, but the file has an exit for them`)
      .toEqual([]);
  });

  it('MERGES a measured nozzle into the rows the app reads, not only into `measured`', () => {
    // THE HOLE THIS CLOSES (2026-09-13). `MEASURED_NOZZLES` was written on
    // 2026-09-08 as the documented landing place for a nozzle nobody
    // publishes, and `gaps.Loki` told the owner to put his caliper readings
    // there. It was emitted as `measured` and NEVER MERGED INTO `motors` — and
    // `nozzleDb.ts` reads `motors` and nothing else, so a measurement would
    // have reached this file and not the app. The builder now merges them.
    //
    // ⚠ THIS TEST IS VACUOUS WHILE `measured` IS EMPTY, and it is today. That
    // is deliberate and it is said out loud: it goes live the moment the first
    // measurement lands (Eric is measuring L2050LW and M1378LR), which is
    // exactly when a silent regression here would cost something. The merge
    // itself was proved by hand on 2026-09-13 with a temporary entry: two rows
    // appeared in `motors` at exitSource "measured" and Loki 54 mm coverage
    // went 14/16 to 16/16. Do not read a green tick here as proof of the merge
    // until `measured` has an entry in it. Since 2026-09-22 the MERGE CODE is
    // exercised on every run regardless, on a synthetic entry (the describe
    // "a measured nozzle, before the first real one lands", below); this test
    // stays the check that the SHIPPED file holds what its `measured` says.
    const byId = new Map(rows.map((r) => [r.motorId, r]));
    const byDesignation = new Map(rows.map((r) => [r.designation, r]));
    const bad = [];
    for (const m of db.measured) {
      for (const want of m.appliesTo ?? []) {
        const row = byDesignation.get(want) ?? [...byId.values()].find((r) => r.commonName === want);
        if (!row) { bad.push(`${m.partNo}: ${want} is in \`measured\` but has no row in \`motors\``); continue; }
        if (row.exitSource !== 'measured') {
          bad.push(`${m.partNo}: ${want}'s row says exitSource ${row.exitSource}, not "measured"`);
        }
        if (row.exitDiameterIn !== m.exitDiameterIn) {
          bad.push(`${m.partNo}: ${want}'s row says ${row.exitDiameterIn} in, the measurement says ${m.exitDiameterIn}`);
        }
        if (!row.provenance?.exitFrom?.includes(m.measuredBy)) {
          bad.push(`${m.partNo}: ${want}'s row does not name who measured it`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
    // A note in the run output, so an empty list reads as "nothing to check"
    // and never as "the merge was verified".
    if (db.measured.length === 0) {
      console.warn('[nozzles.json] `measured` is empty, so the measured-merge check had nothing to assert.');
    }
  });

  it('applies the same physical bounds to any measured row that is added', () => {
    const bad = db.measured
      .filter((m) => !(m.exitDiameterIn > 0) || !m.measuredBy || !m.manufacturer
        || (m.throatDiameterIn !== undefined && m.exitDiameterIn < m.throatDiameterIn))
      .map((m) => JSON.stringify(m));
    expect(bad, bad.join('\n')).toEqual([]);
    // And the rows they became pass a measured row's own screen.
    const rowBad = measuredRowProblems(rows);
    expect(rowBad, rowBad.join('\n')).toEqual([]);
  });
});

/**
 * THE MEASURED PATH, EXERCISED BEFORE THE FIRST REAL MEASUREMENT (audit
 * 2026-09-22). `measured` is empty in the shipped file, so every check above
 * that reads a measured row passes on nothing. Here the builder's own
 * `mergeMeasured` turns a synthetic entry into rows, exactly as it would the
 * owner's L2050LW / M1378LR readings, and every row screen runs on the shipped
 * rows PLUS those. The catalogue motors are synthetic too, so the fixture does
 * not start colliding with real data the day a real measurement lands.
 */
describe('a measured nozzle, before the first real one lands', () => {
  const catalogueFixture = [
    { motorId: 'fixture-loki-54-a', manufacturerAbbrev: 'Loki', designation: 'L9001LW', commonName: 'L9001',
      diameter: 54, caseInfo: '54/4000' },
    { motorId: 'fixture-loki-54-b', manufacturerAbbrev: 'Loki', designation: 'M9002LR', commonName: 'M9002',
      diameter: 54, caseInfo: '54/4000' },
  ];
  const entry = {
    manufacturer: 'Loki', partNo: '54/4000 single-use (fixture)', exitDiameterIn: 1.0, throatDiameterIn: 0.5,
    measuredBy: 'nozzle-db.test.mjs', measuredOn: '2026-09-22', appliesTo: ['L9001LW', 'M9002'],
  };
  const merged = mergeMeasured([entry], catalogueFixture, rows);
  const withMeasured = [...rows, ...merged.rows];

  it('is merged into rows by the builder\'s own code, one per motor it names', () => {
    expect(merged.problems).toEqual([]);
    expect(merged.rows.map((r) => r.motorId)).toEqual(['fixture-loki-54-a', 'fixture-loki-54-b']);
    expect(merged.rows.every((r) => r.exitSource === 'measured')).toBe(true);
    // The metres the app flies are the inches, converted, to the micron.
    expect(merged.rows[0].exitDiameterM).toBe(0.0254);
    expect(merged.rows[0].throatDiameterM).toBe(0.0127);
  });

  it('passes every row screen a published row passes', () => {
    const labelled = unlabelledExits(withMeasured);
    expect(labelled, labelled.join('\n')).toEqual([]);
    const tied = exitsOffTheirPart(withMeasured);
    expect(tied, tied.join('\n')).toEqual([]);
    for (const [what, bad] of [
      ['part number', lokiPartNumberProblems(withMeasured)],
      ['throat', lokiThroatProblems(withMeasured)],
      ['band', lokiBandProblems(withMeasured)],
      ['source', lokiSourceProblems(withMeasured).bad],
      ['custom exit', lokiCustomExitProblems(withMeasured).wrong],
      ['measured', measuredRowProblems(withMeasured)],
    ]) {
      expect(bad, `${what}:\n${bad.join('\n')}`).toEqual([]);
    }
  });

  it('still has every published Loki row screened: only measured rows are routed away', () => {
    // The routing must not quietly empty the published checks: adding measured
    // rows leaves the published set exactly the shipped Loki rows, and a wrong
    // band figure on one of those is still caught.
    const published = publishedLoki(withMeasured);
    expect(published.length).toBe(publishedLoki(rows).length);
    const banded = published.find((r) => r.exitDiameterIn !== undefined && LOKI_BANDS[r.casingDiameterMm]);
    const wrongBand = withMeasured.map((r) => (r === banded ? { ...r, exitDiameterIn: 9.9 } : r));
    expect(lokiBandProblems(wrongBand)).toHaveLength(1);
  });

  it('refuses a measured row that does not say who measured it, or claims a band caution', () => {
    const [row] = merged.rows;
    const anonymous = { ...row, confidenceNote: 'Measured.', provenance: { ...row.provenance, exitFrom: 'Measured' } };
    expect(measuredRowProblems([anonymous]).length).toBe(2);
    expect(measuredRowProblems([{ ...row, customExitNote: 'x' }]).length).toBe(1);
    expect(measuredRowProblems([{ ...row, exitConfidence: 'medium' }]).length).toBe(1);
  });

  it('refuses a measurement of a motor that already has a published row', () => {
    const published = rows.find((r) => r.manufacturer === 'Loki' && r.motorId);
    const clash = mergeMeasured([{ ...entry, appliesTo: [published.designation] }],
      [{ ...catalogueFixture[0], motorId: published.motorId, designation: published.designation }], rows);
    expect(clash.rows).toEqual([]);
    expect(clash.problems.join('\n')).toMatch(/already has a PUBLISHED row/);
  });

  it('refuses a measurement with no measurer, no date, or no motor', () => {
    const problems = (e) => mergeMeasured([{ ...entry, ...e }], catalogueFixture, rows).problems;
    expect(problems({ measuredBy: '' })).toHaveLength(1);
    expect(problems({ measuredOn: undefined })).toHaveLength(1);
    expect(problems({ appliesTo: [] })).toHaveLength(1);
    expect(problems({ exitDiameterIn: 0 })).toHaveLength(1);
    expect(problems({ appliesTo: ['NO-SUCH-MOTOR'] })).toHaveLength(1);
  });
});

/**
 * THE BUILDER'S PURE HELPERS (audit 2026-09-22), pinned where a slipped factor
 * would otherwise ship unseen: a factor applied to EVERY row keeps every ratio,
 * bound and part tie above intact.
 */
describe('build-nozzle-db\'s conversions and readers', () => {
  it('converts inches to metres at exactly 25.4 mm, to the micron', () => {
    expect(BUILD_IN_PER_M).toBeCloseTo(1 / 0.0254, 12);
    // The builder and this file's own both-units check agree on the factor.
    expect(BUILD_IN_PER_M).toBe(IN_PER_M_CHECK);
    expect(buildRound6(inToM(1))).toBe(0.0254);
    expect(buildRound6(inToM(1.75))).toBe(0.04445);
    expect(buildRound6(inToM(0.734))).toBe(0.018644);
    expect(buildRound6(0.12345649)).toBe(0.123456);
    expect(buildRound6(0.1234565)).toBe(0.123457);
  });

  it('reads a store page\'s labelled figures, and a weight of a kilogram or more', () => {
    const page = (summary) => readSpecPage({ productCode: '01800', file: 'x.mhtml', title: 't', summary });
    const single = page('Molded glass/phenolic nozzle for 98mm diameter motors. Dimensions: 3.619" O.D. '
      + '1.000" diameter throat 2.737" diameter exit Weight = 549 grams');
    expect(single).toMatchObject({ odIn: 3.619, throatIn: 1, exitIn: 2.737, weightG: 549 });
    expect(single.multi).toBeUndefined();
    // "1,050 grams" was Number('1,050') = NaN, which JSON writes as null.
    expect(page('3.619" O.D. 1.000" diameter throat 2.737" diameter exit Weight = 1,050 grams').weightG).toBe(1050);
    expect(page('Weight: 1,234.5 grams').weightG).toBe(1234.5);
    expect(page('no weight stated').weightG).toBeUndefined();
    const medusa = page('0.192" diameter center throat 0.500" diameter center exit 0.125" diameter plugged '
      + 'outer throats x 6 0.375" diameter outer exits x 6');
    expect(medusa.multi).toEqual({ centerThroatIn: 0.192, centerExitIn: 0.5, outerThroatIn: 0.125,
      outerExitIn: 0.375, outerCount: 6 });
    expect(page('Throat diameter: 0.13" Exit diameter: 0.25"')).toMatchObject({ throatIn: 0.13, exitIn: 0.25 });
  });

  it('dates the file from every document family it read, each joined to its own folder', () => {
    const raw = {
      assemblies: [{ file: 'RMS-38/H.pdf', docFamily: 'reloadable' }, { file: '29mm/D.pdf', docFamily: 'dms' }],
      specPages: [{ file: 'Nozzles/a.mhtml' }],
      nozzleDrawings: [{ file: 'Nozzles/b.pdf' }],
      certNozzles: [{ file: 'Cert Docs/c.pdf' }],
    };
    expect(sourceDocuments(raw, ['38mm Red.pdf'])).toEqual([
      { root: 'rcs', file: 'Motor Assembly Drawings/RMS-38/H.pdf' },
      { root: 'rcs', file: 'DMS Motor Designs/29mm/D.pdf' },
      { root: 'rcs', file: 'Nozzles/a.mhtml' },
      { root: 'rcs', file: 'Nozzles/b.pdf' },
      { root: 'rcs', file: 'Cert Docs/c.pdf' },
      { root: 'loki', file: '38mm Red.pdf' },
    ]);
    // A third family must be given its folder, not joined to one it is not in.
    expect(() => sourceDocuments({ ...raw, assemblies: [{ file: 'x.pdf', docFamily: 'hybrid' }] }))
      .toThrow(/unknown docFamily "hybrid"/);
    expect(Object.keys(ASSEMBLY_FOLDER).sort()).toEqual(['dms', 'reloadable']);
  });
});
