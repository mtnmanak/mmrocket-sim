import { expect, it } from 'vitest';
import { OrkRocket, resetEngine, type RocketTree, type MotorSpec } from '@online-openrocket/engine';
import { engineTree, normalizeTree, referenceArea } from './treeModel.js';

const motor: MotorSpec = { designation: 'audit-C', diameter: 0.018, length: 0.07, cgX: 0.035,
  ejectionDelay: 5, times: [0, 0.05, 0.1, 0.4, 1, 2, 2.5],
  thrusts: [0, 3.8, 11.75, 4, 3.2, 3, 0], masses: [0.021, 0.02, 0.019, 0.016, 0.012, 0.01, 0.009] };
const fixture = (pod: boolean, crossSection: string): RocketTree => ({ name: 'Flight audit', components: [{
  id: 's', type: 'stage', children: [
    { id: 'n', type: 'nosecone', length: 0.08, aftRadius: 0.0145, thickness: 0.001, density: 500 },
    { id: 'b', type: 'bodytube', length: 0.3, outerRadius: 0.0145, thickness: 0.0005, density: 500,
      motorMount: true, children: [
        { id: 'f', type: 'freeformfinset', finCount: 3, thickness: 0.0015, density: 500, crossSection,
          points: [[0.01, 0], [0.03, 0.04], [0.08, 0.04], [0.06, 0]],
          position: { method: 'bottom', offset: 0 } },
        { id: 'chute', type: 'parachute', diameter: 0.3 },
        ...(pod ? [{ id: 'pod', type: 'podset' as const, instanceCount: 2, radiusMethod: 'free', radiusOffset: 0.025,
          position: { method: 'top' as const, offset: 0.1 }, children: [
            { type: 'nosecone' as const, length: 0.03, aftRadius: 0.01, thickness: 0.0003, density: 500 },
            { type: 'transition' as const, length: 0.04, foreRadius: 0.01, thickness: 0.0003, density: 500 },
          ] }, { id: 'bump', type: 'protuberance' as const, dragClass: 'streamlinedbase',
          width: 0.01, height: 0.005, length: 0.02, mass: 0.001, count: 1 }] : []),
      ] },
    ...(pod ? [{ id: 'aft', type: 'bodytube' as const, length: 0.01, outerRadius: 0.0145,
      thickness: 0.0005, density: 500 }] : []),
  ],
}] } as unknown as RocketTree);
function fly(tree: RocketTree) {
  resetEngine();
  const rocket = OrkRocket.buildTree(engineTree(tree));
  rocket.setMotorById('b', motor);
  const info = rocket.staticInfo();
  const result = rocket.simulate({ randomSeed: 42, windAverage: 0, windStdDeviation: 0, launchRodLength: 1 });
  expect(result.summary.maxAltitude).toBeGreaterThan(5);
  return { info, summary: result.summary };
}

it.each(['rounded', 'airfoil'])('S4a-2 shifted %s outline normalization preserves flight', (section) => {
  const tree = fixture(false, section);
  const before = fly(tree), after = fly(normalizeTree(tree));
  console.log('S4a-2', section, JSON.stringify({ before: before.summary, after: after.summary }));
  // Identical kernel geometry; tolerance is much tighter than displayed flight precision.
  expect(after.summary.maxAltitude).toBeCloseTo(before.summary.maxAltitude, 7);
  expect(after.summary.maxVelocity).toBeCloseTo(before.summary.maxVelocity, 7);
}, 30_000);

it('S4a-3 flies the pod automatic-radius fixture with a body-CD protuberance', () => {
  const tree = fixture(true, 'rounded');
  const result = fly(tree);
  console.log('S4a-3', JSON.stringify({ area: referenceArea(tree), ...result }));
  expect(referenceArea(tree)).toBeCloseTo(Math.PI * (result.info.refDiameter / 2) ** 2, 12);
}, 30_000);
