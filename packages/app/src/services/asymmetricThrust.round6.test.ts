import { expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { asymmetricThrustWarnings } from './asymmetricThrust.js';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';
import { formatWarning } from './simWarnings.js';

it('round 6 R6-1 keeps ejection triggers from different owning/source stages separate', () => {
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
  const motors = [['m0', core], ['strap', strap], ['boost', boost]] as const;
  const warnings = asymmetricThrustWarnings(tree, motors);
  expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_UNKNOWN']);
  expect(warnings[0]?.message).toContain('cannot tell before you fly');
  // Completed-flight evidence lights only the core, not the strap-on.
  const result = { events: [{ type: 'IGNITION', motorMountId: 'boost', time: 0 },
    { type: 'EJECTION_CHARGE', motorMountId: 'boost', time: 2 },
    { type: 'IGNITION', motorMountId: 'm0', time: 2 }, { type: 'GROUND_HIT', time: 20 }],
    branches: [] } as unknown as FlightResult;
  const flown = asymmetricThrustWarnings(tree, motors, result);
  expect(flown[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  expect(flown[0]?.message).toContain('100 %');
});

it.each(['launch', 'ejectioncharge'] as const)(
  'round 6 R6-2 bounds additive known/unknown moments with first trigger %s', event => {
    const tree = balanceTree(3), body = tree.components[0]!.children![0]!;
    body.children![0]!.radialPosition = 0;
    for (const [i, angle] of [-Math.PI / 6, Math.PI / 6].entries()) {
      Object.assign(body.children![i + 1]!, { radialPosition: 0.1, radialDirection: angle });
    }
    body.children!.push({ type: 'parallelstage', id: 'ring', instanceCount: 2,
      radiusMethod: 'free', radiusOffset: 0.17, angleOffset: Math.PI / 2,
      children: [{ type: 'bodytube', id: 'ring-motor', motorMount: true, length: 0.3, outerRadius: 0.02 }] });
    const first = balanceMotor(65, 4), second = balanceMotor(65, 4);
    first.ignition = { event, delay: 0 };
    second.ignition = { event: 'burnout', delay: 0 };
    const motors = [['m0', balanceMotor(1000, 4)], ['m1', first], ['m2', second],
      ['ring-motor', balanceMotor(100, 2)]] as const;
    const warnings = asymmetricThrustWarnings(tree, motors);
    expect(warnings.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_UNKNOWN']);
    expect(formatWarning(warnings[0]!).tier).toBe('caution');
    expect(warnings[0]?.message).toContain('cannot tell before you fly');
    const result = { events: motors.map(([id]) => ({ type: 'IGNITION', motorMountId: id,
      time: id === 'm2' ? 2 : 0 })), branches: [] } as unknown as FlightResult;
    const flown = asymmetricThrustWarnings(tree, motors, result);
    expect(flown[0]?.key).toBe('ASYMMETRIC_THRUST_CAUTION');
    expect(flown[0]?.message).toContain('5.24 %');
    // Even the aligned bound remains below 5% when both small motors are halved.
    first.spec.thrusts = first.spec.thrusts.map(f => f / 2);
    second.spec.thrusts = second.spec.thrusts.map(f => f / 2);
    expect(asymmetricThrustWarnings(tree, motors)).toEqual([]);
  },
);

it('round 6 R6-3 preserves a bracketed stage name through warning formatting', () => {
  const tree = balanceTree(1);
  tree.components[0]!.name = '[Sustainer]';
  tree.components.push({ type: 'stage', id: 'booster', children: [] });
  const warning = asymmetricThrustWarnings(tree, [['m0', balanceMotor()]])[0]!;
  expect(formatWarning(warning).detail).toContain('[Sustainer]: At its worst');
});
