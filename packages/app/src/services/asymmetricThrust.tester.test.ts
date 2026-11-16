// @vitest-environment happy-dom
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { referenceDir } from '../../../../scripts/reference-docs.mjs';
import { expect, it } from 'vitest';
import { importOrk } from './orkFile.js';
import { motorMounts } from '../tree/treeModel.js';
import { MOTOR_DB } from './motorDb.js';
import { bundledOnlyFetchSpec } from './thrustcurve.js';
import { asymmetricThrustWarnings, thrustImbalance, type ThrustSite } from './asymmetricThrust.js';
import { aftLayout } from '../tree/aftLayout.js';
import type { MountMotor } from '../model/design.js';

const corpus = referenceDir('User files');
const file = corpus && existsSync(corpus) ? readdirSync(corpus).find(f => /^8 in Goblin 4 x 75mm v2\.ork$/i.test(f)) : undefined;
it.skipIf(!file)('row 127 owner Goblin: 1 M1780NT + 3 K1499N is Danger, four K1499N are balanced', async () => {
  const bytes = readFileSync(join(corpus!, file!));
  const tree = importOrk(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).tree;
  const load = async (designation: string): Promise<MountMotor> => {
    const entry = MOTOR_DB.find(m => m.designation === designation)!;
    expect(entry).toBeDefined();
    return { label: entry.designation, meta: { label: entry.designation, motorId: entry.motorId },
      spec: await bundledOnlyFetchSpec(entry, 0), ignition: { event: 'automatic', delay: 0 } };
  };
  const [strong, weak] = await Promise.all([load('M1780NT'), load('K1499N')]);
  const mounts = motorMounts(tree).filter(m => /MMT [1-4]/.test(m.name ?? '')).sort((a, b) => a.name!.localeCompare(b.name!));
  expect(mounts).toHaveLength(4);
  const mixed = mounts.map((m, i) => [m.id!, i === 0 ? strong : weak] as const);
  const warnings = asymmetricThrustWarnings(tree, mixed);
  expect(warnings[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  expect(warnings[0]?.message).toContain('Firing then:');
  const sites: ThrustSite[] = [];
  const installed = new Map(mixed);
  aftLayout(tree, 0, Object.fromEntries(mixed.map(([id, m]) => [id, m.spec])), undefined, (id, y, z) => {
    sites.push({ mountId: id, name: id, y, z, spec: installed.get(id)!.spec, ignition: 0 });
  });
  const measured = thrustImbalance(sites);
  console.log(`Owner Goblin measured ${measured.fraction * 100} % at ${measured.time} s; ${warnings[0]?.key}`);
  expect(asymmetricThrustWarnings(tree, mounts.map(m => [m.id!, weak]))).toEqual([]);
});
