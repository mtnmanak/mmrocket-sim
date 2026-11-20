import { expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { asymmetricThrustWarnings } from './asymmetricThrust.js';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';

const axialCore = () => {
  const tree = balanceTree(2);
  const mounts = tree.components[0]!.children![0]!.children!;
  mounts[0]!.radialPosition = 0;
  mounts[1]!.radialPosition = 0.03;
  return tree;
};
const upperCore = () => {
  const tree = axialCore();
  tree.components[0]!.name = 'Sustainer';
  tree.components.push({ type: 'stage', id: 'booster', children: [] });
  return tree;
};

it.each([[1000, 20, undefined], [300, 40, 'ASYMMETRIC_THRUST_CAUTION']] as const)(
  'round 5 R5-1 includes the unknown %s N axial core in the known %s N tube denominator', (peak, tube, key) => {
    const core = balanceMotor(peak), air = balanceMotor(tube);
    air.ignition = { event: 'launch', delay: 3 };
    const warnings = asymmetricThrustWarnings(upperCore(), [['m0', core], ['m1', air]]);
    expect(warnings.map(w => w.key)).toEqual(key ? [key] : []);
    if (key) {
      expect(warnings[0]?.message).toContain('13.3 %');
      expect(warnings[0]?.message).toContain('cannot tell'); // Conservative round-6 bound includes the known moment.
    }
  },
);

it('round 5 R5-1 grades an unknown small tube against the known core peak', () => {
  const core = balanceMotor(1000), air = balanceMotor(20);
  air.ignition = { event: 'burnout', delay: 3 };
  expect(asymmetricThrustWarnings(axialCore(), [['m0', core], ['m1', air]])).toEqual([]);
});

it('round 5 R5-1 includes the unknown core beside mismatched single-instance strap-ons', () => {
  const tree = balanceTree(1), body = tree.components[0]!.children![0]!;
  body.children![0]!.radialPosition = 0;
  for (const [i, angle] of [Math.PI / 2, 3 * Math.PI / 2].entries()) body.children!.push({
    type: 'parallelstage', id: `ring${i}`, instanceCount: 1, radiusMethod: 'free', radiusOffset: 0.12,
    angleOffset: angle, children: [{ type: 'bodytube', id: `strap${i}`, motorMount: true,
      length: 0.3, outerRadius: 0.02 }],
  });
  const core = balanceMotor(1000);
  core.ignition = { event: 'burnout', delay: 0 };
  expect(asymmetricThrustWarnings(tree, [['m0', core], ['strap0', balanceMotor(100)],
    ['strap1', balanceMotor(90)]])).toEqual([]);
});

it('round 5 R5-1 uses the largest installed radius even when its balanced ring has unknown timing', () => {
  const tree = axialCore(), mounts = tree.components[0]!.children![0]!.children!;
  Object.assign(mounts[0]!, { radialPosition: 0, cluster: 'double', clusterScale: 10 });
  mounts[1]!.radialPosition = 0.002;
  const ring = balanceMotor(100), tube = balanceMotor(200);
  ring.ignition = { event: 'burnout', delay: 0 };
  // The two ring motors cancel, but their radius still normalizes the tube moment.
  expect(asymmetricThrustWarnings(tree, [['m0', ring], ['m1', tube]])).toEqual([]);
});

it.each([[1000, 20, undefined], [300, 100, 'ASYMMETRIC_THRUST_DANGER']] as const)(
  'round 5 R5-2 retains known launch timing after an early end with %s N core and %s N tube', (peak, tube, key) => {
    const core = balanceMotor(peak), air = balanceMotor(tube);
    air.ignition = { event: 'launch', delay: 3 };
    const motors = [['m0', core], ['m1', air]] as const;
    for (const event of ['SIM_ABORT', 'GROUND_HIT']) {
      const result = { events: [{ type: 'IGNITION', motorMountId: 'm0', time: 0 },
        { type: event, time: 2.0025 }], branches: [] } as unknown as FlightResult;
      const warnings = asymmetricThrustWarnings(axialCore(), motors, result);
      expect(warnings.map(w => w.key)).toEqual(key ? [key, 'ASYMMETRIC_THRUST_LONE'] : []);
      expect(warnings).toEqual(asymmetricThrustWarnings(axialCore(), motors));
    }
  },
);

it('round 5 R5-3 measures upper motors on the same event with their different relative delays', () => {
  const tree = balanceTree(2), first = balanceMotor(60), second = balanceMotor(60);
  tree.components.push({ type: 'stage', id: 'booster', children: [] });
  first.ignition = { event: 'burnout', delay: 0 };
  second.ignition = { event: 'burnout', delay: 1 };
  const warnings = asymmetricThrustWarnings(tree, [['m0', first], ['m1', second]]);
  expect(warnings[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  expect(warnings[0]?.message).toContain('50 %');
  expect(warnings[0]?.message).toContain('0.1 s after ignition');
  expect(warnings[0]?.message).not.toContain('cannot tell');
});

it.each([[800, 200, 0.005, 0, 'ASYMMETRIC_THRUST_DANGER'],
  [1000, 200, 0.005, 4.1, 'ASYMMETRIC_THRUST_DANGER'],
  [2000, 100, 0.02, 4, 'ASYMMETRIC_THRUST_CAUTION']] as const)(
  'round 5 R5-4 includes the 1 mm floor at delay %s/%s/%s/%s', (peak, tube, radius, delay, key) => {
    const tree = axialCore(), core = balanceMotor(peak), air = balanceMotor(tube);
    tree.components[0]!.children![0]!.children![1]!.radialPosition = radius;
    air.ignition = { event: 'launch', delay };
    expect(asymmetricThrustWarnings(tree, [['m0', core], ['m1', air]])[0]?.key).toBe(key);
  },
);

it('round 5 R5-4 applies the 1 mm roundoff allowance to unknown timing too', () => {
  const tree = axialCore(), core = balanceMotor(1000), air = balanceMotor(200);
  tree.components[0]!.children![0]!.children![1]!.radialPosition = 0.005 * (1 - 5e-15);
  air.ignition = { event: 'burnout', delay: 4.1 };
  expect(asymmetricThrustWarnings(tree, [['m0', core], ['m1', air]])[0]?.key)
    .toBe('ASYMMETRIC_THRUST_UNKNOWN');
});

it.each([undefined, { events: [{ type: 'IGNITION', motorMountId: 'm0', time: 0 },
  { type: 'IGNITION', motorMountId: 'm1', time: 0 }], branches: [] } as unknown as FlightResult])(
  'round 5 R5-5 never rounds a Caution percentage into Danger (result %s)', result => {
    const warning = asymmetricThrustWarnings(balanceTree(2),
      [['m0', balanceMotor(119.97)], ['m1', balanceMotor(80.03)]], result)[0]!;
    expect(warning.key).toBe('ASYMMETRIC_THRUST_CAUTION');
    const percent = Number(warning.message.match(/reaches ([\d.]+) %/)?.[1]);
    expect(percent).toBeGreaterThanOrEqual(19.9);
    expect(percent).toBeLessThan(20);
  },
);
