// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { RocketTree, FlightResult } from '@online-openrocket/engine';
import { INITIAL_UNITS, IMPERIAL_UNITS, noticeComparison, type UnitSelection } from '../prefs/units.js';
import { fieldNoticeText } from '../components/weatherText.js';
import { preflightAudit, DENSITY_RANGE_FACTOR } from './preflightAudit.js';
import { SURFACE_MATERIALS, LINE_MATERIALS, BULK_MATERIALS } from '../data/materials.js';
import { reconcileIncludedMotor, OVERRIDE_INCLUDES_MOTOR, boundedStageCg, stageCgWithoutMotor } from './statedLaunchWeight.js';
import { statedWeightTextFor } from './unitText.js';
import { importCdx1 } from './rasaeroFile.js';
import { importOrk } from './orkFile.js';
import { flightLimitAdvice } from './flightAdvisories.js';
import { parseCoordinates } from './openMeteo.js';
import { railNeededLine } from './railNeeded.js';
import { limitPatch, sanitizeTree } from '../tree/sanitize.js';
import { normalizeTree } from '../tree/treeModel.js';
import { MAX_DIMENSION_M } from '../tree/schema.js';
import { printOffer } from './printPack.js';
import { describeOverlay, diffCatalogue } from './catalogueOverlay.js';
import { MOTOR_DB, MOTOR_DB_DATE } from './motorDb.js';
import { noticeQuantity } from '../prefs/units.js';

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R10 silently clamps tube-fin endpoint residue (%j)', units => {
  const tree: RocketTree = { components: [{ type: 'tubefinset', length: 0.00009999999999999999 }] };
  const notes: string[] = [];
  expect(sanitizeTree(tree, notes, units).components[0]!.length).toBe(0.0001);
  expect(tree.components[0]!.length).toBe(0.00009999999999999999);
  expect(notes).toEqual([]);
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R10 silently clamps negative residue on load and patch (%j)', units => {
  for (const [type, key] of [['launchlug', 'length'], ['bodytube', 'thickness'],
    ['trapezoidfinset', 'height'], ['parachute', 'surfaceDensity']] as const) {
    const node = { type, [key]: -1e-12 };
    const notes: string[] = [];
    const tree = normalizeTree({ components: [{ type: 'stage', children: [node] }] }, notes, { units });
    expect(tree.components[0]!.children![0]![key]).toBe(0);
    expect(limitPatch({ type }, { [key]: -1e-12 }, notes, units)[key]).toBe(0);
    expect(notes).toEqual([]);
    expect(node[key]).toBe(-1e-12);
  }
});

it.each([-1, 1])('R10 silently clamps position residue at the %s endpoint', sign => {
  const notes: string[] = [];
  const tree: RocketTree = { components: [{ type: 'bodytube', position: {
    method: 'top', offset: sign * (MAX_DIMENSION_M + Number.EPSILON * MAX_DIMENSION_M),
  } }] };
  expect(sanitizeTree(tree, notes).components[0]!.position!.offset).toBe(sign * MAX_DIMENSION_M);
  expect(notes).toEqual([]);
});

it.each(['in', 'ft', 'yd'])('R10 length displays stay ordered across 1 mm in %s', length => {
  const units = { ...IMPERIAL_UNITS, length, motorDimensions: length };
  for (const quantity of ['length', 'motorDimensions'] as const) {
    const values = [0.00099, 0.001, 0.001003, 0.00106, 0.0013];
    const displayed = values.map(value => Number.parseFloat(noticeQuantity(quantity, value, units)));
    expect(displayed).toEqual([...displayed].sort((a, b) => a - b));
  }
  const text = printOffer({ type: 'centeringring', length: 0.01, outerRadius: 0.0005 },
    { mountOuterRadius: 0.0005015 }, { x: 0.2, y: 0.2, z: 0.2 }, 'Printer', units).note!;
  expect(text).toContain('does not fit');
  ordered(text, length, 'mm', 1, 2, 1);
});

