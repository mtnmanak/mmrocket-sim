// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { asymmetricThrustWarnings } from './asymmetricThrust.js';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';
import { simulateDesign } from './simulateDesign.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import type { MountMotor } from '../model/design.js';
import type { RocketTree } from '@online-openrocket/engine';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

async function abortFlight(tree: RocketTree, motors: Record<string, MountMotor>) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  // These deliberately finless rockets generate real kernel abort evidence.
  tree.components[0]!.children!.unshift({ type: 'nosecone', length: 0.3,
    aftRadius: 0.15, shape: 'ogive', thickness: 0.002 });
  const out = await simulateDesign({ tree, mountMotors: motors, launch: DEFAULT_CONDITIONS,
    measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null, unmatchedRefs: {} },
  { aero: { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false } });
  const events = [...out.result.events, ...(out.result.branches ?? []).flatMap(b => b.events)];
  expect(events.some(e => e.type === 'SIM_ABORT'), JSON.stringify(events)).toBe(true);
  return { ...out, events };
}

it('round 7 R7-1 keeps different owning/source triggers separate after a kernel abort', async () => {
  const tree = balanceTree(1), body = tree.components[0]!.children![0]!;
  body.children![0]!.radialPosition = 0.035;
  body.children!.push({ type: 'parallelstage', id: 'strap-stage', instanceCount: 1,
    radiusMethod: 'free', radiusOffset: 0.07, angleOffset: Math.PI,
    children: [{ type: 'bodytube', id: 'strap', motorMount: true, length: 0.3, outerRadius: 0.02 }] });
  const booster = structuredClone(tree.components[0]!);
  booster.id = 'booster';
  booster.children![0]!.children = [{ ...body.children![0]!, id: 'boost', radialPosition: 0 }];
  tree.components.push(booster);
  const core = balanceMotor(200), strap = balanceMotor(100), boost = balanceMotor(600);
  strap.ignition = { event: 'ejectioncharge', delay: 0 };
  const motors = { m0: core, strap, boost };
  const out = await abortFlight(tree, motors);
  expect(out.events.filter(e => e.type === 'IGNITION').map(e => e.motorMountId)).toEqual(['boost']);
  expect(out.events.some(e => e.type === 'EJECTION_CHARGE')).toBe(false);
  expect(asymmetricThrustWarnings(tree, Object.entries(motors))[0]?.key).toBe('ASYMMETRIC_THRUST_UNKNOWN');
  const warnings = out.run.simWarnings!.filter(w => w.key.startsWith('ASYMMETRIC_THRUST_'));
  expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_UNKNOWN']);
  expect(warnings[0]?.message).toContain('flight ended before');
}, 60_000);

it('round 7 R7-2 retains the combined-bound caveat after a kernel abort before strap burnout', async () => {
  const tree = balanceTree(3), body = tree.components[0]!.children![0]!;
  body.children![0]!.radialPosition = 0;
  for (const [i, angle] of [-Math.PI / 6, Math.PI / 6].entries()) {
    Object.assign(body.children![i + 1]!, { radialPosition: 0.1, radialDirection: angle });
  }
  body.children!.push({ type: 'parallelstage', id: 'ring', instanceCount: 2,
    radiusMethod: 'free', radiusOffset: 0.17, angleOffset: Math.PI / 2,
    children: [{ type: 'bodytube', id: 'ring-motor', motorMount: true, length: 0.3, outerRadius: 0.02 }] });
  const first = balanceMotor(65, 4), second = balanceMotor(65, 4);
  first.ignition = { event: 'launch', delay: 0 };
  second.ignition = { event: 'burnout', delay: 0 };
  const motors = { m0: balanceMotor(1000, 4), m1: first, m2: second, 'ring-motor': balanceMotor(100, 2) };
  const out = await abortFlight(tree, motors);
  const abortTime = out.events.find(e => e.type === 'SIM_ABORT')!.time;
  expect(abortTime, JSON.stringify(out.events)).toBeGreaterThan(0);
  expect(abortTime).toBeLessThan(motors['ring-motor'].spec.times.at(-1)!);
  expect(out.events.some(e => e.type === 'IGNITION' && e.motorMountId === 'm2')).toBe(false);
  const warnings = out.run.simWarnings!.filter(w => w.key.startsWith('ASYMMETRIC_THRUST_'));
  expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_UNKNOWN']);
  expect(warnings[0]?.message).toContain('cannot be fully checked');
  // Once the pending motor lights at burnout, the overlap crosses Caution.
  const completed = { ...out.result, events: Object.keys(motors).map(id => ({
    type: 'IGNITION', motorMountId: id, time: id === 'm2' ? 2 : 0,
  })), branches: [] };
  expect(asymmetricThrustWarnings(tree, Object.entries(motors), completed)[0]?.message).toContain('5.24 %');
  first.spec.thrusts = first.spec.thrusts.map(f => f / 2);
  second.spec.thrusts = second.spec.thrusts.map(f => f / 2);
  expect(asymmetricThrustWarnings(tree, Object.entries(motors), out.result)).toEqual([]);
}, 60_000);

it('round 7 R7-3 measures a delayed upper burn from its ignition origin', () => {
  const tree = balanceTree(1), motor = balanceMotor();
  tree.components.push({ type: 'stage', id: 'booster', children: [] });
  motor.ignition = { event: 'burnout', delay: 5 };
  const warning = asymmetricThrustWarnings(tree, [['m0', motor]])[0]!;
  expect(warning.key).toBe('ASYMMETRIC_THRUST_DANGER');
  expect(warning.message).toContain('0.1 s after ignition');
  expect(warning.message).not.toContain('5.1 s after ignition');
});
