// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import { addExMotors, deleteExMotor, exToDbEntry, loadExMotors, restoreExMotors, type ExMotor } from './exMotors.js';
import { MAX_EX_ARCHIVE_BYTES, validArchivedExMotor, validFlightSnapshot } from './exMotorArchive.js';
import { exportOrk, importOrk } from './orkFile.js';
import { fetchMotorSpec, type RepairedMotorSpec } from './thrustcurve.js';
import { matchImportedMotor, mountMotorFromDb } from './motorMatch.js';
import { toOrkMotor } from './orkExportMotors.js';
import { autosaveToOrk } from './autosaveBackup.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { encodeShareFragment, MAX_INFLATED_BYTES } from './shareLink.js';
import { applyImportPlan, openShareLink, planImport, resolveImportMotors, type ImportSinks } from './importApply.js';
import { createSequencer } from './latestWins.js';
import { simulateFile } from './simulateFile.js';
import { designFingerprint } from './dirtyState.js';
import { padMassSetKey } from './configSync.js';

const motor = (): ExMotor => ({ motorId: 'ex:round2', designation: 'C6', realManufacturer: 'Round 2',
  diameter: 18, length: 70, totalWeightG: 24, propWeightG: 10, delays: '3,5,P',
  samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 12 }, { time: 0.5, thrust: 6 }, { time: 1.2, thrust: 0 }],
  source: 'eng', addedAt: 1 });
async function fixture(m = motor()) {
  addExMotors([m]);
  const db = exToDbEntry(m);
  const loaded = mountMotorFromDb(db, await fetchMotorSpec(db, 5), 5,
    { event: 'automatic', delay: 0 }, { exMotorId: m.motorId });
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!.id!;
  const write = (notes: string[] = []) => exportOrk({ name: 'Round 2', tree,
    motors: { [mount]: toOrkMotor(loaded, undefined, loadExMotors) }, notes });
  return { tree, mount, loaded, write };
}
beforeEach(() => localStorage.clear());

it.each(['deleted', 'changed', 'invalid'])('saves the loaded snapshot when its library entry is %s', async divergence => {
  const { tree, mount, loaded, write } = await fixture();
  if (divergence === 'deleted') deleteExMotor(motor().motorId);
  else addExMotors([{ ...motor(), ...(divergence === 'invalid' ? { totalWeightG: -1 }
    : { samples: motor().samples.map(s => ({ ...s, thrust: s.thrust * 2 })) }) }]);
  const notes: string[] = [];
  const xml = write(notes);
  expect(notes.join(' ')).toMatch(/C6.*(missing|changed|invalid|deleted)/);
  const recovery = autosaveToOrk({ tree, mountMotors: { [mount]: loaded }, launch: DEFAULT_CONDITIONS, savedAt: 1 });
  await expect(encodeShareFragment(xml)).resolves.toBeTruthy();
  localStorage.clear();
  for (const saved of [xml, recovery]) {
    const opened = importOrk(saved);
    expect(opened.embeddedExMotors![0]).toMatchObject(motor());
    const actual = (await matchImportedMotor(Object.values(opened.motors)[0]!)).motor!;
    expect(actual.spec.times).toEqual(loaded.spec.times);
    expect(actual.spec.thrusts).toEqual(loaded.spec.thrusts);
    expect(actual.spec.masses).toEqual(loaded.spec.masses);
    expect(actual.meta.availableDelays).toEqual([3, 5, Infinity]);
  }
});

it('a recovery record with no MotorSpec still produces an incomplete design archive', async () => {
  const { loaded, tree, mount } = await fixture();
  Reflect.deleteProperty(loaded, 'spec');
  deleteExMotor(motor().motorId);
  const xml = autosaveToOrk({ tree, mountMotors: { [mount]: loaded }, launch: DEFAULT_CONDITIONS, savedAt: 1 });
  expect(importOrk(xml).motors).toEqual({});
  expect(importOrk(xml).notes.join(' ')).toContain('no valid loaded snapshot');
});