it.each([
  [INITIAL_UNITS, 453.59, 453.6, 'lb'],
  [IMPERIAL_UNITS, 999.9, 1000.1, 'kg'],
] as const)('R10 states a catalogue mass change across counterpart transitions once (%j)', (units, a, b, counterpart) => {
  for (const key of ['totalWeightG', 'propWeightG'] as const) {
    const before = { ...MOTOR_DB[0]!, [key]: a };
    const after = { ...before, [key]: b };
    const overlay = { ...diffCatalogue([before], [after]), baseGenerated: MOTOR_DB_DATE,
      fetchedAt: new Date(0).toISOString(), liveCount: 1, rejected: [] };
    const text = describeOverlay(overlay, units).join(' ');
    expect(text).toContain(key + ' changed slightly (now ');
    expect(text).toContain(counterpart);
    expect(text).not.toContain('→');
  }
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R9 states a display-equal catalogue change once (%j)', units => {
  const before = { ...MOTOR_DB[0]!, totalWeightG: 1000 };
  const after = { ...before, totalWeightG: 1000.1 };
  const overlay = { ...diffCatalogue([before], [after]), baseGenerated: MOTOR_DB_DATE,
    fetchedAt: new Date(0).toISOString(), liveCount: 1, rejected: [] };
  const text = describeOverlay(overlay, units).join(' ');
  expect(text).toContain('totalWeightG changed slightly (now ');
  expect(text).not.toContain('→');
});

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('R9 treats conversion-colliding doubles as equality (%j)', units => {
  const bound = 0.497851811249937;
  const pair = noticeComparison('mass', bound + Number.EPSILON / 4, bound, units);
  expect(pair[0]).toBe(pair[1]);
  expect(pair.join(' ')).not.toMatch(/just (above|below)/);
  const result = reconcileIncludedMotor(marked(0.2, bound), 'mount', { ...motor, launchMassKg: bound + Number.EPSILON / 4 }, statedWeightTextFor(units))!;
  expect(result.note).not.toMatch(/just (above|below)/);
});

it('R9 honors radians and caps every displayed quantity at six significant digits', () => {
  expect(noticeQuantity('angle', Math.PI / 6, { ...INITIAL_UNITS, angle: 'rad' })).toBe('0.524 rad (30°)');
  for (const kind of ['mass', 'length', 'area', 'surfaceDensity', 'angle'] as const) {
    const text = noticeComparison(kind, 1234567.123456789, 1234567, INITIAL_UNITS, { digits: 15 }).join(' ');
    for (const match of text.matchAll(/[-+]?\d[\d.,]*(?:e[+-]?\d+)?/g)) {
      expect(match[0].split('e')[0]!.replace(/[^0-9]/g, '').replace(/^0+/, '').replace(/0+$/, '').length, text).toBeLessThanOrEqual(6);
    }
  }
});

const selections = [INITIAL_UNITS, IMPERIAL_UNITS, { ...INITIAL_UNITS, length: 'm', pressure: 'atm' }];

it.each(selections)('treats differences beyond fifteen decimal places as arithmetic residue (%j)', units => {
  const pair = noticeComparison('surfaceDensity', 0.4000000000000001, 0.4, units);
  expect(pair[0]).toBe(pair[1]);
});
function pairs(text: string, unit: string, other: string) {
  const number = '([-+0-9.,e]+)';
  const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(number + ' ' + escape(unit) + ' [([]' + number + ' ' + escape(other) + '[)\\]]', 'g'))]
    .map(m => [Number(m[1]!.replaceAll(',', '')), Number(m[2]!.replaceAll(',', ''))]);
}
function ordered(text: string, unit: string, other: string, first: number, second: number, sign: number) {
  const p = pairs(text, unit, other);
  expect(p.length, text).toBeGreaterThan(Math.max(first, second));
  for (const i of [0, 1]) expect((p[first]![i]! - p[second]![i]!) * sign, text).toBeGreaterThan(0);
}
const lengthUnits = (u: UnitSelection) => [u.length, u.length === 'in' ? 'mm' : 'in'] as const;
function marked(cg: number, mass = 2): RocketTree {
  return { components: [{ type: 'stage', id: 'stage', overrideMass: mass,
    overrideSubcomponentsMass: true, overrideCGX: cg, overrideSubcomponentsCG: true,
    [OVERRIDE_INCLUDES_MOTOR]: 'Test', children: [{ type: 'bodytube', id: 'mount', length: 0.508,
      outerRadius: 0.04, thickness: 0.002 }] }] };
}
const motor = { designation: 'Test', launchMassKg: 1, lengthM: 0.2, cgXFromFrontM: 0.1 };

it('keeps nonfinite CG evidence invalid and normalizes endpoint residue without a motor', () => {
  for (const cg of [Infinity, -Infinity, NaN]) expect(boundedStageCg(cg, 0.508)).toBe(cg);
  const stage = marked(0).components[0]!;
  expect(stageCgWithoutMotor(stage, undefined, null, 1, -Number.EPSILON)).toBe(0);
});

// Restoring independent formatters makes the two numbers equal in a selected
// system. These assertions inspect both displayed numbers, not formatter calls.
it.each(selections)('C15 keeps the rejected backed-out CG beyond the displayed stage end (%j)', units => {
  const at = reconcileIncludedMotor(marked((0.508 + 0.408) / 2), 'mount', motor, statedWeightTextFor(units))!;
  expect(at.tree.components[0]!['overrideCGX']).toBeCloseTo(0.508, 12);
  const past = reconcileIncludedMotor(marked((0.5080004 + 0.408) / 2), 'mount', motor, statedWeightTextFor(units))!;
  expect(past.tree.components[0]!['overrideCGX']).toBeUndefined();
  const text = past.note!.split('stage’s own CG ')[1]!;
  expect(text).toContain('just beyond');
  expect(pairs(text, ...lengthUnits(units))).toHaveLength(1);
});

