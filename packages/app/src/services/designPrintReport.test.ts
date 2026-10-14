// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { designPrintHtml } from './designPrintReport.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import type { SimRun } from './simReport.js';
import { testMotor, testResolution } from './autoDelay.testSupport.js';
import { LATE_BURNOUT_CAUTION, validDelayResolution } from './autoDelaySolver.js';

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
  expect(d.textContent).toContain('Motor count: 4');
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
