// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { referenceDir } from '../../../../scripts/reference-docs.mjs';
import { expect, it } from 'vitest';
import { OrkRocket } from '@online-openrocket/engine';
import { importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { matchImportedMotor } from './motorMatch.js';
import { MOTOR_DB, fitsMount, isAvailable } from './motorDb.js';
import { provisionalDelay, runBatchSweep } from './batchSweep.js';
import { applyStageNozzles, clearStageNozzles, engineTree, hasParallelStage, motorMounts, mountMotorCount, mountName, stageIdByNode, stages } from '../tree/treeModel.js';
import { mountBore } from '../tree/scaleRocket.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { runConfigurationLabel } from './runConfiguration.js';
import { runsToCsv, runsToTable } from './simStore.js';
import { batchMatchingMounts, batchMountDisclosure, batchTargetsDefault } from './batchMountDisclosure.js';
import { batchRingSplits } from './batchRing.js';
import { fetchMotorSpec } from './thrustcurve.js';
import { simulateDesign } from './simulateDesign.js';
import type { FlightTree, MountMotor } from '../model/design.js';
import { batchTargetIgnition } from './batchSweep.js';
import { recordFlightOverrides } from './flightOverrideSummary.js';
import { unzipSync } from 'fflate';

// Same optional local docs junction as xmlParse.corpus.test.ts; no backup copy.
const corpus = referenceDir('User files');
function ownedDesign(root: string | null, name = '8 in Goblin 4 x 75mm v2.ork'): string | undefined {
  if (!root || !existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) { const found = ownedDesign(path, name); if (found) return found; }
  }
  return undefined;
}
const file = corpus ? ownedDesign(corpus) : undefined;

it.skipIf(!file)('discloses the owner’s four separate mounts on two real batch candidates', async () => {
  const loaded = importOrk(new Uint8Array(readFileSync(file!)));
  const tree = loaded.tree;
  const resolved = await Promise.all(Object.entries(loaded.motors).map(async ([id, ref]) => {
    const matched = await matchImportedMotor(ref);
    expect(matched.motor, matched.note).toBeDefined();
    return [id, matched.motor!] as const;
  }));
  expect(resolved).toHaveLength(4);
  const assignedMountMotors = Object.fromEntries(resolved);
  const mounts = motorMounts(tree).map(m => ({ id: m.id!, label: mountName(m), diameterMm: mountBore(m) * 1000,
    motorCount: mountMotorCount(tree, m.id!), maxMotorLengthM: null }));
  const target = mounts.find(m => /MMT 1$/.test(m.label))!;
  expect(target).toBeDefined();
  const candidate = MOTOR_DB.find(m => m.designation === 'M1780NT')!;
  const baseline = MOTOR_DB.find(m => m.motorId === assignedMountMotors[target.id]!.meta.motorId)!;
  expect(candidate).toBeDefined(); expect(baseline).toBeDefined();
  const out = await runBatchSweep({ tree, info: OrkRocket.buildTree(engineTree(tree)).staticInfo(), mounts, target,
    candidates: [candidate, baseline], splits: [], assignedMountMotors,
    assignedMotors: Object.fromEntries(resolved.map(([id, mm]) => [id, mm.spec])),
    assignedMotorIds: Object.fromEntries(resolved.map(([id, mm]) => [id, mm.meta.motorId ?? mm.meta.exMotorId])),
    assignedIgnitions: Object.fromEntries(resolved.map(([id, mm]) => [id, mm.ignition])),
    assignedAutoDelays: Object.fromEntries(resolved.map(([id, mm]) => [id, !!mm.meta.autoDelay])),
    model: 'auto', autoDelay: true, launch: DEFAULT_CONDITIONS, rocketName: loaded.name,
    configuration: { flightConfig: 'Owner Goblin' },
  }, { signal: new AbortController().signal }, { yieldToUi: async () => {} });
  expect(out.rows).toHaveLength(2);
  console.log('Owner Goblin batch (SI):', out.rows.map(row => ({ motor: row.label,
    altitudeM: row.run?.maxAltitude, launchMassKg: row.run?.launchMass, flownDelayS: row.run?.delayS })));
  const others = mounts.filter(m => m.id !== target.id);
  for (const row of out.rows) {
    expect(row.error).toBeUndefined();
    const run = row.run!;
    const text = runConfigurationLabel(run);
    expect(text).toBe(row.entry.motorId === baseline.motorId
      ? `Batch · K1499N in ${target.label}, ${others.map(m => m.label).join(', ')}`
      : `Batch · M1780NT in ${target.label}; K1499N in ${others.map(m => m.label).join(', ')}`);
    const expectedTail = [target.label, `K1499N in ${others.map(m => m.label).join(', ')}`];
    expect(runsToTable([run]).rows[0]?.slice(-2)).toEqual(expectedTail);
    expect(runsToCsv([run])).toContain(`,"${expectedTail[1]}"`);
  }
}, 120_000);

