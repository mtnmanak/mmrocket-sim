// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { MOTOR_DB } from './motorDb.js';
import { bundledOnlyFetchSpec } from './thrustcurve.js';
import { simulateDesign } from './simulateDesign.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { asymmetricThrustWarnings } from './asymmetricThrust.js';
import { balanceMotor } from './asymmetricThrust.testSupport.js';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
const load = async (designation: string, delay: number): Promise<MountMotor> => {
  const entry = MOTOR_DB.find(m => m.designation === designation)!;
  expect(entry).toBeDefined();
  return { label: entry.designation, meta: { label: entry.designation, motorId: entry.motorId },
    spec: await bundledOnlyFetchSpec(entry, delay), ignition: { event: 'automatic', delay: 0 } };
};
const mount = (id: string, radius = 0, angle = 0): ComponentNode => ({
  type: 'innertube', id, name: id, motorMount: true, length: 0.5, outerRadius: 0.03,
  thickness: 0.001, radialPosition: radius, radialDirection: angle, position: { method: 'bottom', offset: 0 },
});
const fins = (): ComponentNode => ({ type: 'freeformfinset', finCount: 4, thickness: 0.003,
  crossSection: 'rounded', points: [[0, 0], [0.15, 0.2], [0.45, 0.2], [0.45, 0]],
  position: { method: 'bottom', offset: 0 } });
const stableCore = (): RocketTree => ({ name: 'Stable thrust grouping regression', components: [
  { type: 'stage', id: 'core', name: 'Sustainer', children: [
    { type: 'nosecone', length: 0.3, aftRadius: 0.05, shape: 'ogive', thickness: 0.001 },
    { type: 'bodytube', length: 1.2, outerRadius: 0.05, thickness: 0.001, children: [
      { type: 'masscomponent', mass: 0.3, length: 0.05, radius: 0.02, position: { method: 'top', offset: 0 } },
      fins(), mount('core-motor'), { type: 'parachute', diameter: 1, deployEvent: 'apogee' },
    ] },
  ] },
] });
const strap = (id: string, angle: number, count = 1): ComponentNode => ({
  type: 'parallelstage', id, name: id, instanceCount: count, radiusMethod: 'free',
  radiusOffset: 0.12, angleOffset: angle, separationEvent: 'ejection', children: [
    { type: 'nosecone', length: 0.1, aftRadius: 0.025, shape: 'ogive', thickness: 0.001 },
    { type: 'bodytube', length: 0.6, outerRadius: 0.025, thickness: 0.001, children: [
      mount(`${id}-motor`), fins(), { type: 'parachute', diameter: 0.5, deployEvent: 'apogee' },
    ] },
  ],
});
const fly = async (tree: RocketTree, motors: Record<string, MountMotor>) => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  const out = await simulateDesign({ tree, mountMotors: motors, launch: DEFAULT_CONDITIONS,
    measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null, unmatchedRefs: {} },
  { aero: { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false } });
  const events = [...out.result.events, ...(out.result.branches ?? []).flatMap(b => b.events)];
  // Establish a completed, stable flight before drawing any warning conclusion.
  expect(events.filter(e => e.type === 'SIM_ABORT'), JSON.stringify(events)).toEqual([]);
  expect(events.some(e => e.type === 'GROUND_HIT')).toBe(true);
  return { events, warnings: out.run.simWarnings!.filter(w => w.key.startsWith('ASYMMETRIC_THRUST_')) };
};

it('round 4 real kernel: identical plugged single-instance strap-ons cancel beside the core', async () => {
  const tree = stableCore(), body = tree.components[0]!.children![1]!;
  body.children!.push(strap('left', Math.PI / 2), strap('right', 3 * Math.PI / 2));
  const motor = await load('G80T', Infinity);
  const motors = { 'core-motor': motor, 'left-motor': motor, 'right-motor': motor };
  const out = await fly(tree, motors);
  expect(out.events.filter(e => e.type === 'IGNITION').map(e => e.motorMountId))
    .toEqual(expect.arrayContaining(Object.keys(motors)));
  expect(out.warnings).toEqual([]);
  expect(asymmetricThrustWarnings(tree, Object.entries(motors))).toEqual([]);
}, 60_000);

it.each([6, Infinity])('round 4 real kernel: J350W delay %s never dilutes a G80T sustainer', async delay => {
  const tree = stableCore(), body = tree.components[0]!.children![1]!;
  body.children = body.children!.filter(n => n.id !== 'core-motor');
  body.children.push(mount('upper-a', 0.035), mount('upper-b', 0.035, Math.PI));
  tree.components.push({ type: 'stage', id: 'booster', name: 'Booster', separationEvent: 'ejection', children: [
    { type: 'bodytube', length: 0.6, outerRadius: 0.05, thickness: 0.001, children: [fins(), mount('boost')] },
  ] });
  const [boost, upper] = await Promise.all([load('J350W', delay), load('G80T', Infinity)]);
  upper.ignition = { event: 'burnout', delay: 1 };
  const motors = { boost, 'upper-a': upper };
  const out = await fly(tree, motors);
  const burnout = out.events.find(e => e.type === 'BURNOUT' && e.motorMountId === 'boost');
  const ignition = out.events.find(e => e.type === 'IGNITION' && e.motorMountId === 'upper-a');
  expect(burnout).toBeDefined();
  expect(ignition).toBeDefined();
  expect(ignition!.time - burnout!.time).toBeCloseTo(1, 5);
  if (!Number.isFinite(delay)) expect(out.events.some(e => e.type === 'STAGE_SEPARATION')).toBe(false);
  for (const warnings of [out.warnings, asymmetricThrustWarnings(tree, Object.entries(motors))]) {
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(warnings[0]?.message).toMatch(/^Stage Sustainer:/);
  }
}, 60_000);

it('round 4 real kernel: dropping a balanced ring does not reset the 1000 N core peak for a 20 N airstart', async () => {
  const tree = stableCore(), body = tree.components[0]!.children![1]!;
  body.children!.push(mount('air', 0.12));
  const ring = strap('ring', Math.PI / 2, 2);
  ring.separationEvent = 'launch'; ring.separationDelay = 2.5;
  body.children!.push(ring);
  const core = balanceMotor(1000, 2), air = balanceMotor(20, 1), ringMotor = balanceMotor(100, 2);
  for (const motor of [core, air, ringMotor]) motor.spec.ejectionDelay = Infinity;
  air.ignition = { event: 'launch', delay: 3 };
  const motors = { 'core-motor': core, air, 'ring-motor': ringMotor };
  const out = await fly(tree, motors);
  expect(out.events.find(e => e.type === 'STAGE_SEPARATION' && e.sourceId === 'ring')?.time).toBeCloseTo(2.5, 5);
  expect(out.events.find(e => e.type === 'IGNITION' && e.motorMountId === 'air')?.time).toBeCloseTo(3, 5);
  expect(out.warnings).toEqual([]);
  expect(asymmetricThrustWarnings(tree, Object.entries(motors))).toEqual([]);
}, 60_000);
