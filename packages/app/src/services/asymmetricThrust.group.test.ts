import { expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { asymmetricThrustWarnings } from './asymmetricThrust.js';
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

it.each([undefined, 1])('round 4 never sums opposite serial motors, separation %s', separation => {
  const tree = serialTree(), motor = balanceMotor(100, 4);
  const warnings = asymmetricThrustWarnings(tree, [['boost', motor], ['m0', motor]], flight(0, separation));
  expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_DANGER']);
  expect(warnings.every(w => w.message.includes('after separation'))).toBe(false);
  expect(warnings[0]?.message).toMatch(/^Stage Sustainer:/);
  expect(warnings[1]?.message).toMatch(/^Stage Booster:/);
  expect(warnings.every(w => w.message.includes('100 %'))).toBe(true);
});

it('round 4 keeps a sustainer load out of the spent booster peak', () => {
  const tree = serialTree(), boost = balanceMotor(1000, 2), upper = balanceMotor(100, 2);
  tree.components[1]!.children![0]!.children![0]!.radialPosition = 0;
  upper.ignition = { event: 'burnout', delay: 1 };
  for (const result of [undefined, flight(3)]) {
    const warnings = asymmetricThrustWarnings(tree, [['boost', boost], ['m0', upper]], result);
    expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_DANGER']);
    expect(warnings[0]?.message).toContain('Sustainer:');
    expect(warnings[0]?.message).toContain('100 %');
    expect(warnings[0]?.message).not.toContain('cannot tell');
  }
});

it('round 4 cancels two plugged single-instance strap-ons beside a centred core', () => {
  const tree = balanceTree(1), body = tree.components[0]!.children![0]!;
  body.children![0]!.radialPosition = 0;
  const motor = balanceMotor();
  motor.spec.ejectionDelay = Infinity;
  for (const [i, angle] of [Math.PI / 2, 3 * Math.PI / 2].entries()) body.children!.push({
    type: 'parallelstage', id: `ring${i}`, instanceCount: 1, radiusMethod: 'free', radiusOffset: 0.2,
    angleOffset: angle, children: [{ type: 'bodytube', id: `strap${i}`, motorMount: true,
      length: 0.3, outerRadius: 0.02 }],
  });
  const motors = [['m0', motor], ['strap0', motor], ['strap1', motor]] as const;
  const result = { events: motors.map(([id]) => ({ type: 'IGNITION', motorMountId: id, time: 0 })),
    branches: [] } as unknown as FlightResult;
  expect(asymmetricThrustWarnings(tree, motors)).toEqual([]);
  expect(asymmetricThrustWarnings(tree, motors, result)).toEqual([]);
});

it.each([1, 2])('round 4 keeps symmetric %s-instance strap-ons in one group after separation', count => {
  const tree = balanceTree(2), body = tree.components[0]!.children![0]!;
  body.children![0]!.radialPosition = 0;
  body.children![1]!.radialPosition = 0.2;
  const core = balanceMotor(1000, 2), air = balanceMotor(20, 1), strap = balanceMotor(100, 2);
  air.ignition = { event: 'launch', delay: 3 };
  for (let i = 0; i < 2 / count; i++) body.children!.push({ type: 'parallelstage', id: `ring${i}`,
    instanceCount: count, radiusMethod: 'free', radiusOffset: 0.2, angleOffset: Math.PI / 2 + i * Math.PI,
    separationEvent: 'burnout', separationDelay: 0.5,
    children: [{ type: 'bodytube', id: `strap${i}`, motorMount: true, length: 0.3, outerRadius: 0.02 }] });
  const motors = [['m0', core], ['m1', air], ...Array.from({ length: 2 / count }, (_, i) => [`strap${i}`, strap] as const)] as const;
  const result = { events: [
    ...motors.map(([id]) => ({ type: 'IGNITION', motorMountId: id, time: id === 'm1' ? 3 : 0 })),
    ...Array.from({ length: 2 / count }, (_, i) => ({ type: 'STAGE_SEPARATION', sourceId: `ring${i}`, time: 2.5 })),
  ], branches: [] } as unknown as FlightResult;
  expect(asymmetricThrustWarnings(tree, motors)).toEqual([]);
  expect(asymmetricThrustWarnings(tree, motors, result)).toEqual([]);
});

it.each([2, 4])('round 5 measures %s upper tubes on one event with relative delays', count => {
  const tree = balanceTree(count);
  tree.components.push({ type: 'stage', id: 'boost-stage', children: [] });
  const air = balanceMotor();
  const motors = Array.from({ length: count }, (_, i) => [`m${i}`, structuredClone(air)] as const);
  expect(asymmetricThrustWarnings(tree, motors)).toEqual([]);
  motors[0]![1].spec.thrusts = motors[0]![1].spec.thrusts.map(f => f * 3);
  const warnings = asymmetricThrustWarnings(tree, motors);
  expect(warnings[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  expect(warnings[0]?.message).toContain('after ignition');
  expect(warnings[0]?.message).not.toContain('cannot tell');
  const result = { events: motors.map(([id]) => ({ type: 'IGNITION', motorMountId: id, time: 2 })), branches: [] } as unknown as FlightResult;
  expect(asymmetricThrustWarnings(tree, motors, result)[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  Object.assign(motors[0]![1], structuredClone(air));
  motors[0]![1].ignition.delay = 1;
  expect(asymmetricThrustWarnings(tree, motors)[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
});

it('round 4 preserves uncertainty after an aborted flight, including a single-trigger upper group', () => {
  const tree = serialTree(), air = balanceMotor();
  air.ignition = { event: 'burnout', delay: 1 };
  const result = { events: [{ type: 'IGNITION', motorMountId: 'boost', time: 0 },
    { type: 'SIM_ABORT', time: 0.8, cause: 'TUMBLE_UNDER_THRUST' }], branches: [] } as unknown as FlightResult;
  const boost = balanceMotor();
  tree.components[1]!.children![0]!.children![0]!.radialPosition = 0;
  expect(asymmetricThrustWarnings(tree, [['boost', boost], ['m0', air]], result)[0]?.message)
    .toContain('cannot be fully checked');
});

it.each(['launch', 'burnout', 'ejectioncharge'] as const)(
  'round 4 retains unrecorded %s advice when the flight ended before ignition could happen', event => {
    const tree = serialTree(), air = balanceMotor();
    air.ignition = { event, delay: 10 };
    const boost = balanceMotor();
    tree.components[1]!.children![0]!.children![0]!.radialPosition = 0;
    const result = flight(3);
    result.events.splice(1);
    result.events.push({ type: 'GROUND_HIT', time: 5 });
    expect(asymmetricThrustWarnings(tree, [['boost', boost], ['m0', air]], result)[0]?.key)
      .toBe(event === 'launch' ? 'ASYMMETRIC_THRUST_DANGER' : 'ASYMMETRIC_THRUST_UNKNOWN');
    result.events[1]!.time = 30;
    expect(asymmetricThrustWarnings(tree, [['boost', boost], ['m0', air]], result)).toEqual([]);
  },
);

it('round 4 includes 5 percent despite multi-motor accumulation roundoff', () => {
  const tree = balanceTree(2);
  const motors = [['m0', balanceMotor(104.99999999999999)], ['m1', balanceMotor(95.00000000000003)]] as const;
  expect(asymmetricThrustWarnings(tree, motors)[0]?.key).toBe('ASYMMETRIC_THRUST_CAUTION');
});

it('round 4 uses the carrying branch end, rather than a later booster landing', () => {
  const tree = serialTree(), air = balanceMotor(), boost = balanceMotor();
  air.ignition = { event: 'burnout', delay: 10 };
  tree.components[1]!.children![0]!.children![0]!.radialPosition = 0;
  const result = flight(3);
  result.events.splice(1);
  result.events.push({ type: 'GROUND_HIT', time: 5 });
  result.branches = [{ name: 'Booster', events: [{ type: 'GROUND_HIT', time: 30 }],
    series: { time: [0, 30] } }] as FlightResult['branches'];
  expect(asymmetricThrustWarnings(tree, [['boost', boost], ['m0', air]], result)[0]?.key)
    .toBe('ASYMMETRIC_THRUST_UNKNOWN');
});

it('round 4 preserves an upper check when the middle-stage trigger is still pending', () => {
  const tree = serialTree(), upper = balanceMotor(), middle = balanceMotor(), boost = balanceMotor();
  const mid = structuredClone(tree.components[1]!);
  mid.id = 'middle'; mid.name = 'Middle';
  mid.children![0]!.children![0]!.id = 'mid';
  mid.children![0]!.children![0]!.radialPosition = 0;
  tree.components.splice(1, 0, mid);
  tree.components[2]!.children![0]!.children![0]!.radialPosition = 0;
  middle.ignition.delay = 10;
  const result = flight(3);
  result.events.splice(1);
  result.events.push({ type: 'GROUND_HIT', time: 5 });
  const warnings = asymmetricThrustWarnings(tree, [['boost', boost], ['mid', middle], ['m0', upper]], result);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.key).toBe('ASYMMETRIC_THRUST_UNKNOWN');
  expect(warnings[0]?.message).toMatch(/^Stage Sustainer:/);
});
