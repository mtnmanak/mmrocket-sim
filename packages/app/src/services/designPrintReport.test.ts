// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree, StaticInfo } from '@online-openrocket/engine';
import { designPrintHtml } from './designPrintReport.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import type { SimRun } from './simReport.js';
import { testMotor, testResolution } from './autoDelay.testSupport.js';
import { LATE_BURNOUT_CAUTION, validDelayResolution } from './autoDelaySolver.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import type { MountMotor } from '../model/design.js';
import { importedSummaryRuns } from './orkFlightData.js';

const tree: RocketTree = { name: 'Current <script>rocket</script>', components: [
  { type: 'stage', id: 'stage', children: [{ type: 'bodytube', id: 'tube', name: 'Tube', length: 0.254, outerRadius: 0.0254, materialName: 'Paper' }] },
] };
const info = { length: 0.254, refDiameter: 0.0508, mass: 0.0283495231, massEmpty: 0.02, cg: 0.1,
  cp: 0.18, cpWorst: 0.17, cna: 5, stabilityCalibers: 1.5748, stabilityCalibersWorst: 1.378, } as StaticInfo;
const run = { id: 'selected', rocket: 'Earlier design', motor: 'F40', manufacturer: 'Maker', flightConfig: 'Config B',
  when: 0, aeroModel: 'classic', maxAltitude: 304.8, maxVelocity: 30.48, maxAcceleration: 9.80665,
  timeToApogee: 7, maxMach: 0.2, delayS: 5, landingRate: 3.048, groundHitVelocity: 5,
  burnoutMass: 0.02, burnoutMassSettled: true, windAvg: 0, comments: 'Hard opening', commentLevels: ['warning'],
  deployments: [{ device: 'Main', time: 7, altitude: 304.8, velocityAtDeployment: 12.192,
    descentRate: 3.048, groundSpeed: 5, cd: 0.8, diameter: 0.5 }],
} as SimRun;
const input = { tree, info, units: IMPERIAL_UNITS, radiusMode: 'diameter' as const,
  stabilityUnit: 'both' as const, withMotors: true, appVersion: 'test', run, changedSince: ['the design'], };
function doc(html: string) { return new DOMParser().parseFromString(html, 'text/html').body; }
it.each([
  [INITIAL_UNITS, 'Material density (kg/m³): 680'],
  [{ ...INITIAL_UNITS, density: 'g/cm³' }, 'Material density (g/cm³): 0.68'],
  [IMPERIAL_UNITS, 'Material density (oz/in³): 0.393065'],
])('S7c-2 prints bulk density in the selected units %s', (units, expected) => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', density: 680 }] }] };
  const d = doc(designPrintHtml({ ...input, tree, units }));
  expect(d.querySelector('tbody tr')!.querySelectorAll('td')[1]!.textContent).toContain(expected);
  expect(d.textContent).not.toContain('Bulk density');
});

it.each([undefined, 0.0038])('S7c-2 keeps same-named canopy and shroud materials (line density %s)', lineDensity => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [
    { type: 'parachute', surfaceMaterialName: 'Nylon', lineMaterialName: 'Nylon', lineDensity },
    { type: 'shockcord', lineMaterialName: 'Nylon', lineDensity },
  ] }] };
  const d = doc(designPrintHtml({ ...input, tree }));
  const cells = [...d.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td')[1]!.textContent);
  expect(cells[0]).toContain('Line material: Nylon');
  expect(cells[1]).not.toContain('Line material: Nylon');
});

it('S7c-2 prints canopy and line materials with their distinct density units', () => {
  const recoveryTree: RocketTree = { components: [{ type: 'stage', children: [
    { type: 'parachute', name: 'Canopy', surfaceMaterialName: 'Ripstop', surfaceDensity: 0.067,
      lineMaterialName: 'Kevlar', lineDensity: 0.0012 },
    { type: 'shockcord', name: 'Cord', lineMaterialName: 'Elastic', lineDensity: 0.0018 },
  ] }] };
  const d = doc(designPrintHtml({ ...input, tree: recoveryTree }));
  for (const text of ['Ripstop', 'Kevlar', 'Elastic', 'kg/m²', 'kg/m']) expect(d.textContent).toContain(text);
});

