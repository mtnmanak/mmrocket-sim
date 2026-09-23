import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DENSITY_UNITS, LENGTH_UNITS, MASS_UNITS, byNtfsName, convertDensity, convertLength, convertMass,
  main, parseOrc, round,
} from './fetch-component-presets.mjs';

/**
 * fetch-component-presets.mjs: the conversion that turns every .orc dimension,
 * mass and density into the SI presets.json ships, and the decision not to
 * write a short catalogue. Until 2026-09-22 the script ran main() at import,
 * so none of this could be tested, and a slipped factor would have shipped on
 * the next regeneration: preset-density.test.mjs screens BULK densities for
 * values no material can have, and cannot see a length or mass factor at all
 * (audit 2026-09-22, Tests rows 480 and 523). Never touches the network.
 */

// The definitions, stated independently of the tables: the inch is 25.4 mm
// exactly, the foot twelve of them, and the avoirdupois pound 0.45359237 kg
// exactly, sixteen ounces to it.
const IN = 0.0254;
const FT = 12 * IN;
const LB = 0.45359237;
const OZ = LB / 16;

/** Relative agreement to 1e-12: the tables are products of exact definitions. */
const same = (actual, want) => Math.abs(actual - want) <= 1e-12 * Math.abs(want);

describe('the unit tables, against the definitions', () => {
  it('lengths', () => {
    const want = { m: 1, meter: 1, meters: 1, cm: 0.01, mm: 0.001, in: IN, inch: IN, 'in/64': IN / 64, ft: FT };
    expect(Object.keys(LENGTH_UNITS).sort()).toEqual(Object.keys(want).sort());
    for (const [u, f] of Object.entries(want)) expect(same(LENGTH_UNITS[u], f), `${u}`).toBe(true);
  });

  it('masses', () => {
    const want = { kg: 1, g: 0.001, oz: OZ, lb: LB };
    expect(Object.keys(MASS_UNITS).sort()).toEqual(Object.keys(want).sort());
    for (const [u, f] of Object.entries(want)) expect(same(MASS_UNITS[u], f), `${u}`).toBe(true);
  });

  it('densities, bulk, surface and line', () => {
    const want = {
      BULK: { 'kg/m3': 1, 'g/cm3': 1000, 'lb/ft3': LB / FT ** 3, 'oz/in3': OZ / IN ** 3 },
      SURFACE: { 'kg/m2': 1, 'g/cm2': 10, 'g/m2': 0.001, 'oz/in2': OZ / IN ** 2, 'oz/ft2': OZ / FT ** 2,
        'lb/ft2': LB / FT ** 2 },
      LINE: { 'kg/m': 1, 'g/m': 0.001, 'g/cm': 0.1, 'oz/in': OZ / IN, 'oz/ft': OZ / FT, 'lb/ft': LB / FT },
    };
    for (const [type, units] of Object.entries(want)) {
      for (const [u, f] of Object.entries(units)) {
        expect(same(DENSITY_UNITS[type][u], f), `${type} ${u}`).toBe(true);
        // Every "x3"/"x2" spelling has its "x^3"/"x^2" twin, at the same factor.
        const caret = u.replace(/([23])$/, '^$1');
        if (caret !== u) expect(DENSITY_UNITS[type][caret], `${type} ${caret}`).toBe(DENSITY_UNITS[type][u]);
      }
    }
    // Sanity on the two a reader can check by heart: water-ish 1 g/cm3, 62.4 lb/ft3.
    expect(convertDensity(62.43, 'lb/ft3', 'BULK', 't')).toBeCloseTo(1000, 0);
  });
});

describe('the converters', () => {
  it('treat a value with no unit as SI already', () => {
    expect(convertLength(0.5, undefined, 't')).toBe(0.5);
    expect(convertMass(0.5, '', 't')).toBe(0.5);
    expect(convertDensity(1200, undefined, 'BULK', 't')).toBe(1200);
  });

  it('read unit spellings the .orc files use', () => {
    expect(convertLength(2, ' in ', 't')).toBe(2 * IN);
    expect(convertMass(1, 'OZ', 't')).toBe(OZ);
    expect(convertDensity(1, ' G / CM3 ', 'BULK', 't')).toBe(1000);
  });

  it('refuse an unknown unit or material type rather than guess', () => {
    expect(() => convertLength(1, 'furlong', 'ctx')).toThrow(/unknown length unit "furlong" \(ctx\)/);
    expect(() => convertMass(1, 'stone', 'ctx')).toThrow(/unknown mass unit/);
    expect(() => convertDensity(1, 'kg/m3', 'VOLUME', 'ctx')).toThrow(/unknown material type/);
    expect(() => convertDensity(1, 'kg/m2', 'BULK', 'ctx')).toThrow(/unknown density unit/);
  });

  it('trims float noise to twelve significant figures', () => {
    expect(round(3 * IN)).toBe(0.0762);
    expect(round(1 / 3)).toBe(0.333333333333);
  });
});

