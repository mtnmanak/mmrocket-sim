// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { importCdx1 } from './rasaeroFile.js';
import { exportOrk, importOrk } from './orkFile.js';
import { orkMotorSet } from './orkExportMotors.js';
import { applyConfigSwitchPlan, planConfigSwitch, planImport, planOrkSave, resolveImportMotors, type ImportedDesign } from './importApply.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { padMassSetKey, withActiveConfigTreeSynced } from './configSync.js';
import { primaryMountOf, addStage, removeNode } from '../tree/treeModel.js';
import { reconcileIncludedMotor } from './statedLaunchWeight.js';
import { applyStageMass, captureStageMass } from './stageMassOverrides.js';
import { useTreeHistory, type TreeHistory } from '../hooks/useTreeHistory.js';

const TEXT = { mass: (n: number) => `${n} kg`, length: (n: number) => `${n} m` };
const sim = (motor: string, weight: number, cg: number) => `<Simulation>
  <SustainerEngine>${motor}</SustainerEngine><SustainerLaunchWt>${weight}</SustainerLaunchWt>
  <SustainerCG>${cg}</SustainerCG></Simulation>`;
const A = sim('K250W  (AT)', 9, 40);
const B = sim('L1000  (AT)', 10, 43);
const cdx = (...sims: string[]) => `<RASAeroDocument><RocketDesign>
  <NoseCone><PartType>NoseCone</PartType><Length>10</Length><Diameter>3</Diameter><Shape>Conical</Shape></NoseCone>
  <BodyTube><PartType>BodyTube</PartType><Length>60</Length><Diameter>3</Diameter></BodyTube>
  </RocketDesign><SimulationList>${sims.join('')}</SimulationList></RASAeroDocument>`;
async function open(imported: ImportedDesign) {
  const p = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text: TEXT });
  return { ...p.snapshot, unmatchedRefs: p.unmatchedRefs };
}
type State = Awaited<ReturnType<typeof open>>;
const switchTo = (s: State, index: number): State => ({ ...s, ...planConfigSwitch(s, s.savedConfigs[index]!, TEXT) });
function built(s: State) {
  const b = buildDesign({ tree: s.tree, assigned: Object.entries(s.mountMotors), kbf: false, supersonic: false,
    measuredDryMassKg: null, primaryMountId: primaryMountOf(s.tree, Object.keys(s.mountMotors)),
    currentSetKey: padMassSetKey(s.tree, s.mountMotors) }, KERNEL_HANDLES);
  if ('error' in b) throw new Error(b.error);
  expect(b.motorFailures).toEqual([]);
  return b.info;
}
function expectStated(s: State, pounds: number, inches: number) {
  const info = built(s);
  // 10 milligrams / 10 micrometres cover source conversion rounding and kernel last bits.
  expect(Math.abs(info.mass - pounds * 0.45359237)).toBeLessThan(1e-5);
  expect(Math.abs(info.cg - inches * 0.0254)).toBeLessThan(1e-5);
}
function save(s: State) {
  const configs = planOrkSave(s, s.unmatchedRefs).savedConfigs;
  const motors = (records: State['mountMotors'], configKey: string) => orkMotorSet({
    records, tree: s.tree, configKey, exLibrary: () => [], first: 'records',
  });
  return exportOrk({ name: 'synthetic', tree: s.tree, activeConfigId: s.activeConfigId,
    motors: motors(s.mountMotors, s.activeConfigId ?? ''),
    configs: configs.map(c => ({ ...c, motors: motors(c.motors, c.id) })),
  });
}
afterEach(() => vi.unstubAllGlobals());

it('round 3: added-stage edits survive A to minted C to A after save and reopen', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const added = addStage(a.tree);
  a.tree = applyStageMass(added.tree, { [added.newId]: { overrideMass: 31, overrideCGX: 1.2 } });
  // Apply None writes back A, then loading a motor makes Save mint C.
  const none = { ...a, savedConfigs: planOrkSave(a, a.unmatchedRefs).savedConfigs,
    activeConfigId: null, mountMotors: {} };
  const custom = { ...none, mountMotors: a.mountMotors };
  const reopened = await open(importOrk(save(custom)));
  expect(reopened.savedConfigs).toHaveLength(3);
  const restoredId = reopened.tree.components.at(-1)!.id!;
  const activeA = switchTo(reopened, 0);
  activeA.tree = applyStageMass(activeA.tree, { [restoredId]: { overrideMass: 32, overrideCGX: 1.3 } });
  const activeC = switchTo(activeA, 2);
  expect(captureStageMass(activeC.tree.components.at(-1)!)).toMatchObject({ overrideMass: 31, overrideCGX: 1.2 });
  expect(captureStageMass(switchTo(activeC, 0).tree.components.at(-1)!))
    .toMatchObject({ overrideMass: 32, overrideCGX: 1.3 });
  for (const c of reopened.savedConfigs) {
    expect(c.stageMassOverrides).toHaveProperty(restoredId);
  }
});

