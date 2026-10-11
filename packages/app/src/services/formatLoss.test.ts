// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './launchConditions.js';
import { checkFormatLoss, type FormatLossInput, type LossyFormat } from './formatLoss.js';
import { exportRkt } from './rocksimFile.js';
import { exportCdx1 } from './rasaeroFile.js';

describe('lossy fix regressions', () => {
  const staged = () => {
    const d = input();
    d.tree.components.push({ type: 'stage', id: 'lower', name: 'Booster', children: [
      { type: 'bodytube', id: 'lowerTube', length: 0.2, outerRadius: 0.03 },
    ] });
    d.motors = { b: { designation: 'G80', manufacturer: 'AeroTech', diameter: 0.029, length: 0.1, delay: 5 },
      lowerTube: { designation: 'G80', manufacturer: 'AeroTech', diameter: 0.029, length: 0.1, delay: 5 } };
    return d;
  };
  it.each([undefined, 'automatic'] as const)('V1 warns about %s upper ignition and plugged lower motors', event => {
    const d = staged(); d.motors.b!.ignitionEvent = event;
    expect(checkFormatLoss('cdx1', d).losses.join('\n')).toContain('Motor “G80” lights on the burnout of the stage below in the .CDX1, not on its ejection charge');
    d.motors.lowerTube!.delay = Infinity;
    expect(checkFormatLoss('cdx1', d).losses.join('\n')).toContain('would not light in the app at all');
    d.motors.b!.ignitionEvent = 'burnout';
    expect(line('cdx1', d, 'not on its ejection charge')).toBe(false);
    d.motors.b!.ignitionEvent = event; delete d.motors.lowerTube;
    expect(line('cdx1', d, 'reopens at launch because there is no exported lower engine')).toBe(true);
    expect(line('cdx1', d, 'not on its ejection charge')).toBe(false);
  });
  it('V2 names omitted shoulder fins and the conical shoulder conversion', () => {
    const d = input();
    const shoulder: ComponentNode = { type: 'transition', name: 'Shoulder', shape: 'ogive', length: 0.03,
      foreRadius: 0.03, aftRadius: 0.035, children: [{ type: 'trapezoidfinset', name: 'Shoulder fins' }] };
    d.tree.components[0]!.children![0]!.children = [{ type: 'podset', instanceCount: 1, radiusMethod: 'free', radiusOffset: 0,
      children: [shoulder, { type: 'bodytube', length: 0.1, outerRadius: 0.035 }] }];
    const report = checkFormatLoss('cdx1', d);
    expect(report.refused).toBeNull();
    expect(report.losses.join('\n')).toContain('fins on “Shoulder”: not in the file');
    expect(report.losses.join('\n')).toContain('“Shoulder”\'s ogive shape is written as conical');
    shoulder.shape = 'conical'; shoulder.children = [];
    expect(line('cdx1', d, 'fins on “Shoulder”')).toBe(false);
    expect(line('cdx1', d, 'shape is written as conical')).toBe(false);
  });
  it('V3 reports implicit ejection chute deployment becoming apogee', () => {
    const d = input({ type: 'parachute', name: 'Default chute' });
    expect(line('cdx1', d, '“Default chute”: ejection deployment becomes apogee')).toBe(true);
    d.tree.components[0]!.children![0]!.children![0]!.deployEvent = 'apogee';
    expect(line('cdx1', d, 'ejection deployment becomes apogee')).toBe(false);
  });
  it('V3/V6 reports default booster separation, lost delay and motorless ejection', () => {
    const d = staged(); const stage = d.tree.components[1]!;
    expect(line('cdx1', d, '“Booster”: ejection separation becomes burnout with 0 s delay')).toBe(true);
    stage.separationDelay = 2;
    expect(line('cdx1', d, '2 s delay is not kept')).toBe(true);
    stage.separationEvent = 'burnout';
    expect(line('cdx1', d, 'Separation')).toBe(false);
    d.motors = {}; stage.separationEvent = 'launch';
    expect(line('cdx1', d, 'reopens on ejection with 0 s delay because this stage has no exported engine')).toBe(true);
  });
  it('V4 compares implicit normal external finishes', () => {
    const d = input(); d.tree.components[0]!.children!.unshift({ type: 'nosecone', finish: 'mirror' });
    expect(line('cdx1', d, 'Surface finish')).toBe(true);
    d.tree.components[0]!.children![0]!.finish = 'normal';
    expect(line('cdx1', d, 'Surface finish')).toBe(false);
  });
  // The writers now write what a blank part flies (review of v0.174, B1;
  // rocksimFile.test.ts and rasaeroFile.test.ts round-trip every part type),
  // so the Save names no writer fallback for one any more.
  it.each(['tubecoupler', 'engineblock', 'trapezoidfinset', 'podset', 'parallelstage', 'bodytube', 'tubefinset',
    'transition', 'freeformfinset', 'masscomponent', 'parachute', 'streamer', 'shockcord', 'centeringring'] as const)(
    'V5 has no writer-fallback line for a blank %s', (type) => {
      const d = input({ type, name: 'Blank part' });
      if (type === 'transition') d.tree.components[0]!.children!.push({ type: 'transition', name: 'Blank part' });
      expect(checkFormatLoss('rkt', d).losses.filter(l => / is written as |one instance is written/.test(l))).toEqual([]);
    });
  it('cdx1 has no line for a blank trapezoid sweep', () => {
    const d = input({ type: 'trapezoidfinset', name: 'Blank fins' });
    expect(line('cdx1', d, 'sweep')).toBe(false);
  });
  it('V6 only calls a doublewedge trailing edge derived', () => {
    const n: ComponentNode = { type: 'trapezoidfinset', airfoilSection: 'biconvex', airfoilTeDiamond: 0.01 };
    const d = input(n);
    expect(checkFormatLoss('cdx1', d).losses.join('\n')).not.toContain('trailing edges are derived');
    expect(line('cdx1', d, 'trailing edge is not kept')).toBe(true);
    n.airfoilSection = 'doublewedge';
    expect(line('cdx1', d, 'trailing edge is derived by the reader')).toBe(true);
  });
  it.each(['rkt', 'cdx1'] as const)('%s suppresses recreated stage names and unambiguous motor identity', format => {
    const d = staged(); d.tree.components[0]!.name = 'Sustainer';
    d.motors = { b: { designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: 5, type: 'single' } };
    expect(line(format, d, 'stage names')).toBe(false);
    expect(line(format, d, 'Motor identity')).toBe(false);
    d.tree.components[0]!.name = 'Custom stage';
    expect(line(format, d, 'stage names')).toBe(true);
    d.motors.b!.designation = 'Unknown999';
    expect(line(format, d, 'Motor identity')).toBe(true);
    d.motors.b!.designation = 'H160'; d.motors.b!.manufacturer = 'Cesaroni';
    expect(line(format, d, 'Motor identity')).toBe(true);
    d.motors.b!.exMotorId = 'ex:test';
    expect(line(format, d, 'Motor identity')).toBe(false);
    expect(line(format, d, 'EX motor')).toBe(true);
  });
  it('does not flag the CDX1 reader’s generic component and recovery names', () => {
    const d = input();
    d.tree.components[0]!.name = 'Sustainer';
    const body = d.tree.components[0]!.children![0]!; body.name = 'Body tube';
    body.children = [{ type: 'trapezoidfinset', name: 'Fins' },
      { type: 'parachute', name: 'Main', deployEvent: 'altitude' },
      { type: 'parachute', name: 'Drogue', deployEvent: 'apogee' }];
    expect(line('cdx1', d, 'Component and stage names')).toBe(false);
    body.children[1]!.name = 'Custom main';
    expect(line('cdx1', d, 'Component and stage names')).toBe(true);
  });
});

