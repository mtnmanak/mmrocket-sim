import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { motorisedStagesWithNozzle } from '../tree/treeModel.js';
import { stageMotors } from './nozzleFollow.js';
import { testMotor } from './autoDelay.testSupport.js';

it.each(['burnout', 'ejectioncharge'] as const)('r3 routes %s from parallel booster to its core, never the reverse', event => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 'core', nozzleExitDiameter: 0.02, children: [
    { type: 'innertube', id: 'cm', motorMount: true },
    { type: 'parallelstage', id: 'strap', nozzleExitDiameter: 0.02, children: [
      { type: 'innertube', id: 'sm', motorMount: true },
    ] },
  ] }, { type: 'stage', id: 'lower' }] };
  const motor = { ...testMotor(false, 5), ignition: { event, delay: 0 } };
  const assigned: [string, typeof motor][] = [['cm', motor], ['sm', motor]];
  const loadout = stageMotors(tree, assigned);
  expect(loadout.find(s => s.stageId === 'strap')?.motors).toEqual([]);
  // On a launch-stage core its attached booster still supplies the trigger.
  tree.components.pop();
  expect(stageMotors(tree, assigned).find(s => s.stageId === 'core')?.motors.map(m => m.mountId)).toEqual(['cm']);
  expect(motorisedStagesWithNozzle(tree, assigned).map(s => s.name)).toEqual(['Stage 1']);
});
