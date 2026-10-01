import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inToM, round6 } from './nozzle-db-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * build-nozzle-db.mjs, the builder itself, on SYNTHETIC documents. Until
 * 2026-09-23 its work ran at module top level: importing it ran the Python
 * extractor over `docs/RCS Schematics`, read motors.json, wrote nozzles.json,
 * and exited when the folder was missing, which it is on CI. So the body that
 * turns the tested helpers (nozzle-db.test.mjs) into rows had no test at all
 * (AUDIT row 480). It now runs only as the entry point and exports the
 * composition, which is what these tests drive.
 *
 * The part numbers, sizes and filenames below are made up to exercise the
 * rules, not AeroTech's or Loki's data; the shipped file is screened by
 * nozzle-db.test.mjs.
 */

// Every call into node:fs and node:child_process, recorded. While `block` is
// set (everywhere but the main() tests, which need a scratch folder) any such
// call throws instead of happening, so a module that still did its work at
// import (the old one) fails here without reading docs/ or touching
// nozzles.json.
const { io, recorded } = vi.hoisted(() => {
  const io = { calls: [], block: true };
  const recorded = (prefix) => async (importOriginal) => {
    const real = await importOriginal();
    const wrap = (name, fn) => new Proxy(fn, {
      apply(target, self, args) {
        io.calls.push(`${prefix}.${name}(${String(args[0])})`);
        if (io.block) throw new Error(`${prefix}.${name} called while the test forbids it`);
        return Reflect.apply(target, self, args);
      },
    });
    const mocked = Object.fromEntries(Object.entries(real)
      .map(([k, v]) => [k, typeof v === 'function' ? wrap(k, v) : v]));
    return { ...mocked, default: mocked };
  };
  return { io, recorded };
});
vi.mock('node:fs', recorded('fs'));
vi.mock('node:child_process', recorded('child_process'));

const builder = () => import('./build-nozzle-db.mjs');

