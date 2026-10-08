// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { engineTree, makeNode } from '../tree/treeModel.js';
import { exportOrk, importOrk } from '../services/orkFile.js';
import { BULK_MATERIALS } from '../data/materials.js';

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
      expect(patches).toEqual([{ filletRadius: 0.0001 }]);
      show({ ...node, ...patches[0] });
      spin(box('Fillet radius (mm)'), true);
      expect(patches.at(-1)).toEqual({ filletRadius: 0 });
      pick('');
      expect(patches.at(-1)).toEqual({ filletDensity: 680, filletMaterialName: undefined, filletMaterialGroup: undefined });
      show({ ...node, ...patches.at(-1) });
      expect(material().value).toBe('');
    });

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
