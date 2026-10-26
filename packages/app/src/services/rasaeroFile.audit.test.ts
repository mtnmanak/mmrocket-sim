// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest';
import { importCdx1 } from './rasaeroFile.js';
import { attachedOf, planConfigSwitch, planImport, resolveImportMotors } from './importApply.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { addExMotors, parseEng } from './exMotors.js';
import { captureStageMass } from './stageMassOverrides.js';
import { exportOrk, importOrk } from './orkFile.js';
import { num } from '../tree/nodeNum.js';
import { reconcileAllIncludedMotors, reconcileIncludedMotor, OVERRIDE_INCLUDES_MOTOR, STATED_STAGE_FIGURES } from './statedLaunchWeight.js';

const TEXT = { mass: (n: number) => `${n} kg`, length: (n: number) => `${n} m` };
const LB = 2.20462262;
const IN = 39.37;
const simulation = (motor: string, weight = 10, cg = 0.7) => `<Simulation>
  <SustainerEngine>${motor}</SustainerEngine><SustainerLaunchWt>${weight * LB}</SustainerLaunchWt>
  <SustainerCG>${cg * IN}</SustainerCG></Simulation>`;
const file = (...sims: string[]) => `<RASAeroDocument><RocketDesign>
  <NoseCone><Length>${0.2 * IN}</Length><Diameter>4</Diameter><Shape>Conical</Shape></NoseCone>
  <BodyTube><Length>${IN}</Length><Diameter>4</Diameter></BodyTube>
  </RocketDesign><SimulationList>${sims.join('')}</SimulationList></RASAeroDocument>`;
const motor = (designation: string, launchMassKg: number) => ({
  designation, launchMassKg, lengthM: 0.4, cgXFromFrontM: 0.2,
});
beforeEach(() => localStorage.clear());

it.each(['overrideSubcomponentsMass', 'overrideSubcomponentsCG'])(
  'keeps unresolved launch provenance across capture and reopen with unticked %s', flag => {
    const imported = importCdx1(file(simulation('M787  (KIP)')));
    const stage = { ...imported.tree.components[0]!, [flag]: false };
    const snapshot = captureStageMass(stage);
    expect(snapshot.overrideIncludesMotor).toBe('M787');
    expect(snapshot.statedStageFigures).toMatchObject({ includesMotor: true, motor: 'M787' });
    const reopened = importOrk(exportOrk({ name: 'Unresolved', tree: { ...imported.tree, components: [stage] },
      activeConfigId: 'c', configs: [{ id: 'c', name: null, isDefault: true, motors: {},
        stageMassOverrides: { [stage.id!]: snapshot } }] }));
    const restored = captureStageMass(reopened.tree.components[0]!);
    expect(restored).toEqual({ overrideMass: 10, overrideCGX: 0.7, overrideIncludesMotor: 'M787',
      [flag === 'overrideSubcomponentsMass' ? 'overrideSubcomponentsCG' : 'overrideSubcomponentsMass']: true,
      statedStageFigures: { motor: 'M787', includesMotor: true, launchKg: 10, massKg: 10, launchCgM: 0.7, cgM: 0.7 } });
    const mount = reopened.tree.components[0]!.children!.find(c => c['motorMount'])!.id!;
    const changed = reconcileIncludedMotor(reopened.tree, mount, motor('M1297', 1), TEXT)!;
    expect(changed.tree.components[0]!['overrideMass']).toBeUndefined();
    expect(changed.tree.components[0]!['overrideCGX']).toBeUndefined();
    expect(changed.severity).toBe('warn');
  });

it('S1c-1 backs out the same-maker EX motor despite a differently named catalogue fallback', async () => {
  addExMotors(parseEng('K1075-SK 54 400 P 0.5 1.5 CTI\n0 0\n0.1 2000\n2 0'));
  const imported = importCdx1(file(simulation('K1075-SK  (CTI)')));
  const plan = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text: TEXT });
  const mounted = Object.values(plan.snapshot.mountMotors)[0]!;
  expect(mounted.spec.designation).toBe('K1075-SK');
  expect(mounted.spec.masses[0]).toBe(1.5);
  const stage = plan.snapshot.tree.components[0]!;
  expect(num(stage, 'overrideMass', NaN)).toBeCloseTo(8.5, 10);
  // 10 kg at 0.7 m, less 1.5 kg at 1.0 m, leaves 5.5 kg m / 8.5 kg.
  expect(num(stage, 'overrideCGX', NaN)).toBeCloseTo(5.5 / 8.5, 10);
  const id = Object.keys(plan.snapshot.mountMotors)[0]!;
  const repick = reconcileIncludedMotor(plan.snapshot.tree, id, motor('K1075-SK', 2), TEXT)!;
  expect(num(repick.tree.components[0]!, 'overrideMass', NaN)).toBeCloseTo(8, 10);
});

