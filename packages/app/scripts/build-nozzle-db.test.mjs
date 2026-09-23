import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inToM, round6 } from './nozzle-db-helpers.mjs';

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