it.skipIf(!corpus || !existsSync(corpus))('124/125 measures target-set eligibility across the tester corpus without altering saved rows', async () => {
  const corpusRoot = corpus!;
  const inputs: { path: string; bytes: Uint8Array }[] = [];
  const walk = (root: string) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ork|rkt|cdx1)$/i.test(entry.name)) inputs.push({ path, bytes: new Uint8Array(readFileSync(path)) });
      else if (/\.zip$/i.test(entry.name)) {
        for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(path))))) {
          if (/\.(ork|rkt|cdx1)$/i.test(name)) inputs.push({ path: `${path}!${name}`, bytes });
        }
      }
    }
  };
  walk(corpusRoot);
  const distinct = new Map(inputs.map(i => [createHash('sha256').update(i.bytes).digest('hex'), i]));
  const affected: { file: string; matching: number; defaultOn: boolean; mixedRing: boolean }[] = [];
  const diameterChanges: { file: string; selected: string; before: number; after: number; excluded: string[] }[] = [];
  const refused: string[] = [];
  let imported = 0;
  for (const { path, bytes } of distinct.values()) {
    try {
      const loaded = /\.ork$/i.test(path) ? importOrk(bytes) : /\.rkt$/i.test(path) ? importRkt(bytes) : importCdx1(bytes);
      imported++;
      const tree = loaded.tree;
      if (stages(tree).length > 1 || hasParallelStage(tree)) continue;
      // Match App's rounded picker bores when measuring the changed candidate set.
      const mounts = motorMounts(tree).map(m => ({ id: m.id!, label: mountName(m), diameterMm: Math.round(mountBore(m) * 1000),
        motorCount: mountMotorCount(tree, m.id!), maxMotorLengthM: null }));
      for (const selected of mounts) {
        const targets = batchMatchingMounts(tree, mounts, selected);
        if (targets.length < 2) continue;
        const before = MOTOR_DB.filter(m => isAvailable(m) && fitsMount(selected.diameterMm, m));
        const after = before.filter(m => targets.every(target => fitsMount(target.diameterMm, m)));
        if (before.length !== after.length) diameterChanges.push({ file: path.slice(corpusRoot.length + 1), selected: selected.label,
          before: before.length, after: after.length, excluded: before.filter(m => !after.includes(m)).map(m => m.designation) });
      }
      const sets = mounts.map(m => batchMatchingMounts(tree, mounts, m)).filter(ms => ms.length > 1);
      if (!sets.length) continue;
      const resolved = await Promise.all(Object.entries(loaded.motors).map(async ([id, ref]) => [id, await matchImportedMotor(ref)] as const));
      if (resolved.some(([, result]) => !result.motor)) { refused.push(path.slice(corpusRoot.length + 1)); continue; }
      const metadata = Object.fromEntries(resolved.map(([id, result]) => [id, result.motor!]));
      const motors = Object.fromEntries(resolved.map(([id, result]) => [id, result.motor!.spec]));
      const ids = Object.fromEntries(resolved.map(([id, result]) => [id, result.motor!.meta.motorId ?? result.motor!.meta.exMotorId]));
      affected.push({ file: path.slice(corpusRoot.length + 1), matching: Math.max(...sets.map(s => s.length)),
        defaultOn: sets.some(s => batchTargetsDefault(s, motors, metadata, ids)),
        mixedRing: sets.some(s => batchRingSplits(tree, s).halves !== null) });
    } catch (error) { refused.push(`${path.slice(corpusRoot.length + 1)}: ${String(error)}`); }
  }
  expect(inputs.length).toBeGreaterThan(0);
  console.log('124/125 tester corpus eligibility (not flown cases):', JSON.stringify({
    inputFilesAndZipMembers: inputs.length, distinctDesigns: distinct.size, imported, affected, refused, diameterChanges,
    changedDefaultTargetSets: affected.filter(f => f.defaultOn).length, optInTargetSets: affected.length,
    newlyAvailableMixedRings: affected.filter(f => f.mixedRing).length }));
}, 120_000);

