// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, onTestFinished, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PreferencesDialog } from './PreferencesDialog.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { makeNode } from '../tree/treeModel.js';
import { KERNEL_DEFAULT_MATERIALS } from '../tree/kernelDefaults.js';
import { loadBundledPresets, presetPatch } from '../services/presets.js';
import { BULK_MATERIALS } from '../data/materials.js';
import { loadUserMaterials, saveUserMaterials, USER_MATERIALS_CHANGED, USER_MATERIALS_KEY } from '../services/userMaterials.js';
import { exportOrk, importOrk } from '../services/orkFile.js';
import { exportRkt, importRkt } from '../services/rocksimFile.js';
import { designMaterials } from '../services/designMaterials.js';
import type { FlightTree } from '../model/design.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let patches: Partial<ComponentNode>[];
const tube = (id: string, extra: Partial<ComponentNode> = {}): ComponentNode => ({ id, type: 'bodytube', name: id, length: 0.2, outerRadius: 0.025, thickness: 0.001, density: 680, ...extra });
const treeOf = (...children: ComponentNode[]): RocketTree => ({ name: 'Materials', components: [{ type: 'stage', id: 's', children }] });
const show = (node: ComponentNode, tree = treeOf(node)) => act(() => root.render(<PrefsProvider>
  <PropertyPanel tree={tree} node={node} onPatch={p => patches.push(p)} />
</PrefsProvider>));
const select = (label = 'Material') => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label)!;
const click = (el: HTMLElement) => act(() => el.click());
const input = (text: string): HTMLInputElement => {
  const label = [...host.querySelectorAll('label')].find(l => l.textContent === text)!;
  return host.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`)!;
};
const type = (el: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const pick = (el: HTMLSelectElement, value: string) => act(() => {
  el.value = value; el.dispatchEvent(new Event('change', { bubbles: true }));
});
beforeEach(() => {
  localStorage.clear(); patches = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); });

it.each([
  ['bulk', 'bodytube', 'Material', 'materialName', 'density'],
  ['surface', 'parachute', 'Canopy material', 'surfaceMaterialName', 'surfaceDensity'],
  ['line', 'shockcord', 'Cord material', 'lineMaterialName', 'lineDensity'],
  ['bulk', 'freeformfinset', 'Fillet material', 'filletMaterialName', 'filletDensity'],
] as const)('offers compatible document %s materials once and applies their exact pair to %s',
  (kind, partType, label, nameKey, densityKey) => {
    const source = { type: partType, id: 'source', [nameKey]: 'Shared mix', [densityKey]: 2 } as ComponentNode;
    const target = { type: partType, id: 'target', crossSection: 'rounded' } as ComponentNode;
    const tree: FlightTree = { ...treeOf(source, target), documentMaterials: [
      { kind, name: 'Shared mix', density: 2 }, { kind, name: 'Unused mix', density: 3.125 },
      { kind: kind === 'bulk' ? 'surface' : 'bulk', name: 'Wrong kind', density: 4 },
    ] };
    show(target, tree);
    const options = [...select(label).querySelectorAll<HTMLOptionElement>('optgroup[label="In this design"] option')];
    expect(options).toHaveLength(2);
    expect(options.filter(o => o.textContent?.includes('Shared mix'))).toHaveLength(1);
    const unused = options.find(o => o.textContent?.includes('Unused mix'))!;
    expect(unused).toBeDefined();
    pick(select(label), unused.value);
    expect(patches).toEqual([{ [nameKey]: 'Unused mix', [densityKey]: 3.125,
      ...(nameKey === 'filletMaterialName' ? { filletMaterialGroup: undefined } : {}) }]);
  });

it.each([['Cardboard', 700], ['Balsa', 120]] as const)(
  'Round2 built-in document name %s cannot offer a misleading density after remount', (name, density) => {
    const target = tube('target');
    const tree: FlightTree = { ...treeOf(target), documentMaterials: [{ kind: 'bulk', name, density }] };
    show(target, tree);
    expect([...select().querySelectorAll('optgroup[label="In this design"] option')]
      .some(o => o.textContent?.includes(name))).toBe(false);
    // Only the built-in pair can be picked; it still displays that pair on remount.
    const builtIn = BULK_MATERIALS.find(m => m.name === name)!;
    pick(select(), name);
    expect(patches).toEqual([{ materialName: name, density: builtIn.density }]);
    const patched = { ...target, ...patches[0] };
    act(() => root.unmount());
    root = createRoot(host);
    show(patched, { ...tree, ...treeOf(patched) });
    expect(select().selectedOptions[0]!.textContent).toContain(String(builtIn.density));
    expect(tree.documentMaterials).toEqual([{ kind: 'bulk', name, density }]);
  });

it('shows design and browser groups; a pick writes the exact pair in one patch', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Saved mix', density: 1234 }]);
  const a = tube('a', { materialName: 'Design mix', density: 900 });
  const b = tube('b', { materialName: 'Design mix', density: 1000 });
  const target = tube('target');
  const tree = treeOf(a, b, target);
  show(target, tree);
  expect([...select().querySelectorAll('optgroup')].map(g => g.label)).toEqual(['In this design', 'My materials']);
  const options = [...select().querySelectorAll<HTMLOptionElement>('optgroup[label="In this design"] option')];
  expect(options.map(o => o.textContent)).toEqual(['Design mix (900 kg/m³)', 'Design mix (1000 kg/m³)']);
  pick(select(), options[1]!.value);
  expect(patches).toEqual([{ materialName: 'Design mix', density: 1000 }]);
  patches = [];
  pick(select(), select().querySelector<HTMLOptionElement>('optgroup[label="My materials"] option')!.value);
  expect(patches).toEqual([{ materialName: 'Saved mix', density: 1234 }]);
  show(a, tree);
  expect([...select().options].filter(o => o.textContent?.includes('Design mix (900'))).toHaveLength(1);
  expect(select().value).toBe('Design mix');
  expect(select().selectedOptions[0]!.textContent).toBe("Design mix (900 kg/m³) — this part's material");
  expect(select().selectedOptions[0]!.parentElement).toBe(select());
});
it.each(['In this design', 'My materials'])('keeps a picked %s entry selected in its group with the next entry reachable', group => {
  const first = tube('first', { materialName: 'Bravo mix', density: 900 });
  const second = tube('second', { materialName: 'Charlie mix', density: 1000 });
  const target = tube('target', { materialName: 'Cardboard' });
  saveUserMaterials([{ kind: 'bulk', name: 'Bravo mix', density: 900 }, { kind: 'bulk', name: 'Charlie mix', density: 1000 }]);
  show(target, treeOf(first, second, target));
  const option = select().querySelector<HTMLOptionElement>(`optgroup[label="${group}"] option`)!;
  const value = option.value;
  pick(select(), value);
  expect(patches).toEqual([{ materialName: 'Bravo mix', density: 900 }]);
  const patched = { ...target, ...patches[0] };
  show(patched, treeOf(first, second, patched));
  expect(select().selectedOptions[0]).toBe(option);
  expect(option.parentElement?.getAttribute('label')).toBe(group);
  expect(option.nextElementSibling?.textContent).toBe('Charlie mix (1000 kg/m³)');
  expect([...select().children].some(child => child.tagName === 'OPTION' && child.textContent?.startsWith('Bravo mix'))).toBe(false);
  // Inserting an earlier entry must not change the selected pair's value.
  const earlier = tube('earlier', { materialName: 'Alpha mix', density: 800 });
  act(() => { saveUserMaterials([{ kind: 'bulk', name: 'Alpha mix', density: 800 }, ...loadUserMaterials()]); });
  show(patched, treeOf(earlier, first, second, patched));
  expect(select().value).toBe(value);
  expect(select().selectedOptions[0]).toBe(option);
  pick(select(), (option.nextElementSibling as HTMLOptionElement).value);
  expect(patches.at(-1)).toEqual({ materialName: 'Charlie mix', density: 1000 });
  const next = { ...target, ...patches.at(-1) };
  show(next, treeOf(earlier, first, second, next));
  expect(select().selectedOptions[0]!.parentElement?.getAttribute('label')).toBe(group);
  // An ordinary built-in pick leaves the group selection state.
  pick(select(), 'Cardboard');
  show(target, treeOf(first, second, target));
  expect(select().value).toBe('Cardboard');
  expect(patches).toHaveLength(3);
});
it('keeps the visible Save, Update and Saved wording in each accessible name', () => {
  const node = tube('target', { materialName: 'My mix', density: 900 });
  show(node);
  for (const label of ['Save to My materials: Material', 'Update in My materials: Material', 'Saved in My materials: Material']) {
    const control = button(label);
    expect(control).toBeDefined();
    const visible = control.textContent!.replace(/^☆\s*/, '').trim();
    expect(control.getAttribute('aria-label')).toContain(visible);
    act(() => { saveUserMaterials([{ kind: 'bulk', name: 'My mix', density: label.startsWith('Save to') ? 800 : 900 }]); });
  }
});
it.each(['Save', 'Update'])('returns focus to the material select after a successful %s', action => {
  const node = tube('target', { materialName: 'My mix', density: 900 });
  if (action === 'Update') saveUserMaterials([{ kind: 'bulk', name: 'My mix', density: 800 }]);
  show(node);
  const control = button(action === 'Save' ? 'Save to My materials: Material' : 'Update in My materials: Material');
  act(() => control.focus()); click(control);
  expect(document.activeElement).toBe(select());
  expect(button('Saved in My materials: Material').disabled).toBe(true);
  expect(loadUserMaterials()).toEqual([{ kind: 'bulk', name: 'My mix', density: 900 }]);
  expect(patches).toEqual([]);
});
it.each([
  ['surfaceDensity', 'surfaceMaterialName', 'Canopy material', 'surface', 'parachute', 'kg/m²'],
  ['lineDensity', 'lineMaterialName', 'Cord material', 'line', 'shockcord', 'kg/m'],
  ['filletDensity', 'filletMaterialName', 'Fillet material', 'bulk', 'freeformfinset', 'kg/m³'],
] as const)('wires %s to compatible design and browser materials', (densityKey, nameKey, label, kind, partType, unit) => {
  saveUserMaterials([{ kind, name: 'Saved', density: 5 }]);
  const source = { type: partType, id: 'source', [densityKey]: 2, [nameKey]: 'Design' } as ComponentNode;
  const target = { type: partType, id: 'target' } as ComponentNode;
  show(target, treeOf(source, target));
  expect(select(label).querySelector('optgroup[label="In this design"]')?.textContent).toContain(`Design (2 ${unit})`);
  pick(select(label), select(label).querySelector<HTMLOptionElement>('optgroup[label="My materials"] option')!.value);
  expect(patches).toEqual([{ [nameKey]: 'Saved', [densityKey]: 5, ...(nameKey === 'filletMaterialName' ? { filletMaterialGroup: undefined } : {}) }]);
});
it('names a custom material on Enter or blur, trims it, retains density and refuses a built-in name', () => {
  show(tube('t', { density: 456 }));
  const name = input('Material name');
  expect(name.maxLength).toBe(80);
  act(() => name.focus()); type(name, 'cUsToM'); act(() => name.blur());
  expect(patches).toEqual([]);
  expect(host.textContent).toContain('Custom is reserved for unnamed materials');
  act(() => name.focus()); type(name, ' bALSa ');
  act(() => name.blur());
  expect(patches).toEqual([]);
  expect(host.textContent).toContain('bALSa is in the built-in list — pick it from the list');
  act(() => name.focus()); type(name, '  My foam  ');
  void act(() => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(patches).toEqual([{ materialName: 'My foam' }]);
  const node = { ...tube('t', { density: 456 }), ...patches[0] };
  show(node);
  expect(select().selectedOptions[0]!.textContent).toBe("My foam (456 kg/m³) — this part's material");
  expect(node.density).toBe(456);
});
it('save/update states follow the library, survive remount, and never patch the design', () => {
  const node = tube('t', { materialName: 'My foam', density: 456 });
  show(node);
  click(button('Save to My materials: Material'));
  expect(loadUserMaterials()).toEqual([{ kind: 'bulk', name: 'My foam', density: 456 }]);
  expect(button('Saved in My materials').disabled).toBe(true);
  show({ ...node, density: 789 });
  click(button('Update in My materials'));
  expect(loadUserMaterials()[0]?.density).toBe(789);
  expect(patches).toEqual([]);
  show(tube('other'));
  expect(select().querySelector('optgroup[label="My materials"]')?.textContent).toContain('My foam (789 kg/m³)');
});
it('shows quota, cap, and corrupt-store messages; a failed save retains the old library', () => {
  show(tube('t', { materialName: 'My mix', density: 456 }));
  const ownSet = localStorage.setItem;
  storageSpy('setItem').mockImplementation(() => { throw Error('quota'); });
  click(button('Save to My materials: Material'));
  expect(host.textContent).toContain('Storage may be full or blocked');
  expect(loadUserMaterials()).toEqual([]);
  vi.restoreAllMocks();
  Object.defineProperty(localStorage, 'setItem', { configurable: true, value: ownSet });
  act(() => { saveUserMaterials(Array.from({ length: 500 }, (_, i) => ({ kind: 'bulk', name: `Mix ${i}`, density: 1 }))); });
  click(button('Save to My materials: Material'));
  expect(host.textContent).toContain('limit of 500');
  act(() => { localStorage.setItem(USER_MATERIALS_KEY, '[null]'); window.dispatchEvent(new Event(USER_MATERIALS_CHANGED)); });
  expect(host.textContent).not.toContain('1 invalid My materials');
  click(button('My materials for Material'));
  expect(host.textContent).toContain('1 invalid My materials');
});
it('keeps the built-in-only options and design byte-for-byte unchanged on render', () => {
  const node = tube('t', { materialName: 'Cardboard' });
  const tree = treeOf(node);
  const before = JSON.stringify(tree);
  show(node, tree);
  expect([...select().options].map(o => [o.value, o.textContent])).toEqual([
    ['', 'Custom'], ...BULK_MATERIALS.map(m => [m.name, `${m.name} (${m.density} kg/m³)`]),
  ]);
  expect(select().value).toBe('Cardboard');
  expect(patches).toEqual([]);
  expect(JSON.stringify(tree)).toBe(before);
});
it('opens My materials from a material selector', () => {
  show(tube('t'));
  click(button('My materials for Material'));
  expect(host.querySelector('[role="dialog"][aria-label="My materials"]')).not.toBeNull();
  click(button('Close My materials'));
});
it('opens My materials from Preferences', () => {
  act(() => root.render(<PrefsProvider><PreferencesDialog onClose={() => {}} /></PrefsProvider>));
  expect([...host.querySelectorAll('h3')].some(h => h.textContent === 'Materials')).toBe(true);
  const heading = [...host.querySelectorAll('h3')].find(h => h.textContent === 'Materials')!;
  expect(heading.className).toBe('prefs-section');
  expect(heading.previousElementSibling?.textContent).toContain('Values are stored in SI internally');
  expect(host.textContent).toContain('Named materials saved in this browser for the material selectors.');
  click(button('My materials…'));
  expect(host.querySelector('[role="dialog"][aria-label="My materials"]')).not.toBeNull();
});
it('refuses an over-limit bulk design material pick with the density limit', () => {
  const node = tube('t');
  show(node, treeOf(node, tube('source', { materialName: 'Too dense', density: 30001 })));
  pick(select(), select().querySelector<HTMLOptionElement>('optgroup[label="In this design"] option')!.value);
  expect(patches).toEqual([]);
  expect(host.textContent).toContain('limit of 30000 kg/m³');
});
it('refreshes other tabs’ library edits and clearing site data', () => {
  show(tube('t'));
  act(() => {
    localStorage.setItem(USER_MATERIALS_KEY, JSON.stringify([{ kind: 'bulk', name: 'Other tab mix', density: 1000 }]));
    window.dispatchEvent(new StorageEvent('storage', { key: USER_MATERIALS_KEY }));
  });
  expect(select().querySelector('optgroup[label="My materials"]')?.textContent).toContain('Other tab mix');
  act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null })); });
  expect(select().querySelector('optgroup[label="My materials"]')).toBeNull();
});
it('a foreign name cannot collide with a design option’s internal value', () => {
  const node = tube('t', { materialName: 'design:0', density: undefined });
  show(node, treeOf(node, tube('source', { materialName: 'Other', density: 900 })));
  expect(select().selectedOptions[0]?.textContent).toContain('design:0');
  pick(select(), select().querySelector<HTMLOptionElement>('optgroup[label="In this design"] option')!.value);
  expect(patches).toEqual([{ materialName: 'Other', density: 900 }]);
});
it.each([
  ['ork', 'bodytube', 'materialName', 'density', 456.789],
  ['rkt', 'bodytube', 'materialName', 'density', 456.789],
  ['ork', 'streamer', 'surfaceMaterialName', 'surfaceDensity', 0.034567],
  ['rkt', 'streamer', 'surfaceMaterialName', 'surfaceDensity', 0.034567],
  ['ork', 'shockcord', 'lineMaterialName', 'lineDensity', 0.012345],
  ['rkt', 'shockcord', 'lineMaterialName', 'lineDensity', 0.012345],
] as const)('a material named through the panel survives .%s on a %s', (format, partType, nameKey, densityKey, density) => {
  const node: ComponentNode = { ...tube('custom'), name: 'Custom part', type: partType,
    stripLength: 0.5, stripWidth: 0.05, cordLength: 1, [densityKey]: density };
  show(node);
  const name = input(`${densityKey === 'surfaceDensity' ? 'Canopy material' : densityKey === 'lineDensity' ? 'Cord material' : 'Material'} name`);
  act(() => name.focus()); type(name, 'My "foam", =strong'); act(() => name.blur());
  expect(patches).toHaveLength(1);
  const named = { ...node, ...patches[0] };
  const tree = treeOf(tube('outer', { children: [named] }));
  const result = format === 'ork'
    ? importOrk(exportOrk({ name: 'Custom', tree }))
    : importRkt(exportRkt({ name: 'Custom', tree }));
  const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
  const restored = all(result.tree.components).find(n => n.name === 'Custom part')!;
  expect(restored[nameKey]).toBe('My "foam", =strong');
  expect(restored[densityKey]).toBeCloseTo(density, 9);
});

// happy-dom binds Storage methods; restore the instance through its proxy.
it('shows the Quest 10100 case-variant material at its actual density, without offering an invalid library save', async () => {
  const quest = (await loadBundledPresets()).find(p => p.manufacturer === 'Quest' && p.partNo === '10100')!;
  expect(quest).toBeDefined();
  const node = { ...makeNode('tubecoupler'), ...presetPatch('tubecoupler', quest) };
  await act(async () => { show(node); });
  expect(select().value).toBe('Kraft Phenolic');
  expect(select().selectedOptions[0]!.textContent).toBe('Kraft Phenolic (958.70503449 kg/m³) — from the parts database');
  expect(button('Save to My materials: Material')).toBeUndefined();
  expect(patches).toEqual([]);
});
it('keeps own options separate even when their names equal internal design or library values', () => {
  saveUserMaterials([{ kind: 'bulk', name: 'Saved', density: 123 }]);
  const source = tube('source', { materialName: 'Other', density: 900 });
  for (const group of ['In this design', 'My materials']) {
    show(tube('t'), treeOf(source));
    const internal = select().querySelector<HTMLOptionElement>(`optgroup[label="${group}"] option`)!.value;
    const own = tube('t', { materialName: internal, density: 456 });
    show(own, treeOf(own, source));
    expect(select().value).toBe(internal);
    expect(select().selectedOptions[0]!.parentElement).toBe(select());
    expect([...select().options].filter(o => o.value === internal)).toHaveLength(1);
    const option = select().querySelector<HTMLOptionElement>(`optgroup[label="${group}"] option`)!;
    expect(option.value).not.toBe(internal);
    pick(select(), option.value);
    expect(patches.at(-1)).toEqual(group === 'My materials'
      ? { materialName: 'Saved', density: 123 } : { materialName: 'Other', density: 900 });
  }
});
it.each([
  ['nosecone', 'Material', 'materialName', 'density', 'bulk'],
  ['parachute', 'Canopy material', 'surfaceMaterialName', 'surfaceDensity', 'surface'],
  ['shockcord', 'Cord material', 'lineMaterialName', 'lineDensity', 'line'],
] as const)('naming a default %s keeps its effective density, focus, reuse and .ork name', (partType, label, nameKey, densityKey, kind) => {
  const node: ComponentNode = { ...makeNode(partType), name: 'Named default' };
  expect(node[densityKey]).toBeUndefined();
  show(node);
  const field = input(`${label} name`);
  act(() => field.focus()); type(field, 'My default');
  void act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const density = KERNEL_DEFAULT_MATERIALS[kind].density;
  expect(patches).toEqual([{ [nameKey]: 'My default', [densityKey]: density }]);
  const named = { ...node, ...patches[0] };
  show(named);
  expect(document.activeElement).toBe(select(label));
  expect(select(label).selectedOptions[0]!.textContent).not.toContain('parts database');
  click(button(`Save to My materials: ${label}`));
  expect(loadUserMaterials()).toEqual([{ kind, name: 'My default', density }]);
  const target = { ...makeNode(partType), id: 'other' };
  show(target, treeOf(named, target));
  expect(select(label).querySelector('optgroup[label="In this design"]')?.textContent).toContain('My default');
  const tree = treeOf(tube('outer', { children: [named] }));
  const restored = importOrk(exportOrk({ name: 'Default density', tree })).tree;
  const flatten = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
  const back = flatten(restored.components).find(n => n.name === 'Named default')!;
  expect(back[nameKey]).toBe('My default');
  expect(back[densityKey]).toBeCloseTo(density, 10);
});
it('labels a zero-density user material neutrally and explains density editing before naming', () => {
  show(tube('t', { density: 0 }));
  const field = input('Material name');
  expect(host.querySelector(`[id="${field.getAttribute('aria-describedby')}"]`)?.textContent)
    .toBe('Typing a density afterwards removes the name; set the density first.');
  act(() => field.focus()); type(field, 'My foam'); act(() => field.blur());
  show({ ...tube('t', { density: 0 }), ...patches[0] });
  expect(select().selectedOptions[0]!.textContent).toBe("My foam (680 kg/m³) — this part's material");
  // A blur leaves focus where the user sent it; only Enter returns it to the select.
  expect(document.activeElement).not.toBe(select());
  show(makeNode('parachute'));
  expect(host.textContent).toContain(`The name applies to this part's current density, ${KERNEL_DEFAULT_MATERIALS.surface.density} kg/m²; to change a canopy or line density, edit a saved entry in My materials, then pick it again from this list.`);
});
it('shows a blocked-storage note only in My materials, once for a part with two material selectors', () => {
  storageSpy('getItem').mockImplementation(() => { throw Error('blocked'); });
  show(makeNode('parachute'));
  expect(host.textContent).not.toContain('Browser storage is blocked');
  click(button('My materials for Canopy material'));
  expect(host.textContent?.match(/Browser storage is blocked here, so My materials is unavailable\./g)).toHaveLength(1);
  expect(host.textContent).not.toContain('Import a saved CSV to restore it');
});