it.each(['abandoned', 'declined', 'superseded'])('parsing an %s open never changes storage', async kind => {
  const { write } = await fixture();
  const xml = write();
  localStorage.clear();
  const seq = createSequencer();
  const offer = vi.fn();
  const apply = vi.fn();
  if (kind === 'abandoned') importOrk(xml);
  else await openShareLink('#d=test', { openSeq: seq,
    read: async () => { const parsed = importOrk(xml); if (kind === 'superseded') seq.begin(); return parsed; },
    shouldOffer: () => true, onOffer: offer, apply, onError: e => { throw e; } });
  expect(apply).not.toHaveBeenCalled();
  expect(offer).toHaveBeenCalledTimes(kind === 'declined' ? 1 : 0);
  expect(loadExMotors()).toEqual([]);
  expect(localStorage.length).toBe(0);
});

it('headless simulation flies embedded EX directly without global writes', async () => {
  const { write } = await fixture();
  const xml = write();
  localStorage.clear();
  const result = await simulateFile(new TextEncoder().encode(xml), 'embedded.ork', { presets: [] });
  expect(result.result.summary.maxAltitude).toBeGreaterThan(0);
  expect(loadExMotors()).toEqual([]);
  expect(localStorage.length).toBe(0);
});

it('disk saves two 90000-sample motors beyond the separate share budget', async () => {
  const a = { ...motor(), samples: Array.from({ length: 90000 }, (_, i) => ({ time: i / 90000, thrust: i % 13 })) };
  const b = { ...a, motorId: 'ex:second', designation: 'C7' };
  const first = await fixture(a);
  const second = await fixture(b);
  expect(new TextEncoder().encode(JSON.stringify([a, b])).length).toBeGreaterThan(MAX_INFLATED_BYTES);
  const xml = exportOrk({ name: 'Large', tree: first.tree, configs: [
    { id: 'a', name: 'a', isDefault: true, motors: { [first.mount]: toOrkMotor(first.loaded, undefined, loadExMotors) } },
    { id: 'b', name: 'b', isDefault: false, motors: { [first.mount]: toOrkMotor(second.loaded, undefined, loadExMotors) } },
  ] });
  const opened = importOrk(xml);
  for (const c of opened.configs) expect((await matchImportedMotor(Object.values(c.motors)[0]!)).motor).toBeDefined();
  await expect(encodeShareFragment(xml)).rejects.toThrow();
}, 30000);

it('collision remapping keeps maximum-length incoming ids valid and resavable', async () => {
  const original = { ...motor(), motorId: `ex:${'x'.repeat(1021)}` };
  const { write } = await fixture(original);
  const xml = write();
  const different = { ...original, samples: original.samples.map(s => ({ ...s, thrust: s.thrust * 2 })) };
  addExMotors([different]);
  const ids = restoreExMotors([original], []);
  expect(ids.get(original.motorId)!.length).toBeLessThanOrEqual(1024);
  expect(loadExMotors().every(validArchivedExMotor)).toBe(true);
  const opened = importOrk(xml);
  const ref = Object.values(opened.motors)[0]!;
  const loaded = (await matchImportedMotor(ref)).motor!;
  expect(() => exportOrk({ name: 'Again', tree: opened.tree,
    motors: { [ref.mountId!]: toOrkMotor(loaded, undefined, loadExMotors) } })).not.toThrow();
});

function sinks(): ImportSinks {
  return { history: { reset: vi.fn() }, setMountMotors: vi.fn(), setUnmatchedRefs: vi.fn(),
    setSavedConfigs: vi.fn(), setActiveConfigId: vi.fn(), setLaunch: vi.fn(), setMeasured: vi.fn(),
    setMachAlt: vi.fn(), setNote: vi.fn(), setShroudPrompt: vi.fn(), markSaved: vi.fn() };
}

