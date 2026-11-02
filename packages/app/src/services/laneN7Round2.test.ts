// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { addExMotors, deleteExMotor, parseEng } from './exMotors.js';
import { readUserMaterials, writeUserMaterials, USER_MATERIALS_KEY } from './userMaterials.js';
import { toOrkMotor } from './orkExportMotors.js';
import type { MountMotor } from '../model/design.js';
import { exportOrk, importOrk } from './orkFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { defaultTree } from '../tree/treeModel.js';

afterEach(() => localStorage.clear());
it('copies only invalid materials, keeps valid rows and counts collisions once', () => {
  const good = { kind: 'bulk' as const, name: 'My foam', density: 42 };
  const bad = { kind: 'bulk', name: 'Balsa', density: 999 };
  localStorage.setItem(USER_MATERIALS_KEY, JSON.stringify([good, bad]));
  expect(readUserMaterials().note).not.toContain('invalid My materials entries');
  expect(writeUserMaterials([good])).toBe('partly-backed-up');
  expect(JSON.parse(localStorage.getItem(`${USER_MATERIALS_KEY}.unreadable-backup`)!)).toEqual([bad]);
  expect(readUserMaterials().materials).toEqual([good]);
});
it('returns recovery details on delete and copies only refused motors', () => {
  const good = parseEng('X99 29 100 P 0.05 0.1 Maker\n0 0\n0.5 20\n1 0')[0]!;
  const bad = { ...good, motorId: 'ex:bad', totalWeightG: 'bad' };
  const key = 'online-openrocket.ex-motors.v1';
  localStorage.setItem(key, JSON.stringify([good, bad]));
  expect(deleteExMotor('missing')).toMatchObject({ stored: true, backedUp: true, partlyBackedUp: true, motors: [good] });
  expect(JSON.parse(localStorage.getItem(`${key}.unreadable-backup`)!)).toEqual([bad]);
  expect(addExMotors([]).motors).toEqual([good]);
});
it('does not borrow a maker from another id with the same designation', () => {
  const motor = parseEng('X99 29 100 P 0.05 0.1 OtherMaker\n0 0\n0.5 20\n1 0')[0]!;
  const mm = { spec: { designation: 'X99' }, meta: { manufacturer: 'EX', exMotorId: 'ex:missing' }, ignition: { event: 'automatic', delay: 0 } } as MountMotor;
  expect(toOrkMotor(mm, undefined, () => [motor]).manufacturer).toBeUndefined();
});
it('retains unavailable warning evidence from malformed ork arrays after reload', () => {
  const xml = exportOrk({ name: 'Warnings', tree: defaultTree(), launch: DEFAULT_CONDITIONS,
    configs: [{ id: 'c1', name: 'Flight', isDefault: true, motors: {} }], activeConfigId: 'c1',
    flightData: { c1: { aeroModel: 'classic', maxAltitude: 123, simWarnings: [] } } });
  const damaged = xml.replace(/<simwarnings[^>]*>.*?<\/simwarnings>/, '<simwarnings version="1">[null]</simwarnings>');
  const imported = importOrk(damaged);
  expect(JSON.stringify(imported)).toContain('StoredWarningsUnavailable');
});