it('round 3: direct export completes partial maps before minting, including empty stages', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const added = addStage(a.tree);
  const original = structuredClone(a.savedConfigs);
  // Exercise the common writer without planOrkSave, with no active config.
  const xml = exportOrk({ name: 'partial', tree: added.tree, activeConfigId: null,
    motors: orkMotorSet({ records: a.mountMotors, tree: added.tree, configKey: '',
      exLibrary: () => [], first: 'records' }),
    configs: a.savedConfigs.map(c => ({ ...c, motors: {} })),
  });
  const reopened = await open(importOrk(xml));
  const id = reopened.tree.components.at(-1)!.id!;
  for (const c of reopened.savedConfigs) expect(c.stageMassOverrides![id]).toEqual({});
  const edited = switchTo(reopened, 0);
  edited.tree = applyStageMass(edited.tree, { [id]: { overrideMass: 32, overrideCGX: 1.3 } });
  expect(captureStageMass(switchTo(edited, 2).tree.components.at(-1)!)).toEqual({});
  expect(a.savedConfigs).toEqual(original);
});

it('round 3: sync completes every snapshot map even under None and retains deleted entries', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const added = addStage(a.tree);
  const tree = applyStageMass(added.tree, { [added.newId]: { overrideMass: 31, overrideCGX: 1.2 } });
  const configs: State['savedConfigs'] = a.savedConfigs.map(c => ({ ...c, stageMassOverrides: {
    ...c.stageMassOverrides, deleted: { overrideMass: 7 },
  } }));
  const completed = withActiveConfigTreeSynced(configs, null, tree);
  for (const c of completed) {
    expect(c.stageMassOverrides![added.newId]).toEqual({ overrideMass: 31, overrideCGX: 1.2 });
    expect(c.stageMassOverrides!['deleted']).toEqual({ overrideMass: 7 });
    expect(c.stageMassOverrides![tree.components[0]!.id!])
      .toEqual(configs.find(original => original.id === c.id)!.stageMassOverrides![tree.components[0]!.id!]);
  }
  expect(withActiveConfigTreeSynced(completed, null, tree)).toBe(completed);
  const snapshotFree = [{ ...a.savedConfigs[0]!, stageMassOverrides: undefined }];
  expect(withActiveConfigTreeSynced(snapshotFree, null, tree)).toBe(snapshotFree);
});

it('round 2: a custom loadout saved after Apply None owns a complete live snapshot', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const stage = a.tree.components[0]!;
  const custom = { ...a, activeConfigId: null,
    tree: { ...a.tree, components: [{ ...stage, overrideMass: 3, overrideCGX: 0.8 }] } };
  const reopened = await open(importOrk(save(custom)));
  expect(reopened.savedConfigs).toHaveLength(3);
  const live = captureStageMass(reopened.tree.components[0]!);
  expect(live).toMatchObject({ overrideMass: 3, overrideCGX: 0.8 });
  expect(captureStageMass(switchTo(switchTo(reopened, 1), 2).tree.components[0]!)).toEqual(live);
  const empty = { ...custom, tree: applyStageMass(custom.tree, { [stage.id!]: {} }) };
  const cleared = await open(importOrk(save(empty)));
  expect(captureStageMass(switchTo(switchTo(cleared, 1), 2).tree.components[0]!)).toEqual({});
});