for (const [format, designFile] of [['ork', file], ['rkt', ownedDesign(corpus, '8 in Goblin 4 x 75mm v2.rkt')]] as const) {
it.skipIf(!designFile)(`124/125 owner Goblin ${format} all-mount batch matches ordinary Launch; off preserves the one-mount loadout`, async () => {
  const bytes = new Uint8Array(readFileSync(designFile!));
  const loaded = format === 'ork' ? importOrk(bytes) : importRkt(bytes);
  const tree = loaded.tree;
  const resolved = await Promise.all(Object.entries(loaded.motors).map(async ([id, ref]) => {
    const matched = await matchImportedMotor(ref);
    expect(matched.motor, matched.note).toBeDefined();
    return [id, matched.motor!] as const;
  }));
  const assignedMountMotors = Object.fromEntries(resolved);
  const mounts = motorMounts(tree).map(m => ({ id: m.id!, label: mountName(m), diameterMm: mountBore(m) * 1000,
    motorCount: mountMotorCount(tree, m.id!), maxMotorLengthM: null }));
  const target = mounts.find(m => /MMT 1$/.test(m.label))!;
  const assignedMotors = Object.fromEntries(resolved.map(([id, mm]) => [id, mm.spec]));
  const assignedMotorIds = Object.fromEntries(resolved.map(([id, mm]) => [id, mm.meta.motorId ?? mm.meta.exMotorId]));
  const assignedIgnitions = Object.fromEntries(resolved.map(([id, mm]) => [id, mm.ignition]));
  const matching = batchMatchingMounts(tree, mounts, target);
  console.log('124 imported owner motors:', resolved.map(([id, mm]) => ({ id, motorId: mm.meta.motorId, exMotorId: mm.meta.exMotorId,
    designation: mm.spec.designation, delay: mm.spec.ejectionDelay, autoDelay: mm.meta.autoDelay })));
  expect(matching).toHaveLength(4);
  // Round 2 corrects the brief: plugged/zero are delays of the same motor identity.
  expect(batchTargetsDefault(matching, assignedMotors, assignedMountMotors, assignedMotorIds)).toBe(true);
  expect(batchTargetsDefault(matching, Object.fromEntries(matching.map(m => [m.id, assignedMotors[target.id]!])),
    assignedMountMotors, assignedMotorIds)).toBe(true);
  expect(batchMountDisclosure(tree, mounts, target, assignedMotors, assignedMountMotors, assignedMotorIds, assignedIgnitions)
    .matchingLabel).toContain('Use all 4 matching mounts');
  expect(batchRingSplits(tree, matching).halves?.mountGroups?.every(g => g.length === 2)).toBe(true);
  const candidate = MOTOR_DB.find(m => m.designation === 'M1780NT')!;
  const baseline = MOTOR_DB.find(m => m.motorId === assignedMotorIds[target.id])!;
  const base = { tree, info: OrkRocket.buildTree(engineTree(tree)).staticInfo(), mounts, target,
    candidates: [candidate, baseline], splits: [], assignedMountMotors, assignedMotors, assignedMotorIds, assignedIgnitions,
    assignedAutoDelays: Object.fromEntries(resolved.map(([id, mm]) => [id, !!mm.meta.autoDelay])),
    model: 'auto' as const, autoDelay: true, launch: DEFAULT_CONDITIONS, rocketName: loaded.name };
  const measurements = [];
  for (const all of [false, true]) {
    const out = await runBatchSweep({ ...base, ...(all ? { targetMountIds: matching.map(m => m.id) } : {}) },
      { signal: new AbortController().signal }, { yieldToUi: async () => {} });
    expect(out.rows).toHaveLength(2);
    expect(out.rows.every(r => r.run && !r.error)).toBe(true);
    const row = out.rows[0]!;
    const spec = await fetchMotorSpec(candidate, provisionalDelay(candidate, true));
    const motors: Record<string, MountMotor> = { ...assignedMountMotors };
    for (const m of all ? matching : [target]) motors[m.id] = { spec, label: candidate.designation,
      meta: { label: candidate.designation, manufacturer: candidate.manufacturerAbbrev, motorId: candidate.motorId, autoDelay: true },
      ignition: all ? assignedIgnitions[m.id]! : { event: 'automatic', delay: 0 } };
    // Launch gets the very same whole-stage nozzle the batch flew, as automatic nozzle following would supply it.
    const stageId = stageIdByNode(tree).get(target.id)!;
    const launchTree = applyStageNozzles(clearStageNozzles(tree), { [stageId]: row.exitM ?? null });
    const single = await simulateDesign({ tree: launchTree, mountMotors: motors, launch: DEFAULT_CONDITIONS,
      measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null },
    { aero: { aeroMode: 'auto', effectiveKbf: true, autoSupersonic: false }, yieldToUi: async () => {} });
    expect(Math.abs(row.run!.launchMass! - single.run.launchMass!)).toBeLessThan(0.001);
    expect(Math.abs(row.run!.maxAltitude! / single.run.maxAltitude! - 1)).toBeLessThan(0.01);
    expect(row.run!.batchMounts!.filter(m => m.role === 'candidate')).toHaveLength(all ? 4 : 1);
    expect(row.run!.batchMounts!.filter(m => m.role === 'kept')).toHaveLength(all ? 0 : 3);
    measurements.push({ allMatching: all, batchMassKg: row.run!.launchMass, launchMassKg: single.run.launchMass,
      batchApogeeM: row.run!.maxAltitude, launchApogeeM: single.run.maxAltitude });
  }
  console.log(`124 owner Goblin ${format} before/after, SI:`, measurements);
}, 120_000);
}