describe('parseOrc', () => {
  const ORC = `<?xml version="1.0"?>
<OpenRocketComponent>
  <Materials>
    <Material UnitsOfMeasure="g/cm3"><Name>Kraft</Name><Density>0.95</Density><Type>BULK</Type></Material>
  </Materials>
  <Components>
    <BodyTube>
      <Manufacturer>Estes</Manufacturer><PartNumber>BT-20</PartNumber><Description>tube</Description>
      <Material Type="BULK">Kraft</Material>
      <InsideDiameter Unit="in">0.710</InsideDiameter>
      <OutsideDiameter Unit="mm">18.7</OutsideDiameter>
      <Length Unit="ft">1</Length>
      <Mass Unit="oz">0.5</Mass>
    </BodyTube>
    <BodyTube>
      <Manufacturer>Estes</Manufacturer><PartNumber>BAD</PartNumber>
      <Length Unit="furlong">1</Length>
    </BodyTube>
  </Components>
</OpenRocketComponent>`;

  it('converts every field of a component to SI, and resolves its material density', () => {
    const { presets, skippedComponents, warnings } = parseOrc(ORC, 't.orc', new Map());
    expect(skippedComponents).toBe(1);
    expect(warnings.join('\n')).toMatch(/SKIPPED BodyTube: unknown length unit "furlong"/);
    expect(presets).toHaveLength(1);
    const [bt] = presets;
    expect(bt).toMatchObject({ kind: 'BodyTube', manufacturer: 'Estes', partNo: 'BT-20' });
    expect(bt.insideDiameter).toBe(round(0.71 * IN));
    expect(bt.outsideDiameter).toBe(0.0187);
    expect(bt.length).toBe(round(FT));
    expect(bt.mass).toBe(round(0.5 * OZ));
    expect(bt.material).toEqual({ name: 'Kraft', type: 'BULK', density: 950 });
  });
});

describe('byNtfsName', () => {
  it('orders names case-insensitively, the way the committed presets.json was generated', () => {
    // The order `readdirSync` returned on the owner's Windows machine for the
    // 24.12 desktop files; a plain `.sort()` would put every capital first.
    const ntfs = ['b2_Rocketry_Parachutes..orc', 'bluetube-legacy.orc', 'bms-legacy.orc', 'Estes-legacy.orc',
      'fliskits-legacy.orc', 'Front_Range_Rocket_Recovery.orc', 'Fruity_Chutes_Enhanced.orc',
      'giantleaprocketry-legacy.orc', 'LocPrecision-legacy.orc', 'publicmissiles-legacy.orc', 'Quest-legacy.orc',
      'RailButton_Database.orc', 'Rocketman.orc', 'semroc-legacy.orc', 'Spherachutes_Parachutes.orc'];
    expect([...ntfs].reverse().sort(byNtfsName)).toEqual(ntfs);
  });
});

describe('main', () => {
  const orc = (part) => `<OpenRocketComponent><Components><BodyTube><Manufacturer>Estes</Manufacturer>`
    + `<PartNumber>${part}</PartNumber><Length Unit="mm">100</Length></BodyTube></Components></OpenRocketComponent>`;

  /** GitHub's contents listing and raw files, with `missing` answering 404 every time. */
  function github({ missing = [] } = {}) {
    const files = { 'a.orc': orc('BT-5'), 'b.orc': orc('BT-20') };
    return async (url) => {
      if (url.includes('api.github.com')) {
        return {
          ok: true, status: 200, headers: new Map(),
          json: async () => Object.keys(files).map((name) => ({ type: 'file', name, download_url: `https://raw/${name}` })),
        };
      }
      const name = url.split('/').pop();
      if (missing.includes(name)) return { ok: false, status: 404, headers: new Map() };
      return { ok: true, status: 200, headers: new Map(), text: async () => files[name] };
    };
  }

  async function run(opts) {
    const dir = mkdtempSync(join(tmpdir(), 'presets-'));
    const outPath = join(dir, 'presets.json');
    try {
      const code = await main({ outPath, sleep: async () => {}, desktopDir: '', allowPartial: false, ...opts });
      return { code, written: existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes the catalogue when every file arrives', async () => {
    const { code, written } = await run({ fetchImpl: github() });
    expect(code).toBe(0);
    expect(written.presets.map((p) => p.partNo)).toEqual(['BT-20', 'BT-5']);
    expect(written.presets[0].length).toBe(0.1);
  });

  it('writes NOTHING and exits 2 when a file fails to download', async () => {
    const { code, written } = await run({ fetchImpl: github({ missing: ['b.orc'] }) });
    expect(code).toBe(2);
    expect(written).toBeNull();
  });

  it('writes the short catalogue when --allow-partial asks for it', async () => {
    const { code, written } = await run({ fetchImpl: github({ missing: ['b.orc'] }), allowPartial: true });
    expect(code).toBe(0);
    expect(written.presets.map((p) => p.partNo)).toEqual(['BT-5']);
  });
});