it.each([
  [INITIAL_UNITS, '15.0 m/s'], [IMPERIAL_UNITS, '49.2 ft/s'],
])('keeps imported deployment ground speed separate from first-device opening evidence in %s', (units, speed) => {
  const [selected] = importedSummaryRuns({ name: 'Dual deployment', storedSimulations: [
    { name: 'Imported flight', configId: null, data: { maxAltitude: 300, deploymentVelocity: 15 } },
  ] });
  const before = JSON.stringify(selected);
  const d = doc(designPrintHtml({ ...input, units, run: selected! }));
  const recovery = [...d.querySelectorAll('h2')].find(h => h.textContent === 'Recovery')!.nextElementSibling!;
  expect(recovery.textContent).toContain(`Recorded summary deployment ground speed: ${speed}`);
  expect(recovery.textContent).toContain('device and opening order not recorded');
  expect(recovery.textContent).not.toMatch(/First recorded deployment|opening speed \d/);
  expect(recovery.textContent).toContain("cannot establish a device's air-relative opening speed");
  expect(JSON.stringify(selected)).toBe(before);
});

it('retains first-deployment evidence for ordinary scalar-only stored runs', () => {
  const d = doc(designPrintHtml({ ...input, units: INITIAL_UNITS,
    run: { ...run, deployments: undefined, altitudeAtDeployment: 100, velocityAtDeployment: 12 } }));
  expect(d.textContent).toContain('First recorded deployment: 100 m; opening speed 12.0 m/s');
});

it.each([
  [INITIAL_UNITS, 'rounded', '50 mm', '100 mm', '75 mm'],
  [IMPERIAL_UNITS, 'rounded', '1.969 in', '3.937 in', '2.953 in'],
  [INITIAL_UNITS, 'airfoil', '50 mm', '100 mm', '75 mm'],
  [IMPERIAL_UNITS, 'airfoil', '1.969 in', '3.937 in', '2.953 in'],
])('prints distinct freeform outline dimensions in %s with %s fins', (units, crossSection, short, tall, extent) => {
  const dimensions = [0.05, 0.1].map(span => {
    const fin: ComponentNode = { type: 'freeformfinset', id: 'fins', name: 'Freeform', finCount: 3, crossSection,
      thickness: 0.003, points: [[0, 0], [0.025, span], [0.075, span], [0.05, 0]] };
    const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', id: 'tube',
      length: 0.3, outerRadius: 0.025, thickness: 0.001, children: [fin] }] }] };
    const before = JSON.stringify(tree);
    const built = buildDesign({ tree, assigned: [], kbf: false, supersonic: false,
      measuredDryMassKg: null, primaryMountId: '', currentSetKey: '' }, KERNEL_HANDLES);
    if ('error' in built) throw new Error(built.error);
    const d = doc(designPrintHtml({ ...input, tree, units, info: built.info,
      infoFor: id => built.rocket.componentInfo(id), run: null }));
    const cell = d.querySelectorAll('tbody tr')[1]!.querySelectorAll('td')[2]!.textContent!;
    expect(cell).toContain(`Root chord: ${short}`);
    expect(cell).toContain(`Axial extent: ${extent}`);
    expect(JSON.stringify(tree)).toBe(before);
    return cell;
  });
  expect(dimensions[0]).toContain(`Span from root: ${short}`);
  expect(dimensions[1]).toContain(`Span from root: ${tall}`);
  expect(dimensions[0]).not.toBe(dimensions[1]);
});

it('reads default and explicitly closed freeform outlines without treating extent as chord', () => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [
    { type: 'freeformfinset', id: 'default', name: 'Default' },
    { type: 'freeformfinset', id: 'closed', name: 'Closed',
      points: [[0.01, 0.02], [0.035, 0.07], [0.085, 0.07], [0.06, 0.02], [0.01, 0.02]] },
  ] }] };
  const before = JSON.stringify(tree);
  const d = doc(designPrintHtml({ ...input, tree, units: INITIAL_UNITS, run: null }));
  const cells = [...d.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td')[2]!.textContent);
  expect(cells[0]).toContain('Root chord: 50 mm; Span from root: 50 mm; Axial extent: 75 mm');
  expect(cells[1]).toContain('Root chord: 50 mm; Span from root: 50 mm; Axial extent: 75 mm');
  expect(JSON.stringify(tree)).toBe(before);
});

