// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { FlightResult, RocketTree } from '@online-openrocket/engine';
import { INITIAL_UNITS, IMPERIAL_UNITS, noticeComparison, noticeQuantity } from '../prefs/units.js';
import { formatWarning, formatWarningText } from './simWarnings.js';
import { flightLimitAdvice } from './flightAdvisories.js';
import { describeDeployment } from './deployOverrideNote.js';
import { deployAltitudeText } from '../components/recoveryContext.js';
import { gustNote } from '../components/weatherText.js';
import { explanationFor } from './noteExplanations.js';
import { railNeededLine } from './railNeeded.js';
import { sanitizeTree, treeProblems } from '../tree/sanitize.js';
import { railInterferenceWarnings, wakeShadowWarnings } from '../tree/mountAngle.js';
import { ringFitFor } from '../components/ringFit.js';
import { importOrk, exportOrk } from './orkFile.js';
import { importRkt, exportRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { exitDiameterFromRse, parseMotorFile } from './exMotors.js';
import { printOffer } from './printPack.js';
import { materialProblem } from './userMaterials.js';
import { explainBuildFailure } from '../tree/sanitize.js';
import { describeComponentFlightTuple } from './flightOverrideText.js';
import { fileLongitudeNote } from './longitudeCheck.js';

it.each([
  ['m', '0.000999 m (0.0393 in)', '0.001 m (0.0394 in)'],
  ['in', '0.0393 in (0.999 mm)', '0.0394 in (1 mm)'],
])('shares fabrication precision across the 1 mm comparison boundary in %s', (unit, actual, limit) => {
  expect(noticeComparison('length', 0.000999, 0.001, unit)).toEqual([actual, limit]);
});

it('compares the displayed small nonzero value rather than a rounded zero', () => {
  expect(noticeQuantity('length', -0.00001, INITIAL_UNITS, { against: 0 })).toBe('-0.01 mm (-0.000394 in)');
  expect(noticeQuantity('length', 0.00009, INITIAL_UNITS, { against: 0.0001 }))
    .toBe('0.09 mm (0.00354 in)');
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('quotes repair values without replacing input evidence (%j)', units => {
  const notes: string[] = [];
  sanitizeTree({ components: [{ type: 'tubefinset', length: 0.00009, thickness: -0.00001 }] }, notes, units);
  const text = notes.join(' ');
  expect(text).toContain(units.length === 'mm' ? '0.09 mm (0.00354 in)' : '0.003543 in (0.09 mm)');
  expect(text).toContain(units.length === 'mm' ? '-0.01 mm (-0.000394 in)' : '-0.000394 in (-0.01 mm)');
  expect(text).not.toMatch(/just (above|below)/);
  const failure = explainBuildFailure({ components: [{ type: 'bodytube', length: -0.0254 }] }, 'kernel', undefined, units);
  expect(failure).toContain(units.length === 'mm' ? '-25.4 mm (-1 in)' : '-1 in (-25.4 mm)');
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('pairs live flight override and geographic notices (%j)', units => {
  expect(describeComponentFlightTuple({ deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 }, units.altitude, 'warning'))
    .toContain(units.altitude === 'm' ? '91.44 m (300 ft)' : '300 ft (91.4 m)');
  const text = fileLongitudeNote({ opened: { latitudeDeg: 26, longitudeDeg: 80 }, sibling: { latitudeDeg: 28, longitudeDeg: -80 },
    siblingCount: 1, distanceKm: 13618, flippedDistanceKm: 198 }, 'Test', units.distance);
  expect(text).toContain(units.distance === 'm' ? '13,600 km (8,451 mi)' : '8,500 mi (13,679 km)');
});

it.each([
  [INITIAL_UNITS, '-273.1 °C (-459.7 °F)'],
  [IMPERIAL_UNITS, '-459.7 °F (-273.1 °C)'],
] as const)('R11 reports the actual equivalents of refused zero kelvin (%j)', (units, equivalent) => {
  const ork = `<openrocket version='1.10'><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.05</radius></bodytube></subcomponents></stage></subcomponents></rocket>`
    + `<simulations><simulation><conditions><atmosphere model='extendedisa'><basetemperature>0</basetemperature><basepressure>101325</basepressure></atmosphere></conditions></simulation></simulations></openrocket>`;
  const result = importOrk(ork, { units });
  expect(result.launch?.temperatureC).toBeNull();
  expect(result.notes.join(' ')).toContain(`0 K — ${equivalent} — outside`);
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('retains rejected temperature comparison evidence (%j)', units => {
  const ork = '<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.05</radius></bodytube></subcomponents></stage></subcomponents></rocket>'
    + '<simulations><simulation><conditions><atmosphere model="extendedisa"><basetemperature>333.16</basetemperature><basepressure>101325</basepressure></atmosphere></conditions></simulation></simulations></openrocket>';
  const cdx = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign><LaunchSite><Temperature>140.018</Temperature></LaunchSite></RASAeroDocument>';
  for (const notes of [importOrk(ork, { units }).notes, importCdx1(cdx, { units }).notes]) {
    expect(notes.join(' ')).toContain('just outside the supported range');
    expect(notes.join(' ').split(noticeQuantity('temperature',333.15,units))).toHaveLength(2);
  }
});

describe('U: notification producer unit matrix', () => {
  it.each([
    [INITIAL_UNITS, '10.6 m/s (35 ft/s)', '100 m (328.1 ft)', '25.4 mm (1 in)', '100 g (3.53 oz)'],
    [IMPERIAL_UNITS, '35 ft/s (10.6 m/s)', '328.1 ft (100 m)', '1 in (25.4 mm)', '3.53 oz (100 g)'],
  ] as const)('formats every producer at its quantity boundary (%j)', (units, speed, height, length, mass) => {
    expect(noticeQuantity('velocity', 10.6, units)).toBe(speed);
    expect(printOffer({ type: 'bodytube', length: 1, outerRadius: 0.0127, thickness: 0.001 }, {}, null, 'Printer', units).note).toContain(
      units.length === 'mm' ? '1000 mm (39.37 in)' : '39.37 in (1000 mm)');
    expect(noticeQuantity('velocity', 20 * 0.3048, units)).toContain('20 ft/s');
    expect(exitDiameterFromRse(1, 38, units)).toMatchObject({ rejected: expect.stringContaining(
      units.motorDimensions === 'mm' ? '1 (only 3% of the 38 mm [1.496 in] case'
        : '1 (only 3% of the 1.496 in [38 mm] case') });
    expect(() => parseMotorFile('bad.eng', 'T 24 70 P 0.2 0.1 Test\n0 0\n1 10\n2 0', [], units)).toThrow(
      units.mass === 'g' ? 'more propellant (200 g [7.05 oz]) than loaded mass (100 g [3.53 oz])'
        : 'more propellant (7.05 oz [200 g]) than loaded mass (3.53 oz [100 g])');
    expect(materialProblem({ kind: 'bulk', name: 'Test material', density: 30001 }, units)).toContain(
      units.density === 'kg/m³' ? '30000 kg/m³ (1872.84 lb/ft³)' : 'oz/in³ (30000 kg/m³)');
    expect(describeDeployment({ deployEvent: 'altitude', deployAltitude: 100, deployDelay: 0 }, units.altitude)).toContain(units.altitude === 'm' ? height : '328.084 ft (100 m)');
    expect(deployAltitudeText(100, units.altitude)).toContain(units.altitude === 'm' ? height : '328.084 ft (100 m)');
    const typed = formatWarning({ key: 'HighSpeedDeployment', message: '', quantity: { kind: 'velocity', value: 10.6 }, sources: [] }, units);
    // Typed detail keeps three decimals in the selected unit.
    expect(typed.detail).toContain(units.velocity === 'm/s' ? '(10.6 m/s [35 ft/s])' : '(34.777 ft/s [10.6 m/s])');
    expect(formatWarningText('[Warning.RECOVERY_HIGH_SPEED]', units)).toContain(units.velocity === 'm/s' ? '20 m/s (65.6 ft/s)' : '65.6 ft/s (20 m/s)');
    expect(explanationFor('HighSpeedDeployment', units).remedy).toContain(units.velocity === 'm/s' ? '20 m/s (65.6 ft/s)' : '65.6 ft/s (20 m/s)');
    expect(railNeededLine({ segments: [], railM: 0.0254, offsetM: 0, allowance: false, thrustEnded: false },
      10.6, units.length, units.velocity)).toContain(length);
    expect(gustNote(1, 1.00001, units)).toContain(units.windspeed === 'm/s' ? 'm/s (' : 'mph (');

    const ring = { type: 'centeringring' as const, id: 'ring', length: 0.01, outerRadius: 0.0127 };
    const tree: RocketTree = { components: [{ type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.01, thickness: 0.001, children: [ring] }] };
    expect(ringFitFor(tree, ring, { outside: true, inside: false }, units).notes.join(' ')).toContain(units.length === 'mm' ? '25.4 mm [1 in]' : '1 in [25.4 mm]');
    const bad: RocketTree = { components: [{ type: 'bodytube', length: -0.0254 }] };
    const notes: string[] = [];
    sanitizeTree(bad, notes, units);
    expect(notes.join(' ')).toContain(units.length === 'mm' ? '-25.4 mm (-1 in)' : '-1 in (-25.4 mm)');
    expect(treeProblems(bad, units).join(' ')).toContain(units.length === 'mm' ? '-25.4 mm (-1 in)' : '-1 in (-25.4 mm)');

    const result = { summary: { maxAltitude: 100, maxMachNumber: 0.1 },
      series: { time: [0], mach: [0.106], Vs: [100] }, events: [{ type: 'APOGEE', time: 0 }] } as unknown as FlightResult;
    const advice = flightLimitAdvice(result, { maxAirspeedMs: 10, armingAltitudeM: 200 }, 'Test', undefined, units);
    expect(advice[0]!.text).toContain(units.velocity === 'm/s' ? '10.6 m/s' : '34.777 ft/s');
    expect(advice[0]!.text).toContain(units.velocity === 'm/s' ? 'ft/s)' : 'm/s)');
    expect(advice[1]!.text).toContain(units.altitude === 'm' ? '100 m (328.1 ft)' : '328.084 ft (100 m)');

    const importedTree: RocketTree = { name: 'Units', components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.3, outerRadius: 0.025, thickness: 0.001 }] }] };
    const ork = exportOrk({ name: 'Units', tree: importedTree, launch: { ...DEFAULT_CONDITIONS, windAverage: -10.6 }, motors: {} });
    expect(importOrk(ork, { units }).notes.join(' ')).toContain(units.windspeed === 'm/s' ? '10.6 m/s (35 ft/s)' : '23.71 mph (10.6 m/s)');
    const rkt = exportRkt({ name: 'Units', tree: importedTree, motors: {}, measured: { massKg: 0.1, cgM: 0.0254 } });
    const rktNotes = importRkt(rkt, { units }).notes.join(' ');
    expect(rktNotes).toContain(mass);
    expect(rktNotes).toContain(length);
    const cdx = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign><LaunchSite><RodLength>-1</RodLength></LaunchSite></RASAeroDocument>';
    expect(importCdx1(cdx, { units }).notes.join(' ')).toContain(units.length === 'mm' ? '-304.8 mm (-12 in)' : '-12 in (-304.8 mm)');

    const railTree: RocketTree = { components: [{ type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.027, children: [
      { type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.05, height: 0.04 },
      { type: 'railbutton', id: 'r', angleOffset: 0 },
    ] }] };
    expect(railInterferenceWarnings(railTree, units).join(' ')).toContain('0°');
    const wakeTree: RocketTree = { components: [{ type: 'bodytube', id: 'b', length: 1, outerRadius: 0.027, children: [
      { type: 'fairing', id: 'camera', name: 'Camera', length: 0.08, width: 0.025, height: 0.02, angleOffset: 0, position: { offset: 0.1, method: 'top' } },
      { type: 'trapezoidfinset', id: 'fin', name: 'Fin', finCount: 3, rootChord: 0.1, height: 0.04, position: { offset: 0.4, method: 'top' } },
    ] }] };
    expect(wakeShadowWarnings(wakeTree, units).join(' ')).toContain(units.length === 'mm' ? '220 mm (8.661 in)' : '8.661 in (220 mm)');
  });

  it('keeps strict comparisons distinct in both displayed systems', () => {
    for (const units of [INITIAL_UNITS, IMPERIAL_UNITS, { ...INITIAL_UNITS, velocity: 'km/h' }, { ...IMPERIAL_UNITS, velocity: 'mph' }]) {
      for (const actual of [15 - 1e-6, 15 + 1e-6]) {
        const text = noticeQuantity('velocity', actual, units, { against: 15 });
        const limit = noticeQuantity('velocity', 15, units);
        expect(text).toBe(`just ${actual > 15 ? 'above' : 'below'} ${limit}`);
      }
    }
    expect(noticeQuantity('velocity', NaN)).toBe('—');
    expect(noticeQuantity('temperature', 273.15, INITIAL_UNITS)).toBe('0 °C (32 °F)');
    expect(noticeQuantity('temperature', 273.15, IMPERIAL_UNITS)).toBe('32 °F (0 °C)');
  });
});


it.each([INITIAL_UNITS, IMPERIAL_UNITS])('pairs every dimension in a print split refusal (%j)', units => {
  const note = printOffer({ type: 'bodytube', length: 0.2032, outerRadius: 0.1524, thickness: 0.002 }, {},
    { x: 0.316, y: 0.316, z: 0.325 }, 'Bambu H2D', units).note;
  expect(note).toBe(units.length === 'in'
    ? '8 in (203.2 mm) — does not fit your Bambu H2D, and cannot be split: Ø12 in (304.8 mm) is wider than the 11.811 in (300 mm) usable bed — no axial cut makes a part narrower. The button exports the whole part.'
    : '203.2 mm (8 in) — does not fit your Bambu H2D, and cannot be split: Ø304.8 mm (12 in) is wider than the 300 mm (11.811 in) usable bed — no axial cut makes a part narrower. The button exports the whole part.');
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('keeps freeform extent units through validation and both importers (%j)', units => {
  const points: [number, number][] = [[0, 0], [2.6, 1], [2.7, 2], [3, 0]];
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 4, outerRadius: 0.05,
    children: [{ type: 'freeformfinset', name: 'Fins', points, thickness: 0.003, crossSection: 'rounded' }] }] }] };
  const limit = units.length === 'in' ? '98.425 in (2500 mm)' : '2500 mm (98.425 in)';
  expect(treeProblems(tree, units).join(' ')).toContain(`within ${limit}`);
  expect(importOrk(exportOrk({ name: 'Fins', tree, launch: DEFAULT_CONDITIONS, motors: {} }), { units }).notes.join(' ')).toContain(`within ${limit}`);
  expect(importRkt(exportRkt({ name: 'Fins', tree, motors: {} }), { units }).notes.join(' ')).toContain(`within ${limit}`);
});