it('commits on blur to another input without stealing focus or patching a second material', () => {
  const node = tube('t'); show(node);
  const field = input('Material name');
  const next = document.createElement('input'); host.append(next);
  act(() => field.focus()); type(field, 'My foam');
  // Explicit relatedTarget also detects the bug in DOM emulators that finish
  // the pending focus move even when a blur handler focuses another control.
  const focus = vi.spyOn(select(), 'focus');
  act(() => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next })); });
  expect(focus).not.toHaveBeenCalled();
  expect(patches).toEqual([{ materialName: 'My foam' }]);
  show({ ...node, ...patches[0] });
  act(() => next.focus()); type(next, 'Nose');
  expect(document.activeElement).toBe(next);
  expect(patches).toHaveLength(1);
});
// Review 2026-10-18: a blur with no new focus target (blank panel space; any button in Safari) used to move focus
// into the material select, where a stray arrow key would change the part's material.
it('commits on a blur to nowhere without moving focus into the material select', () => {
  const node = tube('t'); show(node);
  const field = input('Material name');
  act(() => field.focus()); type(field, 'My foam');
  const focus = vi.spyOn(select(), 'focus');
  act(() => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })); });
  expect(focus).not.toHaveBeenCalled();
  expect(patches).toEqual([{ materialName: 'My foam' }]);
});
it.each(['Balsa', 'Custom', 'x'.repeat(81)])('keeps keyboard focus in a refused name on Enter (%s)', value => {
  show(tube('t')); const field = input('Material name');
  act(() => field.focus()); type(field, value);
  void act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(document.activeElement).toBe(field);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(patches).toEqual([]);
});
it('uses neutral provenance after a library pick on a catalogue-linked tube, including name-only or density-only edits', async () => {
  const row = (await loadBundledPresets()).find(p => p.kind === 'BodyTube' && p.material?.type === 'BULK'
    && !BULK_MATERIALS.some(m => m.name === p.material?.name))!;
  expect(row).toBeDefined();
  const node = { ...tube('linked'), ...presetPatch('bodytube', row) };
  saveUserMaterials([{ kind: 'bulk', name: 'Saved mix', density: 1234 }]);
  await act(async () => { show(node); });
  expect(select().selectedOptions[0]!.textContent).toContain('from the parts database');
  pick(select(), select().querySelector<HTMLOptionElement>('optgroup[label="My materials"] option')!.value);
  show({ ...node, ...patches[0] });
  expect(select().selectedOptions[0]!.textContent).toBe('Saved mix (1234 kg/m³)');
  expect(select().selectedOptions[0]!.parentElement?.getAttribute('label')).toBe('My materials');
  for (const patch of [{ materialName: 'Renamed stock' }, { density: 1234 }]) {
    show({ ...node, ...patch });
    expect(select().selectedOptions[0]!.textContent).toContain("this part's material");
  }
});
it.each([
  { materialName: 'Missing density', density: undefined },
  { materialName: 'Zero density', density: 0 },
  { materialName: 'custom', density: 1200 },
])('offers no impossible library save for %j', patch => {
  show(tube('t', patch));
  expect([...host.querySelectorAll('button')].some(b => /^(Save to |Update in |Saved in)/.test(b.getAttribute('aria-label') ?? ''))).toBe(false);
});
it('a density-only .rkt round trip adds no reserved placeholders to In this design', () => {
  const result = importRkt(exportRkt({ name: 'Unnamed', tree: treeOf(tube('a', { density: 1200 }), tube('b', { density: 650 })) }));
  expect(designMaterials(result.tree, 'bulk')).toEqual([]);
  show(tube('target'), result.tree);
  expect(select().querySelector('optgroup[label="In this design"]')).toBeNull();
});
it.each(['density', 'filletDensity'] as const)('naming zero %s stores the effective bulk default and keeps the .ork name', densityKey => {
  const fillet = densityKey === 'filletDensity';
  const node = { ...makeNode(fillet ? 'freeformfinset' : 'nosecone'), name: 'Zero bulk', [densityKey]: 0 };
  show(node);
  const field = input(fillet ? 'Fillet material name' : 'Material name');
  act(() => field.focus()); type(field, 'My foam'); act(() => field.blur());
  const nameKey = fillet ? 'filletMaterialName' : 'materialName';
  expect(patches[0]).toMatchObject({ [nameKey]: 'My foam', [densityKey]: KERNEL_DEFAULT_MATERIALS.bulk.density });
  const back = importOrk(exportOrk({ name: 'Zero', tree: treeOf(tube('outer', { children: [{ ...node, ...patches[0] }] })) }));
  const flatten = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
  const restored = flatten(back.tree.components).find(n => n.name === 'Zero bulk')!;
  expect(restored[nameKey]).toBe('My foam');
  expect(restored[densityKey]).toBeCloseTo(680, 10);
});
it.each(['parachute', 'freeformfinset'] as const)('distinguishes new material controls on a %s', partType => {
  const labels = partType === 'parachute' ? ['Canopy material', 'Line material'] : ['Material', 'Fillet material'];
  const node = { ...makeNode(partType), filletDensity: 900 };
  show(node);
  for (const label of labels) expect(input(`${label} name`)).toBeDefined();
  if (partType === 'freeformfinset') {
    const field = input('Fillet material name');
    expect(host.querySelector(`[id="${field.getAttribute('aria-describedby')}"]`)?.textContent)
      .toBe('Typing a fillet density afterwards removes the name; set the density first.');
  }
  const named = partType === 'parachute'
    ? { surfaceMaterialName: 'Mix', surfaceDensity: 0.1, lineMaterialName: 'Mix', lineDensity: 0.01 }
    : { materialName: 'Mix', density: 1000, filletMaterialName: 'Mix', filletDensity: 900 };
  show({ ...node, ...named });
  for (const label of labels) expect(button(`Save to My materials: ${label}`)).toBeDefined();
  act(() => { saveUserMaterials(partType === 'parachute'
    ? [{ kind: 'surface', name: 'Mix', density: 0.2 }, { kind: 'line', name: 'Mix', density: 0.02 }]
    : [{ kind: 'bulk', name: 'Mix', density: 1100 }]); });
  for (const label of labels) expect(button(`Update in My materials: ${label}`)).toBeDefined();
});