it.each(['file', 'share'])('accepted %s open commits only at apply and remaps every mounted configuration before the saved mark', async kind => {
  const { write, loaded } = await fixture();
  loaded.padMassKg = 0.15;
  const xml = write();
  localStorage.clear();
  const imported = importOrk(xml);
  const resolved = await resolveImportMotors(imported);
  const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS,
    text: { mass: String, length: String } });
  expect(loadExMotors()).toEqual([]);
  // Library changes while a network motor in this open could be resolving.
  const twin = { ...motor(), samples: motor().samples.map(s => ({ ...s, thrust: s.thrust * 2 })) };
  addExMotors([twin]);
  const targets = sinks();
  const commit = async () => { applyImportPlan(plan, targets); };
  if (kind === 'file') await commit();
  else await openShareLink('#d=test', { openSeq: createSequencer(), read: async () => imported,
    shouldOffer: () => false, onOffer: vi.fn(), apply: commit, onError: e => { throw e; } });
  expect(loadExMotors()).toHaveLength(2);
  expect(loadExMotors()[0]).toEqual(twin);
  for (const set of [plan.snapshot.mountMotors, ...plan.snapshot.savedConfigs.map(c => c.motors)]) {
    for (const m of Object.values(set)) {
      expect(m.meta.exMotorId).toBe('ex:round2~2');
      expect(m.meta.motorId).toBe('ex:round2~2');
      expect((m.spec as RepairedMotorSpec).exDefinition!.motorId).toBe('ex:round2~2');
      expect(m.spec.thrusts).toEqual(motor().samples.map(s => s.thrust));
      expect(m.padMassWeighedWith).toBe(padMassSetKey(plan.snapshot.tree, set));
    }
  }
  expect(plan.note.text).toContain('both were kept');
  expect(targets.markSaved).toHaveBeenCalledWith(designFingerprint(plan.snapshot));
  applyImportPlan(plan, targets);
  expect(loadExMotors()).toHaveLength(2);
});

it('distinct loaded versions of one library id keep stable archive ids across configuration order', async () => {
  const first = await fixture();
  const second = await fixture({ ...motor(), samples: motor().samples.map(s => ({ ...s, thrust: s.thrust * 2 })) });
  deleteExMotor(motor().motorId);
  const configs = [first, second].map((f, i) => ({ id: String(i), name: String(i), isDefault: i === 0,
    motors: { [first.mount]: toOrkMotor(f.loaded, undefined, loadExMotors) } }));
  const save = (reverse: boolean) => importOrk(exportOrk({ name: 'Versions', tree: first.tree,
    configs: reverse ? [...configs].reverse() : configs }));
  const a = save(false), b = save(true);
  expect(a.embeddedExMotors).toHaveLength(2);
  for (const cfg of a.configs) {
    const ref = Object.values(cfg.motors)[0]!;
    expect(ref.exMotorId).toBe(Object.values(b.configs.find(c => c.id === cfg.id)!.motors)[0]!.exMotorId);
    expect(ref.exDefinition!.libraryMotorId).toBe(motor().motorId);
    expect((await matchImportedMotor(ref)).motor!.spec.thrusts).toEqual([first, second][Number(cfg.id)]!.loaded.spec.thrusts);
  }
  expect(first.loaded.meta.exMotorId).toBe(motor().motorId);
});

it('legacy session snapshots retain exact loaded arrays, CG and captured delays without a library', async () => {
  const { loaded, write } = await fixture();
  delete (loaded.spec as RepairedMotorSpec).exDefinition;
  loaded.spec.cgX = 0.03123456789;
  loaded.spec.masses[1] = 0.023456789;
  loaded.spec.masses[loaded.spec.masses.length - 1] = 0;
  deleteExMotor(motor().motorId);
  const reopened = importOrk(write());
  const ref = Object.values(reopened.motors)[0]!;
  expect(ref.exDefinition!.source).toBe('snapshot');
  const actual = (await matchImportedMotor(ref)).motor!;
  expect(actual.spec).toMatchObject(loaded.spec);
  expect(actual.meta.availableDelays).toEqual([3, 5, Infinity]);
  const twice = importOrk(exportOrk({ name: 'Again', tree: reopened.tree,
    motors: { [ref.mountId!]: toOrkMotor(actual, undefined, loadExMotors) } }));
  expect(Object.values(twice.motors)[0]!.exMotorId).toBe(ref.exMotorId);
});

it('changed loaded inputs retain captured RSE metadata while archiving the actual flight data', async () => {
  const original = { ...motor(), source: 'rse' as const, exitDiameterM: 0.005,
    sampleMassesKg: [0.024, 0.022, 0.018, 0.014] };
  const { loaded, write } = await fixture(original);
  loaded.spec.cgX = 0.03123456789;
  loaded.spec.thrusts[1] = 11.23456789;
  deleteExMotor(motor().motorId);
  const parsed = importOrk(write());
  const ref = Object.values(parsed.motors)[0]!;
  expect(ref.exDefinition).toMatchObject({ source: 'rse', exitDiameterM: 0.005,
    sampleMassesKg: original.sampleMassesKg, realManufacturer: original.realManufacturer });
  expect((await matchImportedMotor(ref)).motor!.spec.cgX).toBe(loaded.spec.cgX);
  expect((await matchImportedMotor(ref)).motor!.spec.thrusts).toEqual(loaded.spec.thrusts);
});