it.each([INITIAL_UNITS, IMPERIAL_UNITS])('keeps split geometry refusal units through the print offer (%j)', units => {
  const note = printOffer({ type: 'bodytube', length: 0.4, outerRadius: 0.025, thickness: 0.00005 }, {},
    { x: 0.2, y: 0.2, z: 0.2, spigot: 0.001, lean: false }, 'Printer', units).note;
  expect(note).toContain(units.length === 'in' ? 'wall 0.00197 in [0.05 mm]' : 'wall 0.05 mm [0.00197 in]');
});

it('silently clamps a wall thickness differing from zero only by residue', () => {
  const notes: string[] = [];
  const tree = sanitizeTree({ components: [{ type: 'bodytube', thickness: -1e-18 }] }, notes);
  expect(tree.components[0]!['thickness']).toBe(0);
  expect(notes).toEqual([]);
});

it('names a display-equal metre print-fit bound once', () => {
  const note = printOffer({ type: 'bodytube', length: 0.3, outerRadius: 0.0962, thickness: 0.002 }, {},
    { x: 0.208, y: 0.208, z: 0.208 }, 'Printer', { ...INITIAL_UNITS, length: 'm' }).note;
  expect(note).toContain('Diameter is just over the 0.192 m (7.559 in) usable bed');
  expect(note).not.toContain('0.192 m (7.575 in)');
});

