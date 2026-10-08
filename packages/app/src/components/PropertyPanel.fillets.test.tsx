// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { engineTree, makeNode } from '../tree/treeModel.js';
import { exportOrk, importOrk } from '../services/orkFile.js';
import { BULK_MATERIALS } from '../data/materials.js';
import type { CatalogueDifference } from '../services/presets.js';

// Fin presets are not shipped today. Exercise commitSi's partner-patch contract
// through the real marker UI using a synthetic catalogue boundary.
const catalogue = vi.hoisted(() => ({ differences: [] as CatalogueDifference[] }));
vi.mock('../services/presets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/presets.js')>();
  const row = { kind: 'FinSet', manufacturer: 'Test', partNo: 'F1', description: '' };
  return { ...actual, KIND_FOR_TYPE: { ...actual.KIND_FOR_TYPE, freeformfinset: 'FinSet' },
    loadPresets: async () => [row], linkedPreset: () => row,
    catalogueDifferences: () => catalogue.differences };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let patches: Partial<ComponentNode>[];
const treeFor = (node: ComponentNode): RocketTree => ({ name: 'Fillets', components: [
  { id: 'stage', type: 'stage', children: [
    { id: 'body', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [node] },
  ] },
] });
const show = (node: ComponentNode) => act(() => root.render(<PrefsProvider>
  <PropertyPanel tree={treeFor(node)} node={node} onPatch={(p) => patches.push(p)} />
</PrefsProvider>));
const box = (name: string) => host.querySelector<HTMLInputElement>(`.numfield input[aria-label="${name}"]`)!;
const material = () => host.querySelector<HTMLSelectElement>('select[aria-label="Fillet material"]')!;
const type = (el: HTMLInputElement, value: string) => act(() => {
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const pick = (value: string) => act(() => {
  material().value = value;
  material().dispatchEvent(new Event('change', { bubbles: true }));
});
const spin = (el: HTMLInputElement, down = false) => act(() => {
  el.closest('.numfield')!.querySelectorAll<HTMLButtonElement>('button')[down ? 1 : 0]!.click();
});
const reopenedFin = (node: ComponentNode) => importOrk(exportOrk({ name: 'Fillets', tree: treeFor(node) }))
  .tree.components[0]!.children![0]!.children![0]!;

beforeEach(() => {
  localStorage.clear();
  catalogue.differences = [];
  patches = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('fin root fillet editing', () => {
  it.each(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset'] as const)(
    '%s opens without edits and its radius steps from zero in 0.1 mm increments', (kind) => {
      const node = makeNode(kind);
      const before = JSON.stringify(node);
      show(node);
      const radius = box('Fillet radius (mm)');
      expect(radius).not.toBeNull();
      expect(radius.placeholder).toBe('default: 0');
      expect(box('Fillet material density (kg/m³)').placeholder).toBe('default: 680');
      expect(material().value).toBe('Cardboard');
      expect(patches).toEqual([]);
      expect(JSON.stringify(node)).toBe(before);
      spin(radius);
      expect(patches).toEqual([{ filletRadius: 0.0001,
        filletDensity: 1200, filletMaterialName: 'Epoxy + silica (fillet paste)' }]);
      const enabled = { ...node, ...patches[0] };
      show(enabled);
      expect(material().value).toBe('Epoxy + silica (fillet paste)');
      spin(box('Fillet radius (mm)'), true);
      expect(patches.at(-1)).toEqual({ filletRadius: 0 });
      pick('');
      expect(patches.at(-1)).toEqual({ filletMaterialName: undefined, filletMaterialGroup: undefined });
      show({ ...enabled, filletRadius: 0, ...patches.at(-1) });
      expect(material().value).toBe('');
    });

  it.each([
    { filletDensity: 680, filletMaterialName: 'Cardboard', filletMaterialGroup: 'PaperProducts' },
    { filletDensity: 1350 },
    { filletDensity: 980, filletMaterialName: 'My epoxy', filletMaterialGroup: 'Custom' },
    { filletMaterialName: 'Imported name without density' },
    { filletMaterialGroup: 'Custom' },
  ])('keeps stored material on first enable and re-enable: %j', (stored) => {
    const node = { ...makeNode('freeformfinset'), ...stored, filletRadius: 0 };
    show(node);
    type(box('Fillet radius (mm)'), '3');
    expect(patches).toEqual([{ filletRadius: 0.003 }]);
    show({ ...node, ...patches.at(-1) });
    type(box('Fillet radius (mm)'), '0');
    show({ ...node, ...patches.at(-1) });
    spin(box('Fillet radius (mm)'));
    expect(patches.at(-1)).toEqual({ filletRadius: 0.0001 });
  });

  it('does not assign a new material when resizing an existing material-less fillet', () => {
    show({ ...makeNode('freeformfinset'), filletRadius: 0.002 });
    type(box('Fillet radius (mm)'), '3');
    expect(patches).toEqual([{ filletRadius: 0.003 }]);
  });

  it.each(['rounded', 'airfoil'] as const)(
    're-enabling an implicit %s fillet preserves density, kernel mass and CG', async (crossSection) => {
      const { OrkRocket } = await import('@online-openrocket/engine');
      const original = { ...makeNode('freeformfinset'), crossSection, finCount: 3, filletRadius: 0.003 };
      const xml = exportOrk({ name: 'Implicit fillet', tree: treeFor(original) })
        .replace(/<filletmaterial\b[^>]*>[^<]*<\/filletmaterial>/g, '');
      let node = importOrk(xml).tree.components[0]!.children![0]!.children![0]!;
      expect(node['filletDensity']).toBeUndefined();
      const info = (fin: ComponentNode) => OrkRocket.buildTree(engineTree(treeFor(fin))).staticInfo();
      const before = info(node);
      show(node);
      type(box('Fillet radius (mm)'), '0');
      node = { ...node, ...patches.at(-1) };
      expect.soft(patches.at(-1)).toEqual({ filletRadius: 0,
        filletDensity: 680, filletMaterialName: 'Cardboard' });
      // JSON persistence while disabled must preserve the material without session IDs.
      node = JSON.parse(JSON.stringify(node)) as ComponentNode;
      show(node);
      type(box('Fillet radius (mm)'), '3');
      node = { ...node, ...patches.at(-1) };
      const after = info(node);
      expect.soft(node['filletDensity']).toBe(680);
      expect.soft(node['filletMaterialName']).toBe('Cardboard');
      // Compare the same shipped kernel before/after, allowing 1e-10 kg/m rounding.
      expect.soft(after.mass).toBeCloseTo(before.mass, 10);
      expect.soft(after.cg).toBeCloseTo(before.cg, 10);
    }, 20_000);

  it.each([
    { filletDensity: 1330, filletMaterialName: 'Catalogue epoxy', filletMaterialGroup: 'Custom' },
    { filletDensity: 1330 },
    { filletMaterialName: 'Catalogue epoxy' },
    { filletMaterialGroup: 'Custom' },
    { filletDensity: undefined, filletMaterialName: undefined },
  ])('keeps incoming partner material when enabling a fillet: %j', async (partner) => {
    catalogue.differences = [{ key: 'filletRadius', words: 'fillet radius', have: 0, want: 0.003,
      patch: { filletRadius: 0.003, ...partner } }];
    await act(async () => {
      show({ ...makeNode('freeformfinset'), filletRadius: 0,
        presetManufacturer: 'Test', presetPartNo: 'F1' });
    });
    const use = host.querySelector<HTMLButtonElement>('[aria-label="Use catalogue value 3 mm for Fillet radius"]');
    expect(use).not.toBeNull();
    act(() => use!.click());
    expect(patches).toEqual([{ filletRadius: 0.003, ...partner }]);
  });

  it.each([
    ['Epoxy, unfilled (cured)', 1150],
    ['Epoxy + silica (fillet paste)', 1200],
    ['Epoxy + high-density filler', 1290],
    ['Epoxy + microfibers', 1080],
    ['Epoxy + microballoons', 450],
    ['RocketPoxy', 1500],
  ] as const)('selects and round-trips %s with its density', (name, density) => {
    const node = { ...makeNode('freeformfinset'), filletRadius: 0.003,
      filletMaterialGroup: 'Custom' };
    show(node);
    expect([...material().options].some((o) => o.value === name)).toBe(true);
    pick(name);
    const edited = { ...node, ...patches.at(-1) };
    const xml = exportOrk({ name: 'Fillets', tree: treeFor(edited) });
    // Like other app-only materials, omit the local group: desktop 24.12
    // accepts the unknown name and explicit density as a custom BULK material.
    expect(xml).toContain(`<filletmaterial type="bulk" density="${density}">${name}</filletmaterial>`);
    const back = reopenedFin(edited);
    expect(back['filletMaterialName']).toBe(name);
    expect(back['filletDensity']).toBe(density);
    expect(back['filletMaterialGroup']).toBeUndefined();
  });

  it.each([undefined, { filletDensity: 680, filletMaterialName: 'Cardboard' },
    { filletDensity: 1330, filletMaterialName: 'My epoxy', filletMaterialGroup: 'Custom' }])(
    'opening an existing filleted design leaves its material and kernel mass unchanged: %j', async (stored) => {
      const { OrkRocket } = await import('@online-openrocket/engine');
      const original = { ...makeNode('freeformfinset'), crossSection: 'rounded',
        filletRadius: 0.003, ...stored };
      const mass = (tree: RocketTree) => OrkRocket.buildTree(engineTree(tree)).staticInfo().mass;
      const before = mass(treeFor(original));
      const xml = exportOrk({ name: 'Existing', tree: treeFor(original) });
      // Old files may omit the material element entirely.
      const opened = importOrk(stored ? xml : xml.replace(/<filletmaterial\b[^>]*>[^<]*<\/filletmaterial>/g, '')).tree;
      const node = opened.components[0]!.children![0]!.children![0]!;
      const snapshot = JSON.stringify(opened);
      show(node);
      expect(patches).toEqual([]);
      expect(JSON.stringify(opened)).toBe(snapshot);
      expect(node['filletDensity']).toBe(stored?.filletDensity);
      expect(node['filletMaterialName']).toBe(stored?.filletMaterialName);
      expect(mass(opened)).toBeCloseTo(before, 10);
    }, 20_000);

  it.each(['rounded', 'airfoil'] as const)('new %s fillet mass follows radius squared, both sides, root length and silica density', async (crossSection) => {
    const { OrkRocket } = await import('@online-openrocket/engine');
    const original = { ...makeNode('freeformfinset'), crossSection, finCount: 3,
      points: [[0, 0], [0.02, 0.04], [0.08, 0.04], [0.1, 0]], density: 170 };
    const mass = (node: ComponentNode) => OrkRocket.buildTree(engineTree(treeFor(node))).staticInfo().mass;
    const before = mass(original);
    for (const radius of [0.00005, 0.0001]) {
      show(original);
      type(box('Fillet radius (mm)'), String(radius * 1000));
      const edited = { ...original, ...patches.at(-1) };
      const expected = 0.2146 * radius ** 2 * 2 * 3 * 0.1 * 1200;
      // Flat-surface approximation: r/R <= 0.005 on this 20 mm-radius tube.
      // Allow 1% for tube curvature and coefficient rounding, not a pinned float.
      expect(Math.abs((mass(edited) - before) - expected)).toBeLessThan(expected * 0.01);
    }
  }, 20_000);

  it.each(['rounded', 'airfoil'] as const)('edits freeform %s fillets and reopens them from .ork', (crossSection) => {
    let node: ComponentNode = { ...makeNode('freeformfinset'), crossSection, density: 170,
      filletRadius: 0.002, filletDensity: 1250, filletMaterialName: 'Imported epoxy', filletMaterialGroup: 'Custom' };
    show(node);
    expect(material().value).toBe('Imported epoxy');
    expect(material().selectedOptions[0]!.textContent).not.toContain('parts database');
    expect([...material().options].filter((o) => BULK_MATERIALS.some((m) => m.name === o.value)))
      .toHaveLength(BULK_MATERIALS.length);
    type(box('Fillet radius (mm)'), '3.2');
    node = { ...node, ...patches.at(-1) };
    show(node);
    pick('Fiberglass');
    node = { ...node, ...patches.at(-1) };
    expect(node['density']).toBe(170);
    const back = reopenedFin(node);
    expect(back['filletRadius']).toBeCloseTo(0.0032, 12);
    expect(back['filletDensity']).toBe(1850);
    expect(back['filletMaterialName']).toBe('Fiberglass');
    expect(back['filletMaterialGroup']).not.toBe('Custom');
    expect(back['crossSection']).toBe(crossSection);
    expect(back['points']).toEqual(node['points']);
  });

  it('edits a custom density in selected units and keeps it when radius is zero on save', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
      units: { length: 'in', density: 'g/cm³' }, radiusMode: 'diameter',
    }));
    let node: ComponentNode = { ...makeNode('trapezoidfinset'), filletRadius: 0.00254,
      filletDensity: 1250, filletMaterialName: 'Imported epoxy', filletMaterialGroup: 'Custom' };
    show(node);
    expect(Number(box('Fillet radius (in)').value)).toBeCloseTo(0.1, 9);
    spin(box('Fillet radius (in)'));
    expect(patches.at(-1)!['filletRadius']).toBeCloseTo(0.105 * 0.0254, 12);
    type(box('Fillet material density (g/cm³)'), '1.3');
    expect(patches.at(-1)).toMatchObject({ filletDensity: 1300, filletMaterialName: undefined, filletMaterialGroup: undefined });
    node = { ...node, ...patches.at(-1), filletRadius: 0 };
    const back = reopenedFin(node);
    expect(back['filletRadius'] ?? 0).toBe(0);
    expect(back['filletDensity']).toBe(1300);
    expect(back['filletMaterialName']).toBeUndefined();
    show(back);
    expect(material().value).toBe('');
    expect(Number(box('Fillet material density (g/cm³)').value)).toBe(1.3);
  });

  it('refuses negative radius and nonpositive or excessive density', () => {
    show({ ...makeNode('trapezoidfinset'), filletRadius: 0.002, filletDensity: 1250 });
    type(box('Fillet radius (mm)'), '-1');
    expect(box('Fillet radius (mm)').getAttribute('aria-invalid')).toBe('true');
    for (const value of ['0', '-1', '30001', '1e309']) {
      type(box('Fillet material density (kg/m³)'), value);
      expect(box('Fillet material density (kg/m³)').getAttribute('aria-invalid')).toBe('true');
    }
    expect(patches).toEqual([]);
  });

  it('keeps custom material selection separate from the fin stock material', () => {
    const node = { ...makeNode('ellipticalfinset'), filletRadius: 0.003, filletDensity: 1250,
      filletMaterialName: 'Imported epoxy', filletMaterialGroup: 'Custom', density: 170, materialName: 'Balsa' };
    show(node);
    pick('');
    expect(patches).toEqual([{ filletMaterialName: undefined, filletMaterialGroup: undefined }]);
    const back = reopenedFin({ ...node, ...patches[0] });
    expect(back['filletDensity']).toBe(1250);
    expect(back['filletMaterialName']).toBeUndefined();
    expect(back['materialName']).toBe('Balsa');
  });

  it('keeps tube fins and body tubes free of unsupported fillet controls', () => {
    show(makeNode('freeformfinset'));
    expect(material()).not.toBeNull();
    for (const kind of ['tubefinset', 'bodytube'] as const) {
      show(makeNode(kind));
      expect(material()).toBeNull();
      expect(box('Fillet radius (mm)')).toBeNull();
    }
  });

  it.each(['rounded', 'airfoil'] as const)('only edited %s fillets change kernel mass and CG, and .ork preserves both', async (crossSection) => {
    const { OrkRocket } = await import('@online-openrocket/engine');
    const info = (tree: RocketTree) => OrkRocket.buildTree(engineTree(tree)).staticInfo();
    const original = { ...makeNode('freeformfinset'), crossSection, density: 170 };
    const before = info(treeFor(original));
    show(original);
    expect(box('Fillet radius (mm)')).not.toBeNull();
    expect(patches).toEqual([]);
    // No migration or render-time patch: the untouched tree gives the same result.
    expect(info(treeFor(original)).mass).toBeCloseTo(before.mass, 10);
    pick('Fiberglass');
    let edited = { ...original, ...patches.at(-1) };
    show(edited);
    type(box('Fillet radius (mm)'), '4');
    edited = { ...edited, ...patches.at(-1) };
    const after = info(treeFor(edited));
    expect(after.mass).toBeGreaterThan(before.mass);
    expect(after.cg).toBeGreaterThan(before.cg);
    const saved = importOrk(exportOrk({ name: 'Fillets', tree: treeFor(edited) })).tree;
    const reopened = info(saved);
    // 1e-10 kg/m tolerates kernel rounding without pinning hard-coded physics results.
    expect(reopened.mass).toBeCloseTo(after.mass, 10);
    expect(reopened.cg).toBeCloseTo(after.cg, 10);
    show(edited);
    type(box('Fillet radius (mm)'), '0');
    const removed = info(treeFor({ ...edited, ...patches.at(-1) }));
    expect(removed.mass).toBeCloseTo(before.mass, 10);
    expect(removed.cg).toBeCloseTo(before.cg, 10);
  }, 20_000);
});
