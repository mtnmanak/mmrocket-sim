import { treeProblems } from '../tree/sanitize.js';
import { screenEntry } from './catalogueOverlay.js';
import { samplesToMotorSpec } from './thrustcurve.js';
import { MOTOR_DB } from './motorDb.js';
import { preflightAudit, DENSITY_RANGE_FACTOR } from './preflightAudit.js';
import { SURFACE_MATERIALS } from '../data/materials.js';
import { farNoticeText } from '../components/weatherText.js';
// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { INITIAL_UNITS, IMPERIAL_UNITS, noticeQuantity } from '../prefs/units.js';
import { parseMotorFile } from './exMotors.js';
import { importOrk } from './orkFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { designStateFromSession } from './sessionRestore.js';
import { scaleRocket } from '../tree/scaleRocket.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { explanationFor } from './noteExplanations.js';
import { formatWarning } from './simWarnings.js';

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('keeps both mass comparisons explicit when normal displays coincide (%j)', units => {
  for (const [prop, loaded] of [[100.04, 100], [37.04, 37], [999.7, 999.6]] as const) {
    let text = '';
    try { parseMotorFile('bad.eng', `T 24 70 P ${prop / 1000} ${loaded / 1000} Test\n0 0\n1 10\n2 0`, [], units); }
    catch (error) { text = String(error); }
    const pairs = [...text.matchAll(/\(([\d.]+) (g|oz)(?: \[|, )([\d.]+) (g|oz|lb)\]?\)/g)];
    expect(text).toContain('slightly more propellant than loaded mass');
    expect(pairs).toHaveLength(1);
  }
});

it.each(['bar', 'inHg', 'mbar'])('distinguishes rejected pressure from the boundary in %s', pressure => {
  const units = { ...INITIAL_UNITS, pressure };
  const ork = '<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.05</radius></bodytube></subcomponents></stage></subcomponents></rocket><simulations><simulation><conditions><atmosphere model="extendedisa"><basepressure>110001</basepressure></atmosphere></conditions></simulation></simulations></openrocket>';
  const cdx = `<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign><LaunchSite><Pressure>${1100.01 / 33.86389}</Pressure></LaunchSite></RASAeroDocument>`;
  for (const notes of [importOrk(ork, { units }).notes, importCdx1(cdx, { units }).notes]) {
    const text=notes.join(' ');
    if(pressure==='bar'||pressure==='inHg') expect(text).toContain('just outside the supported range');
    else {
      const pairs=[...text.matchAll(/([-+\d.,e]+ (?:mbar|bar|inHg)) [([]([-+\d.,e]+ (?:mbar|bar|inHg))[)\]]/g)];
      expect(pairs).toHaveLength(3);
      expect(pairs[0]![0]).not.toBe(pairs[2]![0]);
    }
    expect(text.split(noticeQuantity('pressure', 110000, units))).toHaveLength(2);
  }
});

