// @vitest-environment happy-dom
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { addExMotors, exLibraryBackupNote, exToMotorSpec, parseEng, restoreExMotors } from './exMotors.js';
import { importMotorFiles } from './importMotorFiles.js';
import { exportOrk, importOrk } from './orkFile.js';
import { highestTier, noteFlags } from './importNotes.js';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const key = 'online-openrocket.ex-motors.v1';
const eng = 'R99 29 100 P 0.05 0.1 Maker\n0 0\n0.5 20\n1 0';
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  addExMotors([]); // Clear any session-only library left by a refused write.
});

it('returns session-only motors when the localStorage getter throws', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  expect(addExMotors(parseEng(eng))).toMatchObject({ stored: false });
});

it('reports the recovery copy after quota prevents a new library', async () => {
  localStorage.setItem(key, 'not JSON');
  const real = localStorage.setItem;
  onTestFinished(() => { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: real }); });
  vi.spyOn(localStorage, 'setItem').mockImplementation(function (k: string, v: string) {
    if (k === key) throw new DOMException('full', 'QuotaExceededError');
    real.call(localStorage, k, v);
  });
  const result = await importMotorFiles([new File([eng], 'r.eng')]);
  expect(result.write).toMatchObject({ stored: false, backedUp: true });
  expect(result.error).toContain('recovery copy in this browser');
  expect(result.error).toContain('No new library was saved');
  expect(result.noticeTier).toBe('information');
  expect(exLibraryBackupNote(result.write!)).not.toContain('started a new library');
  const notes: string[] = [];
  restoreExMotors(parseEng(eng.replace('R99', 'R100')), notes);
  expect(notes.join(' ')).toContain('No new library was saved');
  expect(localStorage.getItem(`${key}.unreadable-backup`)).toBe('not JSON');
  Object.defineProperty(localStorage, 'setItem', { configurable: true, value: real });
});

it.each([false, true])('assigns export tiers at the producer (missing maker %s)', missing => {
  const motor = parseEng(eng)[0]!;
  if (!missing) addExMotors([motor]);
  const spec = exToMotorSpec(motor, Infinity);
  if (missing) delete spec.exDefinition;
  const tree = defaultTree(), notes: string[] = [];
  exportOrk({ name: 'Receipt', tree, notes, motors: { [motorMounts(tree)[0]!.id!]: {
    designation: motor.designation, diameter: 0.029, length: 0.1, delay: Infinity,
    exMotorId: motor.motorId, exMotorSpec: spec, ...(missing ? {} : { manufacturer: 'Maker' }),
  } } });
  expect(notes.join(' ')).toContain('Used EX motors are embedded');
  expect(highestTier(noteFlags(notes))).toBe(missing ? 'caution' : 'information');
  if (missing) expect(notes.join(' ')).toContain('a source naming only EX has no maker to restore');
});

it.each(['[{"key":"Readable","message":"kept"},null]', 'broken JSON'])('keeps accurate warning loss evidence for %s', raw => {
  const xml = exportOrk({ name: 'Warnings', tree: defaultTree(), launch: DEFAULT_CONDITIONS,
    configs: [{ id: 'c1', name: 'Flight', isDefault: true, motors: {} }], activeConfigId: 'c1',
    flightData: { c1: { aeroModel: 'classic', maxAltitude: 123, simWarnings: [] } } });
  const damaged = xml.replace(/<simwarnings[^>]*>.*?<\/simwarnings>/, `<simwarnings version="1">${raw}</simwarnings>`)
    .replace(/(<simulation[^>]*>\s*<name>)[^<]*/, '$1Bad&#10;&#x202e;name');
  const imported = importOrk(damaged);
  const serialized = JSON.stringify(imported);
  expect(serialized).toContain('Some saved simulation warnings could not be read; this does not mean the flight had none.');
  expect(imported.notes.join(' ')).not.toContain('shows none');
  expect(imported.notes.join(' ')).not.toMatch(/[\n\u202e]/);
  if (raw.startsWith('[')) expect(serialized).toContain('Readable');
});

it('marks per-configuration nozzle loss as Caution while stage overrides stay Information', () => {
  const tree = defaultTree(), stage = tree.components[0]!.id!, notes: string[] = [];
  const config = { id: 'c1', name: 'Flight', isDefault: true, motors: {}, stageMassOverrides: { [stage]: { overrideMass: 0.2 } } };
  exportOrk({ name: 'Overrides', tree, configs: [config], notes });
  expect(notes.join(' ')).toContain('Per-configuration stage mass and CG');
  expect(highestTier(noteFlags(notes))).toBe('information');
  const losses: string[] = [];
  exportOrk({ name: 'Nozzles', tree, configs: [{ ...config, nozzles: { [stage]: 0.01 } }], notes: losses });
  expect(losses.join(' ')).toContain('Nozzle exit diameters differ');
  expect(highestTier(noteFlags(losses))).toBe('caution');
});
