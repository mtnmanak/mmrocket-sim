// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { OrkRocket, resetEngine } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { engineTree, updateNode } from '../tree/treeModel.js';

/**
 * "Relative to" re-expresses the SAME station; it never moves the part (audit
 * 2026-09-30, `PropertyPanel.tsx:1477`). Desktop's `setAxialMethod`
 * (RocketComponent.java:1384-1387) recomputes the offset from the part's
 * physical position, and the select used to patch `{ ...pos, method }` with the
 * offset unchanged instead: a fin set at Top +0.25 m in a 0.30 m tube, switched
 * to Bottom, landed 0.25 m behind the tube's aft end, moving CP, CG and margin
 * with nothing on screen to say so.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const TUBE = 0.3;

const onTube = (part: Record<string, unknown>, tube: Record<string, unknown> = { length: TUBE }): RocketTree => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012, thickness: 0.002 },
      { id: 'b1', type: 'bodytube', outerRadius: 0.012, thickness: 0.0005, ...tube, children: [part] },
    ],
  }],
} as unknown as RocketTree);

const mount = (tree: RocketTree, node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

const methodSelect = (): HTMLSelectElement =>
  host.querySelector<HTMLSelectElement>('select[aria-label="Position relative to"]')!;
const pick = (el: HTMLSelectElement, value: string) => act(() => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

/**
 * Where a part's leading edge sits in its parent — `AxialMethod.getAsPosition`
 * (24.12), written out here rather than borrowed from tree/position.ts, so the
 * test does not grade the panel with the helper the fix uses.
 */
const startOf = (pos: ComponentPosition, partLen: number, parentLen: number): number =>
  pos.method === 'middle' ? pos.offset + (parentLen - partLen) / 2
    : pos.method === 'bottom' ? pos.offset + (parentLen - partLen)
      : pos.offset;
const offsetFor = (method: ComponentPosition['method'], start: number, partLen: number, parentLen: number): number =>
  method === 'middle' ? start - (parentLen - partLen) / 2
    : method === 'bottom' ? start - (parentLen - partLen)
      : start;

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

const METHODS = ['top', 'middle', 'bottom'] as const;
const PAIRS = METHODS.flatMap((from) => METHODS.filter((to) => to !== from).map((to) => [from, to] as const));

/**
 * Three parts whose KERNEL length differs in kind: a planar fin set's root
 * chord (no `length` key at all), a rail button's zero (Middle and Bottom sit
 * L/2 and L from Top), and an overhanging freeform fin, whose root chord
 * (last point, 50 mm) is shorter than its drawn outline (80 mm).
 */
const PARTS: { label: string; len: number; node: Record<string, unknown> }[] = [
  { label: 'trapezoidal fin set', len: 0.05, node: {
    id: 'p', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03,
    sweep: 0.02, height: 0.03, thickness: 0.003 } },
  { label: 'rail button', len: 0, node: {
    id: 'p', type: 'railbutton', outerDiameter: 0.0097, angleOffset: Math.PI } },
  { label: 'overhanging freeform fin set', len: 0.05, node: {
    id: 'p', type: 'freeformfinset', finCount: 3, thickness: 0.003,
    points: [[0, 0], [0.06, 0.04], [0.08, 0.04], [0.05, 0]] } },
];