it.each([
  { rejected: 'mass and CG', weight: 2, cg: 0.9, dry: 0.5, dryCg: 0.6 },
  { rejected: 'only CG', weight: 10, cg: 0.2, dry: 8.5, dryCg: 0.5 / 8.5 },
].flatMap(fixture => ['EX first', 'fallback first'].map(order => ({ ...fixture, order }))))(
  'S1c-1 recovers when the catalogue fallback rejected $rejected ($order)', async ({ weight, cg, dry, dryCg, order }) => {
    const loadEx = () => addExMotors(parseEng('K1075-SK 54 400 P 0.5 1.5 CTI\n0 0\n0.1 2000\n2 0'));
    if (order === 'EX first') loadEx();
    const imported = importCdx1(file(simulation('K1075-SK  (CTI)', weight, cg)));
    const before = imported.tree.components[0]!;
    expect(before['overrideCGX']).toBeUndefined();
    if (weight === 2) expect(before['overrideMass']).toBeUndefined();
    else expect(num(before, 'overrideMass', NaN)).toBeCloseTo(7.3612, 10);

    const plan = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text: TEXT });
    const id = Object.keys(plan.snapshot.mountMotors)[0]!;
    let tree = plan.snapshot.tree;
    let loaded = plan.snapshot.mountMotors[id]!;
    if (order === 'fallback first') {
      expect(loaded.spec.designation).toBe('2245K1075-P');
      expect(tree.components[0]!['overrideCGX']).toBeUndefined();
      if (weight === 2) expect(tree.components[0]!['overrideMass']).toBeUndefined();
      else expect(num(tree.components[0]!, 'overrideMass', NaN)).toBeCloseTo(7.3612, 10);
      loadEx();
      loaded = (await resolveImportMotors(imported)).working[id]!.motor!;
      // Keep the tree that was actually opened with the fallback; do not re-import.
      tree = reconcileIncludedMotor(tree, id, attachedOf(loaded.spec), TEXT)?.tree ?? tree;
    }
    expect(loaded.spec.designation).toBe('K1075-SK');
    expect(loaded.spec.masses[0]).toBe(1.5);
    const stage = tree.components[0]!;
    expect(num(stage, 'overrideMass', NaN)).toBeCloseTo(dry, 10);
    // Subtract the EX motor's 1.5 kg m moment from the stated launch moment.
    expect(num(stage, 'overrideCGX', NaN)).toBeCloseTo(dryCg, 10);
    expect(stage['overrideSubcomponentsMass']).toBe(true);
    expect(stage['overrideSubcomponentsCG']).toBe(true);
    expect(reconcileIncludedMotor(tree, id, attachedOf(loaded.spec), TEXT)).toBeNull();
  });

it.each([
  { edit: 'typed pending mass', weight: 2, field: 'overrideMass', value: 0.4, recover: false },
  { edit: 'typed pending CG', weight: 10, field: 'overrideCGX', value: 0.3, recover: false },
  { edit: 'cleared fallback mass', weight: 10, field: 'overrideMass', value: undefined, recover: false },
  { edit: 'cleared recovered CG', weight: 10, field: 'overrideCGX', value: undefined, recover: true },
])('S1c-1 respects a user-$edit after fallback reconciliation', async ({ weight, field, value, recover }) => {
  const imported = importCdx1(file(simulation('K1075-SK  (CTI)', weight, 0.2)));
  const plan = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text: TEXT });
  const id = Object.keys(plan.snapshot.mountMotors)[0]!;
  addExMotors(parseEng('K1075-SK 54 400 P 0.5 1.5 CTI\n0 0\n0.1 2000\n2 0'));
  const loaded = (await resolveImportMotors(imported)).working[id]!.motor!;
  const attached = attachedOf(loaded.spec);
  const tree = recover ? reconcileIncludedMotor(plan.snapshot.tree, id, attached, TEXT)!.tree : plan.snapshot.tree;
  expect(captureStageMass(tree.components[0]!).statedStageFigures).toBeDefined();
  const stage = { ...tree.components[0]!, [field]: value };
  const edited = { ...tree, components: [stage] };
  const result = reconcileIncludedMotor(edited, id, attached, TEXT)!;
  expect(result.tree.components[0]).toEqual({ ...stage, [STATED_STAGE_FIGURES]: undefined });
  expect(result.note).toBeNull();
  expect(captureStageMass(stage).statedStageFigures).toBeUndefined();
  expect(reconcileIncludedMotor(result.tree, id, attached, TEXT)).toBeNull();
});

