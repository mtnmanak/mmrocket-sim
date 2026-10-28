// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { loadSession, discardSession } from './session.js';
import { flightDataForExport, type ImportedSummaryDocument } from './orkFlightData.js';
import { exportOrk, importOrk, type OrkExportFlightData } from './orkFile.js';
import { loadUserMaterials, readUserMaterials, saveUserMaterials, writeUserMaterials, USER_MATERIALS_KEY } from './userMaterials.js';
import { canBackUpUnreadableStore, unreadableBackupKey } from './storeBackup.js';
import type { SavedConfig } from '../model/design.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const material = { kind: 'bulk' as const, name: 'My laminate', density: 1234 };
const badMaterial = { ...material, name: 'X', density: 'abc' };
const exKey = 'online-openrocket.ex-motors.v1';
const config: SavedConfig = { id: 'c', name: 'Stored', isDefault: true, motors: {} };
const tree = { name: 'Stored', components: [{ type: 'stage' as const, id: 's', children: [
  { type: 'bodytube' as const, id: 'bt', motorMount: true, length: 0.3, outerRadius: 0.02, thickness: 0.001 },
] }] };
const data: OrkExportFlightData = { runId: 'r1', aeroModel: 'hybrid', hybridBand: [0.8, 1.2], rogersKbf: false,
  maxAltitude: 100, maxVelocity: 20, maxAcceleration: 30, maxMach: 0.1, timeToApogee: 4, flightTime: 15,
  groundHitVelocity: 5, launchRodVelocity: 12, deploymentVelocity: 8, optimumDelay: 3 };
afterEach(() => { discardSession(); localStorage.clear(); vi.restoreAllMocks(); });

function restoreData(fields: unknown) {
  const sim = { name: 'Stored', configId: 'c', status: 'outdated', data: fields };
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree, launch: DEFAULT_CONDITIONS,
    savedConfigs: [config], importedDocument: { name: 'Imported', storedSimulations: [sim] } }));
  return { loaded: loadSession()!, sim };
}
function save(document: ImportedSummaryDocument) {
  const flightData = flightDataForExport({ runs: [], savedConfigs: [config], importedDocument: document,
    activeConfigId: 'c', assigned: [], mountIds: [], designKey: '', conditionsKey: '',
    model: { aeroMode: 'hybrid', effectiveKbf: false, autoSupersonic: false }, hasNozzle: false,
    motorSetKeyOf: () => '', hardwareDeltaKg: 0, primaryMountOf: () => null });
  return exportOrk({ name: 'Saved', tree, launch: DEFAULT_CONDITIONS, configs: [{ ...config, motors: {} }], flightData, activeConfigId: 'c' });
}

it('removes a hostile runId so the restored summary can be saved', () => {
  const { loaded } = restoreData({ ...data, runId: { toString: 0 } });
  expect(() => save(loaded.importedDocument!)).not.toThrow();
  expect(loaded.importedDocument!.storedSimulations[0]!.data).not.toHaveProperty('runId');
});
it.each<[string, unknown]>([
  ['aeroModel', {}], ['hybridBand', [1, 0.5]], ['rogersKbf', 'false'],
  ...['maxAltitude', 'maxVelocity', 'maxAcceleration', 'maxMach', 'timeToApogee', 'flightTime',
    'groundHitVelocity', 'launchRodVelocity', 'deploymentVelocity', 'optimumDelay'].map(key => [key, 'bad'] as [string, unknown]),
])('F8 drops unreadable flight-data field %s', (key, value) => {
  const { loaded } = restoreData({ ...data, [key]: value });
  expect(loaded.importedDocument!.storedSimulations[0]!.data).not.toHaveProperty(key);
  expect(() => save(loaded.importedDocument!)).not.toThrow();
});
it('keeps a valid stored simulation through restore and file round-trip', () => {
  const { loaded, sim } = restoreData(data);
  expect(loaded.importedDocument!.storedSimulations).toEqual([sim]);
  expect(importOrk(save(loaded.importedDocument!)).storedSimulations).toEqual([sim]);
});

