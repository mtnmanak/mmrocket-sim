import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILES, IN, LB, MM, OZ, dim, displayFor, lengthFactor, main, mapShape, massFactor, massOf, round7,
} from './merge-rocksim-parts.mjs';

/**
 * merge-rocksim-parts.mjs: the unit codes that turn RockSim's CSV cells into
 * the SI lengths and masses presets.json ships, and the merge rules. Until
 * 2026-09-22 the merge ran at module top level, so none of this could be
 * tested (audit 2026-09-22, Tests rows 480, 531 and 581). The real CSVs are
 * third-party and not in the repo; these tests use synthetic ones.
 */

describe('the unit tables', () => {
  it('are the exact definitions', () => {
    expect(IN).toBe(0.0254);
    expect(MM).toBe(0.001);
    expect(LB).toBe(0.45359237);
    expect(OZ * 16).toBeCloseTo(LB, 15);
  });

  it('read the "Units" cell the way OpenRocket\'s loader does', () => {
    // 0 / "in." / blank / "?" = inches (OpenRocket's assumption), 1 / "mm" = millimetres.
    for (const u of ['0', 'in', 'in.', 'IN', '', '?', undefined]) expect(lengthFactor(u), `${u}`).toBe(IN);
    for (const u of ['1', 'mm', ' MM ']) expect(lengthFactor(u), `${u}`).toBe(MM);
    expect(lengthFactor('cm')).toBeNull();
  });

  it('read the "Mass Units" cell by RockSim\'s mass-unit codes', () => {
    const want = [['0', OZ], ['oz.', OZ], ['1', LB], ['lb', LB], ['2', 0.001], ['g', 0.001], ['3', 1], ['kg', 1]];
    for (const [u, f] of want) expect(massFactor(u), u).toBe(f);
    expect(massFactor('stone')).toBeNull();
    expect(massFactor('')).toBeNull();
  });

  it('turn a cell into SI, and "not catalogued" into nothing', () => {
    expect(dim('0.71', IN)).toBe(round7(0.71 * 0.0254));
    expect(dim('18.7', MM)).toBe(0.0187);
    expect(dim('0', IN)).toBeUndefined();
    expect(dim('?', IN)).toBeUndefined();
    expect(massOf('5', '2')).toBe(0.005);
    expect(massOf('0.13', '0')).toBe(round7(0.13 * OZ));
    for (const m of ['0', '', '?']) expect(massOf(m, '2'), `mass "${m}"`).toBeUndefined();
    expect(massOf('5', 'stone')).toBeUndefined();
  });

  it('round to seven decimals, the name it now has', () => {
    expect(round7(0.123456789)).toBe(0.1234568);
  });

  it('map RockSim\'s nose-shape codes', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((c) => mapShape(String(c))))
      .toEqual(['CONICAL', 'OGIVE', 'ELLIPSOID', 'ELLIPSOID', 'POWER', 'PARABOLIC', 'HAACK']);
    expect(mapShape('')).toBe('CONICAL');
    expect(mapShape('sears-haack')).toBe('HAACK');
    expect(mapShape('bulbous')).toBeUndefined();
  });
});

describe('displayFor', () => {
  const catalogue = new Map([['apogeecomponents', 'Apogee Components']]);
  it('prefers a ruled DISPLAY spelling', () => {
    expect(displayFor('SEMROC Astronautics', catalogue)).toBe('SEMROC');
  });
  it('then the catalogue\'s own spelling of the same maker', () => {
    // Unreachable before 2026-09-22: `mfrDisplay` returned the CSV spelling first.
    expect(displayFor('APOGEE components', catalogue)).toBe('Apogee Components');
  });
  it('then the CSV\'s spelling', () => {
    expect(displayFor('Acme Rockets', catalogue)).toBe('Acme Rockets');
  });
});

describe('main, on synthetic CSVs', () => {
  const HEADER = 'Mfg,Part,Desc,Units,ID,OD,Length,Material,Engine,MassUnits,Mass';

  function world(bodyTubeRows, presets) {
    const dir = mkdtempSync(join(tmpdir(), 'rocksim-'));
    for (const { file } of FILES) writeFileSync(join(dir, file), `${HEADER}\n`);
    writeFileSync(join(dir, 'Body_tubeDATA.CSV'), [HEADER, ...bodyTubeRows].join('\n'));
    const presetsPath = join(dir, 'presets.json');
    writeFileSync(presetsPath, JSON.stringify({ count: presets.length, presets }, null, 1) + '\n');
    const jsonOut = join(dir, 'report.json');
    return {
      dir,
      run: () => main({ argv: [], csvDir: dir, presetsPath, dryRun: false, jsonOut }),
      presets: () => JSON.parse(readFileSync(presetsPath, 'utf8')).presets,
      report: () => JSON.parse(readFileSync(jsonOut, 'utf8')),
    };
  }
  const bt205 = { kind: 'BodyTube', manufacturer: 'Estes', partNo: 'BT205', insideDiameter: 0.018034,
    outsideDiameter: 0.0186944, length: 0.4572 };

  it('appends a new part in SI, marked as RockSim\'s', () => {
    const w = world(['Estes,BT-60,tube,0,1.595,1.637,18,Kraft phenolic,,2,20'], [bt205]);
    try {
      expect(w.run()).toBe(0);
      const added = w.presets().find((p) => p.partNo === 'BT-60');
      expect(added).toMatchObject({ source: 'rocksim', insideDiameter: round7(1.595 * IN), length: round7(18 * IN),
        mass: 0.02, material: { name: 'Kraft phenolic', type: 'BULK', density: 950 } });
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it('meets a catalogue part under the SHARED part-number key, not a private one', () => {
    // "BT-20.5" and "BT205" are one part to presetKey. The private key kept the
    // dot, so with dimensions over 2 % apart this row was appended as a second
    // part; now it is the same part, and a logged conflict (OpenRocket wins).
    const w = world(['Estes,BT-20.5,tube,0,0.71,0.736,24,Kraft phenolic,,2,5'], [bt205]);
    try {
      expect(w.run()).toBe(0);
      expect(w.presets().map((p) => p.partNo)).toEqual(['BT205']);
      expect(w.report().conflicts.map((c) => c.partNo)).toEqual(['BT-20.5']);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it('refuses to write two spellings of one maker', () => {
    // Neither spelling is in DISPLAY or the catalogue, so each row keeps its own.
    const w = world([
      'Acme Rockets,A-1,tube,0,1,1.1,12,Kraft phenolic,,2,5',
      'ACME ROCKETS,A-2,tube,0,2,2.1,12,Kraft phenolic,,2,9',
    ], [bt205]);
    try {
      expect(w.run()).toBe(1);
      expect(w.presets().map((p) => p.partNo)).toEqual(['BT205']);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it('files a row under the catalogue\'s spelling of its maker', () => {
    const cat = { ...bt205, manufacturer: 'Apogee Components', partNo: 'X1' };
    const w = world(['APOGEE components,X-2,tube,0,1,1.1,12,Kraft phenolic,,2,5'], [cat]);
    try {
      expect(w.run()).toBe(0);
      expect(w.presets().find((p) => p.partNo === 'X-2').manufacturer).toBe('Apogee Components');
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it('says where the CSVs are expected when none are configured, and writes nothing', () => {
    const w = world([], [bt205]);
    try {
      const before = readFileSync(join(w.dir, 'presets.json'), 'utf8');
      expect(main({ argv: [], csvDir: '', presetsPath: join(w.dir, 'presets.json') })).toBe(1);
      expect(readFileSync(join(w.dir, 'presets.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
