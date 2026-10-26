// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { typedPadMass, dropPadMass, legacyPadMassWrite } from './padMassReconcile.js';
import { withoutStoredRef } from './configSync.js';
import { previewMounts } from '../tree/scaleRocket.js';
import { resolveImportMotors, planImport, planConfigSwitch } from './importApply.js';
import { parseEng, exToMotorSpec } from './exMotors.js';
import { mountMotorFromDb } from './motorMatch.js';
import { findDbMotor } from './motorDb.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

it.each(['constructor', 'toString', '__proto__'])('pad-mass editing cannot invent a motor for %s', id => {
  const motors = {};
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', id, motorMount: true }] }] };
  expect(typedPadMass(tree, id, 1, 'weighed')(motors)).toBe(motors);
  expect(dropPadMass(id)(motors)).toBe(motors);
  expect(legacyPadMassWrite({ kind: 'rekey', mountId: id, key: 'weighed', note: { text: 'rekey', severity: 'info', tier: 'information' } }).motors(motors)).toBe(motors);
});

it.each(['constructor', 'toString', '__proto__'])('leaves unowned stored reference %s unchanged', id => {
  const configs = [{ id: 'a', name: 'A', isDefault: true, motors: {}, unmatchedRefs: {}, unmatched: ['keep'] }];
  expect(withoutStoredRef(configs, 'a', id)).toBe(configs);
});

it.each(['constructor', 'toString', '__proto__'])('scales mount %s without an inherited custom choice', id => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 1, outerRadius: 0.05,
    children: [{ type: 'innertube', id, length: 0.1, outerRadius: 0.01, thickness: 0.001, motorMount: true }] }] }] };
  const actual = previewMounts(tree, 2, { mountChoices: {} });
  const normal = structuredClone(tree);
  normal.components[0]!.children![0]!.children![0]!.id = 'ordinary';
  expect(actual.map(m => ({ ...m, id: 'same' }))).toEqual(previewMounts(normal, 2).map(m => ({ ...m, id: 'same' })));
});

it.each(['constructor', 'toString', '__proto__'])('resolves and applies imported config and mount keys %s', async id => {
  const motor = parseEng('Test 29 100 5 0.01 0.02 Home\n0 0\n0.1 10\n1 0')[0]!;
  const loaded = mountMotorFromDb(findDbMotor('H128W')!, exToMotorSpec(motor, 5), 5, { event: 'automatic', delay: 0 });
  const ref = { manufacturer: 'Home', designation: 'Test', diameter: 0.029, length: 0.1, delay: 5 };
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id, motorMount: true }] }] };
  const imported = { name: 'Imported', tree, notes: [], motors: { [id]: ref }, configs: [{ id, name: 'A', isDefault: true, motors: { [id]: ref }, deployments: {}, separations: {} }] };
  const resolved = await resolveImportMotors(imported, async () => ({ motor: loaded, note: '' }));
  expect(Object.hasOwn(resolved.working, id)).toBe(true);
  expect(Object.hasOwn(resolved.configs, id)).toBe(true);
  expect(Object.hasOwn(resolved.configResults!, id)).toBe(true);
  const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } });
  expect(Object.hasOwn(plan.snapshot.mountMotors, id)).toBe(true);
  expect(Object.hasOwn(plan.snapshot.savedConfigs[0]!.motors, id)).toBe(true);
});

it.each(['constructor', 'toString', '__proto__'])('configuration switching seeds only an owned nozzle for %s', id => {
  const motor = parseEng('Test 29 100 5 0.01 0.02 Home\n0 0\n0.1 10\n1 0')[0]!;
  const loaded = mountMotorFromDb(findDbMotor('H128W')!, exToMotorSpec(motor, 5), 5, { event: 'automatic', delay: 0 });
  const tree: RocketTree = { components: [{ type: 'stage', id, children: [{ type: 'bodytube', id: 'm', motorMount: true }] }] };
  const config = { id: 'a', name: 'A', isDefault: true, motors: { m: loaded }, nozzles: {} };
  const plan = planConfigSwitch({ tree, mountMotors: {}, savedConfigs: [config], activeConfigId: null, unmatchedRefs: {} }, config, { mass: String, length: String });
  expect(plan.nozzleStated).toEqual([]);
});