it('round 2: deletion retains snapshots for undo, then a configuration switch prunes them', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const added = addStage(a.tree);
  a.tree = applyStageMass(added.tree, { [added.newId]: { overrideMass: 31, overrideCGX: 1.2 } });
  a.savedConfigs = a.savedConfigs.map(c => ({ ...c, stageMassOverrides: {
    ...c.stageMassOverrides, [added.newId]: { overrideMass: 31, overrideCGX: 1.2 },
  } }));
  let h: TreeHistory;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  function Probe() { h = useTreeHistory(a.tree); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(<Probe />));
    act(() => h.setTree(removeNode(h.tree, added.newId)));
    const retained = withActiveConfigTreeSynced(a.savedConfigs, a.activeConfigId, h!.tree);
    expect(retained[0]!.stageMassOverrides![added.newId]).toMatchObject({ overrideMass: 31 });
    act(() => h.undo());
    expect(captureStageMass(h!.tree.components.at(-1)!)).toMatchObject({ overrideMass: 31, overrideCGX: 1.2 });
    act(() => h.redo());
    const switched = switchTo({ ...a, tree: h!.tree, savedConfigs: retained }, 1);
    for (const c of switched.savedConfigs) expect(c.stageMassOverrides).not.toHaveProperty(added.newId);
  } finally { act(() => root.unmount()); }
});

it('opens, switches, switches back, and opens in reverse with each simulation own mass and CG', async () => {
  const first = await open(importCdx1(cdx(A, B)));
  expectStated(first, 9, 40);
  const second = switchTo(first, 1);
  expectStated(second, 10, 43);
  expectStated(switchTo(second, 0), 9, 40);
  const reverse = await open(importCdx1(cdx(B, A)));
  expectStated(reverse, 10, 43);
  expectStated(switchTo(reverse, 1), 9, 40);
});

it('clears absent target overrides and preserves edited or removed overrides on switching back', async () => {
  const a = await open(importCdx1(cdx(A, sim('L1000  (AT)', 0, 0))));
  const b = switchTo(a, 1);
  expect(captureStageMass(b.tree.components[0]!)).toEqual({});
  expectStated(switchTo(b, 0), 9, 40);
  const stage = a.tree.components[0]!;
  const edited = { ...a, tree: { ...a.tree, components: [{ ...stage, overrideMass: 3, overrideCGX: 0.8 }] } };
  const returned = switchTo(switchTo(edited, 1), 0);
  expect(captureStageMass(returned.tree.components[0]!)).toMatchObject({ overrideMass: 3, overrideCGX: 0.8 });
  const cleared = { ...a, tree: applyStageMass(a.tree, { [stage.id!]: {} }) };
  expect(captureStageMass(switchTo(switchTo(cleared, 1), 0).tree.components[0]!)).toEqual({});
});

it('a swap after switching keeps dry overrides and never subtracts a second motor', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const b = switchTo(a, 1);
  const id = Object.keys(b.mountMotors)[0]!;
  const replacement = a.mountMotors[id]!;
  expect(reconcileIncludedMotor(b.tree, id, { designation: replacement.spec.designation,
    launchMassKg: replacement.spec.masses[0]!, lengthM: replacement.spec.length,
    cgXFromFrontM: replacement.spec.cgX }, TEXT)).toBeNull();
  const swapped = { ...b, mountMotors: { [id]: replacement } };
  const info = built(swapped);
  expect(info.mass).toBeCloseTo(built(b).massEmpty + replacement.spec.masses[0]!, 7);
  expect(built(switchTo(switchTo(swapped, 0), 1)).mass).toBeCloseTo(info.mass, 7);
});

it('restores unresolved motor marks, refuses unrelated motors, and spends matching marks once', async () => {
  vi.stubGlobal('fetch', async () => { throw new Error('unavailable synthetic motor'); });
  const a = await open(importCdx1(cdx(A, sim('Z999TEST  (EX)', 10, 43))));
  const b = switchTo(a, 1);
  const id = Object.keys(b.unmatchedRefs)[0]!;
  expect(b.tree.components[0]!['overrideIncludesMotor']).toBe('Z999TEST');
  const motor = { designation: 'Z999TEST', launchMassKg: 1, lengthM: 0.3, cgXFromFrontM: 0.15 };
  const corrected = reconcileIncludedMotor(b.tree, id, motor, TEXT)!;
  expect(corrected.tree.components[0]!['overrideMass']).toBeCloseTo(10 * 0.45359237 - 1, 6);
  expect(reconcileIncludedMotor(corrected.tree, id, motor, TEXT)).toBeNull();
  const unrelated = reconcileIncludedMotor(b.tree, id, { ...motor, designation: 'K250W' }, TEXT)!;
  expect(captureStageMass(unrelated.tree.components[0]!)).toEqual({});
  const back = switchTo(switchTo({ ...b, tree: corrected.tree }, 0), 1);
  expect(captureStageMass(back.tree.components[0]!)).toEqual(captureStageMass(corrected.tree.components[0]!));
});

