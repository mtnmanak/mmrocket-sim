// @vitest-environment happy-dom
import { URL as NodeURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { INITIAL_UNITS, IMPERIAL_UNITS, noticeQuantity } from '../prefs/units.js';
import { screenEntry, describeOverlay, diffCatalogue } from './catalogueOverlay.js';
import { MOTOR_DB, MOTOR_DB_DATE } from './motorDb.js';
import { loadCatalogueMotor, matchImportedMotor, describeRow, fetchSpecByDigest } from './motorMatch.js';
import { samplesToMotorSpec } from './thrustcurve.js';
import { preflightAudit } from './preflightAudit.js';
import { SURFACE_MATERIALS, LINE_MATERIALS, BULK_MATERIALS } from '../data/materials.js';
import { paperTemplateGeometry, paperTemplatePages } from './paperTemplates.js';
import { finAlignmentJigGeometry } from './finAlignmentJig.js';
import { finTemplateSvg } from './finTemplate.js';
import { windProfileSummary } from './windProfile.js';
import { stationPressureHelp, siteTemperatureHelp, densityAltitudeHelp, rodAimHelp } from '../components/LaunchPanel.js';
import { fieldNoticeText } from '../components/weatherText.js';
import { parseForecast } from './openMeteo.js';
import { printPackReadme } from './printPack.js';
import { splitComponent } from '../tree/splitSolid.js';

describe('U: catalogue, fabrication and density notification units', () => {
  it.each([
    ['mm', '0.15 mm (0.00591 in)', '0.05 mm (0.00197 in)', '0.3 mm [0.0118 in]'],
    ['cm', '0.015 cm (0.00591 in)', '0.005 cm (0.00197 in)', '0.03 cm [0.0118 in]'],
    ['m', '0.00015 m (0.00591 in)', '0.00005 m (0.00197 in)', '0.0003 m [0.0118 in]'],
    ['in', '0.00591 in (0.15 mm)', '0.00197 in (0.05 mm)', '0.0118 in [0.3 mm]'],
    ['ft', '0.000492 ft (0.15 mm)', '0.000164 ft (0.05 mm)', '0.000984 ft [0.3 mm]'],
  ])('preserves small print clearances and CA guidance in %s', (length, clearance, ca, diameter) => {
    const printer = { x: 0.2, y: 0.2, z: 0.2 };
    const split = splitComponent({ type: 'bodytube', length: 0.4, outerRadius: 0.0254, thickness: 0.002 }, {}, printer)!;
    const readme = printPackReadme(split, 'Tube', printer, 'Test', { ...INITIAL_UNITS, length });
    expect(readme).toContain(`Joint clearance is ${clearance} per side (${diameter} on the diameter)`);
    expect(readme).toContain(`CA wants about ${ca}`);
    const displayedClearance = Number(readme.match(/Joint clearance is ([\d.]+)/)![1]);
    const displayedCa = Number(readme.match(/CA wants about ([\d.]+)/)![1]);
    expect(displayedClearance / displayedCa).toBeCloseTo(3, 2);
  });

  it.each([INITIAL_UNITS, IMPERIAL_UNITS])('uses both systems in each producer (%j)', units => {
    const imperial = units.length === 'in';
    const length = imperial ? '1 in (25.4 mm)' : '25.4 mm (1 in)';
    const mass = imperial ? '3.53 oz [100 g]' : '100 g [3.53 oz]';
    const row = { ...MOTOR_DB[0]!, diameter: 25.4, length: 25.4, totalWeightG: 100, propWeightG: 200 };
    expect(screenEntry(row, units)).toContain(mass);
    expect(screenEntry({ ...row, diameter: 400 }, units)).toContain(imperial ? '15.748 in (400 mm)' : '400 mm (15.748 in)');
    expect(describeRow(row, [row], units)).toContain(imperial ? '(1 in [25.4 mm],' : '(25.4 mm [1 in],');
    const before = { ...row, propWeightG: 50, diameter: 24 };
    const after = { ...before, diameter: 25.4 };
    const overlay = { ...diffCatalogue([before], [after]), baseGenerated: MOTOR_DB_DATE,
      fetchedAt: new Date(0).toISOString(), liveCount: 1, added: [], removed: [], rejected: [{ entry: row, reason: screenEntry(row)! }] };
    const description = describeOverlay(overlay, units).join(' ');
    expect(description).toContain(length);
    expect(description).toContain(mass);
    expect(() => samplesToMotorSpec(row, [{ time: 0, thrust: 0 }, { time: 1, thrust: 1 }], 0, undefined, units)).toThrow(mass);

    expect(noticeQuantity('area', 0.00064516, units)).toBe(imperial ? '1 in² (645.16 mm²)' : '645.16 mm² (1 in²)');
    expect(noticeQuantity('surfaceDensity', 1, units)).toBe(imperial ? '0.0228 oz/in² (1 kg/m²)' : '1 kg/m² (0.205 lb/ft²)');
    expect(noticeQuantity('lineDensity', 1, units)).toBe(imperial ? '0.896 oz/in (1 kg/m)' : '1 kg/m (0.672 lb/ft)');
    for (const [kind, table, field, name] of [
      ['bodytube', BULK_MATERIALS, 'density', 'materialName'],
      ['parachute', SURFACE_MATERIALS, 'surfaceDensity', 'surfaceMaterialName'],
      ['shockcord', LINE_MATERIALS, 'lineDensity', 'lineMaterialName'],
    ] as const) {
      const material = table[0]!;
      const tree: RocketTree = { components: [{ id: 'part', type: kind, [name]: material.name, [field]: 1e8 }] };
      const finding = preflightAudit(tree, {}, [], units).findings.find(f => f.kind === 'material-density');
      expect(finding?.reason).toContain(imperial ? 'oz/in' : 'kg/m');
      expect(finding?.reason).toContain(imperial ? '(100000000 kg/m' : 'lb/ft');
    }
    const tube: ComponentNode = { type: 'bodytube', outerRadius: 0.0254, length: 0.2 };
    const fin: ComponentNode = { type: 'freeformfinset', points: [[0, 0], [0.1, 0], [0.1, 0.03]], finCount: 3, thickness: 0.003, crossSection: 'rounded' };
    expect(() => finAlignmentJigGeometry(tube, fin, 0.02, units)).toThrow(imperial ? '0.394 in (10 mm)' : '10 mm (0.394 in)');
    expect(finTemplateSvg(fin, 'Units', {}, 'transparent', units)).toContain(imperial ? 'exactly 1.969 in (50 mm)' : 'exactly 50 mm (1.969 in)');
    const paper = paperTemplateGeometry({ type: 'transition', shape: 'conical', foreRadius: 0.0254, aftRadius: 0.0254 + 1e-10, length: 0.1 }, {}, units);
    expect(paper.notes.join(' ')).toContain(imperial ? 'in (0.0001 mm)' : '0.0001 mm (');
    expect(paperTemplatePages(paper, 'Units', units)[0]!.svg).toContain(imperial ? '0.394 in (10 mm) overlap' : '10 mm (0.394 in) overlap');
    expect(windProfileSummary([{ altitude: 100, speed: 1, direction: 0 }], units.altitude)).toContain(imperial ? '328.1 ft (100 m)' : '100 m (328.1 ft)');
    const forecast = JSON.parse(readFileSync(new NodeURL('./__fixtures__/open-meteo/forecast-blackrock-1190m.json', import.meta.url), 'utf8'));
    expect(() => parseForecast({ ...forecast, elevation: 100 }, [200], units)).toThrow(imperial ? '328.1 ft (100 m)' : '100 m (328.1 ft)');
    expect(stationPressureHelp(units)).toContain(imperial ? '3,900 ft (1,188.7 m)' : '1,188.7 m (3,900 ft)');
    expect(siteTemperatureHelp(units)).toContain(imperial ? '59 °F [15 °C]' : '15 °C [59 °F]');
    expect(densityAltitudeHelp(units)).toContain(imperial ? '110 ft [33.5 m]' : '33.5 m [110 ft]');
    expect(rodAimHelp(units)).toContain('180°');
    expect(fieldNoticeText('windAverage', 10.6, units)).toContain(imperial ? '23.712 mph (10.6 m/s)' : '10.6 m/s (34.777 ft/s)');
    const printer = { x: 0.2, y: 0.2, z: 0.2, margin: 0.008, clearance: 0.00015 };
    const split = splitComponent({ type: 'bodytube', length: 0.4, outerRadius: 0.0254, thickness: 0.002 }, {}, printer);
    expect(split).not.toBeNull();
    expect(printPackReadme(split!, 'Tube', printer, 'Test', units)).toContain(imperial ? '0.00591 in (0.15 mm) per side' : '0.15 mm (0.00591 in) per side');
  });

  it.each([INITIAL_UNITS, IMPERIAL_UNITS])('keeps unit preferences through imported motor matching (%j)', async units => {
    const db = { ...MOTOR_DB[0]!, manufacturerAbbrev: 'AeroTech', diameter: 25.4 };
    const result = await matchImportedMotor({ designation: db.designation, manufacturer: 'Cesaroni Technology Inc.', diameter: 0.0254, length: 0.1, delay: 0 }, {
      units, findDb: () => db,
      fetchSpec: async () => ({ designation: db.designation, diameter: 0.0254, length: 0.1, times: [0, 1], thrusts: [0, 0], masses: [0.1, 0.1], cgX: 0.05, ejectionDelay: 0 }),
    });
    expect(result.openNote).toContain(units.length === 'in' ? '1 in [25.4 mm]' : '25.4 mm [1 in]');
    const invalid = { ...MOTOR_DB[0]!, totalWeightG: 100, propWeightG: 200 };
    // Real sample-cache shape: thrustcurve.ts reads samples plus nullable header
    // masses. No header means the catalogue masses must be checked, with the
    // loader's default fetchSpec forwarding this user's units.
    const key = `tc:samples:v7:${invalid.motorId}`;
    localStorage.setItem(key, JSON.stringify({ samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 1 }], masses: null }));
    try {
      await expect(loadCatalogueMotor(invalid.manufacturerAbbrev, invalid.designation, 0, { units, catalogue: [invalid] }))
        .rejects.toThrow(units.mass === 'g' ? '200 g [7.05 oz]' : '7.05 oz [200 g]');
    } finally { localStorage.removeItem(key); }
  });

  it.each([
    ['area', 0.00064516, '645.16 mm² (1 in²)', '1 in² (645.16 mm²)'],
    ['surfaceDensity', 1, '1 kg/m² (0.205 lb/ft²)', '0.0228 oz/in² (1 kg/m²)'],
    ['lineDensity', 1, '1 kg/m (0.672 lb/ft)', '0.896 oz/in (1 kg/m)'],
  ] as const)('converts the dimensions of %s without changing their SI evidence', (quantity, si, metric, imperial) => {
    expect(noticeQuantity(quantity, si, INITIAL_UNITS)).toBe(metric);
    expect(noticeQuantity(quantity, si, IMPERIAL_UNITS)).toBe(imperial);
    expect(noticeQuantity(quantity, si * (1 + 1e-8), INITIAL_UNITS, { against: si })).toBe(`just above ${metric}`);
    expect(noticeQuantity(quantity, si * (1 - 1e-8), IMPERIAL_UNITS, { against: si })).toBe(`just below ${imperial}`);
  });
});