it('S7b-1 re-picking an initially unresolved motor updates mass and CG again', () => {
  const imported = importCdx1(file(simulation('M787  (KIP)')));
  const id = Object.keys(imported.motors)[0]!;
  const first = reconcileIncludedMotor(imported.tree, id, motor('M787', 1), TEXT)!;
  expect(num(first.tree.components[0]!, 'overrideMass', NaN)).toBeCloseTo(9, 10);
  const second = reconcileAllIncludedMotors(first.tree, { [id]: motor('M787', 2) }, TEXT);
  expect(num(second.tree.components[0]!, 'overrideMass', NaN)).toBeCloseTo(8, 10);
  expect(num(second.tree.components[0]!, 'overrideCGX', NaN)).toBeCloseTo(5 / 8, 10);
  expect(second.notes).toHaveLength(1);
  expect(reconcileAllIncludedMotors(second.tree, { [id]: motor('M787', 2) }, TEXT).tree).toBe(second.tree);
});

it.each(['overrideSubcomponentsMass', 'overrideSubcomponentsCG'])(
  'S7b-2 leaves a user-disabled %s untouched and drops the record', flag => {
    const imported = importCdx1(file(simulation('K62N  (AT)')));
    const stage = { ...imported.tree.components[0]!, [flag]: undefined };
    const changed = { ...imported.tree, components: [stage] };
    const id = Object.keys(imported.motors)[0]!;
    const result = reconcileIncludedMotor(changed, id, motor('K62N', 2), TEXT)!;
    expect(result.tree.components[0]).toEqual({ ...stage, [STATED_STAGE_FIGURES]: undefined });
    expect(result.note).toBeNull();
    expect(captureStageMass(stage).statedStageFigures).toBeUndefined();
  });

it('S1c-3 warns when switching to a configuration whose stated weight was rejected', async () => {
  const imported = importCdx1(file(simulation('K62N  (AT)'), simulation('K62N  (AT)', 0.1)));
  const plan = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text: TEXT });
  const state = { ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs };
  const switched = planConfigSwitch(state, state.savedConfigs[1]!, TEXT);
  expect(switched.tree.components[0]!['overrideMass']).toBeUndefined();
  expect(switched.note.text).toContain('NOT applied');
  expect(switched.note.text).toContain('which is not a mass');
  expect(switched.note.severity).toBe('warn');
});

it('S1c-3 carries motor-inclusive weight diagnostics onto configuration switches', async () => {
  const imported = importCdx1(file(simulation('K62N  (AT)'), simulation('M787  (KIP)')));
  const plan = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text: TEXT });
  const state = { ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs };
  const switched = planConfigSwitch(state, state.savedConfigs[1]!, TEXT);
  expect(switched.note.text).toContain('Applied WITH the motor still included');
  expect(switched.note.severity).toBe('warn');
});

it('S1c-3 names a booster weight below the stack above when its configuration is applied', async () => {
  const sim = (weight: number) => simulation('K62N  (AT)').replace('</Simulation>',
    `<IncludeBooster1>True</IncludeBooster1><Booster1LaunchWt>${weight * LB}</Booster1LaunchWt></Simulation>`);
  const xml = file(sim(20), sim(9)).replace('</RocketDesign>',
    '<Booster><Length>30</Length><Diameter>4</Diameter></Booster></RocketDesign>');
  const imported = importCdx1(xml);
  const plan = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text: TEXT });
  const state = { ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs };
  expect(state.tree.components[1]!['overrideMass']).toBeCloseTo(10, 10);
  const switched = planConfigSwitch(state, state.savedConfigs[1]!, TEXT);
  expect(switched.tree.components[1]!['overrideMass']).toBeUndefined();
  expect(switched.note.text).toContain('LESS than');
  expect(switched.note.text).toContain('stack above');
  expect(switched.note.severity).toBe('warn');
});

it('S1c-6 reports an unknown nose shape and the tangent-ogive fallback', () => {
  const imported = importCdx1(file().replace('<Shape>Conical</Shape>', '<Shape>Parabola</Shape>'));
  expect(imported.tree.components[0]!.children![0]!.shape).toBe('ogive');
  expect(imported.notes.join(' ')).toMatch(/Parabola.*[Tt]angent ogive/);
});