it.each(selections)('C15 treats subtraction residue at the front as the valid zero CG (%j)', units => {
  const result = reconcileIncludedMotor(marked(0.204 - Number.EPSILON), 'mount', motor, statedWeightTextFor(units))!;
  expect(result.tree.components[0]!['overrideCGX']).toBe(0);
  expect(result.note).not.toContain('outside');
});

it.each(selections)('C14 distinguishes almost equal stated and motor masses (%j)', units => {
  const result = reconcileIncludedMotor(marked(0.2, 1), 'mount', { ...motor, launchMassKg: 1.0000004 }, statedWeightTextFor(units))!;
  expect(result.note).toContain('weighs slightly more than that on its own');
  expect(pairs(result.note!, units.mass, units.mass === 'g' ? 'lb' : 'kg')).toHaveLength(1);
});

it.each(selections)('C13 preserves an imported CG just beyond a stage end (%j)', units => {
  const xml = (cg: number) => '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign>'
    + '<SimulationList><Simulation><SustainerLaunchWt>2</SustainerLaunchWt><SustainerCG>' + cg * 39.37 + '</SustainerCG></Simulation></SimulationList></RASAeroDocument>';
  const at = importCdx1(xml(20 / 39.37), { units });
  expect(at.notes.join(' ')).not.toContain('outside the stage');
  const past = importCdx1(xml(20 / 39.37 + 4e-7), { units });
  const text = past.notes.join(' ').split('works out to ')[1]!;
  expect(text).toContain('just beyond');
  expect(pairs(text, ...lengthUnits(units))).toHaveLength(1);
});

for (const [type, table, field, name] of [
  ['bodytube', BULK_MATERIALS, 'density', 'materialName'],
  ['parachute', SURFACE_MATERIALS, 'surfaceDensity', 'surfaceMaterialName'],
  ['shockcord', LINE_MATERIALS, 'lineDensity', 'lineMaterialName'],
] as const) {
  it.each(selections)('C04 ' + field + ' ignores ULP residue but reports a real exceedance (%j)', units => {
    const material = table.find(m => m.name === 'Mylar') ?? table[0]!;
    const max = Math.max(...table.filter(m => m.group === material.group).map(m => m.density)) * DENSITY_RANGE_FACTOR;
    const check = (density: number) => preflightAudit({ components: [{ type, id: 'part', [field]: density, [name]: material.name }] }, {}, [], units)
      .findings.filter(f => f.kind === 'material-density');
    expect(check(max)).toHaveLength(0);
    expect(check(max + Math.abs(max) * Number.EPSILON)).toHaveLength(0);
    expect(check(max * (1 + 1e-8))).toHaveLength(1);
  });
}

it.each(selections)('C16 orders refused weather cells against both range endpoints (%j)', units => {
  for (const [key, value, bound, sign] of [
    ['pressureHPa', 299.9, 300, -1], ['pressureHPa', 1100.1, 1100, 1],
    ['temperatureC', 60.02, 60, 1], ['temperatureC', -60.02, -60, -1],
  ] as const) {
    const text = fieldNoticeText(key, value, units, 'auto', false, bound) + '; '
      + fieldNoticeText(key, bound, units);
    const primary = key === 'pressureHPa' ? units.pressure : units.temperature;
    const secondary = key === 'pressureHPa' ? (['inHg', 'psi'].includes(primary) ? 'mbar' : 'inHg')
      : primary === '°F' ? '°C' : '°F';
    if (text.startsWith('just ')) {
      expect(text).toContain(sign < 0 ? 'just below' : 'just above');
      expect(pairs(text.split('; ')[0]!, primary, secondary)).toHaveLength(1);
    } else ordered(text, primary, secondary, 0, 1, sign);
  }
});

it.each(selections)('C21 keeps the arming endpoint paired with the reported altitude (%j)', units => {
  const flight = (height: number) => ({ summary: { maxAltitude: height, maxMachNumber: 0 },
    series: { time: [0], altitude: [height] }, events: [{ type: 'APOGEE', time: 0 }] }) as unknown as FlightResult;
  expect(flightLimitAdvice(flight(0.3556), { armingAltitudeM: 0.3556 }, 'Test', undefined, units)).toHaveLength(1);
  const text = flightLimitAdvice(flight(0.355595), { armingAltitudeM: 0.3556 }, 'Test', undefined, units)[0]!.text;
  if (!text.includes('just below')) {
    const primary = units.altitude, secondary = primary === 'ft' ? 'm' : 'ft';
    ordered(text, primary, secondary, 0, 1, -1);
  }
});

