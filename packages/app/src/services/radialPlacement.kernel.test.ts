import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';

const offset = 0.008; // m
const partMass = 0.02; // kg
const offsetTypes = ['innertube', 'masscomponent', 'parachute', 'streamer', 'shockcord'] as const;
const ringTypes = ['tubecoupler', 'centeringring', 'bulkhead', 'engineblock'] as const;
const types = [...offsetTypes, ...ringTypes];
const motor: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 5,
  times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2],
  thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
};

function build(type: typeof types[number], radialPosition = 0, radialDirection = 0,
  ballast = false, crossSection = 'rounded', cant = 0.02) {
  const children: ComponentNode[] = [
    { type, overrideMass: partMass, length: 0.03, outerRadius: 0.01, innerRadius: 0.008,
      thickness: 0.002, radialPosition, radialDirection, deployEvent: 'never' },
    { type: 'innertube', id: 'mount', motorMount: true, length: 0.07, outerRadius: 0.0095,
      thickness: 0.0005, position: { method: 'bottom', offset: 0 } },
    { type: 'freeformfinset', finCount: 3, thickness: 0.002, crossSection, cant,
      points: [[0, 0], [0.02, 0.03], [0.05, 0.03], [0.05, 0]],
      position: { method: 'bottom', offset: 0 } },
  ];
  if (ballast) children.push({ type: 'masscomponent', mass: partMass,
    radialPosition: offset, radialDirection: 0 });
  const tree: RocketTree = { components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.025, thickness: 0.001, shape: 'ogive' },
    { type: 'bodytube', length: 0.3, outerRadius: 0.025, thickness: 0.0003, density: 950, children },
  ] };
  return OrkRocket.buildTree(engineTree(tree));
}

// Compare against the parallel-axis law, allowing 1e-9 relative rounding noise.
function relative(actual: number, expected: number) {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-9);
}

describe('radial placement reaches the simulation kernel', () => {
  it.each(['parachute', 'streamer', 'shockcord'] as const)(
    'changes pitch/yaw inertia for sideways %s offsets without fin cant', (type) => {
      for (const crossSection of ['rounded', 'airfoil']) {
        const centered = build(type, 0, 0, false, crossSection, 0).staticInfo();
        const atZero = build(type, offset, 0, false, crossSection, 0).staticInfo();
        const sideways = build(type, offset, Math.PI / 2, false, crossSection, 0).staticInfo();
        const expected = partMass * (centered.massEmpty - partMass) / centered.massEmpty * offset ** 2;
        relative(atZero.longitudinalInertiaEmpty, centered.longitudinalInertiaEmpty);
        relative(sideways.longitudinalInertiaEmpty - centered.longitudinalInertiaEmpty, expected);
      }
    });

  it.each(offsetTypes)('places %s mass off axis and respects its direction in radians', (type) => {
    const centered = build(type).staticInfo();
    const shifted = build(type, offset).staticInfo();
    relative(shifted.massEmpty, centered.massEmpty);
    relative(shifted.cg, centered.cg);
    const expected = partMass * (centered.massEmpty - partMass) / centered.massEmpty * offset ** 2;
    relative(shifted.rotationalInertiaEmpty - centered.rotationalInertiaEmpty, expected);

    const aligned = build(type, offset, 0, true).staticInfo();
    const opposed = build(type, offset, Math.PI, true).staticInfo();
    // Equal opposing offsets cancel the radial first moment; aligned ones do not.
    relative(opposed.rotationalInertiaEmpty - aligned.rotationalInertiaEmpty,
      4 * partMass ** 2 * offset ** 2 / aligned.massEmpty);
  });

  it.each(ringTypes)('keeps %s on the centerline like desktop OpenRocket', (type) => {
    for (const ballast of [false, true]) {
      const centered = build(type, 0, 0, ballast).staticInfo();
      for (const direction of [0, Math.PI / 2, Math.PI]) {
        const shifted = build(type, offset, direction, ballast).staticInfo();
        relative(shifted.massEmpty, centered.massEmpty);
        relative(shifted.cg, centered.cg);
        relative(shifted.rotationalInertiaEmpty, centered.rotationalInertiaEmpty);
        relative(shifted.longitudinalInertiaEmpty, centered.longitudinalInertiaEmpty);
      }
    }
  });

  it.each(types.flatMap(type => ['rounded', 'airfoil'].map(crossSection => ({ type, crossSection }))))(
    'flies $type with desktop radial-placement parity and $crossSection freeform fins', ({ type, crossSection }) => {
      const centered = build(type, 0, 0, false, crossSection);
      const shifted = build(type, offset, 0, false, crossSection);
      centered.setMotorById('mount', motor);
      shifted.setMotorById('mount', motor);
      // Keep this short control on the rail so identical times have identical motor masses.
      const options = { launchRodLength: 100, maxTime: 0.4, windAverage: 0, windStdDeviation: 0,
        randomSeed: 42, series: 'full' as const };
      const on = centered.simulate(options), off = shifted.simulate(options);
      expect(off.events.some(event => event.type === 'LIFTOFF')).toBe(true);
      expect(off.series.time.length).toBeGreaterThan(10);
      expect(off.series.time).toEqual(on.series.time);
      for (let i = 0; i < off.series.time.length; i++) {
        const mass = on.series.mass[i]!;
        relative(off.series.mass[i]!, mass);
        relative(off.series.cgLocation[i]!, on.series.cgLocation[i]!);
        if (ringTypes.some(ring => ring === type)) {
          relative(off.series['Ir']![i]!, on.series['Ir']![i]!);
          relative(off.series['Il']![i]!, on.series['Il']![i]!);
        } else {
          // The m/M term checks that roll inertia follows the displaced radial CG.
          relative(off.series['Ir']![i]! - on.series['Ir']![i]!,
            partMass * (mass - partMass) / mass * offset ** 2);
        }
      }
    }, 30_000);
});