it.each(['empty', 'same', 'different', 'blocked'])('F9 materials removes invalid entries only after preserving their raw store: %s', backup => {
  const raw = JSON.stringify([badMaterial, material]);
  const side = unreadableBackupKey(USER_MATERIALS_KEY);
  localStorage.setItem(USER_MATERIALS_KEY, raw);
  if (backup === 'same' || backup === 'different') localStorage.setItem(side, backup === 'same' ? raw : 'older');
  const own = localStorage.setItem;
  if (backup === 'blocked') Object.defineProperty(localStorage, 'setItem', { configurable: true, value: (key: string, value: string) => {
    if (key === side) throw Error('blocked');
    own.call(localStorage, key, value);
  } });
  try {
    expect(readUserMaterials().note).toMatch(/invalid/);
    expect(saveUserMaterials(loadUserMaterials())).toBe(true);
    const canCopy = backup === 'empty' || backup === 'same';
    expect(JSON.parse(localStorage.getItem(USER_MATERIALS_KEY)!)).toEqual(canCopy ? [material] : [badMaterial, material]);
    expect(localStorage.getItem(side)).toBe(canCopy ? raw : backup === 'different' ? 'older' : null);
    expect(readUserMaterials().note).toBe(canCopy ? '' : '1 invalid My materials entries were ignored.');
  } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: own }); }
});
it.each(['{broken', '{}'])('F9 materials read note does not promise a refused backup: %s', raw => {
  localStorage.setItem(USER_MATERIALS_KEY, raw);
  localStorage.setItem(unreadableBackupKey(USER_MATERIALS_KEY), 'older');
  expect(readUserMaterials().note).not.toContain('keeps a copy');
  expect(readUserMaterials().note).toContain('unchanged');
  expect(writeUserMaterials([material])).toBe('unreadable');
  expect(localStorage.getItem(USER_MATERIALS_KEY)).toBe(raw);
  expect(localStorage.getItem(unreadableBackupKey(USER_MATERIALS_KEY))).toBe('older');
});
it.each(['empty', 'same', 'different', 'blocked'])('F9 EX removes refused entries with different ids only after preserving the raw store: %s', async backup => {
  vi.resetModules();
  const ex = await import('./exMotors.js');
  const motor = ex.parseEng('Test 29 100 P 0.05 0.1 Home\n0 0\n0.5 20\n1 0')[0]!;
  const bad = { ...motor, motorId: 'ex:old-id', totalWeightG: 'abc' };
  const raw = JSON.stringify([bad, motor]);
  const side = unreadableBackupKey(exKey);
  localStorage.setItem(exKey, raw);
  if (backup === 'same' || backup === 'different') localStorage.setItem(side, backup === 'same' ? raw : 'older');
  const notes: string[] = [];
  ex.loadExMotors(notes);
  expect(notes).toHaveLength(1);
  const own = localStorage.setItem;
  if (backup === 'blocked') Object.defineProperty(localStorage, 'setItem', { configurable: true, value: (key: string, value: string) => {
    if (key === side) throw Error('blocked');
    own.call(localStorage, key, value);
  } });
  try {
    const second = { ...motor, motorId: 'ex:second', designation: 'Second' };
    expect(ex.addExMotors([second]).stored).toBe(true);
    const canCopy = backup === 'empty' || backup === 'same';
    expect(JSON.parse(localStorage.getItem(exKey)!)).toEqual([...(canCopy ? [] : [bad]), motor, second]);
    expect(localStorage.getItem(side)).toBe(canCopy ? raw : backup === 'different' ? 'older' : null);
    const after: string[] = [];
    ex.loadExMotors(after);
    expect(after).toHaveLength(canCopy ? 0 : 1);
  } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: own }); }
});
it('backup preflight is read-only and accepts only an empty or matching side key', () => {
  expect(canBackUpUnreadableStore('k', 'raw')).toBe(true);
  expect(localStorage.getItem(unreadableBackupKey('k'))).toBeNull();
  localStorage.setItem(unreadableBackupKey('k'), 'raw');
  expect(canBackUpUnreadableStore('k', 'raw')).toBe(true);
  expect(canBackUpUnreadableStore('k', 'different')).toBe(false);
  expect(localStorage.getItem(unreadableBackupKey('k'))).toBe('raw');
});
it('backup preflight refuses a blocked side-key read', () => {
  const own = localStorage.getItem;
  Object.defineProperty(localStorage, 'getItem', { configurable: true, value: () => { throw Error('blocked'); } });
  try { expect(canBackUpUnreadableStore('k', 'raw')).toBe(false); }
  finally { Object.defineProperty(localStorage, 'getItem', { configurable: true, value: own }); }
});
it('preserves valid nullable numeric fields on restore', () => {
  const nullable = { ...data, optimumDelay: null, groundHitVelocity: null };
  const { loaded, sim } = restoreData(nullable);
  expect(loaded.importedDocument!.storedSimulations).toEqual([sim]);
  expect(() => save(loaded.importedDocument!)).not.toThrow();
});