it.each(['km/h', 'mph', 'kt'])('C36 retains the defining 15 m/s rail rule in %s', velocity => {
  const text = railNeededLine({ segments: [[0, 20, 0, 1]], railM: 2, offsetM: 0, allowance: false, thrustEnded: false },
    15, 'm', velocity, undefined, { value: 15, symbol: 'm/s' });
  expect(text).toContain('15 m/s');
});


it('treats adjacent doubles collapsed by conversion as residue', () => {
  const limit = 0.497851811249937;
  const [actual] = noticeComparison('mass', limit + Number.EPSILON / 4, limit, INITIAL_UNITS);
  expect(actual).toBe(noticeComparison('mass', limit, limit, INITIAL_UNITS)[0]);
});
it('treats a tiny near-zero difference as equality when grouping', () => {
  expect(noticeComparison('altitude', -1e-25, 0, INITIAL_UNITS, { grouped: true })[0]).toBe('0 m (0 ft)');
});


it.each([INITIAL_UNITS, IMPERIAL_UNITS])('uses one counterpart unit across a mass comparison boundary (%j)', units => {
  const [actual, limit] = noticeComparison('mass', units.mass === 'g' ? 0.45359236 : 0.99999999, units.mass === 'g' ? 0.45359237 : 1, units);
  const counterpart = units.mass === 'g' ? 'lb' : 'kg';
  expect(actual).toContain(counterpart);
  expect(limit).toContain(counterpart);
});


it('ignores only arithmetic residue at imported angle and time-step endpoints', () => {
  const xml = (condition: string) => '<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.05</radius></bodytube></subcomponents></stage></subcomponents></rocket>'
    + '<simulations><simulation><conditions>' + condition + '</conditions></simulation></simulations></openrocket>';
  const angle = importOrk(xml('<launchrodangle>' + (30 + Number.EPSILON * 30) + '</launchrodangle>'));
  expect(angle.launch?.launchRodAngleDeg).toBe(30);
  expect(angle.notes.join(' ')).not.toContain('Rod angle field');
  const step = importOrk(xml('<timestep>' + (0.05 - Number.EPSILON * 0.05) + '</timestep>'));
  expect(step.launch?.timeStepS).toBe(0.05);
  expect(step.notes.join(' ')).not.toContain('It is being flown');
});

it('R9 treats motor-subtraction residue on either side as the same zero airframe mass', () => {
  for (const residual of [-Number.EPSILON / 4, Number.EPSILON / 4]) {
    const result = reconcileIncludedMotor(marked(0.2, 0.497851811249937 + residual), 'mount',
      { ...motor, launchMassKg: 0.497851811249937 }, statedWeightTextFor(INITIAL_UNITS))!;
    expect(result.tree.components[0]!['overrideMass']).toBeUndefined();
    expect(result.note).toContain('weighs as much as that on its own');
    expect(result.note).not.toContain('just ');
  }
});

it('R9 normalizes coordinate endpoint residue before returning accepted coordinates',()=>{
  for(const sign of [-1,1]) {
    const value=String(sign*(90+Number.EPSILON*90))+' '+String(sign*(180+Number.EPSILON*180));
    expect(parseCoordinates(value)).toEqual({ok:true,latitudeDeg:sign*90,longitudeDeg:sign*180});
  }
});

it.each([-1,1])('R9 atmospheric endpoints accept serialization residue (%s)', sign=>{
  const temperature=sign<0?-60:60, pressure=sign<0?300:1100;
  const kelvin=(temperature+273.15)*(1+sign*2*Number.EPSILON);
  const pa=pressure*100*(1+sign*2*Number.EPSILON);
  const xml='<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents><bodytube><length>1</length><radius>0.05</radius></bodytube></subcomponents></stage></subcomponents></rocket>'
    +'<simulations><simulation><conditions><atmosphere model="extendedisa"><basetemperature>'+kelvin+'</basetemperature><basepressure>'+pa+'</basepressure></atmosphere></conditions></simulation></simulations></openrocket>';
  const cdx='<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign><LaunchSite>'
    +'<Temperature>'+((kelvin-273.15)*1.8+32)+'</Temperature><Pressure>'+(pa/100/33.8639)+'</Pressure></LaunchSite></RASAeroDocument>';
  for(const result of [importOrk(xml),importCdx1(cdx)]) {
    expect(result.launch?.temperatureC).toBeCloseTo(temperature,12);
    expect(result.launch?.pressureHPa).toBeCloseTo(pressure,10);
    expect(result.notes.join(' ')).not.toContain('is not a launch site');
  }
});
