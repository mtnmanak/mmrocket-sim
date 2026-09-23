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
  lokiSheets: [], observations: [], measured: [],
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
    const fills = { manufacturer: 'Loki', partNo: 'synthetic-c', exitDiameterIn: 1.2, throatDiameterIn: 0.9, ...measuredBy, appliesTo: ['N5500LW'] };
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
          { ...fills, partNo: 'synthetic-a', appliesTo: ['H90-LR'] }, // H90-LR has Loki's own row
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
    const { main } = await builder();
    const outPath = join(dir, 'nozzles.json');
    const motorsPath = join(dir, 'motors.json');
    writeFileSync(motorsPath, JSON.stringify(CATALOGUE()));
    // The shipped Loki sheets name motors this synthetic catalogue does not have.
    expect(main({ argv: [], source: dir, lokiSource: dir, outPath, motorsPath, extract: () => RAW() })).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(errors[0]).toBe('Loki sheet readings do not hold together:');
    expect(errors).toContain('  G66: read off a sheet, but the catalogue has no Loki motor by that name');
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
