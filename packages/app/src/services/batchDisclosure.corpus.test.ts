// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { OrkRocket } from '@online-openrocket/engine';
import { importOrk } from './orkFile.js';
import { matchImportedMotor } from './motorMatch.js';
import { MOTOR_DB } from './motorDb.js';
import { runBatchSweep } from './batchSweep.js';
import { engineTree, motorMounts, mountMotorCount, mountName } from '../tree/treeModel.js';
import { mountBore } from '../tree/scaleRocket.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { runConfigurationLabel } from './runConfiguration.js';
import { runsToCsv, runsToTable } from './simStore.js';

// Same optional local docs junction as xmlParse.corpus.test.ts; no backup copy.
const corpus = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/User files');
function ownedDesign(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && /^8 in Goblin 4 x 75mm v2\.ork$/i.test(entry.name)) return path;
    if (entry.isDirectory()) { const found = ownedDesign(path); if (found) return found; }
  }
  return undefined;
}
const file = ownedDesign(corpus);

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
