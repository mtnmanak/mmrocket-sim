// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { SaveMyPartDialog } from './SaveMyPartDialog.js';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { loadBundledPresets, loadCustomPresets, presetPatch, saveCustomPresets } from '../services/presets.js';

vi.mock('../data/presets.json', () => ({ default: { presets: [
  { kind: 'BodyTube', manufacturer: 'Estes', partNo: 'BT-2', description: 'Bundled tube', altPartNos: ['BT-2-ALT'] },
] } }));
vi.mock('../services/presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/presets.js')>();
  return { ...real, loadBundledPresets: vi.fn(real.loadBundledPresets) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const close = vi.fn();
const node: ComponentNode = { type: 'bodytube', id: 'b', name: 'Handmade tube', length: 0.3, outerRadius: 0.025, thickness: 0.002 };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const field = (label: string) => {
  const id = [...host.querySelectorAll('label')].find((el) => el.textContent === label)!.htmlFor;
  return host.querySelector<HTMLInputElement>(`[id="${id}"]`)!;
};
const input = (label: string, value: string) => act(() => {
  const el = field(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const save = async () => {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
};
beforeAll(async () => { await loadBundledPresets(); });
beforeEach(() => {
  localStorage.clear(); close.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<SaveMyPartDialog node={node} onClose={close} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('M2.2 save dialog', () => {
  it.each(['parachute', 'streamer'] as const)('S3c-2 saves and restores a zero-density %s', async type => {
    act(() => root.render(<SaveMyPartDialog node={{ type, surfaceDensity: 0, lineDensity: 0 }} onClose={close} />));
    input('Part number', 'ZERO'); await save();
    const notes: string[] = [];
    const stored = loadCustomPresets(notes)[0]!;
    expect(notes).toEqual([]);
    expect(presetPatch(type, stored, undefined, undefined, { saved: true })['surfaceDensity']).toBe(0);
    if (type === 'parachute') expect(presetPatch(type, stored, undefined, undefined, { saved: true })['lineDensity']).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });
  it('S3a-1 keeps fields read-only while the catalogue is loading', async () => {
    let finish!: (rows: readonly never[]) => void;
    vi.mocked(loadBundledPresets).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    input('Part number', 'A'); field('Part number').focus();
    act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (const label of ['Manufacturer', 'Part number', 'Description']) expect(field(label).readOnly).toBe(true);
    expect(document.activeElement).toBe(field('Part number'));
    await act(async () => finish([]));
    expect(loadCustomPresets()[0]?.partNo).toBe('A');
  });
  it('prefills the part name and requires a nonblank part number', async () => {
    expect(field('Manufacturer').value).toBe('My parts');
    expect(field('Description').value).toBe('Handmade tube');
    await save();
    expect(host.textContent).toContain('Enter a part number.');
    expect(field('Part number').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('Part number'));
    expect(close).not.toHaveBeenCalled();
    expect(loadCustomPresets()).toHaveLength(0);
  });
  it('refuses a bundled identity, including manufacturer aliases, but preserves + in part numbers', async () => {
    input('Manufacturer', 'Estes Industries'); input('Part number', 'BT-2');
    await save();
    expect(host.textContent).toContain('belong to a bundled catalogue part');
    expect(document.activeElement).toBe(field('Part number'));
    expect(close).not.toHaveBeenCalled();
    expect(loadCustomPresets()).toHaveLength(0);
    input('Part number', 'BT-2+'); await save();
    expect(loadCustomPresets()[0]?.partNo).toBe('BT-2+');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('replaces only the matching custom kind/manufacturer/part number and never patches the design', async () => {
    saveCustomPresets([
      { kind: 'BodyTube', manufacturer: 'My parts', partNo: 'T1', description: 'Old' },
      { kind: 'NoseCone', manufacturer: 'My parts', partNo: 'T1', description: 'Keep kind' },
      { kind: 'BodyTube', manufacturer: 'Other', partNo: 'T1', description: 'Keep manufacturer' },
    ]);
    input('Part number', ' T1 '); input('Description', 'Updated'); await save();
    const rows = loadCustomPresets();
    expect(rows).toHaveLength(3);
    expect(rows.map((p) => p.description)).toEqual(['Keep kind', 'Keep manufacturer', 'Updated']);
    expect(rows[2]).toMatchObject({ outsideDiameter: 0.05, length: 0.3, thickness: 0.002 });
    expect(rows[2]?.mass).toBeUndefined();
    expect(node.name).toBe('Handmade tube');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('reports a storage failure and keeps the dialog and entered values', async () => {
    input('Part number', 'T1');
    const original = localStorage.setItem;
    Object.defineProperty(localStorage, 'setItem', { configurable: true, value: () => { throw new Error('quota'); } });
    try {
      await save();
      expect(host.textContent).toContain('storage is full or blocked');
      expect(close).not.toHaveBeenCalled();
      expect(field('Part number').value).toBe('T1');
      expect(document.activeElement).toBe(field('Part number'));
      expect(loadCustomPresets()).toHaveLength(0);
    } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: original }); }
  });
  it('does not save after Cancel while the bundled catalogue is still loading', async () => {
    let finish!: (rows: readonly never[]) => void;
    vi.mocked(loadBundledPresets).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    input('Part number', 'T1');
    act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(field('Part number').disabled).toBe(false);
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click());
    await act(async () => { finish([]); });
    expect(loadCustomPresets()).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('opens from the property-panel preset area for a supported part', async () => {
    act(() => root.render(<PrefsProvider><PropertyPanel node={node} tree={{ components: [node] }} onPatch={() => { throw new Error('Must not change design'); }} /></PrefsProvider>));
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Save as My part'));
    expect(button).toBeDefined();
    act(() => button!.click()); await flush();
    expect(host.querySelector('[role="dialog"][aria-label="Save as My part"]')).not.toBeNull();
  });
  it('allows a bundled identity of another kind', async () => {
    act(() => root.render(<SaveMyPartDialog node={{ type: 'nosecone' }} onClose={close} />));
    input('Manufacturer', 'Estes'); input('Part number', 'BT-2'); await save();
    expect(loadCustomPresets()).toHaveLength(1);
    expect(loadCustomPresets()[0]?.kind).toBe('NoseCone');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('refuses a bundled alternate part number of the same kind', async () => {
    input('Manufacturer', 'Estes'); input('Part number', 'BT-2-ALT'); await save();
    expect(host.textContent).toContain('belong to a bundled catalogue part');
    expect(loadCustomPresets()).toHaveLength(0);
  });
  it('replaces a normalized custom identity so the saved row resolves unambiguously', async () => {
    saveCustomPresets([{ kind: 'BodyTube', manufacturer: 'My parts', partNo: 'T-1', description: 'Old' }]);
    input('Manufacturer', 'my parts'); input('Part number', 'T1'); await save();
    expect(loadCustomPresets()).toHaveLength(1);
    expect(loadCustomPresets()[0]).toMatchObject({ manufacturer: 'my parts', partNo: 'T1', description: 'Handmade tube' });
  });
  it('retains focus and accepts only one submit while the catalogue loads', async () => {
    let finish!: (rows: readonly never[]) => void;
    vi.mocked(loadBundledPresets).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    input('Part number', 'T1'); field('Part number').focus();
    act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect([...host.querySelectorAll('input, button')].some((el) => (el as HTMLInputElement).disabled)).toBe(false);
    expect(document.activeElement).toBe(field('Part number'));
    act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(loadCustomPresets()).toHaveLength(0);
    await act(async () => finish([]));
    expect(loadCustomPresets()).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('refuses punctuation-only part numbers with an explanation', async () => {
    input('Part number', '—'); await save();
    expect(host.textContent).toContain('punctuation alone cannot identify a part');
    expect(loadCustomPresets()).toEqual([]);
    expect(document.activeElement).toBe(field('Part number'));
  });
  it.each([['Ü1', 'Ä1'], ['Корпус', 'Носок'], ['管', '鼻'], ['Tube-ü', 'Tube-ä']])('refuses ambiguous Unicode part numbers %s and %s', async (first, second) => {
    input('Part number', first); await save();
    expect(loadCustomPresets().map((p) => p.partNo)).toEqual([first]);
    close.mockClear();
    input('Part number', second); await save();
    expect(loadCustomPresets().map((p) => p.partNo)).toEqual([first]);
    expect(host.textContent).toContain(`cannot be told apart from My part My parts ${first}`);
    expect(host.textContent).toContain('Latin letter or digit');
    expect(document.activeElement).toBe(field('Part number'));
    expect(close).not.toHaveBeenCalled();
  });
  it('refuses ambiguous Unicode manufacturers with the same part number', async () => {
    saveCustomPresets([{ kind: 'BodyTube', manufacturer: '管', partNo: 'T1', description: 'Keep' }]);
    input('Manufacturer', '鼻'); input('Part number', 'T1'); await save();
    expect(loadCustomPresets().map((p) => p.manufacturer)).toEqual(['管']);
    expect(host.textContent).toContain('cannot be told apart from My part 管 T1');
    expect(close).not.toHaveBeenCalled();
  });
  it('keeps Unicode part numbers with distinguishing Latin letters or digits', async () => {
    input('Part number', 'Корпус-1'); await save();
    input('Part number', 'Носок-2'); await save();
    expect(loadCustomPresets().map((p) => p.partNo)).toEqual(['Корпус-1', 'Носок-2']);
  });
  it('shows a success confirmation below the panel preset buttons after saving', async () => {
    act(() => root.render(<PrefsProvider><PropertyPanel node={node} tree={{ components: [node] }} onPatch={() => {}} /></PrefsProvider>));
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Save as My part'))!.click());
    const regions = [...host.querySelectorAll('[role="status"]')];
    input('Part number', 'T1'); await save();
    const success = [...host.querySelectorAll('[role="status"]')].find(s => s.textContent?.includes('Saved My parts T1'));
    expect(regions).toContain(success);
    expect(host.querySelector('[aria-label="Save as My part"]')).toBeNull();
    expect([...host.querySelectorAll('[role="status"]')].some((s) => s.textContent?.includes('Saved My parts T1 in this browser.'))).toBe(true);
  });
  it('offers no save action for freeform fins', () => {
    const fin: ComponentNode = { type: 'freeformfinset', id: 'f' };
    act(() => root.render(<PrefsProvider><PropertyPanel node={fin} tree={{ components: [fin] }} onPatch={() => {}} /></PrefsProvider>));
    expect(host.textContent).not.toContain('Save as My part');
  });
});

/** Audit S7-3: Save rebuilds the list from the raw store, never from the filtering reader. */
describe('S7-3 save keeps rows it cannot read', () => {
  const KEY = 'online-openrocket.custom-presets.v1';
  const unreadable = { kind: 'BodyTube', manufacturer: 'Newer build', partNo: 7, description: 'x' };
  it('keeps unreadable rows verbatim and replaces the matching row', async () => {
    const existing = { kind: 'BodyTube', manufacturer: 'My parts', partNo: 'P1', description: 'Old', length: 0.1 };
    const other = { ...existing, partNo: 'P2' };
    localStorage.setItem(KEY, JSON.stringify([unreadable, existing, 'junk', other]));
    input('Part number', 'P1'); await save();
    const stored = JSON.parse(localStorage.getItem(KEY)!) as unknown[];
    expect(stored.slice(0, 3)).toEqual([unreadable, 'junk', other]);
    expect(stored).toHaveLength(4);
    expect(stored[3]).toMatchObject({ partNo: 'P1', description: 'Handmade tube' });
    expect(close).toHaveBeenCalledOnce();
  });
  it.each(['{not json', '{"rows":[]}', 'null'])('refuses to save over an unreadable store %s', async (raw) => {
    localStorage.setItem(KEY, raw);
    input('Part number', 'P1'); await save();
    expect(localStorage.getItem(KEY)).toBe(raw);
    expect(host.textContent).toContain('Could not save My part. Stored My parts could not be read, so the app left them unchanged.');
    expect(close).not.toHaveBeenCalled();
  });
});
