// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresetPicker } from './PresetPicker.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import {
  componentToPreset, csvToPresets, editCustomPresets, loadBundledPresets, loadCustomPresets, presetsToCsv, saveCustomPresets, type Preset,
} from '../services/presets.js';
import { downloadBlob } from '../services/saveFile.js';

vi.mock('../data/presets.json', () => ({ default: { presets: [
  { kind: 'BodyTube', manufacturer: 'Factory', partNo: 'B1', description: 'Bundled tube', length: 0.2, outsideDiameter: 0.03 },
] } }));
vi.mock('../services/saveFile.js', () => ({ downloadBlob: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const apply = vi.fn(); const close = vi.fn();
const CUSTOM: Preset = { kind: 'BodyTube', manufacturer: 'My parts', partNo: 'M1', description: 'Homemade', length: 0.4 };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const render = async () => {
  act(() => root.render(<PrefsProvider><PresetPicker type="bodytube" onApply={apply} onClose={close} /></PrefsProvider>));
  await flush();
};
const toggle = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const rows = () => [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')];
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
const deleting = () => host.querySelector<HTMLButtonElement>('[aria-label="Delete My part: My parts M1"]')!;
const importCsv = async (csv: string) => {
  const el = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(el, 'files', { configurable: true, value: [new File([csv], 'parts.csv')] });
  await act(async () => { el.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
};
beforeAll(async () => { await loadBundledPresets(); });
beforeEach(() => {
  localStorage.clear(); apply.mockClear(); close.mockClear(); vi.mocked(downloadBlob).mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('M2.3 My parts picker', () => {
  it('marks only custom rows and never offers deletion for bundled rows, even an identical imported copy', async () => {
    saveCustomPresets([CUSTOM, { ...(await loadBundledPresets())[0]! }]); await render();
    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.textContent).not.toContain('my part');
    expect(rows()[0]!.querySelector('button')).toBeNull();
    expect(rows()[1]!.textContent).toContain('my part');
    expect(rows()[1]!.querySelector('button')?.textContent).toBe('Delete');
    expect(rows()[2]!.textContent).toContain('my part');
  });
  it('persists My parts only across reopening and exports only matching user rows', async () => {
    saveCustomPresets([CUSTOM, { ...CUSTOM, kind: 'NoseCone', partNo: 'N1' }]); await render();
    expect(toggle().checked).toBe(false);
    act(() => toggle().click());
    expect(rows().map((r) => r.cells[1]!.textContent)).toEqual(['M1']);
    act(() => button('⬇ CSV').click());
    const blob = vi.mocked(downloadBlob).mock.calls[0]![0];
    expect(csvToPresets(await blob.text())).toEqual([CUSTOM]);
    act(() => root.unmount()); root = createRoot(host); await render();
    expect(toggle().checked).toBe(true);
    expect(rows()).toHaveLength(1);
    act(() => toggle().click()); expect(rows()).toHaveLength(2);
  });
  it('exports all own matches beyond the table cap', async () => {
    saveCustomPresets(Array.from({ length: 301 }, (_, i) => ({ ...CUSTOM, partNo: `M${i}` })));
    await render(); act(() => toggle().click());
    expect(rows()).toHaveLength(300);
    act(() => button('⬇ CSV').click());
    expect(csvToPresets(await vi.mocked(downloadBlob).mock.calls[0]![0].text())).toHaveLength(301);
  });
  it('confirms once, cancels safely, deletes only the custom row and never applies it', async () => {
    saveCustomPresets([CUSTOM]); await render();
    act(() => deleting().click());
    expect(apply).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(loadCustomPresets()).toHaveLength(1);
    expect(host.querySelector('[role="dialog"][aria-label="Delete My part"]')).not.toBeNull();
    act(() => button('Cancel').click()); expect(loadCustomPresets()).toHaveLength(1);
    act(() => deleting().click());
    const confirm = host.querySelector('[aria-label="Delete My part"]')!;
    act(() => [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click());
    expect(loadCustomPresets()).toHaveLength(0);
    expect(rows()).toHaveLength(1); expect(rows()[0]!.cells[1]!.textContent).toBe('B1');
    expect(host.textContent).toContain('Deleted My parts M1');
    expect(apply).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it('keeps a custom row and reports a failed deletion', async () => {
    saveCustomPresets([CUSTOM]); await render(); act(() => deleting().click());
    const original = localStorage.setItem;
    Object.defineProperty(localStorage, 'setItem', { configurable: true, value: () => { throw new Error('blocked'); } });
    try {
      const confirm = host.querySelector('[aria-label="Delete My part"]')!;
      act(() => [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click());
      expect(host.textContent).toContain('Could not delete My part');
      expect(loadCustomPresets()).toHaveLength(1); expect(rows()).toHaveLength(2);
    } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: original }); }
  });
  it.each(['Delete', 'Backspace'])('opens deletion with %s from the roving row without adding table tab stops', async (key) => {
    saveCustomPresets([CUSTOM]); await render();
    expect(host.querySelectorAll('tbody [tabindex="0"]')).toHaveLength(1);
    const row = rows()[1]!;
    act(() => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    expect(host.querySelector('[aria-label="Delete My part"]')).not.toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(deleting().title).toContain('Delete or Backspace');
    const confirm = host.querySelector('[aria-label="Delete My part"]')!;
    act(() => [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click());
    expect(document.activeElement).toBe(toggle());
  });
  it('restores saved component fields on an interactive pick', async () => {
    saveCustomPresets([{ ...CUSTOM, savedComponent: true, length: undefined, thickness: 0.003 }]);
    await render();
    act(() => rows()[1]!.click());
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ thickness: 0.003 }));
    expect(apply.mock.calls[0]![0]).not.toHaveProperty('length');
  });
  it('shows no matches when search hides existing My parts', async () => {
    saveCustomPresets([CUSTOM]); await render(); act(() => toggle().click());
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'missing');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('No presets match.');
    expect(host.textContent).not.toContain('No My parts of this kind');
  });
  it('clears a manufacturer that disappears on deletion', async () => {
    saveCustomPresets([CUSTOM, { ...CUSTOM, manufacturer: 'Other', partNo: 'O1' }]);
    await render(); act(() => toggle().click());
    const select = host.querySelector('select')!;
    act(() => { select.value = 'My parts'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => deleting().click());
    act(() => { [...host.querySelectorAll('[aria-label="Delete My part"] button')].find((b) => b.textContent === 'Delete')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(select.value).toBe('');
    expect(rows().map((r) => r.cells[1]!.textContent)).toEqual(['O1']);
  });
  it('deletes only the exact displayed identity among legacy normalized duplicates', async () => {
    const other = { ...CUSTOM, manufacturer: 'my parts', partNo: 'M-1' };
    saveCustomPresets([CUSTOM, other]); await render();
    act(() => deleting().click());
    act(() => { [...host.querySelectorAll('[aria-label="Delete My part"] button')].find((b) => b.textContent === 'Delete')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(loadCustomPresets()).toEqual([other]);
    expect(rows().map((r) => r.cells[1]!.textContent)).toEqual(['B1', 'M-1']);
  });
  it.each([['My Parts', 'my parts'], ['Estes Industries', 'Estes']])('CSV import replaces normalized numbers and manufacturer aliases (%s)', async (oldMfr, newMfr) => {
    saveCustomPresets([{ ...CUSTOM, manufacturer: oldMfr, partNo: 'T-1' }]); await render();
    const imported = { ...CUSTOM, manufacturer: newMfr, partNo: 'T1', description: 'Updated' };
    await importCsv(presetsToCsv([imported]));
    expect(loadCustomPresets()).toEqual([imported]);
  });
  it.each(['fresh', 'repeat'] as const)('normalizes only a linear number of identities during a %s CSV import', async (mode) => {
    const incoming = Array.from({ length: 64 }, (_, i) => ({ ...CUSTOM, partNo: `T-${i}`, description: 'Updated' }));
    const stored = mode === 'repeat'
      ? incoming.map((p) => ({ ...p, partNo: p.partNo.replace('-', ''), description: 'Old' })) : [];
    const retained = { ...CUSTOM, kind: 'NoseCone', partNo: 'T0' };
    saveCustomPresets([...stored, retained]); await render();
    const csv = presetsToCsv(incoming);
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      await importCsv(csv);
      // Count work rather than elapsed time, so slower machines use the same guard.
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(4 * (stored.length + 1 + incoming.length));
      expect(host.textContent).toContain('Imported 64 preset(s)');
      expect(loadCustomPresets()).toEqual([retained, ...incoming]);
    } finally { normalize.mockRestore(); }
  });
  it('imports a saved nameless material and clears the receiving material name', async () => {
    await render();
    await importCsv(presetsToCsv([{ ...componentToPreset({ type: 'bodytube', length: 0.2, density: 680 }), partNo: 'DEFAULT' }]));
    expect(host.textContent).toContain('Imported 1 preset(s)');
    act(() => rows()[1]!.click());
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ density: 680, materialName: undefined }));
  });
  it.each(['', '54 mm'])('keeps the receiving tube radius when saved CSV outsideDiameter is %j', async (outsideDiameter) => {
    const node = { type: 'bodytube', outerRadius: 0.027 } as const;
    act(() => root.render(<PrefsProvider><PresetPicker type="bodytube" node={node} onApply={apply} onClose={close} /></PrefsProvider>));
    await flush();
    await importCsv(`kind,manufacturer,partNo,savedComponent,outsideDiameter\nBodyTube,My parts,BLANK,TRUE,${outsideDiameter}\n`);
    expect(host.textContent).toContain('Imported 1 preset(s)');
    act(() => rows()[1]!.click());
    expect({ ...node, ...apply.mock.calls[0]![0] }).toMatchObject({ outerRadius: 0.027 });
  });
  it.each(['existing', 'same CSV'] as const)('refuses ambiguous CSV identities against %s rows without changing storage', async (source) => {
    const first = { ...CUSTOM, partNo: 'Корпус', outsideDiameter: 0.064 };
    const second = { ...CUSTOM, partNo: 'Носок', outsideDiameter: 0.05 };
    const before = source === 'existing' ? [first] : [];
    saveCustomPresets(before); await render();
    await importCsv(presetsToCsv(source === 'existing' ? [second] : [first, second]));
    expect(loadCustomPresets()).toEqual(before);
    expect(host.textContent).toContain('Nothing imported.');
    expect(host.textContent).toContain(`cannot be told apart from My part My parts ${first.partNo}`);
    expect(host.textContent).toContain('Latin letter or digit');
  });
  it('preserves unrelated legacy link collisions during CSV import', async () => {
    const legacy = ['Корпус', 'Носок'].map((partNo) => ({ ...CUSTOM, partNo }));
    saveCustomPresets(legacy); await render();
    await importCsv(presetsToCsv([CUSTOM]));
    expect(host.textContent).toContain('Imported 1 preset(s)');
    expect(loadCustomPresets()).toEqual([...legacy, CUSTOM]);
  });
  it('keeps normalized duplicates within the CSV and distinguishes plus signs', async () => {
    const incoming = ['T1', 'T-1', 'T1+'].map((partNo) => ({ ...CUSTOM, partNo }));
    saveCustomPresets([{ ...CUSTOM, partNo: 't 1' }]); await render();
    await importCsv(presetsToCsv(incoming));
    expect(host.textContent).toContain('Imported 3 preset(s)');
    expect(loadCustomPresets()).toEqual(incoming);
  });
  it('shows a visible keyboard deletion hint outside the screen-reader-only text', async () => {
    await render();
    const hint = [...host.querySelectorAll('p')].find((p) => p.textContent?.includes('Delete or Backspace on a my part row'));
    expect(hint).toBeDefined();
    expect(hint!.closest('.sr-only')).toBeNull();
  });
  it('labels the remembered My parts count and explains its empty view', async () => {
    localStorage.setItem('online-openrocket.preset-my-parts-only.v1', 'true');
    await render();
    expect(host.querySelector('h2')?.textContent).toContain('My parts · 0 parts');
    expect(host.textContent).toContain('No My parts of this kind — turn off My parts only to see the catalogue.');
    act(() => toggle().click());
    expect(rows()).toHaveLength(1);
    expect(host.querySelector('h2')?.textContent).toContain('openrocket-database · 1 parts');
  });
  it('keeps the catalogue columns, values, ordering and application unchanged without custom parts', async () => {
    await render();
    expect(toggle().checked).toBe(false);
    expect([...host.querySelectorAll('th')].map((h) => h.textContent)).toEqual(['Manufacturer', 'Part number', 'Description', 'Dimensions', 'Material']);
    expect(rows()).toHaveLength(1);
    expect([...rows()[0]!.cells].map((c) => c.textContent)).toEqual(['Factory', 'B1', 'Bundled tube', '⌀30 L200 mm', '']);
    expect(rows()[0]!.textContent).not.toContain('my part');
    expect(host.querySelector('[aria-label^="Delete My part:"]')).toBeNull();
    act(() => rows()[0]!.click());
    expect(apply).toHaveBeenCalledWith({ name: 'Factory B1', length: 0.2, outerRadius: 0.015, filled: false,
      presetManufacturer: 'Factory', presetPartNo: 'B1', orkPresetManufacturer: undefined,
      orkPresetPartNo: undefined, orkPresetDigest: undefined });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

/** Audit S7-3 / S3c-4: a write rebuilds the list from the raw store, never from the filtering reader. */
describe('S7-3 My parts writes keep rows they cannot read', () => {
  const KEY = 'online-openrocket.custom-presets.v1';
  const UNREADABLE = [{ kind: 'BodyTube', manufacturer: 'Newer build', partNo: 7, description: 'x' }, 'not a row', null];
  const NEW_ROW: Preset = { kind: 'BodyTube', manufacturer: 'My parts', partNo: 'N1', description: 'New', length: 0.3 };
  const confirmDelete = () => {
    act(() => deleting().click());
    const confirm = host.querySelector('[aria-label="Delete My part"]')!;
    act(() => [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click());
  };
  it('deletes only the chosen row and keeps unreadable rows verbatim and in place', async () => {
    localStorage.setItem(KEY, JSON.stringify([UNREADABLE[0], CUSTOM, ...UNREADABLE.slice(1)]));
    await render();
    confirmDelete();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(UNREADABLE));
  });
  it('imports beside unreadable rows and keeps them verbatim', async () => {
    localStorage.setItem(KEY, JSON.stringify([UNREADABLE[0], CUSTOM]));
    await render();
    await importCsv(presetsToCsv([NEW_ROW]));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([UNREADABLE[0], CUSTOM, NEW_ROW]);
    expect(host.textContent).toContain('Imported 1 preset(s)');
  });
  it('drops the replaced row and appends its import beside an unreadable row', async () => {
    localStorage.setItem(KEY, JSON.stringify([CUSTOM, UNREADABLE[0]]));
    await render();
    const replaced = { ...CUSTOM, description: 'Replaced' };
    await importCsv(presetsToCsv([replaced]));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([UNREADABLE[0], replaced]);
  });
  // An unreadable store is copied aside, then replaced: refusing left the user
  // nothing in the app that could recover (cloud session 20).
  it.each(['{not json', '{"rows":[]}', '"text"', 'null'])('copies an unreadable store %s aside, then imports into a new list', async (raw) => {
    saveCustomPresets([CUSTOM]); await render();
    localStorage.setItem(KEY, raw);
    await importCsv(presetsToCsv([NEW_ROW]));
    expect(localStorage.getItem(`${KEY}.unreadable-backup`)).toBe(raw);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([NEW_ROW]);
    expect(host.textContent).toContain('Stored My parts could not be read. The app kept a copy of them in this browser and started a new list.');
  });
  it('copies an unreadable store aside on a delete too', async () => {
    saveCustomPresets([CUSTOM]); await render();
    localStorage.setItem(KEY, '{not json');
    confirmDelete();
    expect(localStorage.getItem(`${KEY}.unreadable-backup`)).toBe('{not json');
    expect(localStorage.getItem(KEY)).toBe('[]');
  });
  it('refuses, as before, when an earlier different copy holds the side key', async () => {
    saveCustomPresets([CUSTOM]); await render();
    localStorage.setItem(`${KEY}.unreadable-backup`, 'older');
    localStorage.setItem(KEY, '{not json');
    confirmDelete();
    expect(localStorage.getItem(KEY)).toBe('{not json');
    expect(host.textContent).toContain('Could not delete My part. Stored My parts could not be read, so the app left them unchanged.');
    await importCsv(presetsToCsv([NEW_ROW]));
    expect(localStorage.getItem(KEY)).toBe('{not json');
    expect(localStorage.getItem(`${KEY}.unreadable-backup`)).toBe('older');
    expect(host.textContent).toContain('Nothing imported. Stored My parts could not be read, so the app left them unchanged.');
  });
  it('rewrites a valid list byte for byte and leaves a row repaired on read as stored', () => {
    const repairedOnRead = { ...CUSTOM, partNo: 'R1', mass: '5' };
    const raw = JSON.stringify([CUSTOM, repairedOnRead, NEW_ROW]);
    localStorage.setItem(KEY, raw);
    const before = loadCustomPresets();
    expect(saveCustomPresets(editCustomPresets(() => false)!.list)).toBe(true);
    expect(localStorage.getItem(KEY)).toBe(raw);
    expect(loadCustomPresets()).toEqual(before);
    expect(editCustomPresets((p) => p.partNo === 'M1')).toEqual({ list: [repairedOnRead, NEW_ROW], backedUp: false });
  });
  it('reads an absent store as empty and refuses one that cannot be read', () => {
    expect(editCustomPresets(() => true, [NEW_ROW])).toEqual({ list: [NEW_ROW], backedUp: false });
    const original = localStorage.getItem;
    Object.defineProperty(localStorage, 'getItem', { configurable: true, value: () => { throw new Error('blocked'); } });
    try {
      expect(editCustomPresets(() => true, [NEW_ROW])).toBeNull();
    } finally { Object.defineProperty(localStorage, 'getItem', { configurable: true, value: original }); }
  });
  it('S3c-4 reports a refused import write even when storage already holds the same rows', async () => {
    saveCustomPresets([NEW_ROW]); await render();
    const original = localStorage.setItem;
    Object.defineProperty(localStorage, 'setItem', { configurable: true, value: () => { throw new Error('blocked'); } });
    try {
      await importCsv(presetsToCsv([NEW_ROW]));
    } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: original }); }
    expect(host.textContent).toContain('Could not store 1 of 1 preset(s)');
    expect(host.textContent).not.toContain('Imported 1 preset(s)');
  });
});