describe('importing the builder', () => {
  it('reads nothing, writes nothing and runs nothing: no docs/, no motors.json, no nozzles.json', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) at import`);
    });
    try {
      vi.resetModules(); // evaluate it afresh, whatever an earlier test loaded
      io.calls.length = 0;
      const mod = await builder();
      expect(io.calls).toEqual([]);
      expect(exit).not.toHaveBeenCalled();
      expect(typeof mod.main).toBe('function');
      expect(typeof mod.buildNozzleDb).toBe('function');
    } finally {
      exit.mockRestore();
    }
  });
});

// ------------------------------------------------------------ the documents

/** An assembly drawing as extract-nozzle-pdfs.py reports it. */
const assembly = (file, lomRows, extra = {}) => ({
  file,
  docFamily: 'reloadable',
  caseFolder: file.split('/')[0],
  atFamilyRoot: false,
  designationFromFile: file.split('/')[1].replace(/ Assembly.*$/, ''),
  foundLomHeader: true,
  designationOnSheet: true,
  designationStemOnSheet: true,
  revisions: [],
  lomRows: [{ part: '04580', desc: 'NOZZLE CAP' }, ...lomRows],
  ...extra,
});
const specPage = (code, summary) => ({
  file: `Nozzles/${code}.mhtml`, productCode: code, title: `Nozzle ${code}`, summary,
});
/** A nozzle drawing that prints AeroTech's dash-number rule. */
const drawing = (part, dashRows = []) => ({
  file: `Nozzles/rcs_${part}_nozzle_dwg.pdf`,
  text: `DASH NUMBERS INDICATE IN-HOUSE MACHINING OF THROAT DIAMETER ${part} SCALE 1 / 1`,
  statesDashNumberRule: true,
  callouts: [],
  dashRows,
  revisions: [],
});

const NEW_SHEET = 'RMS-54-1706 High Power/K1100T-L Assembly (New Single-Throat Nozzle).pdf';
const OLD_SHEET = 'RMS-54-1706 High Power/K1100T-M Assembly (Original Nozzle).pdf';
const M_SHEET = 'RMS-98-10240 High Power/M1000W-L Assembly.pdf';

const RAW = () => ({
  specPages: [
    specPage('01670', 'Nozzle for 54mm motors. Dimensions: 1.600" O.D. 0.455" diameter throat 1.250" diameter exit Weight = 60 grams'),
    specPage('01650', 'Nozzle for 54mm motors. Dimensions: 1.600" O.D. 0.600" diameter throat 0.812" diameter exit Weight = 55 grams'),
    specPage('01880', 'Nozzle for 98mm motors. Dimensions: 3.619" O.D. 1.000" diameter throat 1.750" diameter exit Weight = 549 grams'),
  ],
  nozzleDrawings: [drawing('01670'), drawing('01880', [['01880-4', '1.219']])],
  assemblies: [
    assembly(NEW_SHEET, [{ part: '01670-3', desc: 'NOZZLE (54MM) (.615" DT DRILLED)' }]),
    assembly(OLD_SHEET, [{ part: '01650', desc: 'NOZZLE (54MM) (.615" DT DRILLED)' }]),
    assembly(M_SHEET, [{ part: '01880-4', desc: 'NOZZLE (98MM) (1.219" DT DRILLED)' }]),
  ],
  certNozzles: [],
});

const CATALOGUE = () => ({
  generated: '2026-09-19',
  motors: [
    { motorId: 'at-k1100', manufacturerAbbrev: 'AeroTech', designation: 'K1100T', commonName: 'K1100', diameter: 54, caseInfo: 'RMS-54/1706', type: 'reload', availability: 'regular' },
    { motorId: 'at-m1000', manufacturerAbbrev: 'AeroTech', designation: 'M1000W', commonName: 'M1000', diameter: 98, caseInfo: 'RMS-98/10240', type: 'reload', availability: 'regular' },
    { motorId: 'loki-h90', manufacturerAbbrev: 'Loki', designation: 'H90-LR', commonName: 'H90', diameter: 38, caseInfo: '38/240', type: 'reload', availability: 'regular' },
    { motorId: 'loki-n5500', manufacturerAbbrev: 'Loki', designation: 'N5500LW', commonName: 'N5500', diameter: 98, caseInfo: null, type: 'reload', availability: 'regular' },
  ],
});
const aerotechOf = (db) => db.motors.filter((m) => m.manufacturerAbbrev === 'AeroTech');
const lokiOf = (db) => db.motors.filter((m) => m.manufacturerAbbrev === 'Loki');
const SEPT_13 = Date.UTC(2026, 8, 13, 12);

/** The full composition on the synthetic set, without the shipped tables that name real motors. */
const build = async (over = {}) => (await builder()).buildNozzleDb({
  raw: RAW(), motorsDb: CATALOGUE(), mtimeMs: () => SEPT_13,
  lokiSheets: [], observations: [], measured: [], sheetJoins: [], instructionRows: [], storePages: [],
  ...over,
});

// ------------------------------------------------------------ the AeroTech rows

describe('the AeroTech rows, one per drawing and then one per motor', () => {
  it('carries the base part\'s exit across a dash number, and reads the throat off the motor\'s own sheet', async () => {
    const { aerotechDrawingRows, oneRowPerMotor } = await builder();
    const raw = RAW();
    const { rows, perDrawing, unmatched, unresolved } = aerotechDrawingRows(raw, aerotechOf(CATALOGUE()));
    expect(perDrawing).toHaveLength(3);
    expect(unmatched).toEqual([]);
    expect(unresolved).toEqual([]);
    const m = oneRowPerMotor(rows, raw.assemblies).find((r) => r.motorId === 'at-m1000');
    expect(m).toMatchObject({
      manufacturer: 'AeroTech',
      designation: 'M1000W-L',
      catalogDesignation: 'M1000W',
      caseFamily: 'RMS-98-10240 High Power',
      docFamily: 'reloadable',
      casingDiameterMm: 98,
      nozzlePartNo: '01880-4',
      // 01880-4 has no page of its own: the base part's moulded exit, under the
      // rule the base drawing prints, so graded high.
      exitDiameterIn: 1.75,
      exitDiameterM: round6(inToM(1.75)),
      exitSource: 'base-spec-page',
      exitConfidence: 'high',
      // The throat is this motor's, from its own LIST OF MATERIAL row, not the base part's 1.000.
      throatDiameterIn: 1.219,
      throatDiameterM: round6(inToM(1.219)),
    });
    expect(m.exitAmbiguous).toBeUndefined();
    expect(m.confidenceNote).toBeUndefined();
    expect(m.provenance).toMatchObject({
      exitFrom: 'Nozzles/01880.mhtml',
      assemblyDrawings: [M_SHEET],
      caseAgrees: true,
    });
  });

  it('keeps both of two published nozzles, picks the one the sheet names as newer, and says so', async () => {
    const { aerotechDrawingRows, oneRowPerMotor } = await builder();
    const raw = RAW();
    const { rows } = aerotechDrawingRows(raw, aerotechOf(CATALOGUE()));
    const k = oneRowPerMotor(rows, raw.assemblies).find((r) => r.motorId === 'at-k1100');
    expect(k).toMatchObject({
      designation: 'K1100T-L',
      nozzlePartNo: '01670-3',
      exitDiameterIn: 1.25,
      exitAmbiguous: true,
      exitPickedBy: 'sheet-label',
      // "high" off its own sheet, but never high while two sheets disagree.
      exitConfidence: 'medium',
    });
    expect(k.alternatives).toEqual([{
      nozzlePartNo: '01650',
      exitDiameterM: round6(inToM(0.812)),
      exitDiameterIn: 0.812,
      throatDiameterM: round6(inToM(0.615)),
      assemblyDrawing: OLD_SHEET,
      lomDescription: 'NOZZLE (54MM) (.615" DT DRILLED)',
    }]);
    expect(k.confidenceNote).toBe('AeroTech publish two nozzles for this motor (01670-3 1.25 in against 01650 0.812 in). '
      + "The one used here is the one AeroTech's own sheet name calls the newer; "
      + 'check which nozzle is in your reload kit before trusting the exit area.');
    expect(k.provenance.assemblyDrawings).toEqual([NEW_SHEET, OLD_SHEET].sort());
  });

  it('lets a sheet\'s own dated nozzle revision outrank its filename', async () => {
    const { aerotechDrawingRows, oneRowPerMotor } = await builder();
    const raw = RAW();
    raw.assemblies[1].revisions = [
      { letter: 'C', text: 'PER EO C, NEW NOZZLE', date: '8 / 19 / 04', isoDate: '2004-08-19', mentionsNozzle: true },
    ];
    const { rows } = aerotechDrawingRows(raw, aerotechOf(CATALOGUE()));
    const k = oneRowPerMotor(rows, raw.assemblies).find((r) => r.motorId === 'at-k1100');
    expect(k).toMatchObject({ nozzlePartNo: '01650', exitDiameterIn: 0.812, exitPickedBy: 'dated-revision' });
    expect(k.alternatives.map((a) => a.nozzlePartNo)).toEqual(['01670-3']);
    expect(k.confidenceNote).toContain('dated revision block calls current (2004-08-19)');
  });

  it('takes a Medusa\'s exit from the throats its own sheet opens, and grades an assumed count medium', async () => {
    const { aerotechDrawingRows, oneRowPerMotor } = await builder();
    const FAMILY = 'RMS-54-852 High Power';
    const raw = {
      // One centre throat and six outers moulded shut: the geometry is the
      // part's, how many are opened is each motor's own sheet.
      specPages: [specPage('01700', 'Medusa nozzle for 54mm motors. 0.192" diameter center throat '
        + '0.500" diameter center exit 0.125" diameter plugged outer throats x 6 '
        + '0.375" diameter outer exits x 6 Weight = 80 grams')],
      nozzleDrawings: [],
      assemblies: [
        // "DRILL TO", no count: only the centre is taken as open, and said so.
        assembly(`${FAMILY}/J99W-L Assembly.pdf`, [{ part: '01700-1', desc: 'MEDUSA NOZZLE CENTER DRILL TO .266"' }]),
        // The count stated outright: centre plus three outers.
        assembly(`${FAMILY}/K199T-L Assembly.pdf`, [{ part: '01700-10', desc: 'MEDUSA NOZZLE (1C .359" + 3M .297" DT DRILLED)' }]),
        // Nothing this build can read: no exit, and the reason in the row.
        assembly(`${FAMILY}/K299W-L Assembly.pdf`, [{ part: '01700-12', desc: 'MEDUSA NOZZLE' }]),
      ],
      certNozzles: [],
    };
    const motor = (id, designation) => ({
      motorId: id, manufacturerAbbrev: 'AeroTech', designation, commonName: designation.slice(0, -1),
      diameter: 54, caseInfo: 'RMS-54/852', type: 'reload', availability: 'regular',
    });
    const catalogue = [motor('at-j99w', 'J99W'), motor('at-k199t', 'K199T'), motor('at-k299w', 'K299W')];
    const { rows, parts } = aerotechDrawingRows(raw, catalogue);
    // The part itself has no one exit: it is resolved per motor.
    expect(parts.get('01700-1')).toMatchObject({ exitSource: 'medusa', exitConfidence: 'per-motor' });
    expect(parts.get('01700-1').exitDiameterIn).toBeUndefined();
    const byId = new Map(oneRowPerMotor(rows, raw.assemblies).map((r) => [r.motorId, r]));

    expect(byId.get('at-j99w')).toMatchObject({
      nozzlePartNo: '01700-1',
      exitDiameterIn: 0.5, // the centre exit alone
      exitDiameterM: round6(inToM(0.5)),
      throatDiameterIn: 0.266,
      exitSource: 'medusa-open-throats',
      exitConfidence: 'medium',
      medusa: { openOuterThroats: 0, outerCountAssumed: true, centerExitIn: 0.5, outerExitIn: 0.375, centerThroatIn: 0.266 },
      confidenceNote: 'The sheet gives a drilled throat with no count, so only the centre throat is taken as open — '
        + 'the moulded state. If outer throats were also opened the exit area is larger.',
    });
    expect(byId.get('at-j99w').provenance.exitFrom)
      .toBe(`Nozzles/01700.mhtml (geometry) + ${FAMILY}/J99W-L Assembly.pdf (throats opened)`);

    // sqrt(0.500² + 3 x 0.375²) = 0.81968 and sqrt(0.359² + 3 x 0.297²) = 0.62730,
    // each to four decimals.
    expect(byId.get('at-k199t')).toMatchObject({
      exitDiameterIn: 0.8197,
      throatDiameterIn: 0.6273,
      exitSource: 'medusa-open-throats',
      exitConfidence: 'high',
      medusa: { openOuterThroats: 3, outerCountAssumed: false, centerThroatIn: 0.359, outerThroatIn: 0.297 },
    });
    expect(byId.get('at-k199t').confidenceNote).toBeUndefined();

    expect(byId.get('at-k299w')).toMatchObject({ exitSource: 'none', exitConfidence: 'none' });
    expect(byId.get('at-k299w').exitDiameterIn).toBeUndefined();
    expect(byId.get('at-k299w').confidenceNote).toContain('does not state which throats are opened');
  });

  it('joins a DMS sheet to the single-use motor of its own casing size', async () => {
    const { aerotechDrawingRows, oneRowPerMotor } = await builder();
    const dms = (file) => assembly(file, [{ part: '01999', desc: 'NOZZLE (DMS) DRILLED TO .209"' }], { docFamily: 'dms' });
    const raw = {
      specPages: [specPage('01999', 'Nozzle for DMS motors. Dimensions: 0.900" O.D. 0.150" diameter throat 0.400" diameter exit Weight = 9 grams')],
      nozzleDrawings: [],
      assemblies: [dms('38mm/H99ST-14A Assembly.pdf'), dms('29mm/G99T-14A Assembly.pdf')],
      certNozzles: [],
    };
    const motor = (id, designation, diameter, caseInfo, type) => ({
      motorId: id, manufacturerAbbrev: 'AeroTech', designation, commonName: designation.replace(/^HP-/, '').slice(0, 3),
      diameter, caseInfo, type, availability: 'regular',
    });
    // Each pair ties on name and case, and the one listed FIRST is the wrong
    // one, so only the rule under test can pick the other.
    const catalogue = [
      // The same motor as a reload and as a DMS: a DMS sheet is of the single-use one.
      motor('at-h99st', 'H99ST', 38, 'RMS-38/360', 'reload'),
      motor('at-hp-h99st', 'HP-H99ST', 38, null, 'SU'),
      // One name in two casing sizes: the DMS folder ("29mm") says which.
      motor('at-g99t-38', 'G99T', 38, null, 'SU'),
      motor('at-g99t-29', 'G99T', 29, null, 'SU'),
    ];
    const { rows, unmatched } = aerotechDrawingRows(raw, catalogue);
    expect(unmatched).toEqual([]);
    const byDesignation = new Map(oneRowPerMotor(rows, raw.assemblies).map((r) => [r.designation, r]));
    expect(byDesignation.get('H99ST-14A')).toMatchObject({
      motorId: 'at-hp-h99st',
      catalogDesignation: 'HP-H99ST',
      caseFamily: '38mm DMS (single-use)',
      docFamily: 'dms',
      casingDiameterMm: 38,
      exitDiameterIn: 0.4,
      throatDiameterIn: 0.209,
      exitSource: 'spec-page',
    });
    expect(byDesignation.get('G99T-14A')).toMatchObject({
      motorId: 'at-g99t-29',
      caseFamily: '29mm DMS (single-use)',
      casingDiameterMm: 29,
    });
    // And the whole build takes them: no DMS row sits on a reloadable motor.
    const { db } = await build({ raw, motorsDb: { generated: '2026-09-19', motors: catalogue } });
    expect(db.counts).toMatchObject({ dmsDrawings: 2, dmsRows: 2, dmsRowsWithExit: 2, reloadableDrawings: 0 });
  });

  it('refuses a sheet whose casing size cannot be read', async () => {
    const { aerotechDrawingRows, BuildRefused } = await builder();
    const raw = RAW();
    raw.assemblies[2].atFamilyRoot = true;
    let err;
    try { aerotechDrawingRows(raw, aerotechOf(CATALOGUE())); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines).toEqual([
      'These drawings sit at a document-family root, so their casing size cannot be read:',
      `  ${M_SHEET}`,
      'Put each in a casing-size subfolder, or give findMotor another way to get the diameter.',
    ]);
  });
});

/**
 * A STORE PAGE READ LIVE (2026-10-01). Part 01600's page states its exit, and it
 * was never among the pages saved in docs/RCS Schematics/Nozzles, so the I40N-P
 * published none. A page read live goes through the same reader as a saved one.
 */
describe('a store page read live', () => {
  const DMS_38 = '38mm/I99N-P.pdf';
  const liveRaw = (lom = [{ part: '01999', desc: '38MM NOZZLE MACHINED 1.25" O.D. X .156" DT' }]) => ({
    specPages: [],
    nozzleDrawings: [],
    assemblies: [assembly(DMS_38, lom, { docFamily: 'dms', designationFromFile: 'I99N-P' })],
    certNozzles: [],
  });
  const i99 = { motorId: 'at-i99n', manufacturerAbbrev: 'AeroTech', designation: 'I99N-P', commonName: 'I99',
    diameter: 38, caseInfo: null, type: 'SU', availability: 'regular' };
  const PAGE = {
    productCode: '01999', title: '38mm Nozzle, 0.137" Throat',
    url: 'https://example.invalid/01999', readOn: '2026-10-01',
    summary: 'Molded nozzle for 38mm motors. Dimensions: 1.308" O.D. 0.137" diameter throat 0.289" diameter exit Click here for drawing',
  };

  it('resolves a part the way a saved page does, and names the page and the day it was read', async () => {
    const { aerotechDrawingRows } = await builder();
    const { rows, parts } = aerotechDrawingRows(liveRaw(), [i99], { storePages: [PAGE] });
    expect(parts.get('01999')).toMatchObject({
      name: '38mm Nozzle, 0.137" Throat', exitDiameterIn: 0.289, exitSource: 'spec-page', exitConfidence: 'high',
      throatDiameterIn: 0.137, throatSource: 'spec-page',
      provenance: { specPage: 'https://example.invalid/01999 (store page, read 2026-10-01)' },
    });
    expect(rows[0]).toMatchObject({
      motorId: 'at-i99n', exitDiameterIn: 0.289, exitSource: 'spec-page', exitConfidence: 'high',
      throatDiameterIn: 0.156, // the motor's own drilled throat, not the moulded 0.137
      provenance: { exitFrom: 'https://example.invalid/01999 (store page, read 2026-10-01)' },
    });
    // And without it the part has no exit, which is what the file said before.
    expect(aerotechDrawingRows(liveRaw(), [i99]).rows[0].exitSource).toBe('none');
  });

  it('dates the file by the day a live page was read, when that is the newest source', async () => {
    const { db } = await build({ raw: liveRaw(), motorsDb: { generated: '2026-09-30', motors: [i99] }, storePages: [PAGE] });
    expect(db.generated).toBe('2026-10-01'); // every document's mtime is 13 September
    expect((await build({ raw: liveRaw(), motorsDb: { generated: '2026-09-30', motors: [i99] } })).db.generated).toBe('2026-09-13');
  });

  it('refuses a live page a saved one now covers, or one that states no exit', async () => {
    const { aerotechDrawingRows, BuildRefused } = await builder();
    const refused = (raw, pages) => {
      try { aerotechDrawingRows(raw, [i99], { storePages: pages }); } catch (e) {
        expect(e).toBeInstanceOf(BuildRefused);
        return e.lines;
      }
      return null;
    };
    const saved = { ...liveRaw(), specPages: [specPage('01999', PAGE.summary)] };
    expect(refused(saved, [PAGE])).toEqual(['A store page in STORE_PAGES_READ_LIVE does not hold:',
      '  01999: the saved page Nozzles/01999.mhtml now covers it — delete the live reading']);
    expect(refused(liveRaw(), [{ ...PAGE, summary: 'Molded nozzle for 38mm motors. Dimensions: 1.308" O.D.' }]))
      .toEqual(['A store page in STORE_PAGES_READ_LIVE does not hold:', '  01999: the page states no exit']);
  });

  it('refuses to carry 01600\'s exit to a dash number its own drawing gives another', async () => {
    // rcs_01600_nozzle_dwg.pdf: "01600-1 NOZZLE DRILLED .228" Dt, .375" EXIT DIA." — the dash
    // rule would have carried the base 0.289 in onto a part whose drawing says 0.375 in.
    const { aerotechDrawingRows, BuildRefused } = await builder();
    const raw = liveRaw([{ part: '01600-1', desc: 'NOZZLE DRILLED .228"' }]);
    let err;
    try { aerotechDrawingRows(raw, [i99], { storePages: [{ ...PAGE, productCode: '01600' }] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines[0]).toBe('01600-1: 01600\'s own drawing gives its dash numbers their own exits, so its 0.289 in '
      + 'may not be carried to 01600-1:');
    expect(err.lines[1]).toMatch(/01600-1 NOZZLE DRILLED \.228" Dt, \.375" EXIT DIA\./);
    // Any other part's dash number still takes the base exit under the rule.
    const other = aerotechDrawingRows(liveRaw([{ part: '01999-1', desc: 'NOZZLE DRILLED .228"' }]), [i99], { storePages: [PAGE] });
    expect(other.rows[0]).toMatchObject({ nozzlePartNo: '01999-1', exitDiameterIn: 0.289, exitSource: 'base-spec-page' });
  });
});

// ------------------------------------------------------------ the Loki rows

describe('the Loki rows', () => {
  it('take the nozzle from Loki\'s case column when no sheet names the motor, and the exit from its band', async () => {
    const { lokiMotorRows } = await builder();
    const { lokiRows, lokiSheetVsTable } = lokiMotorRows(lokiOf(CATALOGUE()), []);
    expect(lokiSheetVsTable).toEqual([]);
    // N5500 has no case in Loki's column and no sheet: no row at all.
    expect(lokiRows.map((r) => r.motorId)).toEqual(['loki-h90']);
    expect(lokiRows[0]).toMatchObject({
      nozzlePartNo: '#16',
      throatDiameterIn: 0.25, // 16/64 in, Loki's own definition of the number
      exitDiameterIn: 0.63, // the 38 mm band #16 thru #18
      exitDiameterM: round6(inToM(0.63)),
      exitSource: 'loki-case-table',
      exitConfidence: 'medium',
    });
  });

  it('prefer the motor\'s own sheet, and refuse a sheet the catalogue cannot place', async () => {
    const { lokiMotorRows, BuildRefused } = await builder();
    const onSheet = lokiMotorRows(lokiOf(CATALOGUE()), [{ file: 'synthetic.pdf', rows: [['H90', 16, 0.250]] }]);
    expect(onSheet.lokiRows[0]).toMatchObject({ exitSource: 'loki-sheet', exitConfidence: 'high' });
    expect(onSheet.lokiSheetVsTable).toMatchObject([{ commonName: 'H90', agrees: true }]);

    let err;
    try { lokiMotorRows(lokiOf(CATALOGUE()), [{ file: 'synthetic.pdf', rows: [['J320', 22, 0.344]] }]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines).toEqual([
      'Loki sheet readings do not hold together:',
      '  J320: read off a sheet, but the catalogue has no Loki motor by that name',
    ]);
  });

  it('refuse a sheet that misprints its own throat or disagrees with another sheet', async () => {
    const { lokiMotorRows, BuildRefused } = await builder();
    let err;
    try {
      lokiMotorRows(lokiOf(CATALOGUE()), [
        { file: 'a.pdf', rows: [['H90', 16, 0.300]] }, // #16 is 0.250 in
        { file: 'b.pdf', rows: [['H90', 17, 0.266]] },
      ]);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines).toEqual([
      'Loki sheet readings do not hold together:',
      '  a.pdf H90: #16 is 0.2500 in, sheet prints 0.3',
      '  H90: a.pdf say #16, b.pdf says #17',
    ]);
  });

  it('refuse a sheet that disagrees with Loki\'s own case column', async () => {
    const { lokiMotorRows, BuildRefused } = await builder();
    let err;
    // #17 reads true against its own printed throat, but the 38/240 case takes #16.
    try { lokiMotorRows(lokiOf(CATALOGUE()), [{ file: 'synthetic.pdf', rows: [['H90', 17, 0.266]] }]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines).toEqual([
      'A Loki instruction sheet disagrees with Loki\'s own commercial-throat column:',
      '  H90 (38/240): sheet #17, table #16',
    ]);
  });

  it('stop, rather than refuse, when the catalogue\'s join key is not unique', async () => {
    // Not a BuildRefused: the join itself would need changing, not the data.
    const { lokiMotorRows, BuildRefused } = await builder();
    const h90 = lokiOf(CATALOGUE())[0];
    let err;
    try { lokiMotorRows([h90, { ...h90, motorId: 'loki-h90-again' }], []); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BuildRefused);
    expect(err.message).toBe('Loki commonName H90 is not unique in the catalogue — the join key has to change.');
  });
});

describe("the join from a drawing's name to the catalogue", () => {
  // Nothing above exercises these: switching the D13-10W rule off dropped 21
  // small AeroTech motors' catalogue match with every other test green (claim
  // check of the v0.141 notes).
  it("reads each way AeroTech write a designation in a drawing's name", async () => {
    const { designationCandidates } = await builder();
    expect(designationCandidates('N4000W-PS')).toEqual(['N4000W-PS', 'N4000W']);
    expect(designationCandidates('G54W-L')).toEqual(['G54W-L', 'G54W']);
    expect(designationCandidates('D13-10W')).toEqual(['D13-10W', 'D13W', 'D13']);
    expect(designationCandidates('C3.4-PT')).toEqual(['C3.4-PT', 'C3.4T', 'C3.4']);
    expect(designationCandidates('G33-5J')).toEqual(['G33-5J', 'G33J', 'G33']);
  });

  it('finds the catalogue motor a small-motor drawing means, delay or plug inside the name', async () => {
    const { findMotor } = await builder();
    const at = [
      { designation: 'D13W', commonName: 'D13', diameter: 18, caseInfo: null, type: 'SU', availability: 'regular' },
      { designation: 'C3.4T', commonName: 'C3.4', diameter: 18, caseInfo: null, type: 'SU', availability: 'regular' },
      { designation: 'D10W', commonName: 'D10', diameter: 18, caseInfo: null, type: 'SU', availability: 'regular' },
    ];
    expect(findMotor(at, 'D13-10W', 18, '18mm')).toMatchObject({ entry: at[0], via: 'D13W' });
    expect(findMotor(at, 'C3.4-PT', 18, '18mm')).toMatchObject({ entry: at[1], via: 'C3.4T' });
    // The casing size gates it: the same name at 29 mm is no motor here.
    expect(findMotor(at, 'D13-10W', 29, '29mm')).toBeNull();
  });

  /**
   * A SHEET FILED UNDER A NAME THE CATALOGUE DOES NOT USE (board Tier 1 row 13,
   * 2026-10-01). AeroTech's H219T sheet is filed as H218T-14A.pdf and their J1265T
   * is J1265ST-14A, so both rows were built and reached no motor. They are joined
   * by an entry that quotes its evidence, never by guessing from the file name.
   */
  const misnamed = (file, title) => assembly(`38mm/${file}`, [{ part: '01999', desc: 'NOZZLE (DMS) DRILLED .228"' }],
    { docFamily: 'dms', designationOnSheet: false, designationStemOnSheet: false, titleBlockDesignations: [title] });
  const misnamedRaw = () => ({
    specPages: [specPage('01999', 'Nozzle for DMS motors. Dimensions: 0.900" O.D. 0.150" diameter throat 0.400" diameter exit Weight = 9 grams')],
    nozzleDrawings: [],
    assemblies: [misnamed('H998T-14A Assembly.pdf', 'H999T-14A')],
    certNozzles: [],
  });
  const h999t = { motorId: 'at-h999t', manufacturerAbbrev: 'AeroTech', designation: 'H999T', commonName: 'H999',
    diameter: 38, caseInfo: null, type: 'SU', availability: 'regular' };
  const JOIN = { docFamily: 'dms', file: '38mm/H998T-14A Assembly.pdf', titleBlock: 'H999T-14A',
    catalogDesignation: 'H999T', evidence: ['synthetic: the title block reads "H999T-14A"'] };

  it('joins a sheet filed under another name to the motor its entry names, and keeps the evidence', async () => {
    const { aerotechDrawingRows } = await builder();
    const { rows, unmatched } = aerotechDrawingRows(misnamedRaw(), [h999t], { sheetJoins: [JOIN] });
    expect(unmatched).toEqual([]);
    expect(rows[0]).toMatchObject({
      motorId: 'at-h999t',
      designation: 'H998T-14A', // the file's, which is what the drawing is filed as
      catalogDesignation: 'H999T',
      exitDiameterIn: 0.4,
      provenance: {
        designationOnSheet: 'no',
        // What findDbMotor re-resolves, so the shipped-file join check lands on the same motor.
        matchedVia: 'H999T',
        joinEvidence: ['synthetic: the title block reads "H999T-14A"'],
      },
    });
    // Without the entry the file name reaches nothing, which is the gap it closes.
    const bare = aerotechDrawingRows(misnamedRaw(), [h999t]);
    expect(bare.rows[0].motorId).toBeUndefined();
    expect(bare.unmatched).toEqual([{ file: '38mm/H998T-14A Assembly.pdf', designation: 'H998T-14A' }]);
  });

  it('refuses a join its sheet, the catalogue or the file name no longer bears out', async () => {
    const { aerotechDrawingRows, BuildRefused } = await builder();
    const refused = (joins, catalogue = [h999t], raw = misnamedRaw()) => {
      try { aerotechDrawingRows(raw, catalogue, { sheetJoins: joins }); } catch (e) {
        expect(e).toBeInstanceOf(BuildRefused);
        return e.lines;
      }
      return null;
    };
    const head = 'A sheet join in SHEET_CATALOGUE_JOINS does not hold:';
    // The title block says something else: the entry rests on a sheet that is not this one.
    expect(refused([{ ...JOIN, titleBlock: 'H997T-14A' }])).toEqual([head,
      '  dms 38mm/H998T-14A Assembly.pdf: the entry rests on a title block reading "H997T-14A", the sheet\'s reads "H999T-14A"']);
    // The catalogue has no such motor, or two of them.
    expect(refused([JOIN], [])).toEqual([head,
      '  dms 38mm/H998T-14A Assembly.pdf: the catalogue has no AeroTech H999T at 38 mm (found 0)']);
    expect(refused([JOIN], [h999t, { ...h999t, motorId: 'at-h999t-again' }])).toEqual([head,
      '  dms 38mm/H998T-14A Assembly.pdf: the catalogue has no AeroTech H999T at 38 mm (found 2)']);
    // The file name now reaches a motor by itself: the entry is redundant, or it contradicts the catalogue.
    const named = { ...h999t, motorId: 'at-h998t', designation: 'H998T', commonName: 'H998' };
    expect(refused([JOIN], [h999t, named])).toEqual([head,
      '  dms 38mm/H998T-14A Assembly.pdf: its file name reaches H998T by itself now — re-read the sheet, then delete or correct the entry']);
    // An entry for a sheet the set does not hold any more.
    expect(refused([JOIN, { ...JOIN, file: '38mm/H996T-14A Assembly.pdf' }])).toEqual([head,
      '  dms 38mm/H996T-14A Assembly.pdf: no such sheet in this document set — delete the entry, or correct its file']);
    // Two entries for one sheet, and an entry whose sheet no longer names a nozzle.
    expect(refused([JOIN, JOIN])).toEqual([head, '  dms 38mm/H998T-14A Assembly.pdf: named by two entries']);
    const capOnly = { ...misnamedRaw(), assemblies: [{ ...misnamedRaw().assemblies[0], lomRows: [{ part: '04580', desc: 'NOZZLE CAP' }] }] };
    expect(refused([JOIN], [h999t], capOnly)).toEqual([head,
      '  dms 38mm/H998T-14A Assembly.pdf: the sheet names no nozzle, so the entry joins nothing']);
  });

  /**
   * A NOZZLE NAMED ONLY IN AN INSTRUCTION SHEET (board Tier 1 row 13). L1365M-PS
   * has no assembly drawing; its reload kit's instruction sheet prints the parts
   * list. Two tables sit side by side on that page, so the extractor's row runs
   * both together, and the nozzle line is transcribed in the builder and then
   * checked against the row the extractor read.
   */
  const SHEET = '75mm High-Power Reloadable Motor Instructions/75-9999M (L9999M-PS) Instructions.pdf';
  const INSTRUCTION = {
    file: SHEET, page: 2, designation: 'L9999M-PS', caseFolder: 'RMS-75/5120',
    row: { qty: '1', part: '01770', desc: 'HP 75MM NOZZLE (.685" DT UNDRILLED)', item: '3' },
  };
  const instructionRaw = (rows = ['L9999M-PS Assembly Drawing and Instructions',
    '1 01770 HP 75MM NOZZLE (.685" DT UNDRILLED) 3 1 03287 SMOKE CHARGE(1.305" O.D. X 1.5") 10']) => ({
    specPages: [specPage('01770', 'Nozzle for 75mm motors. Dimensions: 2.730" O.D. 0.685" diameter throat 1.875" diameter exit Weight = 300 grams')],
    nozzleDrawings: [],
    assemblies: [],
    certNozzles: [],
    instructionSheets: [{ file: SHEET, found: true, pages: [{ page: 2, rows }] }],
  });
  const l9999m = { motorId: 'at-l9999m', manufacturerAbbrev: 'AeroTech', designation: 'L9999M', commonName: 'L9999',
    diameter: 75, caseInfo: 'RMS-75/5120', type: 'reload', availability: 'regular' };

  it('takes a nozzle from an instruction sheet\'s parts list once the sheet bears out the transcription', async () => {
    const { db } = await build({ raw: instructionRaw(), motorsDb: { generated: '2026-09-30', motors: [l9999m] },
      instructionRows: [INSTRUCTION] });
    const row = db.motors.find((m) => m.motorId === 'at-l9999m');
    expect(row).toMatchObject({
      designation: 'L9999M-PS',
      catalogDesignation: 'L9999M',
      caseFamily: 'RMS-75/5120',
      docFamily: 'instructions',
      nozzlePartNo: '01770',
      // The exit is the part's store page, as for any drawing: nothing typed here but the parts-list line.
      exitDiameterIn: 1.875,
      exitSource: 'spec-page',
      exitConfidence: 'high',
      throatDiameterIn: 0.685,
      provenance: {
        lomDescription: 'HP 75MM NOZZLE (.685" DT UNDRILLED)',
        lomLocation: 'page 2, item 3',
        designationOnSheet: 'exact',
        matchedVia: 'L9999M-PS',
        caseAgrees: true,
        assemblyDrawings: [SHEET],
      },
    });
    // Counted apart from the drawings, so "resolved N of M drawings" still means drawings.
    expect(db.counts).toMatchObject({ assemblyDrawings: 0, nozzlePartResolved: 0, instructionSheetRows: 1 });
  });

  it('refuses a transcription its sheet does not bear out, or one that reaches no motor in its case', async () => {
    const { BuildRefused } = await builder();
    const refused = async (over) => {
      try {
        await build({ motorsDb: { generated: '2026-09-30', motors: [l9999m] }, instructionRows: [INSTRUCTION], ...over });
      } catch (e) {
        expect(e).toBeInstanceOf(BuildRefused);
        return e.lines;
      }
      return null;
    };
    const head = 'An instruction-sheet nozzle row in INSTRUCTION_SHEET_NOZZLES does not hold:';
    // The item number belongs to the line: "... UNDRILLED) 4" is another row of the table.
    expect(await refused({ raw: instructionRaw(), instructionRows: [{ ...INSTRUCTION, row: { ...INSTRUCTION.row, item: '4' } }] }))
      .toEqual([head, `  ${SHEET} page 2: no row reads "1 01770 HP 75MM NOZZLE (.685" DT UNDRILLED) 4"`]);
    expect(await refused({ raw: instructionRaw(['1 01770 HP 75MM NOZZLE (.685" DT UNDRILLED) 3']) }))
      .toEqual([head, `  ${SHEET} page 2: the page never names L9999M-PS`]);
    expect(await refused({ raw: { ...instructionRaw(), instructionSheets: [] } }))
      .toEqual([head, `  ${SHEET}: the extractor did not read it (python extract-nozzle-pdfs.py is given each entry's file)`]);
    expect(await refused({ raw: { ...instructionRaw(), instructionSheets: [{ file: SHEET, found: false, pages: [] }] } }))
      .toEqual([head, `  ${SHEET}: no such file under Instructions`]);
    expect(await refused({ raw: instructionRaw(), instructionRows: [{ ...INSTRUCTION, page: 1 }] }))
      .toEqual([head, `  ${SHEET} page 1: no LIST OF MATERIAL on that page`]);
    // On the page word for word, but not a nozzle: nothing would reach the motor.
    expect(await refused({
      raw: instructionRaw(['L9999M-PS Assembly Drawing and Instructions', '1 75ACC AFT CLOSURE 2']),
      instructionRows: [{ ...INSTRUCTION, row: { qty: '1', part: '75ACC', desc: 'AFT CLOSURE', item: '2' } }],
    })).toEqual([head, `  ${SHEET}: the transcribed line is not a nozzle row (no LIST OF MATERIAL row names a nozzle)`]);
    // Read correctly, but the motor it names is not in the catalogue in that case.
    expect(await refused({ raw: instructionRaw(), motorsDb: { generated: '2026-09-30', motors: [{ ...l9999m, caseInfo: 'RMS-75/3840' }] } }))
      .toEqual([head, `  ${SHEET}: L9999M-PS reaches L9999M, whose case RMS-75/3840 is not the sheet's RMS-75/5120`]);
    expect(await refused({ raw: instructionRaw(), motorsDb: { generated: '2026-09-30', motors: [] } }))
      .toEqual([head, `  ${SHEET}: L9999M-PS reaches no catalogue motor`]);
  });

  it("breaks a tie by the drawing's own case family, and says when it could not", async () => {
    const { findMotor } = await builder();
    const at = [
      { designation: 'H100W', commonName: 'H100', diameter: 29, caseInfo: 'RMS-29/180', type: 'reload', availability: 'regular' },
      { designation: 'H100W', commonName: 'H100', diameter: 29, caseInfo: 'RMS-29/240', type: 'reload', availability: 'regular' },
    ];
    expect(findMotor(at, 'H100W-M', 29, 'RMS-29-240 High Power'))
      .toMatchObject({ entry: at[1], caseAgrees: true, ambiguous: false });
    expect(findMotor(at, 'H100W-M', 29, 'RMS-29-180 High Power'))
      .toMatchObject({ entry: at[0], caseAgrees: true, ambiguous: false });
    expect(findMotor(at, 'H100W-M', 29, 'RMS-29-360 High Power'))
      .toMatchObject({ caseAgrees: false, ambiguous: true });
  });
});