it.skipIf(!file)('Round 2 owner empty targets match ordinary Launch with configuration or own ignition', async () => {
  const loaded = importOrk(new Uint8Array(readFileSync(file!)));
  const config = loaded.configs.find(c => c.id === 'rocksim-sim-3')!;
  expect(config).toBeDefined();
  const mounts = motorMounts(loaded.tree).map(m => ({ id: m.id!, label: mountName(m), diameterMm: mountBore(m) * 1000,
    motorCount: mountMotorCount(loaded.tree, m.id!), maxMotorLengthM: null }));
  const target = mounts.find(m => /MMT 1$/.test(m.label))!;
  const candidateIds = ['M1780NT', 'K1499N'];
  const candidates = candidateIds.map(name => MOTOR_DB.find(m => m.designation === name)!);
  const sourceMotors = Object.fromEntries(await Promise.all(Object.entries(config.motors).map(async ([id, ref]) => {
    const matched = await matchImportedMotor(ref);
    expect(matched.motor, matched.note).toBeDefined();
    return [id, matched.motor!] as const;
  })));
  for (const empty of ['air-start mounts', 'all', 'own settings'] as const) {
    const overrides = empty === 'own settings' ? {} : { ignitions: config.ignitions };
    const tree: FlightTree = empty === 'own settings'
      ? { ...loaded.tree, ignitionDefaults: { ...loaded.tree.ignitionDefaults, ...config.ignitions } } : loaded.tree;
    const motors = empty === 'air-start mounts'
      ? Object.fromEntries(Object.entries(sourceMotors).filter(([id]) => (config.ignitions?.[id]?.delay ?? 0) === 0)) : {};
    const ignitions = Object.fromEntries(mounts.map(m => [m.id, batchTargetIgnition(tree, overrides.ignitions ?? {}, m.id)]));
    const targetIds = mounts.map(m => m.id);
    const out = await runBatchSweep({ tree, info: OrkRocket.buildTree(engineTree(tree)).staticInfo(), mounts, target,
      targetMountIds: targetIds, candidates, splits: [], assignedMountMotors: motors,
      assignedMotors: Object.fromEntries(Object.entries(motors).map(([id, mm]) => [id, mm.spec])),
      assignedMotorIds: Object.fromEntries(Object.entries(motors).map(([id, mm]) => [id, mm.meta.motorId])),
      assignedIgnitions: ignitions, autoDelay: true, model: 'auto', launch: DEFAULT_CONDITIONS, rocketName: loaded.name,
      configuration: { flightConfig: 'Owner air starts', flightOverrides: recordFlightOverrides(tree, overrides, motors, undefined, targetIds) },
    }, { signal: new AbortController().signal }, { yieldToUi: async () => {} });
    for (const row of out.rows) {
      expect(row.error).toBeUndefined();
      const spec = await fetchMotorSpec(row.entry, provisionalDelay(row.entry, true));
      const assigned = Object.fromEntries(mounts.map(m => [m.id, { spec, label: row.entry.designation,
        meta: { label: row.entry.designation, motorId: row.entry.motorId, manufacturer: row.entry.manufacturerAbbrev, autoDelay: true },
        ignition: { event: 'automatic' as const, delay: 0 } }]));
      const stageId = stageIdByNode(tree).get(target.id)!;
      const launchTree = applyStageNozzles(clearStageNozzles(tree), { [stageId]: row.exitM ?? null });
      const single = await simulateDesign({ tree: launchTree, mountMotors: assigned, detachedOverrides: overrides,
        launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null },
      { aero: { aeroMode: 'auto', effectiveKbf: true, autoSupersonic: false }, yieldToUi: async () => {} });
      expect(Math.abs(row.run!.launchMass! - single.run.launchMass!)).toBeLessThan(0.001);
      expect(Math.abs(row.run!.maxAltitude! / single.run.maxAltitude! - 1)).toBeLessThan(0.01);
      expect(row.run!.flightOverrides!.filter(r => r.family === 'ignition')).toHaveLength(empty === 'own settings' ? 0 : 2);
      console.log('Round 2 owner empty acceptance SI:', { empty, candidate: row.entry.designation,
        batchMassKg: row.run!.launchMass, launchMassKg: single.run.launchMass,
        batchApogeeM: row.run!.maxAltitude, launchApogeeM: single.run.maxAltitude });
    }
  }
}, 120000);