it('names a display-equal ring/motor bound once in metres', () => {
  const note = printOffer({ type: 'centeringring', length: 0.01, outerRadius: 0.096 },
    { mountOuterRadius: 0.0962 }, null, 'Printer', { ...INITIAL_UNITS, length: 'm' }).note;
  expect(note).toContain("motor mount is just over this ring's 0.192 m (7.559 in) OD and does not fit");
  expect(note).not.toContain('0.192 m (7.575 in)');
});

describe('fixed-unit notices: the 680 kg/m³ stand-in density', () => {
  const ork = (parts: string) => `<openrocket><rocket><name>Units</name><subcomponents><stage><subcomponents>${parts}</subcomponents></stage></subcomponents></rocket></openrocket>`;
  const rkt = (parts: string) => `<RockSimDocument><DesignInformation><RocketDesign><Name>Units</Name><StageCount>1</StageCount><Stage3Parts><BodyTube><Name>Tube</Name><OD>100</OD><ID>96</ID><Len>400</Len><AttachedParts>${parts}</AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
  const fillet = (density: string) => ork(`<trapezoidfinset><name>Fins</name><filletradius>0.006</filletradius><filletmaterial type="bulk" density="${density}">Fillet</filletmaterial></trapezoidfinset>`);
  it.each([
    [INITIAL_UNITS, '680 kg/m³ (42.451 lb/ft³)', '680 kg/m³ [42.451 lb/ft³]'],
    [IMPERIAL_UNITS, '0.393 oz/in³ (680 kg/m³)', '0.393 oz/in³ [680 kg/m³]'],
  ] as const)('prints it in the preferred density first in every producer (%j)', (units, density, nested) => {
    const caution = `zero bulk density cannot be flown by the app's engine; it uses ${density} instead, adding mass.`;
    const body = importOrk(ork('<bodytube><name>Body</name><material type="bulk" density="0">Zero</material></bodytube>'), { units });
    expect(body.noteTiers?.find(note => note.kind === 'I21.zero-bulk-density')?.text).toContain(`“Body”: ${caution}`);
    const zeroFillet = importOrk(fillet('0'), { units });
    expect(zeroFillet.noteTiers?.find(note => note.kind === 'I21.zero-bulk-density')?.text).toContain(`“Fins fillets”: ${caution}`);
    expect(importOrk(fillet('junk'), { units }).notes.join(' '))
      .toContain(`“Fins”: invalid <filletmaterial density> value; using the default fillet density (${nested}), which changes fin mass.`);
    const ring = importRkt(rkt('<Ring><Name>Weightless ring</Name><Density>0</Density><DensityType>0</DensityType></Ring>'), { units });
    expect(ring.noteTiers?.find(note => note.kind === 'I21.zero-bulk-density')?.text).toContain(`“Weightless ring”: ${caution}`);
    expect(explanationFor('I21.zero-bulk-density', units).meaning)
      .toBe(`The engine replaces zero bulk density with ${density}, adding mass. Saving replaces the zero density.`);
  });
});
