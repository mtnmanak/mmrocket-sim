import { expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { asymmetricThrustWarnings, thrustImbalance } from './asymmetricThrust.js';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';

const serialTree = () => {
  const tree = balanceTree(1), booster = structuredClone(tree.components[0]!);
  tree.components[0]!.id = 'upper';
  tree.components[0]!.name = 'Sustainer';
  booster.id = 'booster';
  booster.name = 'Booster';
  booster.children![0]!.children![0]!.id = 'boost';
  booster.children![0]!.children![0]!.radialDirection = Math.PI;
  tree.components.push(booster);
  return tree;
};
const flight = (upper: number, separation?: number): FlightResult => ({ events: [
  { type: 'IGNITION', motorMountId: 'boost', time: 0 },
  { type: 'IGNITION', motorMountId: 'm0', time: upper },
  ...(separation === undefined ? [] : [{ type: 'STAGE_SEPARATION', sourceId: 'booster', time: separation }]),
], branches: [] } as unknown as FlightResult);

it.each([20, 50])('round 3 keeps a delayed %s N motor with its attached core over the whole burn', peak => {
  const tree = balanceTree(2);
  tree.components[0]!.children![0]!.children![0]!.radialPosition = 0;
  const core = balanceMotor(peak === 20 ? 1000 : 300);
  const air = { ...balanceMotor(peak), ignition: { event: 'launch' as const, delay: 3 } };
  const warnings = asymmetricThrustWarnings(tree, [['m0', core], ['m1', air]]);
  expect(warnings.map(w => w.key)).toEqual(peak === 20 ? [] : ['ASYMMETRIC_THRUST_CAUTION']);
  if (peak === 50) expect(warnings[0]?.message).toContain('16.7 %');
  // A pod is part of its owning vehicle too.
  const mount = tree.components[0]!.children![0]!.children!.pop()!;
  mount.radialPosition = 0;
  tree.components[0]!.children![0]!.children!.push({ type: 'podset', instanceCount: 1,
    radiusMethod: 'free', radiusOffset: 0.06, children: [{ type: 'bodytube', length: 0.3,
      outerRadius: 0.02, children: [mount] }] });
  expect(asymmetricThrustWarnings(tree, [['m0', core], ['m1', air]]).map(w => w.key))
    .toEqual(warnings.map(w => w.key));
});

it('round 4 checks opposite serial motors independently with branch-only separation events', () => {
  const tree = serialTree(), motor = balanceMotor(100, 4);
  const result = flight(0, 1);
  result.branches = [{ name: 'Booster', events: result.events.splice(2), series: {} }] as FlightResult['branches'];
  const warnings = asymmetricThrustWarnings(tree, [['boost', motor], ['m0', motor]], result);
  expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_DANGER']);
  expect(warnings.every(w => w.message.includes('after separation'))).toBe(false);
  expect(warnings.some(w => w.message.includes('Sustainer'))).toBe(true);
  expect(warnings.every(w => w.message.includes('100 %'))).toBe(true);
  expect(asymmetricThrustWarnings(tree, [['boost', motor], ['m0', motor]], flight(0)).map(w => w.key))
    .toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_DANGER']);
});

it.each(['launch', 'ignition', 'burnout', 'ejection', 'upperignition'])('round 4 ignores %s separation in serial thrust grouping', event => {
  const tree = serialTree();
  Object.assign(tree.components[1]!, { separationEvent: event, separationDelay: 1 });
  const motor = { ...balanceMotor(100, 4), ignition: { event: 'launch' as const, delay: 0 } };
  if (event === 'burnout' || event === 'ejection') {
    // A short centred trigger splits the two long-burning opposite motors.
    const trigger = structuredClone(tree.components[1]!.children![0]!.children![0]!);
    trigger.id = 'trigger'; trigger.radialPosition = 0;
    tree.components[1]!.children![0]!.children!.push(trigger);
  }
  const trigger = balanceMotor(1, 0.5); trigger.spec.ejectionDelay = 0;
  const warnings = asymmetricThrustWarnings(tree, [['boost', motor], ['m0', motor], ['trigger', trigger]]);
  expect(warnings.filter(w => w.key === 'ASYMMETRIC_THRUST_DANGER')).toHaveLength(2);
  expect(warnings.every(w => w.message.includes('after separation'))).toBe(false);
  tree.components[1]!.separationEvent = 'never';
  expect(asymmetricThrustWarnings(tree, [['boost', motor], ['m0', motor]]).map(w => w.key))
    .toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_DANGER']);
});

it('round 3 does not sum burns that only touch, and retains launch booster advice on the report', () => {
  const tree = serialTree(), boost = balanceMotor(1000, 2), upper = balanceMotor(100, 2);
  // Include nonzero endpoints: a single shared instant cannot double the peak.
  boost.spec = { ...boost.spec, times: [0, 2], thrusts: [1000, 1000] };
  upper.spec = { ...upper.spec, times: [0, 2], thrusts: [100, 100] };
  const warnings = asymmetricThrustWarnings(tree, [['boost', boost], ['m0', upper]], flight(2, 2));
  expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_DANGER']);
  expect(warnings.every(w => w.message.includes('100 %'))).toBe(true);
  tree.components[0]!.children![0]!.children![0]!.radialPosition = 0;
  expect(asymmetricThrustWarnings(tree, [['boost', boost], ['m0', upper]], flight(2, 2)))
    .toHaveLength(1);
  expect(thrustImbalance([
    { mountId: 'a', name: 'a', y: 0.06, z: 0, spec: upper.spec, ignition: 0 },
    { mountId: 'b', name: 'b', y: -0.06, z: 0, spec: upper.spec, ignition: 2 },
  ]).fraction).toBeCloseTo(1, 12);
});

it.each([2, 4])('round 3 checks %s separate unknown-time tubes as one co-ignited set', count => {
  const tree = balanceTree(count);
  tree.components.push({ type: 'stage', id: 'boost-stage', children: [] });
  const air = balanceMotor();
  const motors = Array.from({ length: count }, (_, i) => [`m${i}`, structuredClone(air)] as const);
  expect(asymmetricThrustWarnings(tree, motors)).toEqual([]);
  motors[0]![1].spec.thrusts = motors[0]![1].spec.thrusts.map(f => f * 3);
  expect(asymmetricThrustWarnings(tree, motors)[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  const result = { events: motors.map(([id]) => ({ type: 'IGNITION', motorMountId: id, time: 2 })), branches: [] } as unknown as FlightResult;
  expect(asymmetricThrustWarnings(tree, motors, result)[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  Object.assign(motors[0]![1], structuredClone(air));
  motors[0]![1].ignition.delay = 1;
  expect(asymmetricThrustWarnings(tree, motors)[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
});