it('saves both configurations while B is active and opens/switches their own overrides', async () => {
  const b = switchTo(await open(importCdx1(cdx(A, B))), 1);
  const xml = save(b);
  expect(xml).toContain('<stagemassconfiguration');
  const reopened = await open(importOrk(xml));
  expectStated(reopened, 10, 43);
  expectStated(switchTo(reopened, 0), 9, 40);
  expectStated(switchTo(switchTo(reopened, 0), 1), 10, 43);
  expectStated(await open(importOrk(xml, { configId: b.savedConfigs[0]!.id })), 9, 40);
});

it('empty saved snapshots clear bare values; CG-only marks survive; ordinary overrides stay global', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const stage = a.tree.components[0]!;
  const values = { overrideCGX: 0.8, overrideSubcomponentsCG: true, overrideIncludesMotor: 'Z999TEST' };
  const configs = a.savedConfigs.map((c, i) => ({ ...c, stageMassOverrides: { [stage.id!]: i === 0 ? {} : values } }));
  const xml = exportOrk({ name: 'snapshot', tree: a.tree, configs: configs.map(c => ({ ...c, motors: {} })) });
  expect(captureStageMass(importOrk(xml, { configId: configs[0]!.id }).tree.components[0]!)).toEqual({});
  expect(captureStageMass(importOrk(xml, { configId: configs[1]!.id }).tree.components[0]!)).toEqual(values);
  const noConfig = { name: 'normal', components: [{ type: 'stage' as const, id: 's', overrideMass: 2 }] };
  expect(applyStageMass(noConfig)).toBe(noConfig);
  expect(captureStageMass({ overrideMass: NaN, overrideCGX: Infinity, overrideIncludesMotor: 'stale' })).toEqual({});
  const untouched = applyStageMass(noConfig, { other: {} });
  expect(untouched.components[0]).toBe(noConfig.components[0]);
  expect(captureStageMass({ overrideMass: 0, overrideCGX: 0, overrideSubcomponentsMass: false,
    overrideSubcomponentsCG: false, overrideCD: 2 })).toEqual({ overrideMass: 0, overrideCGX: 0,
    overrideSubcomponentsMass: false, overrideSubcomponentsCG: false });
});

it('the writer takes live active edits even before sync, preserving the inactive snapshot', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  const stage = a.tree.components[0]!;
  const live = { ...stage, overrideMass: 3, overrideCGX: 0.7 };
  const notes: string[] = [];
  const xml = exportOrk({ name: 'live', tree: { ...a.tree, components: [live] },
    activeConfigId: a.activeConfigId, notes,
    configs: a.savedConfigs.map(c => ({ ...c, motors: {} })),
  });
  expect(captureStageMass(importOrk(xml).tree.components[0]!)).toEqual(captureStageMass(live));
  expect(notes.join(' ')).toContain('OpenRocket desktop uses the active configuration');
  const inactive = importOrk(xml, { configId: a.savedConfigs[1]!.id });
  expect(captureStageMass(inactive.tree.components[0]!)).toEqual(a.savedConfigs[1]!.stageMassOverrides![stage.id!]);
});

it('switch resets undo and redo so neither restores previous overrides under the new motor', async () => {
  const a = await open(importCdx1(cdx(A, B)));
  let h: TreeHistory;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  function Probe() { h = useTreeHistory(a.tree); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(<Probe />));
    act(() => h.setTree({ ...a.tree, name: 'edited' }));
    act(() => h.undo());
    expect(h!.canRedo).toBe(true);
    const plan = planConfigSwitch({ ...a, tree: h!.tree }, a.savedConfigs[1]!, TEXT);
    act(() => applyConfigSwitchPlan(plan, a.savedConfigs, { history: h!, seedNozzleFollow: vi.fn(),
      setSavedConfigs: vi.fn(), setMountMotors: vi.fn(), setUnmatchedRefs: vi.fn(), setActiveConfigId: vi.fn(), setNote: vi.fn() }));
    act(() => { h.undo(); h.redo(); });
    expect(h!.canUndo).toBe(false); expect(h!.canRedo).toBe(false);
    expectStated({ ...a, ...plan, tree: h!.tree }, 10, 43);
  } finally { act(() => root.unmount()); }
});