it('bounds the loaded snapshot sample count independently of source sample count', async () => {
  const { loaded } = await fixture();
  const snapshot = { ...loaded.spec, times: Array.from({ length: 100001 }, (_, i) => i),
    thrusts: Array<number>(100001).fill(1), masses: Array<number>(100001).fill(0.024) };
  expect(validFlightSnapshot(snapshot)).toBe(false);
  expect(validArchivedExMotor({ ...motor(), flightSnapshot: snapshot })).toBe(false);
});

it('no valid snapshot still saves geometry, shares, and recovers without the motor and with a persistent note', async () => {
  const { loaded, tree, mount, write } = await fixture();
  delete (loaded.spec as RepairedMotorSpec).exDefinition;
  loaded.spec.thrusts[1] = NaN;
  deleteExMotor(motor().motorId);
  const notes: string[] = [];
  const xml = write(notes);
  const recovery = autosaveToOrk({ tree, mountMotors: { [mount]: loaded }, launch: DEFAULT_CONDITIONS, savedAt: 1 });
  await expect(encodeShareFragment(xml)).resolves.toBeTruthy();
  for (const file of [xml, recovery]) {
    const reopened = importOrk(file);
    expect(motorMounts(reopened.tree)).toHaveLength(motorMounts(tree).length);
    expect(Object.values(reopened.motors)).toEqual([]);
    expect(reopened.notes.join(' ')).toMatch(/C6.*no valid loaded snapshot.*without this motor/);
  }
  expect(notes.join(' ')).toContain('without this motor');
});

it('invalid loaded data uses a valid captured definition before giving up the motor', async () => {
  const { loaded, write } = await fixture();
  loaded.spec.thrusts[1] = NaN;
  deleteExMotor(motor().motorId);
  const notes: string[] = [];
  const reopened = importOrk(write(notes));
  expect(reopened.embeddedExMotors).toHaveLength(1);
  expect(notes.join(' ')).toContain('captured source definition');
});

it('disk budget fallback saves and names the omitted motor, with matching reader bounds', async () => {
  const huge = { ...motor(), realManufacturer: 'x'.repeat(MAX_EX_ARCHIVE_BYTES) };
  const { tree, mount, loaded, write } = await fixture(huge);
  const notes: string[] = [];
  const xml = write(notes);
  expect(notes.join(' ')).toMatch(/C6.*disk archive budget.*without this motor/);
  expect(importOrk(xml).motors).toEqual({});
  const recovery = autosaveToOrk({ tree, mountMotors: { [mount]: loaded }, launch: DEFAULT_CONDITIONS, savedAt: 1 });
  expect(importOrk(recovery).notes.join(' ')).toContain('disk archive budget');
  await expect(encodeShareFragment(xml)).resolves.toBeTruthy();
});

it.each([
  ['designation', { designation: '' }], ['diameter', { diameter: NaN }], ['length', { length: 0 }],
  ['CG', { cgX: Infinity }], ['times lower count', { times: [0], thrusts: [0], masses: [0.024] }],
  ['time finite', { times: [0, 0.1, 0.5, Infinity] }], ['time NaN', { times: [0, NaN, 0.5, 1.2] }],
  ['time negative', { times: [-1, 0.1, 0.5, 1.2] }],
  ['time order', { times: [0, 0.1, 0.1, 1.2] }],
  ['thrust count', { thrusts: [0] }], ['thrust finite', { thrusts: [0, Infinity, 6, 0] }],
  ['thrust NaN', { thrusts: [0, NaN, 6, 0] }],
  ['thrust negative', { thrusts: [0, -1, 6, 0] }], ['mass count', { masses: [0.024] }],
  ['mass finite', { masses: [0.024, Infinity, 0.018, 0.014] }], ['mass nonnegative', { masses: [0.024, -1, 0.018, 0.014] }],
  ['initial mass', { masses: [0, 0.022, 0.018, 0.014] }],
])('refuses unsafe snapshot %s at save and read boundaries', async (_name, damage) => {
  const { loaded } = await fixture();
  const snapshot = { ...loaded.spec, ...damage };
  expect(validFlightSnapshot(snapshot)).toBe(false);
  expect(validArchivedExMotor({ ...motor(), flightSnapshot: snapshot })).toBe(false);
});