it.skipIf(!file).each([0, 0.09])('Round 3 owner mixed configuration matches Launch at stage exit %s m', async exit => {
  const loaded = importOrk(new Uint8Array(readFileSync(file!)));
  const config = loaded.configs.find(c => c.id === 'rocksim-sim-3')!;
  const resolved = Object.fromEntries(await Promise.all(Object.entries(config.motors).map(async ([id, ref]) => {
    const matched = await matchImportedMotor(ref);
    expect(matched.motor, matched.note).toBeDefined();
    return [id, matched.motor!] as const;
  })));
  const mounts = motorMounts(loaded.tree).map(m => ({ id: m.id!, label: mountName(m), diameterMm: mountBore(m) * 1000,
    motorCount: mountMotorCount(loaded.tree, m.id!), maxMotorLengthM: null }));
  const target = mounts.find(m => /MMT 1$/.test(m.label))!;
  const motorIds = Object.fromEntries(Object.entries(resolved).map(([id, mm]) => [id, mm.meta.motorId ?? mm.meta.exMotorId]));
  const candidates = [...new Set(Object.values(motorIds))].map(id => MOTOR_DB.find(m => m.motorId === id)!);
  const motors = Object.fromEntries(await Promise.all(Object.entries(resolved).map(async ([id, mm]) => {
    const candidate = candidates.find(c => c.motorId === motorIds[id])!;
    return [id, { ...mm, spec: await fetchMotorSpec(candidate, provisionalDelay(candidate, false)),
      meta: { ...mm.meta, autoDelay: false }, ignition: config.ignitions?.[id] ?? mm.ignition }] as const;
  })));
  const stageId = stageIdByNode(loaded.tree).get(target.id)!;
  const tree = applyStageNozzles(loaded.tree, { [stageId]: exit });
  const split = batchRingSplits(tree, mounts).halves!;
  const out = await runBatchSweep({ tree, info: OrkRocket.buildTree(engineTree(tree)).staticInfo(), mounts, target,
    targetMountIds: mounts.map(m => m.id), candidates, splits: [split], assignedMountMotors: motors,
    assignedMotors: Object.fromEntries(Object.entries(motors).map(([id, mm]) => [id, mm.spec])),
    assignedMotorIds: motorIds, assignedIgnitions: Object.fromEntries(Object.entries(motors).map(([id, mm]) => [id, mm.ignition])),
    autoDelay: false, model: 'auto', launch: DEFAULT_CONDITIONS, rocketName: loaded.name,
  }, { signal: new AbortController().signal }, { yieldToUi: async () => {} });
  const row = out.rows.find(r => r.combo && r.run?.batchMounts?.every(m => m.role !== 'candidate'
    || m.motor === resolved[m.mountId]?.spec.designation))!;
  expect(row, JSON.stringify(out.rows.map(r => ({ error: r.error, mounts: r.run?.batchMounts })))).toBeDefined();
  console.log('Round 3 owner mixed row SI:', { typedExitM: exit, flownExitM: row.exitM, launchMassKg: row.run!.launchMass, apogeeM: row.run!.maxAltitude });
  expect(row.exitM).toBe(exit);
  const ordinary = await simulateDesign({ tree, mountMotors: motors, detachedOverrides: { ignitions: config.ignitions }, launch: DEFAULT_CONDITIONS,
    measured: { massKg: null, cgM: null }, savedConfigs: [], activeConfigId: null },
  { aero: { aeroMode: 'auto', effectiveKbf: true, autoSupersonic: false }, yieldToUi: async () => {} });
  expect(Math.abs(row.run!.launchMass! - ordinary.run.launchMass!)).toBeLessThan(0.001);
  expect(Math.abs(row.run!.maxAltitude! / ordinary.run.maxAltitude! - 1)).toBeLessThan(0.01);
  console.log('Round 3 owner mixed acceptance SI:', { typedExitM: exit, batchMassKg: row.run!.launchMass, launchMassKg: ordinary.run.launchMass,
    batchApogeeM: row.run!.maxAltitude, launchApogeeM: ordinary.run.maxAltitude });
}, 120000);
