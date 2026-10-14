// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { designPrintHtml } from './designPrintReport.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import type { SimRun } from './simReport.js';

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
