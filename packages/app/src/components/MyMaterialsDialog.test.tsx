// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, onTestFinished, beforeEach, expect, it, vi } from 'vitest';
import { MyMaterialsDialog } from './MyMaterialsDialog.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { loadUserMaterials, saveUserMaterials, USER_MATERIALS_KEY } from '../services/userMaterials.js';
import { downloadBlob } from '../services/saveFile.js';

vi.mock('../services/saveFile.js', () => ({ downloadBlob: vi.fn() }));
const locale = vi.hoisted(() => ({ decimalComma: undefined as boolean | undefined }));
vi.mock('../prefs/units.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../prefs/units.js')>();
  return { ...actual, readDecimal: (text: string, decimalComma = locale.decimalComma) => actual.readDecimal(text, decimalComma) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const click = (el: HTMLElement) => act(() => el.click());
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === text || b.textContent === text)!;
const input = (label: string) => {
  const l = [...host.querySelectorAll('label')].find(l => l.textContent === label)!;
  return host.querySelector<HTMLInputElement>(`[id="${l.htmlFor}"]`)!;
};
const type = (el: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const mount = () => act(() => root.render(<PrefsProvider><MyMaterialsDialog onClose={() => root.render(null)} /></PrefsProvider>));
const upload = async (csv: string) => {
  const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(field, 'files', { value: [new File([csv], 'materials.csv')], configurable: true });
  await act(async () => { field.dispatchEvent(new Event('change', { bubbles: true })); });
};
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
it.each(['0', '-5', '', '1,250', '0x10'])('S3c-g1 refuses the visible invalid density %j on submit', value => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }]); mount();
  click(button('Edit bulk material Mix'));
  type(input('Density (kg/m³)'), value);
  act(() => button('Save material').focus());
  const density = input('Density (kg/m³)');
  const focused: { invalid: string | null; description: string | null | undefined }[] = [];
  density.addEventListener('focus', () => focused.push({ invalid: density.getAttribute('aria-invalid'),
    description: document.getElementById(density.getAttribute('aria-describedby') ?? '')?.textContent }));
  act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(host.querySelector('form')).not.toBeNull();
  expect(host.textContent).not.toContain('Material updated.');
  expect(loadUserMaterials()[0]?.density).toBe(900);
  expect(focused).toEqual([{ invalid: 'true', description: expect.stringMatching(/density/i) }]);
  expect(density.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(density);
  const errorId = density.getAttribute('aria-describedby');
  expect(errorId).toBeTruthy();
  expect(document.getElementById(errorId!)?.textContent).toMatch(/density/i);
});
it('S3c-g1 does not report an update after another tab deleted the edited material', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }]); mount();
  click(button('Edit bulk material Mix'));
  localStorage.setItem(USER_MATERIALS_KEY, '[]');
  act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(host.textContent).not.toContain('Material updated.');
  expect(loadUserMaterials()).toEqual([]);
  expect(host.textContent).toContain('no longer in My materials');
});
it('renames an unchanged app-seeded density in a decimal-comma locale without accepting a new ambiguous draft', () => {
  locale.decimalComma = true;
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900.125 }]); mount();
  click(button('Edit bulk material Mix'));
  type(input('Material name'), 'Renamed');
  act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(loadUserMaterials()).toEqual([{ kind: 'bulk', name: 'Renamed', density: 900.125 }]);
  expect(host.textContent).toContain('Material updated.');
  click(button('Edit bulk material Renamed'));
  type(input('Density (kg/m³)'), '800.125');
  act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(host.querySelector('form')).not.toBeNull();
  expect(loadUserMaterials()[0]?.density).toBe(900.125);
  type(input('Density (kg/m³)'), '800,125');
  act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(loadUserMaterials()[0]?.density).toBe(800.125);
});
afterEach(() => { locale.decimalComma = undefined; act(() => root.unmount()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); });
it('uses themed buttons and a destructive confirmation in the material library', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }]); mount();
  const themed = () => {
    for (const el of host.querySelectorAll('button:not([tabindex="-1"])')) expect(el.classList.contains('file-btn')).toBe(true);
  };
  themed(); click(button('Edit bulk material Mix')); themed(); click(button('Cancel'));
  click(button('Delete bulk material Mix')); themed();
  expect(button('Delete material').classList.contains('modal-danger')).toBe(true);
});
it('imports and displays added/replaced/refused counts with a built-in refusal reason', async () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }]); mount();
  const status = host.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(status!.textContent).toBe('');
  await upload('kind,name,density,unit\nbulk,MIX,1000,kg/m3\nsurface,Cloth,0.1,kg/m2\nbulk,Balsa,170,kg/m3\n');
  expect(host.querySelector('[role="status"]')).toBe(status);
  expect(status!.textContent).toContain('1 added, 1 replaced, 1 refused.');
  expect(host.textContent).toContain('Balsa is in the built-in list');
  expect(loadUserMaterials()).toEqual([{ kind: 'bulk', name: 'MIX', density: 1000 }, { kind: 'surface', name: 'Cloth', density: 0.1 }]);
  expect(host.querySelector('section[aria-label="bulk materials"]')?.textContent).toContain('1000 kg/m³');
  expect(host.querySelector('section[aria-label="surface materials"]')?.textContent).toContain('0.1 kg/m²');
});
it('distinguishes edit, delete and confirmations for the same name in different kinds', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }, { kind: 'surface', name: 'Mix', density: 0.1 }]); mount();
  for (const kind of ['bulk', 'surface']) {
    expect(button(`Edit ${kind} material Mix`)).toBeDefined();
    click(button(`Delete ${kind} material Mix`));
    const confirmation = host.querySelector(`[role="dialog"][aria-label="Delete ${kind} material Mix?"]`);
    expect(confirmation?.querySelector('h2')?.textContent).toBe(`Delete ${kind} material Mix?`);
    click(button('Cancel'));
  }
});
it('reports duplicate CSV names once and bounds the refusal detail shown in the status', async () => {
  mount();
  await upload('kind,name,density,unit\nbulk,New,1,kg/m3\nbulk,NEW,2,kg/m3\n'
    + 'bulk,Bad,1,5,kg/m3\n'.repeat(30));
  const status = host.querySelector('[role="status"]')!.textContent!;
  expect(status).toContain('1 added, 0 replaced, 30 refused.');
  expect(status.match(/Expected four columns/g)).toHaveLength(10);
  expect(status).toContain('and 20 more');
  expect(loadUserMaterials()).toEqual([{ kind: 'bulk', name: 'NEW', density: 2 }]);
});
it('keeps the status region mounted while reading CSV and reporting its outcome', async () => {
  mount();
  const status = host.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(status!.textContent).toBe('');
  let finish!: (csv: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const picked = new File([], 'materials.csv');
  vi.spyOn(picked, 'text').mockReturnValue(pending);
  const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(field, 'files', { value: [picked], configurable: true });
  void act(() => field.dispatchEvent(new Event('change', { bubbles: true })));
  expect(host.querySelector('[role="status"]')).toBe(status);
  expect(status!.textContent).toBe('Reading CSV…');
  expect(button('Import CSV into My materials').disabled).toBe(true);
  await act(async () => { finish('kind,name,density,unit\nline,Cord,0.001,kg/m'); });
  expect(host.querySelector('[role="status"]')).toBe(status);
  expect(status!.textContent).toContain('1 added, 0 replaced, 0 refused.');
  expect(status!.textContent).not.toContain('Reading');
  expect(button('Import CSV into My materials').disabled).toBe(false);
});
it('restores focus after a rename, deleting an entry, and deleting the last entry', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }, { kind: 'bulk', name: 'Other', density: 800 }]); mount();
  click(button('Edit bulk material Mix'));
  type(input('Material name'), 'Renamed');
  act(() => button('Save material').focus());
  void act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(button('Edit bulk material Renamed'));
  for (const name of ['Renamed', 'Other']) {
    act(() => button(`Delete bulk material ${name}`).focus()); click(button(`Delete bulk material ${name}`));
    act(() => button('Delete material').focus()); click(button('Delete material'));
    expect(document.activeElement).toBe(host.querySelector('h2'));
  }
});
it('focuses the Material name field when Edit replaces a list entry', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Earlier', density: 800 }, { kind: 'bulk', name: 'Mix', density: 900 }]); mount();
  const edit = button('Edit bulk material Mix');
  act(() => edit.focus()); click(edit);
  expect(document.activeElement).toBe(input('Material name'));
  type(input('Material name'), 'Draft');
  expect(document.activeElement).toBe(input('Material name'));
});
it('returns focus to the edited entry after Cancel removes its form', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Earlier', density: 800 }, { kind: 'bulk', name: 'Mix', density: 900 }]); mount();
  click(button('Edit bulk material Mix'));
  type(input('Material name'), 'Unsaved');
  act(() => button('Cancel').focus()); click(button('Cancel'));
  expect(document.activeElement).toBe(button('Edit bulk material Mix'));
  expect(loadUserMaterials()[1]?.name).toBe('Mix');
});
it('keeps the visible Export CSV and Import CSV wording in their accessible names', () => {
  mount();
  for (const label of ['Export CSV of My materials', 'Import CSV into My materials']) {
    const control = button(label);
    expect(control).toBeDefined();
    expect(control.getAttribute('aria-label')).toContain(control.textContent!.replace(/^[⬇⬆]\s*/, '').trim());
  }
});
it('edits a name and density via NumField, refuses built-in and duplicate names, then deletes after one confirmation', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }, { kind: 'bulk', name: 'Other', density: 800 }]); mount();
  click(button('Edit bulk material Mix'));
  type(input('Material name'), 'Balsa');
  void act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain('Balsa is in the built-in list');
  type(input('Material name'), 'other');
  void act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain('already in My materials');
  type(input('Material name'), '  New mix  ');
  const density = input('Density (kg/m³)'); act(() => density.focus()); type(density, '1200'); act(() => density.blur());
  void act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(loadUserMaterials()[0]).toEqual({ kind: 'bulk', name: 'New mix', density: 1200 });
  click(button('Delete bulk material New mix'));
  expect(loadUserMaterials()).toHaveLength(2);
  expect(host.querySelector('[role="dialog"][aria-label="Delete bulk material New mix?"]')).not.toBeNull();
  click(button('Cancel'));
  expect(loadUserMaterials()).toHaveLength(2);
  click(button('Delete bulk material New mix')); click(button('Delete material'));
  expect(loadUserMaterials()).toEqual([{ kind: 'bulk', name: 'Other', density: 800 }]);
});
it('exports CSV through the file saver and shows an actionable empty state', async () => {
  mount();
  expect(host.textContent).toContain('No saved materials');
  act(() => { saveUserMaterials([{ kind: 'line', name: '=Cord, "mine"', density: 0.002 }]); });
  click(button('Export CSV of My materials'));
  expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'my-materials.csv');
  const blob = vi.mocked(downloadBlob).mock.calls.at(-1)![0];
  expect(await blob.text()).toContain('"\'=Cord, ""mine"""');
});
it('a failed import save reports failure, preserves storage, and does not claim additions', async () => {
  mount();
  storageSpy('setItem').mockImplementation(() => { throw Error('quota'); });
  await upload('kind,name,density,unit\nbulk,Mix,1000,kg/m3');
  expect(host.textContent).toContain('Storage may be full or blocked');
  expect(host.textContent).not.toContain('1 added');
  expect(localStorage.getItem(USER_MATERIALS_KEY)).toBeNull();
});
it('traps focus and Escape closes the library, restoring its opener', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  mount();
  expect(host.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  void act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
it('refuses an oversized CSV with a message naming the 2 MiB limit', async () => {
  mount();
  const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(field, 'files', { value: [new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'big.csv')], configurable: true });
  await act(async () => { field.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.textContent).toContain('limit of 2 MiB');
  expect(loadUserMaterials()).toEqual([]);
});
it('keeps deletion failure inside its confirmation and leaves the saved entry intact', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Mix', density: 900 }]); mount();
  click(button('Delete bulk material Mix'));
  const status = host.querySelector('[aria-label="Delete bulk material Mix?"] [role="status"]');
  expect(status).not.toBeNull();
  expect(status!.textContent).toBe('');
  storageSpy('setItem').mockImplementation(() => { throw Error('quota'); });
  click(button('Delete material'));
  expect(host.querySelector('[aria-label="Delete bulk material Mix?"] [role="status"]')).toBe(status);
  expect(status!.textContent).toContain('Storage may be full or blocked');
  const confirmation = host.querySelector('[role="dialog"][aria-label="Delete bulk material Mix?"]');
  expect(confirmation?.textContent).toContain('Storage may be full or blocked');
  expect(loadUserMaterials()).toHaveLength(1);
});

// happy-dom binds Storage methods; restore the instance through its proxy.
function storageSpy(key: 'getItem' | 'setItem') {
  const own = localStorage[key];
  onTestFinished(() => { Object.defineProperty(localStorage, key, { configurable: true, value: own }); });
  return vi.spyOn(localStorage, key);
}

it.each(['{broken', '{"rows":[]}'])('copies an unreadable stored library %s aside, then imports into a new list', async raw => {
  localStorage.setItem(USER_MATERIALS_KEY, raw); mount();
  await upload('kind,name,density,unit\nbulk,Mix,1000,kg/m3\n');
  expect(localStorage.getItem(`${USER_MATERIALS_KEY}.unreadable-backup`)).toBe(raw);
  expect(loadUserMaterials()).toEqual([{ kind: 'bulk', name: 'Mix', density: 1000 }]);
  expect(host.querySelector('[role="status"]')!.textContent).toContain('My materials could not be read. The app kept a copy of them in this browser and started a new list.');
});
it('refuses an import when an earlier different copy holds the side key', async () => {
  localStorage.setItem(`${USER_MATERIALS_KEY}.unreadable-backup`, 'older');
  localStorage.setItem(USER_MATERIALS_KEY, '{broken'); mount();
  await upload('kind,name,density,unit\nbulk,Mix,1000,kg/m3\n');
  expect(localStorage.getItem(USER_MATERIALS_KEY)).toBe('{broken');
  expect(host.querySelector('[role="status"]')!.textContent).toContain('My materials could not be read from browser storage, so the app left them unchanged.');
});
it.each([false, true])('deletes a material and preserves unreadable entries in the backup or live list (occupied backup: %s)', occupied => {
  const unreadable = { kind: 'solid', name: 'From a newer build', density: 5 };
  const raw = JSON.stringify([unreadable, { kind: 'bulk', name: 'Mix', density: 900 }]);
  const side = USER_MATERIALS_KEY + '.unreadable-backup';
  localStorage.setItem(USER_MATERIALS_KEY, raw);
  if (occupied) localStorage.setItem(side, 'older');
  mount();
  click(button('Delete bulk material Mix'));
  click(button('Delete material'));
  expect(host.textContent).toContain('Material deleted.');
  expect(JSON.parse(localStorage.getItem(USER_MATERIALS_KEY)!)).toEqual(occupied ? [unreadable] : []);
  expect(localStorage.getItem(side)).toBe(occupied ? 'older' : raw);
});