describe('PropertyPanel — "Relative to" keeps the part where it is', () => {
  it('the audit\'s case: Top +0.25 m in a 0.30 m tube becomes Bottom 0, still flush with the aft end', () => {
    const fins = { ...PARTS[0]!.node, position: { method: 'top', offset: 0.25 } };
    mount(onTube(fins), fins as unknown as ComponentNode);
    pick(methodSelect(), 'bottom');
    expect(patches).toHaveLength(1);
    const pos = patches[0]!['position'] as ComponentPosition;
    expect(pos.method).toBe('bottom');
    // Before the fix the offset stayed 0.25: the leading edge at 0.50 m, the
    // trailing edge 0.25 m past the end of a 0.30 m tube.
    expect(pos.offset).toBeCloseTo(0, 12);
  });

  for (const { label, len, node } of PARTS) {
    it.each(PAIRS)(`${label}: %s → %s keeps the leading edge 120 mm down the tube`, (from, to) => {
      const start = 0.12;
      const part = { ...node, position: { method: from, offset: offsetFor(from, start, len, TUBE) } };
      mount(onTube(part), part as unknown as ComponentNode);
      expect(methodSelect().value).toBe(from);
      pick(methodSelect(), to);
      expect(patches).toHaveLength(1);
      const pos = patches[0]!['position'] as ComponentPosition;
      expect(pos.method).toBe(to);
      expect(startOf(pos, len, TUBE), `${from} → ${to}`).toBeCloseTo(start, 12);
    });
  }

  /**
   * THE KERNEL IS THE JUDGE of where a part is: the station it builds is what
   * mass, CG and CP come from. Its 'middle' and 'bottom' measure against the
   * PARENT'S getLength(), which for a tube saved with no length (an autosave
   * from before 22 September) is the bridge's 0.3 m — not the 0.2 m the
   * panel's slider frames itself with (audit row 351). Both parts are here: a
   * freeform fin, whose kernel length is its root chord, and a mass component.
   */
  it('the station the kernel flies does not move, even in a tube saved with no length', () => {
    resetEngine();
    for (const part of [
      { ...PARTS[2]!.node, id: 'ff', position: { method: 'top', offset: 0.04 } },
      { id: 'mc', type: 'masscomponent', mass: 0.05, length: 0.03, radius: 0.005,
        position: { method: 'middle', offset: 0.03 } },
    ]) {
      for (const tube of [{ length: TUBE }, {}]) {
        const tree = onTube(part, tube);
        const id = part.id as string;
        const before = OrkRocket.buildTree(engineTree(tree)).componentInfo(id).positionX;
        for (const to of METHODS) {
          if (to === (part.position as ComponentPosition).method) continue;
          patches = [];
          mount(tree, part as unknown as ComponentNode);
          pick(methodSelect(), to);
          const patched = updateNode(tree, id, patches[0] as Partial<ComponentNode>);
          const after = OrkRocket.buildTree(engineTree(patched)).componentInfo(id).positionX;
          expect(after, `${id} in a tube ${'length' in tube ? 'of 0.3 m' : 'with no length'}, → ${to}`)
            .toBeCloseTo(before, 9);
        }
      }
    }
  }, 60000);

  /**
   * A PART WITH NO POSITION (2026-10-01). A Tube coupler or Bulkhead added from
   * the Add menu carried none, and the kernel flies such a part at its own
   * default — the BOTTOM of its tube for both — while this panel showed "Top of
   * parent", 0. A switch then re-measured the station the panel showed rather
   * than the one the part flies at: a bulkhead in this 0.7 m tube switched to
   * Middle moved 0.697 m forward, from the aft end to the top, and Top was
   * already "selected", so it could not be picked at all.
   */
  it('a part with no position shows where the kernel flies it, and a switch keeps it there', () => {
    resetEngine();
    for (const part of [
      { id: 'cp', type: 'tubecoupler', length: 0.05, thickness: 0.0005 },
      { id: 'bh', type: 'bulkhead', length: 0.003 },
    ]) {
      const tree = onTube(part, { length: 0.7 });
      const before = OrkRocket.buildTree(engineTree(tree)).componentInfo(part.id).positionX;
      for (const to of ['top', 'middle'] as const) {
        patches = [];
        mount(tree, part as unknown as ComponentNode);
        expect(methodSelect().value, part.type).toBe('bottom');
        pick(methodSelect(), to);
        expect(patches, `${part.type} → ${to}`).toHaveLength(1);
        const patched = updateNode(tree, part.id, patches[0] as Partial<ComponentNode>);
        const after = OrkRocket.buildTree(engineTree(patched)).componentInfo(part.id).positionX;
        expect(after, `${part.type} → ${to}`).toBeCloseTo(before, 9);
      }
    }
  }, 60000);
});