it('keeps latitude and longitude in compact degrees even with radians selected', () => {
  const xml = '<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.05</radius></bodytube></subcomponents></stage></subcomponents></rocket><simulations><simulation><conditions><launchlatitude>95</launchlatitude><launchlongitude>-200</launchlongitude></conditions></simulation></simulations></openrocket>';
  const text = importOrk(xml, { units: { ...INITIAL_UNITS, angle: 'rad' } }).notes.join(' ');
  expect(text).toContain('95\u00b0');
  expect(text).toContain('-200\u00b0');
  expect(text).not.toContain('rad');
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('quotes the same kernel deployment threshold in meaning and remedy (%j)', units => {
  const explanation = explanationFor('HighSpeedDeployment', units);
  const threshold = units.velocity === 'm/s' ? '20 m/s (65.6 ft/s)' : '65.6 ft/s (20 m/s)';
  expect(explanation.meaning).toContain(threshold);
  expect(explanation.remedy).toContain(threshold);
  expect(formatWarning({ key: 'HighSpeedDeployment', message: '' }, units).label).toContain(threshold);
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R13 typed deployment warnings retain the explanation threshold (%j)', units => {
  const threshold = units.velocity === 'm/s' ? '20 m/s (65.6 ft/s)' : '65.6 ft/s (20 m/s)';
  for (const value of [30.48, 20.00001]) {
    const warning = formatWarning({ key: 'HighSpeedDeployment', message: '',
      quantity: { kind: 'velocity', value }, sources: [{ name: 'Main' }] }, units);
    expect.soft(warning.label).toContain(threshold);
    expect(explanationFor('HighSpeedDeployment', units).meaning).toContain(threshold);
    expect(explanationFor('HighSpeedDeployment', units).remedy).toContain(threshold);
    expect(warning.detail).toContain('"Main"');
    if (value === 20.00001) expect(warning.detail).toContain('slightly above this threshold');
  }
});

it('uses brackets inside an existing parenthetical', () => {
  expect(noticeQuantity('altitude', 304.8, INITIAL_UNITS, { parenthesized: true, grouped: true })).toBe('304.8 m [1,000 ft]');
});

it('threads imperial units into restored repairs and scale-limit repairs', () => {
  const tree = { components: [{ type: 'nosecone' as const, length: 0.2, shoulderRadius: -0.013 }] };
  const restored = designStateFromSession({ tree, launch: DEFAULT_CONDITIONS, savedAt: 0 }, { legacyMaxMotorLengthM: null, units: IMPERIAL_UNITS });
  expect(restored.restoreNotes.join(' ')).toContain('-0.511811 in (-13 mm)');
});

it('threads imperial units into scale-limit repairs', () => {
  const scaled = scaleRocket({ components: [{ type: 'bodytube' as const, length: 999 }] }, 2, { units: IMPERIAL_UNITS });
  expect(scaled.notes.join(' ')).toMatch(/in \[?\(?1998000 mm/);
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('retains strict catalogue and sampler comparisons at both unit boundaries (%j)', units => {
  const motor = { ...MOTOR_DB[0]!, totalWeightG: 100, propWeightG: 100.04 };
  const texts = [screenEntry(motor, units)!];
  try { samplesToMotorSpec(motor, [{ time: 0, thrust: 0 }, { time: 1, thrust: 1 }], 0, undefined, units); }
  catch (error) { texts.push(String(error)); }
  expect(texts).toHaveLength(2);
  for (const text of texts) {
    const pairs = [...text.matchAll(/\(([\d.]+) (g|oz) \[([\d.]+) (g|oz)\]\)/g)];
    expect(text).toContain('slightly more propellant than loaded mass');
    expect(pairs).toHaveLength(1);
  }
});

it('retains surface-density ordering in the actual preflight range', () => {
  const material = SURFACE_MATERIALS[0]!;
  const max = Math.max(...SURFACE_MATERIALS.filter(m => m.group === material.group).map(m => m.density)) * DENSITY_RANGE_FACTOR;
  const actual = max * (1 + 1e-8);
  const tree = { components: [{ type: 'parachute' as const, id: 'chute', surfaceMaterialName: material.name, surfaceDensity: actual }] };
  const reason = preflightAudit(tree, {}, [], INITIAL_UNITS).findings.find(f => f.kind === 'material-density')!.reason;
  const pairs = [...reason.matchAll(/([\d.]+) kg\/m² \(([\d.]+) lb\/ft²\)/g)];
  expect(reason).toContain('density is just outside the screening range');
  expect(pairs).toHaveLength(2);
  expect(pairs[0]![0]).not.toBe(pairs[1]![0]);
});

it('keeps geographic distances on the km/mi scale', () => {
  expect(farNoticeText('m', 1368)).toBe('1.4 km (0.9 mi)');
  expect(farNoticeText('ft', 1368)).toBe('0.9 mi (1.4 km)');
});

it('keeps sanitizer length and density comparands on the correct side', () => {
  const tree = { components: [{ type: 'bodytube' as const, length: 1000.000004, density: 30000.001 }] };
  const text = treeProblems(tree).join(' ');
  for (const [unit, other] of [['mm', 'in'], ['kg/m³', 'lb/ft³']]) {
    const pairs = [...text.matchAll(new RegExp(`([0-9.]+) ${unit} \\(([0-9.]+) ${other}\\)`, 'g'))];
    expect(text).toContain('is just over the');
    expect(pairs).toHaveLength(1);
  }
});