it.each([
  [{}, 'primary mount/group'],
  [{ batch: true }, 'candidate group'],
  [{ batch: true, motorConfig: 'mixed 2+2' }, 'candidate group'],
  [{ motorConfig: 'single' }, 'candidate group'],
])('scopes multiple-mount recorded motor counts for %s', (provenance, scope) => {
  const selected = { ...run, ...provenance, motor: 'C6-5', motorCount: 1, boosterMotors: ['C6-0'] };
  const before = JSON.stringify(selected);
  const d = doc(designPrintHtml({ ...input, run: selected, currentLoadout: 'Today: 12 motors' }));
  const flight = [...d.querySelectorAll('p')].map(p => p.textContent).filter(t => t?.includes('motor count') || t?.includes('Motor count'));
  expect(flight).toContain(`Motor count (${scope}): 1`);
  expect(flight).toContain('Complete flight motor count: Unknown (not recorded).');
  expect(flight).not.toContain('Motor count: 1');
  expect(d.textContent).toContain('Other motor: C6-0');
  expect(JSON.stringify(selected)).toBe(before);
});

it.each([false, true])('does not invent a missing motor count (imported=%s)', importedSummary => {
  const d = doc(designPrintHtml({ ...input, run: { ...run, importedSummary, motorCount: undefined } }));
  expect(d.textContent).toContain(`Motor count (${importedSummary ? 'scope not recorded' : 'primary mount/group'}): Unknown`);
  expect(d.textContent).toContain('Complete flight motor count: Unknown (not recorded).');
});

it.each(['curve', 'ignition', 'partial'] as const)('withholds current launch figures for a %s motor refusal from a real build', refusal => {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!;
  mount.name = 'Refused <mount>';
  const motor: MountMotor = { label: 'C6-5', meta: { label: 'C6-5', manufacturer: 'Estes' },
    ignition: { event: 'automatic', delay: 0 }, spec: { designation: 'C6', diameter: 0.018,
      length: 0.07, cgX: 0.035, ejectionDelay: 5, times: [0, 0.2, 1.8],
      thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.0122] } };
  const rejected = refusal === 'ignition'
    ? { ...motor, ignition: { event: 'bogus' as MountMotor['ignition']['event'], delay: 0 } }
    : { ...motor, spec: { ...motor.spec, thrusts: [0, 14] } };
  const assigned: [string, MountMotor][] = [[mount.id!, rejected]];
  if (refusal === 'partial') {
    const accepted = { ...mount, id: 'accepted-print-mount', name: 'Accepted mount' };
    const parent = tree.components[0]!.children!.find(n => n.children?.includes(mount))!;
    parent.children!.push(accepted);
    assigned.push([accepted.id, motor]);
  }
  const built = buildDesign({ tree, assigned, kbf: false, supersonic: false,
    measuredDryMassKg: null, primaryMountId: mount.id!, currentSetKey: '' }, KERNEL_HANDLES);
  if ('error' in built) throw new Error(built.error);
  expect(built.motorFailures).toHaveLength(1);
  expect(built.motorFailures[0]!.mountId).toBe(mount.id);
  // A 0.05 g tolerance allows last-bit differences while detecting the missing 24 g motor.
  expect(built.info.mass - built.info.massEmpty).toBeCloseTo(refusal === 'partial' ? 0.024 : 0, 4);
  const d = doc(designPrintHtml({ ...input, tree, info: built.info, units: INITIAL_UNITS,
    withMotors: refusal === 'partial', motorFailures: built.motorFailures,
    currentLoadout: `Refused <mount>: C6-5${refusal === 'partial' ? '; Accepted mount: C6-5' : ''}`, run: null }));
  expect(d.textContent).toContain('Length');
  expect(d.textContent).toContain('Dry mass');
  expect(d.textContent).not.toContain('Launch mass');
  expect(d.textContent).not.toMatch(/CG \d|margin \d/);
  expect(d.querySelector('.caution')?.textContent).toContain('Refused <mount>');
  expect(d.querySelector('.caution')?.textContent).toContain(mount.id!);
  expect(d.textContent).toContain(built.motorFailures[0]!.text);
  expect(d.textContent).toContain('do not describe the complete assigned loadout');
  const loadout = [...d.querySelectorAll('p')].find(p => p.textContent!.startsWith('Current configuration'))!;
  expect(loadout.nextElementSibling?.textContent).toContain('Refused <mount>');
  expect(d.querySelector('script')).toBeNull();
  const selected = doc(designPrintHtml({ ...input, tree, info: built.info, motorFailures: built.motorFailures,
    run: { ...run, launchMass: 0.0566990462, launchCG: 0.1, launchCP: 0.2 } }));
  expect(selected.querySelector('.summary')!.textContent).toContain('Launch mass: 2.00 oz');
  expect(selected.querySelector('.summary')!.textContent).toContain('Launch CG:');
});