it.each(['overrideSubcomponentsMass', 'overrideSubcomponentsCG'])(
  'round1 S7b-1 backs out the motor while keeping an unticked %s', flag => {
    const imported = importCdx1(file(simulation('M787  (KIP)')));
    const stage = { ...imported.tree.components[0]!, [flag]: false };
    expect(stage[OVERRIDE_INCLUDES_MOTOR]).toBeDefined();
    const tree = { ...imported.tree, components: [stage] };
    const id = Object.keys(imported.motors)[0]!;
    const result = reconcileIncludedMotor(tree, id, motor('M787', 1), TEXT)!;
    expect(num(result.tree.components[0]!, 'overrideMass', NaN)).toBeCloseTo(9, 10);
    expect(num(result.tree.components[0]!, 'overrideCGX', NaN)).toBeCloseTo(6 / 9, 10);
    expect(result.tree.components[0]![flag]).toBe(false);
    expect(result.tree.components[0]![OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
    expect(result.note).toContain('taken back out');
    expect(result.note).toContain('kept unticked');
    expect(result.tree.components[0]![STATED_STAGE_FIGURES]).toBeUndefined();
    expect(reconcileIncludedMotor(result.tree, id, motor('M787', 2), TEXT)).toBeNull();
  });

it('round1 S7b-1 rejects the same CG only once and recovers after a corrected pick', () => {
  const imported = importCdx1(file(simulation('M787  (KIP)', 10, 0.2)));
  const id = Object.keys(imported.motors)[0]!;
  const first = reconcileIncludedMotor(imported.tree, id, motor('M787', 3), TEXT)!;
  expect(first.tree.components[0]!['overrideCGX']).toBeUndefined();
  expect(reconcileIncludedMotor(first.tree, id, motor('M787', 3), TEXT)).toBeNull();
  const second = reconcileIncludedMotor(first.tree, id, motor('M787', 1), TEXT)!;
  expect(num(second.tree.components[0]!, 'overrideMass', NaN)).toBeCloseTo(9, 10);
  expect(num(second.tree.components[0]!, 'overrideCGX', NaN)).toBeCloseTo(1 / 9, 10);
});

it.each(['overrideSubcomponentsMass', 'overrideSubcomponentsCG', 'both'])(
  'round2 reports absent %s flags and retains no unusable restatement record', flag => {
    const imported = importCdx1(file(simulation('M787  (KIP)')));
    const stage = { ...imported.tree.components[0]! };
    if (flag !== 'overrideSubcomponentsCG') delete stage['overrideSubcomponentsMass'];
    if (flag !== 'overrideSubcomponentsMass') delete stage['overrideSubcomponentsCG'];
    const id = Object.keys(imported.motors)[0]!;
    const result = reconcileIncludedMotor({ ...imported.tree, components: [stage] }, id, motor('M787', 1), TEXT)!;
    const corrected = result.tree.components[0]!;
    expect(num(corrected, 'overrideMass', NaN)).toBeCloseTo(9, 10);
    expect(num(corrected, 'overrideCGX', NaN)).toBeCloseTo(6 / 9, 10);
    expect(corrected[STATED_STAGE_FIGURES]).toBeUndefined();
    expect(result.note).toContain(flag === 'both' ? 'boxes have been kept unticked' : 'box has been kept unticked');
    expect(reconcileIncludedMotor(result.tree, id, motor('M787', 2), TEXT)).toBeNull();
  });

it.each([false, undefined])('round2 omits the unticked CG note when the CG override was rejected (%s)', flag => {
  const imported = importCdx1(file(simulation('M787  (KIP)', 10, 0.2)));
  const stage = { ...imported.tree.components[0]!, overrideSubcomponentsCG: flag };
  const id = Object.keys(imported.motors)[0]!;
  const result = reconcileIncludedMotor({ ...imported.tree, components: [stage] }, id, motor('M787', 3), TEXT)!;
  expect(result.tree.components[0]!['overrideCGX']).toBeUndefined();
  expect(result.tree.components[0]![STATED_STAGE_FIGURES]).toBeUndefined();
  expect(result.note).toContain('CG override has been cleared');
  expect(result.note).not.toContain('kept unticked');
  expect(reconcileIncludedMotor(result.tree, id, motor('M787', 3), TEXT)).toBeNull();
});