// ------------------------------------------------------------ the whole file

describe('buildNozzleDb, the whole composition', () => {
  it('puts both makers in one table in one order, and counts what it holds', async () => {
    const { db } = await build();
    expect(db.generated).toBe('2026-09-13'); // the newest source document, not the clock
    expect(db.catalogueGenerated).toBe('2026-09-19');
    expect(db.motors.map((m) => `${m.manufacturer} ${m.designation}`))
      .toEqual(['AeroTech K1100T-L', 'AeroTech M1000W-L', 'Loki H90-LR']);
    expect(db.nozzles.map((p) => p.partNo)).toEqual(['01650', '01670', '01670-3', '01880', '01880-4']);
    expect(db.counts).toMatchObject({
      assemblyDrawings: 3,
      nozzlePartResolved: 3,
      distinctNozzleParts: 5,
      motorsWithExit: 3,
      motorsMatchedToCatalogue: 3,
      motorsLoadableWithExit: 3,
      motorsWithTwoNozzleOptions: 1,
      catalogueMotors: 4,
      catalogueAeroTech: 2,
      lokiSheetsRead: 0,
      lokiRows: 1,
      lokiRowsFromCaseTable: 1,
      catalogueLoki: 2,
    });
    expect(db.uncovered).toEqual({ 'Loki 98 mm single-use (no reload case)': ['N5500LW'] });
    expect(db.coverage.byManufacturer.Loki.byCasingDiameterMm).toEqual({
      38: { inProduction: 1, withNozzleRow: 1, withExitDiameter: 1, missing: [] },
      98: { inProduction: 1, withNozzleRow: 0, withExitDiameter: 0, missing: ['N5500LW'] },
    });
    expect(db.measured).toEqual([]);
    expect(db.crossCheck.dmsSheetObservations.rows).toEqual([]);
  });

  it('refuses a DMS sheet that joins a reloadable motor', async () => {
    const { BuildRefused } = await builder();
    const raw = RAW();
    raw.assemblies[2].docFamily = 'dms';
    raw.assemblies[2].caseFolder = '98mm';
    let err;
    try { await build({ raw }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines).toEqual([
      'A DMS single-use drawing matched a motor the catalogue does not call single-use:',
      '  M1000W-L -> M1000W (type reload)',
    ]);
  });

  it('checks the shipped DMS observations against the rows it built', async () => {
    // With the shipped table, a set that has none of the motors it describes is
    // refused rather than written.
    const { BuildRefused } = await builder();
    let err;
    try { await build({ observations: undefined }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines[0]).toBe('DMS_SHEET_OBSERVATIONS does not describe the rows this build produced:');
    expect(err.lines).toContain('  K76WN-P: named in DMS_SHEET_OBSERVATIONS but has no row');
  });

  it('refuses each way an observation can fail to describe its row, line by line', async () => {
    const { BuildRefused } = await builder();
    // M1000W-L publishes exit 1.75, throat 1.219, source base-spec-page, part 01880-4.
    const holds = { motors: ['M1000W-L'], field: 'exit', published: 1.75, onSheet: 1.8 };
    const observations = [
      holds,
      { motors: ['X1W-P'], field: 'exit', published: null },
      { motors: ['M1000W-L'], field: 'exit', published: 1.5, onSheet: 1.6 },
      { motors: ['M1000W-L'], field: 'colour', published: 'red' },
      { motors: ['M1000W-L'], field: 'throat', published: 1.219, onSheet: -1 },
      { motors: ['M1000W-L'], field: 'throat', published: 1.219, onSheet: 1.219 },
      { motors: ['M1000W-L'], field: 'exitSource', published: 'base-spec-page', onSheet: 1.8, partNo: '01880' },
    ];
    let err;
    try { await build({ observations }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines).toEqual([
      'DMS_SHEET_OBSERVATIONS does not describe the rows this build produced:',
      '  X1W-P: named in DMS_SHEET_OBSERVATIONS but has no row',
      '  M1000W-L: the observation says this file publishes 1.5 for exit, but it publishes 1.75',
      '  M1000W-L: unknown observation field "colour"',
      '  M1000W-L: onSheet is -1, which is not a dimension',
      '  M1000W-L: onSheet and published are the same number (1.219), so there is nothing for this observation to observe',
      '  M1000W-L: the observation is about part 01880, but this row\'s nozzle is "01880-4"',
    ]);
    // The one that holds is written into the file as it stands.
    const { db } = await build({ observations: [holds] });
    expect(db.crossCheck.dmsSheetObservations.rows).toEqual([holds]);
  });

  it('merges a measured nozzle into a motor with no row, and refuses one that would replace a row', async () => {
    const { BuildRefused } = await builder();
    const measuredBy = { measuredBy: 'synthetic calipers', measuredOn: '2026-09-23' };
    const fills = { manufacturer: 'Loki', partNo: 'synthetic-c', exitDiameterIn: 1.2, throatDiameterIn: 0.9, ...measuredBy,
      appliesTo: [{ motorId: 'loki-n5500', designation: 'N5500LW' }] };
    const { db } = await build({ measured: [fills] });
    expect(db.measured).toEqual([fills]);
    expect(db.motors.map((m) => `${m.manufacturer} ${m.designation}`))
      .toEqual(['AeroTech K1100T-L', 'AeroTech M1000W-L', 'Loki H90-LR', 'Loki N5500LW']);
    expect(db.motors.at(-1)).toMatchObject({
      motorId: 'loki-n5500', nozzlePartNo: 'synthetic-c', exitDiameterIn: 1.2, exitSource: 'measured', exitConfidence: 'high',
    });
    expect(db.uncovered).toEqual({});
    expect(db.counts).toMatchObject({ motorsWithExit: 4, motorsLoadableWithExit: 4 });

    let err;
    try {
      await build({
        measured: [
          { ...fills, partNo: 'synthetic-a', appliesTo: [{ motorId: 'loki-h90', designation: 'H90-LR' }] }, // H90-LR has Loki's own row
          { ...fills, partNo: 'synthetic-b', exitDiameterIn: 0 },
        ],
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BuildRefused);
    expect(err.lines).toEqual([
      'MEASURED_NOZZLES cannot be merged:',
      '  synthetic-a: H90-LR already has a PUBLISHED row — a measurement must not silently replace one. '
        + 'Decide which source wins and say so here.',
      '  synthetic-b: no usable exitDiameterIn',
    ]);
  });

  it('dates the file by its NEWEST source document, a Loki sheet included, past one it cannot read', async () => {
    const JULY_2 = Date.UTC(2026, 6, 2, 12);
    const asked = [];
    const { db } = await build({
      lokiSheets: [{ file: 'synthetic.pdf', rows: [['H90', 16, 0.250]] }],
      mtimeMs: ({ root, file }) => {
        asked.push(`${root}:${file}`);
        if (file === 'Nozzles/01650.mhtml') throw new Error('moved'); // skipped, not fatal
        return root === 'loki' ? SEPT_13 : JULY_2;
      },
    });
    expect(db.generated).toBe('2026-09-13');
    expect(asked).toContain('loki:synthetic.pdf');
    expect(asked).toContain(`rcs:Motor Assembly Drawings/${M_SHEET}`);
    expect(asked).toContain('rcs:Nozzles/01650.mhtml');
  });
});

// ------------------------------------------------------------ main()

describe('main', () => {
  let dir;
  let errors;
  beforeEach(() => {
    io.block = false;
    dir = mkdtempSync(join(tmpdir(), 'nozzle-db-'));
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((line) => { errors.push(line); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    io.block = true;
  });

  it('exits 1 without extracting or writing when the document set is missing', async () => {
    const { main } = await builder();
    const outPath = join(dir, 'nozzles.json');
    const extract = vi.fn();
    io.calls.length = 0;
    expect(main({ argv: [], source: join(dir, 'no-such-folder'), outPath, extract })).toBe(1);
    // The recorder does see the builder's own calls, so the empty record the
    // import test asserts is a measurement and not a mock that missed them.
    expect(io.calls).toEqual([`fs.existsSync(${join(dir, 'no-such-folder')})`]);
    expect(extract).not.toHaveBeenCalled();
    expect(existsSync(outPath)).toBe(false);
    expect(errors[0]).toBe(`No RCS document set at ${join(dir, 'no-such-folder')}.`);
  });

  it('writes nothing and exits 1 when the build is refused', async () => {
    const { main, INSTRUCTION_SHEET_NOZZLES } = await builder();
    const outPath = join(dir, 'nozzles.json');
    const motorsPath = join(dir, 'motors.json');
    writeFileSync(motorsPath, JSON.stringify(CATALOGUE()));
    const extract = vi.fn(() => RAW());
    // The shipped instruction-sheet entry names a sheet this synthetic set never read.
    expect(main({ argv: [], source: dir, lokiSource: dir, outPath, motorsPath, extract })).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    // The extractor is handed the instruction sheets the builder transcribes, and only those.
    expect(INSTRUCTION_SHEET_NOZZLES.length).toBeGreaterThan(0);
    expect(extract).toHaveBeenCalledWith(dir, INSTRUCTION_SHEET_NOZZLES.map((e) => e.file));
    expect(errors[0]).toBe('An instruction-sheet nozzle row in INSTRUCTION_SHEET_NOZZLES does not hold:');
    expect(errors[1]).toMatch(/: the extractor did not read it/);
  });
});

// ------------------------------------------------------------ the command line

/**
 * The entry-point guard, the way the header says to run the builder. Every
 * test above imports the module, so a guard that never fired would pass them
 * all while `node build-nozzle-db.mjs --report` exited 0 having done nothing
 * (review of AUDIT row 480). Each run points --source at a folder that does
 * not exist, so the builder stops at its first check: no Python, no docs/,
 * nothing written, and CI can run it.
 */
describe('running the builder as a command', () => {
  let dir;
  beforeEach(() => {
    io.block = false;
    dir = mkdtempSync(join(tmpdir(), 'nozzle-db-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    io.block = true;
  });
  const run = (script) => spawnSync(process.execPath, [script, '--source', join(dir, 'no-such-folder')],
    { encoding: 'utf8' });

  it('runs main() when node is given the file', () => {
    const r = run(join(here, 'build-nozzle-db.mjs'));
    expect(r.stderr).toContain(`No RCS document set at ${join(dir, 'no-such-folder')}.`);
    expect(r.status).toBe(1);
  });

  it('runs main() when node is given the file through a junction or a symlink', () => {
    // Node loads the entry module from its REAL path, so argv[1] and
    // import.meta.url name one file two ways; a guard comparing only the two
    // strings did nothing and exited 0. The link points at a scratch COPY of
    // the builder and its one local import, never at the repo, so removing
    // the scratch folder cannot reach the real scripts whichever way rmSync
    // treats a junction.
    const real = join(dir, 'real');
    mkdirSync(real);
    for (const f of ['build-nozzle-db.mjs', 'nozzle-db-helpers.mjs']) copyFileSync(join(here, f), join(real, f));
    const link = join(dir, 'link');
    symlinkSync(real, link, 'junction'); // a junction on Windows; the type is ignored elsewhere
    const r = run(join(link, 'build-nozzle-db.mjs'));
    expect(r.stderr).toContain(`No RCS document set at ${join(dir, 'no-such-folder')}.`);
    expect(r.status).toBe(1);
  });
});