const input = (node?: ComponentNode): FormatLossInput => ({
  tree: { name: 'Test', components: [{ type: 'stage', id: 's', children: [
    { type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.03, children: node ? [node] : [] },
  ] }] }, launch: { ...DEFAULT_CONDITIONS }, motors: {}, configs: [], activeConfigId: null,
  measured: { massKg: null, cgM: null }, flightData: {},
});
const line = (format: LossyFormat, data: FormatLossInput, text: string) =>
  checkFormatLoss(format, data).losses.some(l => l.includes(text));

// Every row removes just the data named by its detector for the negative case.
const cases: [LossyFormat, string, ComponentNode, ComponentNode][] = [
  ['rkt', 'Rail buttons', { type: 'railbutton' }, { type: 'bodytube' }],
  ['rkt', 'Protuberances', { type: 'protuberance' } as unknown as ComponentNode, { type: 'bodytube' }],
  ['rkt', 'Camera shrouds', { type: 'fairing' }, { type: 'bodytube' }],
  ['rkt', 'shoulder walls', { type: 'nosecone', shoulderThickness: 0.001 }, { type: 'nosecone' }],
  ['rkt', 'Ogive shape', { type: 'nosecone', shape: 'ogive', shapeParameter: 0.5 }, { type: 'nosecone' }],
  ['rkt', 'clipping', { type: 'transition', clipped: true }, { type: 'transition' }],
  ['rkt', 'Supersonic fin', { type: 'trapezoidfinset', airfoilSection: 'hexagonal' }, { type: 'trapezoidfinset', crossSection: 'rounded' }],
  ['rkt', 'Fillet material group', { type: 'trapezoidfinset', filletMaterialGroup: 'Custom' }, { type: 'trapezoidfinset' }],
  ['rkt', 'case-as-airframe', { type: 'bodytube', caseAirframe: true }, { type: 'bodytube' }],
  ['rkt', 'Multiple ring', { type: 'centeringring', instanceCount: 2 }, { type: 'centeringring', instanceCount: 1 }],
  ['rkt', 'Ring radial', { type: 'bulkhead', radialPosition: 0.01 }, { type: 'bulkhead', radialPosition: 0 }],
  ['rkt', 'Multiple launch', { type: 'launchlug', instanceCount: 2 }, { type: 'launchlug', instanceCount: 1 }],
  ['rkt', 'Packed recovery', { type: 'parachute', packedLength: 0.1 }, { type: 'parachute' }],
  ['rkt', 'Mass-object size', { type: 'masscomponent', radius: 0.01 }, { type: 'masscomponent' }],
  ['rkt', 'Zero-density parachute', { type: 'parachute', lineDensity: 0 }, { type: 'parachute', lineDensity: 0.002 }],
  ['rkt', 'reopens on Auto', { type: 'streamer', cd: 0.75 }, { type: 'streamer', cd: 0.8 }],
  ['rkt', 'Automatic recovery Cd', { type: 'streamer' }, { type: 'streamer', cd: 0.3 }],
  ['rkt', 'Automatic recovery Cd', { type: 'parachute' }, { type: 'parachute', cd: 1.2 }],
  ['rkt', 'Shock-cord CG', { type: 'shockcord', overrideCGX: 0.1 }, { type: 'shockcord' }],
  ['rkt', 'Surface finish', { type: 'bodytube', finish: 'mirror' }, { type: 'bodytube', finish: 'normal' }],
  ['rkt', 'Dormant maximum', { type: 'innertube', maxMotorLength: 0 }, { type: 'innertube' }],
  ['rkt', 'Drag overrides', { type: 'bodytube', overrideCD: 0 }, { type: 'bodytube' }],
  ['rkt', 'Separation settings', { type: 'parallelstage', separationDelay: 1 }, { type: 'podset' }],
  ['cdx1', 'Inner parts', { type: 'innertube' }, { type: 'bodytube' }],
  ['cdx1', 'Rail buttons', { type: 'railbutton' }, { type: 'bodytube' }],
  ['cdx1', 'Launch lugs', { type: 'launchlug' }, { type: 'bodytube' }],
  ['cdx1', 'Protuberances', { type: 'protuberance' } as unknown as ComponentNode, { type: 'bodytube' }],
  ['cdx1', 'Streamers', { type: 'streamer' }, { type: 'bodytube' }],
  ['cdx1', 'Parachute construction', { type: 'parachute', deployEvent: 'apogee' }, { type: 'bodytube' }],
  ['cdx1', 'Unsupported parachute', { type: 'parachute', deployEvent: 'ejection' }, { type: 'parachute', deployEvent: 'apogee' }],
  ['cdx1', 'Fin cant', { type: 'trapezoidfinset', cant: 0.1 }, { type: 'trapezoidfinset', crossSection: 'airfoil' }],
  ['cdx1', 'Fin tabs', { type: 'trapezoidfinset', tabHeight: 0.01, tabLength: 0.03 }, { type: 'trapezoidfinset' }],
  ['cdx1', 'Absolute fin', { type: 'trapezoidfinset', position: { method: 'absolute', offset: 0.2 } }, { type: 'trapezoidfinset' }],
  ['cdx1', 'Fin section detail', { type: 'trapezoidfinset', finLeRadius: 0.001 }, { type: 'trapezoidfinset', crossSection: 'rounded' }],
  ['cdx1', 'Materials and walls', { type: 'bodytube', thickness: 0.001 }, { type: 'bodytube' }],
  ['cdx1', 'Component and stage names', { type: 'bodytube', name: 'My tube' }, { type: 'bodytube' }],
  ['cdx1', 'Nose and transition shoulders', { type: 'nosecone', shoulderLength: 0.01 }, { type: 'nosecone' }],
  ['cdx1', 'Motor mounts', { type: 'bodytube', motorMount: true }, { type: 'bodytube' }],
  ['cdx1', 'Individual mass', { type: 'bodytube', overrideMass: 0 }, { type: 'bodytube' }],
  ['cdx1', 'Surface finish', { type: 'bodytube', finish: 'polished' }, { type: 'bodytube' }],
  ['rkt', 'Stage mass includes-motor', { type: 'parallelstage', overrideIncludesMotor: 'M1297' }, { type: 'parallelstage' }],
  ['cdx1', 'Nose shape parameter', { type: 'nosecone', shape: 'ogive', shapeParameter: 0.5 }, { type: 'nosecone' }],
  ['cdx1', 'Freeform fins', { type: 'freeformfinset', points: [[0, 0], [0.02, 0.03], [0.04, 0.03], [0.05, 0]] }, { type: 'trapezoidfinset' }],
];
describe('design-specific format losses', () => {
  it.each(cases)('%s: %s only when present', (format, text, present, absent) => {
    expect(line(format, input(present), text)).toBe(true);
    expect(line(format, input(absent), text)).toBe(false);
  });
  it.each(['rkt', 'cdx1'] as const)('%s reports real exporter refusal', format => {
    const d = input(); d.tree.components = Array.from({ length: 4 }, () => ({ type: 'stage' as const }));
    expect(checkFormatLoss(format, d).refused).toMatch(/at most 3 stages/);
  });
  it('does not warn on default launch settings or appearance', () => {
    const d = input({ type: 'bodytube', color: '#ff0000', density: 680, thickness: 0.0005 });
    d.tree.components[0]!.children![0]!.density = 680;
    d.tree.components[0]!.children![0]!.thickness = 0.0005;
    expect(checkFormatLoss('rkt', d).losses).toEqual([]);
    expect(line('cdx1', input(), 'Launch settings')).toBe(false);
  });
  it.each(['rkt', 'cdx1'] as const)('%s names nondefault lost launch fields', format => {
    const d = input(); d.launch.latitudeDeg += 1;
    expect(line(format, d, 'Latitude')).toBe(true);
    expect(line(format, input(), 'Latitude')).toBe(false);
  });
  it.each([
    ['launchRodLengthM', 2, 'Rod length', false], ['launchRodAngleDeg', 5, 'Rod angle', false],
    // Rod aim acts only on a tilted rod: formatLoss.safety.test.ts.
    ['launchGuideAllowance', false, 'Allow for lug', true],
    ['windAverage', 5, 'Wind avg', false], ['windStdDev', 1, 'Wind gusts', true],
    ['launchAltitudeM', 100, 'Site altitude', false], ['temperatureC', 25, 'Temperature', false],
    ['pressureHPa', 900, 'Station pressure', false], ['latitudeDeg', 45, 'Latitude', true],
    ['longitudeDeg', 20, 'Longitude', true], ['geodeticMethod', 'flat', 'Geodetic calculations', true],
    ['timeStepS', 0.01, 'Time step', true],
  ] as const)('checks the actual default for %s', (key, value, label, cdxLoss) => {
    const d = input(); d.launch = { ...d.launch, [key]: value } as LaunchConditions;
    expect(line('rkt', d, label)).toBe(true);
    expect(line('cdx1', d, label)).toBe(cdxLoss);
    expect(line('rkt', input(), label)).toBe(false);
  });
  it.each(['rkt', 'cdx1'] as const)('%s detects measurements, motors and summaries', format => {
    const d = input(); d.measured.cgM = 0.2;
    d.motors.b = { designation: 'EX Test', exMotorId: 'ex:1', diameter: 0.02, length: 0.1, delay: 5, padMassKg: 1 };
    d.flightData = { run: {} } as FormatLossInput['flightData'];
    for (const text of ['Measured mass', 'EX motor “EX Test”', 'Weighed pad mass', 'Flight summaries']) {
      expect(line(format, d, text)).toBe(true);
      expect(line(format, input(), text)).toBe(false);
    }
  });
  it.each(['rkt', 'cdx1'] as const)('%s writes only the active flight configuration and names it', format => {
    const d = input();
    d.configs = [{ id: 'a', name: 'Club flight', motors: {}, isDefault: true }]; d.activeConfigId = 'a';
    expect(line(format, d, 'Flight configurations:')).toBe(false);
    d.configs.push({ id: 'b', name: 'Other', motors: {}, isDefault: false, nozzles: { s: 0 } });
    expect(line(format, d, 'only “Club flight” is written')).toBe(true);
    expect(line(format, d, 'Which stages each flight configuration switches off')).toBe(false);
    d.configs[0]!.stageActiveness = { s: false };
    expect(line(format, d, 'Which stages each flight configuration switches off')).toBe(true);
  });
  it('reports stage names and ineffective overrides only when stored', () => {
    const d = input(); const stage = d.tree.components[0]!;
    for (const text of ['Axial stage names', 'Stage mass/CG']) expect(line('rkt', d, text)).toBe(false);
    stage.name = 'Booster'; stage.overrideCGX = 0.1;
    for (const text of ['Axial stage names', 'Stage mass/CG']) expect(line('rkt', d, text)).toBe(true);
  });
  it('reports extra parachutes only beyond the first two, and names the omitted chute', () => {
    const d = input(); const body = d.tree.components[0]!.children![0]!;
    body.children = [{ type: 'parachute', deployEvent: 'apogee' }, { type: 'parachute', deployEvent: 'altitude' }];
    expect(line('cdx1', d, 'Additional parachutes')).toBe(false);
    body.children.push({ type: 'parachute', name: 'Backup', deployEvent: 'apogee', deployDelay: 2 });
    expect(line('cdx1', d, 'Additional parachutes are omitted, including their delays: “Backup”')).toBe(true);
  });
  it('covers booster geometry, nozzle and separation loss without inventing an engine', () => {
    const d = input();
    const stage: ComponentNode = { type: 'stage', id: 'boost', children: [{ type: 'bodytube', id: 'boostTube' }] };
    d.tree.components.push(stage);
    for (const text of ['Booster geometry', 'Booster nozzle', 'Separation ']) expect(line('cdx1', d, text)).toBe(false);
    stage.children!.push({ type: 'nosecone' }); stage.nozzleExitDiameter = 0.02; stage.separationEvent = 'ejection';
    for (const text of ['Booster geometry', 'Booster nozzle']) expect(line('cdx1', d, text)).toBe(true);
    expect(line('cdx1', d, 'Separation ')).toBe(false); // motorless ejection still reopens on ejection
    d.motors.boostTube = { designation: 'G80', manufacturer: 'AeroTech', diameter: 0.029, length: 0.1, delay: 5 };
    expect(line('cdx1', d, 'Booster nozzle')).toBe(false);
    expect(line('cdx1', d, 'Separation ')).toBe(true);
  });
  it('covers manufacturer, ejection and ignition losses, including bottom-stage delay', () => {
    const d = input();
    d.motors.b = { designation: 'EX-1', manufacturer: 'Unknown', diameter: 0.02, length: 0.1, delay: 5, ignitionEvent: 'never', ignitionDelay: 1 };
    for (const text of ['manufacturer has no supported', 'selected ejection delay', 'ignition trigger/timing']) {
      expect(line('cdx1', d, text)).toBe(true); expect(line('cdx1', input(), text)).toBe(false);
    }
    d.motors.b.manufacturer = 'AeroTech'; d.motors.b.ignitionEvent = 'burnout';
    expect(line('cdx1', d, 'manufacturer has no supported')).toBe(false);
    expect(line('cdx1', d, 'ignition trigger/timing')).toBe(false);
    d.tree.components.unshift({ type: 'stage', children: [{ type: 'bodytube' }] }, { type: 'stage', children: [{ type: 'bodytube' }] });
    expect(line('cdx1', d, 'Bottom-stage ignition delay')).toBe(true);
    d.motors.b.ignitionDelay = 0;
    expect(line('cdx1', d, 'Bottom-stage ignition delay')).toBe(false);
  });
  it.each(['rkt', 'cdx1'] as const)('%s retains all existing writer and save-path notes', format => {
    const d = input({ type: 'trapezoidfinset', filletRadius: 0.001 });
    d.tree.components[0]!.nozzleExitDiameter = 0;
    d.tree.components[0]!.children![0]!.motorMount = true;
    d.tree.components[0]!.children![0]!.maxMotorLength = 0.2;
    d.launch.windLevels = [{ altitude: 100, speed: 2, direction: 0 }];
    d.launch.launchRodAimDeg = 20; d.launch.launchRodAngleDeg = 5;
    const existing: string[] = [];
    if (format === 'rkt') exportRkt({ name: 'Test', tree: d.tree, notes: existing, compInfo: {} });
    else exportCdx1({ name: 'Test', tree: d.tree, notes: existing, launch: d.launch });
    const report = checkFormatLoss(format, d);
    for (const text of existing) expect(report.losses).toContain(text);
    for (const text of ['Winds aloft', 'Maximum motor length', 'explicit nozzle OFF']) expect(report.losses.join('\n')).toContain(text);
    if (format === 'cdx1') expect(report.losses.join('\n')).toContain('Rod aim (20°)');
  });
  it('names a delayed supported chute through the existing note and stays silent for zero delay', () => {
    const d = input({ type: 'parachute', deployEvent: 'apogee', deployDelay: 2 });
    expect(line('cdx1', d, 'cannot store deployment delays')).toBe(true);
    expect(line('cdx1', input({ type: 'parachute', deployEvent: 'apogee' }), 'cannot store deployment delays')).toBe(false);
  });
  it('keeps rounded and airfoil freeform fins writable in RockSim, and plain fin thickness in CDX1', () => {
    for (const crossSection of ['rounded', 'airfoil']) {
      const d = input({ type: 'freeformfinset', crossSection, thickness: 0.003,
        points: [[0, 0], [0.01, 0.03], [0.04, 0.03], [0.05, 0]] });
      expect(checkFormatLoss('rkt', d).refused).toBeNull();
      expect(checkFormatLoss('cdx1', d).refused).toBeNull();
      expect(line('cdx1', d, 'Materials and walls')).toBe(false);
    }
  });
  it('does not call an exactly carried CDX1 finish or double-wedge trailing edge a loss', () => {
    const polished = input({ type: 'bodytube', finish: 'finishpolished' });
    polished.tree.components[0]!.children![0]!.finish = 'finishpolished';
    expect(line('cdx1', polished, 'Surface finish')).toBe(false);
    const fin: ComponentNode = { type: 'trapezoidfinset', rootChord: 0.1, tipChord: 0.06,
      airfoilSection: 'doublewedge', crossSection: 'airfoil', airfoilLeDiamond: 0.03, airfoilTeDiamond: 0.05 };
    expect(line('cdx1', input(fin), 'Fin section detail')).toBe(false);
    fin.airfoilTeDiamond = 0.01;
    expect(line('cdx1', input(fin), 'Fin section detail')).toBe(true);
  });
  it('detects multiline names and exterior geometry outside the CDX1 written chain', () => {
    const d = input();
    expect(line('cdx1', d, 'Rocket name')).toBe(false);
    expect(line('cdx1', d, 'Exterior parts')).toBe(false);
    d.tree.name = 'First line\nSecond line';
    d.tree.components[0]!.children![0]!.children = [{ type: 'nosecone', name: 'Nested nose',
      children: [{ type: 'trapezoidfinset' }] }];
    expect(line('cdx1', d, 'Rocket name')).toBe(true);
    expect(line('cdx1', d, 'Exterior parts')).toBe(true);
  });
  it('keeps exact tangent-ogive and Haack parameters quiet in CDX1', () => {
    for (const [shape, shapeParameter] of [['ogive', 1], ['haack', 0], ['haack', 0.33]] as const) {
      expect(line('cdx1', input({ type: 'nosecone', shape, shapeParameter }), 'Nose shape parameter')).toBe(false);
    }
    expect(line('cdx1', input({ type: 'nosecone', shape: 'haack', shapeParameter: 0.2 }), 'Nose shape parameter')).toBe(true);
  });
  it('keeps stage loss notes independent of computed mass, including the CG-only gap', () => {
    const d = input(); const s = d.tree.components[0]!;
    s.overrideCGX = 0.2; s.overrideSubcomponentsCG = true;
    const dry: string[] = [], computed: string[] = [];
    exportRkt({ name: 'Test', tree: d.tree, notes: dry, compInfo: {} });
    exportRkt({ name: 'Test', tree: d.tree, notes: computed, compInfo: {
      s: { mass: 0, cgX: 0.2, positionX: 0 }, b: { mass: 1, cgX: 0.25, positionX: 0 },
    } });
    expect(dry).toEqual(computed);
    expect(dry.join(' ')).toContain('Stage mass/CG overrides');
    for (const note of computed) expect(checkFormatLoss('rkt', d).losses).toContain(note);
  });
  it.each(['rkt', 'cdx1'] as const)('%s leaves every input unchanged', format => {
    const d = input({ type: 'trapezoidfinset', filletRadius: 0.001 });
    const before = structuredClone(d); checkFormatLoss(format, d); expect(d).toEqual(before);
  });
  it.each(['rkt', 'cdx1'] as const)('%s preserves extension notes and the real validation refusal', format => {
    const d = input();
    Object.assign(d.tree, { orkSimulationExtensions: [{ name: null, configId: null, xml: ['<extension extensionid="test"/>'] }] });
    expect(line(format, d, 'Simulation extensions are not carried')).toBe(true);
    expect(line(format, input(), 'Simulation extensions are not carried')).toBe(false);
    Object.assign(d.tree, { orkSimulationExtensions: 'invalid' });
    expect(checkFormatLoss(format, d).refused).toBe('Stored simulation extensions are invalid; the file was not saved.');
  });
  it('uses the real RockSim recovery refusal, and refuses an unsupported CDX1 freeform outline', () => {
    expect(checkFormatLoss('rkt', input({ type: 'parachute', name: 'Main', deployEvent: 'apogee', deployDelay: 1 })).refused)
      .toContain('Recovery device “Main”: .rkt cannot faithfully save apogee deployment with 1 s delay');
    expect(checkFormatLoss('cdx1', input({ type: 'freeformfinset', points: [[0, 0], [0, 0.03], [0.04, 0.01], [0.05, 0]] })).refused)
      .toContain("isn't a simple 3/4-point trapezoid");
  });
});
