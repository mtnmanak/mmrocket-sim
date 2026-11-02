// @vitest-environment happy-dom
import { afterEach, onTestFinished, expect, it, vi } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { defaultTree } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { MAX_STORED_WARNINGS } from './storedWarnings.js';
import { USER_MATERIALS_KEY, writeUserMaterials, saveUserMaterials } from './userMaterials.js';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const readable = { key: 'Readable', message: 'kept' };
const deep = { ...readable, details: Array.from({ length: 20 }).reduce<unknown>(x => [x], null) };
it.each([
  ['broken JSON', 'No warnings could be read.'],
  [JSON.stringify([readable, null]), 'The readable warnings were kept.'],
  [JSON.stringify([deep]), 'Only stop and high-priority warnings were kept'],
  [JSON.stringify(Array.from({ length: MAX_STORED_WARNINGS + 1 }, () => readable)), 'Only stop and high-priority warnings were kept'],
  [JSON.stringify([{ ...readable, ...Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`field${i}`, i])) }]), 'Only stop and high-priority warnings were kept'],
])('R4 describes the warning read branch for %s', (raw, wording) => {
  const xml = exportOrk({ name: 'Warnings', tree: defaultTree(), launch: DEFAULT_CONDITIONS,
    configs: [{ id: 'c1', name: 'Flight', isDefault: true, motors: {} }], activeConfigId: 'c1',
    flightData: { c1: { aeroModel: 'classic', maxAltitude: 123, simWarnings: [] } } });
  const result = importOrk(xml.replace(/<simwarnings[^>]*>.*?<\/simwarnings>/, `<simwarnings version="1">${raw}</simwarnings>`));
  expect(result.notes.join(' ')).toContain(wording);
  expect(result.notes.join(' ')).toContain('This does not mean the flight had no warnings.');
});

it.each(['broken JSON', JSON.stringify([{ bad: true }])])('R4 retains the material copy result after a refused write (%s)', raw => {
  localStorage.setItem(USER_MATERIALS_KEY, raw);
  const real = localStorage.setItem;
  onTestFinished(() => { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: real }); });
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === USER_MATERIALS_KEY) throw new DOMException('full', 'QuotaExceededError');
    real.call(localStorage, key, value);
  });
  expect(writeUserMaterials([{ kind: 'bulk', name: 'My mix', density: 900 }])).toBe('backup-write-failed');
  expect(saveUserMaterials([{ kind: 'bulk', name: 'My mix', density: 900 }])).toBe(false);
  expect(localStorage.getItem(`${USER_MATERIALS_KEY}.unreadable-backup`)).toBe(raw);
  expect(localStorage.getItem(USER_MATERIALS_KEY)).toBe(raw);
});