function storageSpy(key: 'getItem' | 'setItem') {
  const own = localStorage[key];
  onTestFinished(() => { Object.defineProperty(localStorage, key, { configurable: true, value: own }); });
  return vi.spyOn(localStorage, key);
}

it.each([
  ['parachute', 'Canopy material', 'surfaceDensity', 'surfaceMaterialName', 'surface', 'kg/m²'],
  ['streamer', 'Canopy material', 'surfaceDensity', 'surfaceMaterialName', 'surface', 'kg/m²'],
  ['parachute', 'Line material', 'lineDensity', 'lineMaterialName', 'line', 'kg/m'],
  ['shockcord', 'Cord material', 'lineDensity', 'lineMaterialName', 'line', 'kg/m'],
] as const)('states the actual density before naming a %s %s', (partType, label, densityKey, nameKey, kind, unit) => {
  for (const density of [undefined, 0, 0.123]) {
    patches = [];
    show({ ...makeNode(partType), [densityKey]: density });
    const field = input(`${label} name`);
    const effective = density ?? KERNEL_DEFAULT_MATERIALS[kind].density;
    expect(host.querySelector(`[id="${field.getAttribute('aria-describedby')}"]`)?.textContent)
      .toBe(`The name applies to this part's current density, ${effective} ${unit}; to change a canopy or line density, edit a saved entry in My materials, then pick it again from this list.`);
    type(field, 'Named cloth or cord');
    void act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(patches).toEqual([{ [nameKey]: 'Named cloth or cord', ...(density === undefined ? { [densityKey]: effective } : {}) }]);
  }
});
it('keeps the material status region mounted through refusals, clearing and saving', () => {
  const node = tube('t'); show(node);
  const region = select().parentElement!.querySelector('[role="status"]');
  expect(region).not.toBeNull();
  expect(region!.textContent).toBe('');
  const field = input('Material name'); type(field, 'Balsa');
  void act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(region!.textContent).toContain('Balsa is in the built-in list');
  expect(region!.querySelector('p')?.id).toBe(field.getAttribute('aria-describedby')!.split(' ').at(-1));
  type(field, 'My mix');
  expect(region!.textContent).toBe('');
  void act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  show({ ...node, ...patches[0] }); click(button('Save to My materials: Material'));
  expect(select().parentElement!.querySelector('[role="status"]')).toBe(region);
  expect(region!.textContent).toBe('Saved in My materials.');
});