it('C-A6 composes current dimensions and parts separately from the SELECTED flight, in preferences', () => {
  const d = doc(designPrintHtml(input));
  expect(d.querySelector('script')).toBeNull();
  expect(d.textContent).toContain('Current <script>rocket</script>');
  expect(d.textContent).toContain('Length 10 in');
  expect(d.textContent).toContain('Launch mass 1.00 oz');
  expect(d.textContent).toContain('Earlier design');
  expect(d.textContent).toContain('Config B');
  expect(d.textContent).toContain('1000 ft');
  expect(d.textContent).toContain('40.0 ft/s');
  expect(d.textContent).toContain('10.0 ft/s');
  expect(d.textContent).toContain('Paper');
  expect(d.textContent).toMatch(/Caution:.*the design changed/s);
  expect(d.textContent).toContain('Danger: Hard opening');
  expect(d.querySelector('svg[aria-label="Current design schematic"]')).not.toBeNull();
  const noFlight = doc(designPrintHtml({ ...input, run: null, currentLoadout: 'Working settings: F40 in Mount A' }));
  expect(noFlight.textContent).toContain('Current configuration and motor assignments: Working settings: F40 in Mount A');
});
it('C-A6 marks absent, unknown, stale and imported evidence honestly, and uses the roll-swept CP', () => {
  expect(doc(designPrintHtml({ ...input, run: null, info: null })).textContent).toContain('No flight selected');
  expect(doc(designPrintHtml({ ...input, changedSince: null })).textContent).toContain('Design match unknown');
  const imported = doc(designPrintHtml({ ...input, run: { ...run, importedSummary: true }, changedSince: [] }));
  expect(imported.textContent).toContain('Imported summary');
  expect(imported.textContent).not.toContain('matches the current design');
  const d = doc(designPrintHtml({ ...input, units: INITIAL_UNITS, changedSince: [] }));
  expect(d.textContent).toContain('CP 170 mm');
  expect(d.textContent).not.toContain('CP 180 mm');
  expect(d.textContent).toContain('matches the current design');
  const html = designPrintHtml(input);
  expect(html).toContain('thead { display: table-header-group; }');
  expect(html).toContain('break-inside: avoid');
  expect(doc(designPrintHtml({ ...input, run: { ...run, when: NaN } })).textContent).toContain('an unknown time');
  const unverified = doc(designPrintHtml({ ...input, run: { ...run, importedSummary: true,
    flightConfig: 'Old unverified simulation title', flightConfigId: 'c' } }));
  expect(unverified.textContent).not.toContain('Old unverified simulation title');
  expect(unverified.textContent).toContain('Configuration not recorded');
});
it('C-A6 keeps long part names and available dimensions without a wide union table', () => {
  const name = 'A very long part '.repeat(20);
  const d = doc(designPrintHtml({ ...input, tree: { ...tree, components: [{ type: 'stage', children: [
    { type: 'bodytube', name, length: 0.254, outerRadius: 0.0254, materialName: 'Paper' },
  ] }] } }));
  expect(d.textContent).toContain(name);
  expect(d.querySelectorAll('thead th')).toHaveLength(5);
  expect(d.textContent).toContain('Outer diameter');
  expect(d.textContent).toContain('Outer diameter (in): 2');
});
it('C-A6 includes resolved ring sizes and the stored kernel warning tier, without assuming unknown masses', () => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', id: 'b', outerRadius: 0.05,
    thickness: 0.002, length: 0.3, children: [
      { type: 'centeringring', id: 'r', name: 'Ring', innerRadius: 0.02, length: 0.003 },
      { type: 'bulkhead', id: 'h', name: 'Bulkhead', length: 0.003 },
    ] }] }] };
  const d = doc(designPrintHtml({ ...input, tree, units: INITIAL_UNITS, run: { ...run,
    simWarnings: [{ key: 'NO_RECOVERY_DEVICE', message: '[Warning.NO_RECOVERY_DEVICE]' }] } }));
  expect(d.textContent).toContain('Outside diameter: 96 mm');
  expect(d.textContent).toContain('Opening diameter: 40 mm');
  expect(d.textContent).toContain('NO_RECOVERY_DEVICE');
  expect(d.querySelector('tr:nth-child(2) td:last-child')!.textContent).toBe('Unknown');
});
it('prints stated solid discs and marks invalid ring dimensions without substituting context', () => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', id: 'b',
    outerRadius: 0.032, thickness: 0.002, length: 0.3, children: [
      { type: 'innertube', id: 'mount', outerRadius: 0.01, length: 0.3 },
      { type: 'centeringring', id: 'solid', outerRadius: 0.04, innerRadius: 0, length: 0.003 },
      { type: 'centeringring', id: 'invalid', outerRadius: 0.04, innerRadius: 0.05, length: 0.003 },
      { type: 'bulkhead', id: 'zero', outerRadius: 0, length: 0.003 },
      { type: 'bulkhead', id: 'negative', outerRadius: -0.02, length: 0.003 },
      { type: 'bulkhead', id: 'nonfinite', outerRadius: NaN, length: 0.003 },
    ] }] }] };
  const before = JSON.stringify(tree);
  const d = doc(designPrintHtml({ ...input, tree, units: INITIAL_UNITS, run: null }));
  const rows = [...d.querySelectorAll('tbody tr')];
  expect(rows[2]!.textContent).toContain('Outside diameter: 80 mm; Opening diameter: 0 mm');
  expect(rows[3]!.textContent).toContain('Opening diameter: Unknown');
  expect(rows[3]!.textContent).not.toContain('Opening diameter: 20 mm');
  for (const row of rows.slice(3)) expect(row.textContent).toContain('Caution:');
  for (const row of rows.slice(4)) {
    expect(row.textContent).toContain('Outside diameter: Unknown');
    expect(row.textContent).not.toContain('Outside diameter: 60 mm');
  }
  expect(JSON.stringify(tree)).toBe(before);
});
it('keeps the known outside diameter but refuses the opening around a four-tube offset cluster', () => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', id: 'body',
    outerRadius: 0.1016, thickness: 0.003, length: 1, children: [
      { type: 'innertube', id: 'mount', outerRadius: 0.0375, length: 1, motorMount: true, cluster: '4-ring' },
      { type: 'centeringring', id: 'ring', outerRadius: 0.0986, innerRadius: 0.04, length: 0.003 },
    ] }] }] };
  const d = doc(designPrintHtml({ ...input, tree, units: INITIAL_UNITS, run: null }));
  const row = [...d.querySelectorAll('tbody tr')].find(r => r.textContent?.includes('Opening diameter:'))!;
  expect(row.textContent).toContain('Outside diameter: 197.2 mm');
  expect(row.textContent).not.toContain('Outside diameter: Unknown');
  expect(row.textContent).toContain('Opening diameter: Unknown');
  expect(row.textContent).toContain('Caution:');
  expect(row.textContent).toMatch(/cluster/);
});
it('prints the recorded delays for each mount and branch rather than one cluster recommendation', () => {
  const resolution = testResolution([['primary', testMotor()], ['secondary', testMotor()]], [7, 3]);
  resolution.mounts.forEach((m, i) => {
    m.mountName = i ? 'Secondary <mount>' : 'Primary mount';
    m.branchId = i ? 'detached' : 'core';
    m.branchName = i ? 'Separated <branch>' : 'Core branch';
    m.motorIdentity = i ? 'Recorded motor B' : 'Recorded motor A';
  });
  expect(validDelayResolution(resolution)).toBe(true);
  const selected = { ...run, motorCount: 4, delayS: 7, optimumDelayS: 99, recommendedDelayS: 99,
    delayResolution: resolution };
  const before = JSON.stringify(selected);
  const d = doc(designPrintHtml({ ...input, run: selected, currentLoadout: 'Today: 12 s in another mount' }));
  const delayTable = d.querySelector('table[aria-label="Per-mount ejection delays"]');
  expect(delayTable).not.toBeNull();
  const rows = [...delayTable!.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(2);
  const values = rows.map(row => [...row.querySelectorAll('th, td')].map(cell => cell.textContent));
  expect(values[0]).toEqual(['Primary mount (primary)', 'Recorded motor A', 'Core branch (core)', 'auto', '7 s', '7 s', '7 s']);
  expect(values[1]).toEqual(['Secondary <mount> (secondary)', 'Recorded motor B', 'Separated <branch> (detached)', 'auto', '3 s', '3 s', '3 s']);
  expect(d.textContent).toContain('Motor count (primary mount/group): 4');
  expect(d.textContent).not.toContain('99 s');
  expect(delayTable!.textContent).not.toContain('Today');
  expect(JSON.stringify(selected)).toBe(before);
});
it('keeps recorded manual and plugged delays distinct from missing recommendations', () => {
  const resolution = testResolution([['plugged', testMotor(false, Infinity)], ['manual', testMotor(false, 3)]], [Infinity, 3]);
  expect(validDelayResolution(resolution)).toBe(true);
  const d = doc(designPrintHtml({ ...input, run: { ...run, delayS: Infinity, delayResolution: resolution } }));
  const rows = [...d.querySelectorAll('table[aria-label="Per-mount ejection delays"] tbody tr')];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain('plugged — no ejection charge');
  expect(rows[0]!.querySelectorAll('td')[3]!.textContent).toBe('Unknown');
  expect(rows[1]!.textContent).toContain('manual');
  expect(rows[1]!.querySelector('td:last-child')!.textContent).toBe('3 s');
});
it('keeps hypothetical-charge and burnout cautions beside the mount delay they qualify', () => {
  const resolution = testResolution([['exception', testMotor()]], [0]);
  Object.assign(resolution.mounts[0]!, { rawOptimum: -1, burnoutTime: 3, apogeeTime: 2,
    exception: 'plugged-on-charge', caution: LATE_BURNOUT_CAUTION });
  expect(validDelayResolution(resolution)).toBe(true);
  const d = doc(designPrintHtml({ ...input, run: { ...run, delayResolution: resolution } }));
  const row = d.querySelector('table[aria-label="Per-mount ejection delays"] tbody tr');
  expect(row?.textContent).toContain('plugged → Auto (charge recovery)');
  expect(row?.textContent).toContain('hypothetical charge (motor sold plugged)');
  expect(row?.textContent).toContain('limited by burnout');
  expect(row?.querySelector('.caution')?.textContent).toContain(LATE_BURNOUT_CAUTION);
});
it('scopes scalar-only legacy evidence to the primary motor and distinguishes plugged from missing', () => {
  const d = doc(designPrintHtml({ ...input, run: { ...run, motorCount: 4, delayS: 7,
    optimumDelayS: 6.8, recommendedDelayS: 7 } }));
  expect(d.textContent).toContain('Legacy scalar delay evidence');
  expect(d.textContent).toContain('Other mounts’ delays are not recorded');
  expect(d.textContent).toContain('Primary motor ejection delay flown: 7 s');
  expect(d.textContent).toContain('Primary motor optimal delay: 6.8 s; recommended drill-to-fit delay: 7 s');
  const plugged = doc(designPrintHtml({ ...input, run: { ...run, delayS: Infinity } }));
  expect(plugged.textContent).toContain('Primary motor ejection delay flown: plugged — no ejection charge');
  expect(plugged.textContent).toContain('Hypothetical primary motor-eject recommendation');
  const missing = doc(designPrintHtml({ ...input, run: { ...run, delayS: NaN } }));
  expect(missing.textContent).toContain('Primary motor ejection delay flown: Unknown');
});
it('refuses an invalid stored delay vector without borrowing today’s assignments', () => {
  const resolution = testResolution([['a', testMotor()]], [7]);
  resolution.mounts[0]!.recommendedDelay = 3;
  expect(validDelayResolution(resolution)).toBe(false);
  const d = doc(designPrintHtml({ ...input, run: { ...run, delayResolution: resolution },
    currentLoadout: 'Today: manual 12 s' }));
  expect(d.querySelector('table[aria-label="Per-mount ejection delays"]')).toBeNull();
  expect(d.textContent).toContain('Per-mount delay evidence is invalid or incomplete');
  expect(d.textContent).toContain('Primary motor ejection delay flown: 5 s');
});

it('N032: prints heights in the Altitude unit and ground distance in Horizontal distance', () => {
  const units = { ...INITIAL_UNITS, altitude: 'ft', distance: 'km' };
  const flown = { ...run, landingDistanceM: 1500, densityAltitudeM: 152.4,
    branches: [{ name: 'Booster', motorLabel: 'F40', apogee: 304.8, recoveryMass: 0.02, deployments: [] }] } as unknown as SimRun;
  const text = doc(designPrintHtml({ ...input, units, run: flown })).textContent!.replace(/\s+/g, ' ');
  expect(text).toMatch(/Apogee: 1,?000 ft/);
  expect(text).toMatch(/density altitude: 500 ft/);
  expect(text).toMatch(/Main: opens at 7 s, 1,?000 ft/);
  expect(text).toMatch(/Booster: F40; apogee 1,?000 ft/);
  expect(text).toMatch(/landing distance: 1\.50? km/);
  expect(text).not.toMatch(/0\.3048? km|0\.15 km/);
});