it('rounds converted weather zero points without floating-point residue', () => {
  expect(fieldNoticeText('temperatureC', (32 + 459.67) * 5 / 9 - 273.15, IMPERIAL_UNITS)).toBe('32 °F (0 °C)');
  expect(fieldNoticeText('temperatureC', -160 / 9, IMPERIAL_UNITS)).toBe('0 °F (-17.8 °C)');
});

it('keeps preferred units in the digest adapter mass refusal', async () => {
  const row = { ...MOTOR_DB[0]!, motorId: 'unit-digest-refusal', totalWeightG: 100, propWeightG: 200 };
  const key = 'tc:samples:v7:unit-digest-refusal';
  localStorage.setItem(key, JSON.stringify({ samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 10 }, { time: 2, thrust: 0 }], masses: null, t: Date.now() }));
  try {
    await expect(fetchSpecByDigest(row, 0, undefined, IMPERIAL_UNITS))
      .rejects.toThrow('more propellant (7.05 oz [200 g]) than loaded mass (3.53 oz [100 g])');
  } finally { localStorage.removeItem(key); }
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R9 elevation mismatch names a display-equal requested height once (%j)', units => {
  const body = JSON.parse(readFileSync(new NodeURL('./__fixtures__/open-meteo/forecast-blackrock-1190m.json', import.meta.url), 'utf8'));
  expect(() => parseForecast({...body,elevation:1e8+0.6},[1e8],units))
    .toThrow('an elevation just above the requested '+noticeQuantity('altitude',1e8,units));
});
it.each([undefined,{totalWeightG:100,propWeightG:100+1e-10}])('R9 accepted mass residue never leaves negative burnout mass (%j)', header => {
  const row={...MOTOR_DB[0]!,totalWeightG:100,propWeightG:100+1e-10};
  const spec=samplesToMotorSpec(row,[{time:0,thrust:0},{time:1,thrust:1},{time:2,thrust:0}],0,header);
  expect(spec.masses.every(m=>m>=0)).toBe(true);
  expect(spec.masses.at(-1)).toBe(0);
});
