// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentInfo, ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The property panel's numeric inputs, driven through the real panel — the
 * findings of the 2026-09-22 audit's "Design editing and numeric inputs"
 * section, each of which was measured this way before it was fixed.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const tube = (id: string, over: Record<string, unknown> = {}): ComponentNode => ({
  id, type: 'bodytube', name: id, length: 0.3, outerRadius: 0.02, thickness: 0.001, ...over,
} as unknown as ComponentNode);

const treeOf = (...nodes: ComponentNode[]): RocketTree => ({
  name: 'R', components: [{ id: 's1', type: 'stage', children: nodes }],
} as unknown as RocketTree);

const infoOf = (massKg: number): ComponentInfo => ({
  length: 0.3, mass: massKg, sectionMass: massKg, cgX: 0.15, positionX: 0,
} as unknown as ComponentInfo);

/**
 * Renders the panel into the SAME root every time, with no key — the way it
 * sat in App before the audit, and the way it still sits for one component
 * across an undo or a unit switch.
 */
const show = (tree: RocketTree, node: ComponentNode, info?: ComponentInfo) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} info={info} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

const inputNamed = (name: string): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
/** The ▴ (0) or ▾ (1) spinner beside a named NumField. */
const spinner = (name: string, i: 0 | 1): HTMLButtonElement =>
  inputNamed(name).closest('.numfield')!.querySelectorAll('button')[i] as HTMLButtonElement;
const click = (el: HTMLElement) => act(() => { el.click(); });

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

describe('PropertyPanel — a spinner click leaves nothing behind for the next component', () => {
  /**
   * The audit's HIGH, reproduced as it was measured: tube B has no override and
   * a computed 120 g, yet its Mass-override field showed A's figure, and one ▴
   * committed A's mass plus a step onto B.
   */
  it("tube B's blank mass override neither shows nor steps from tube A's figure", () => {
    const a = tube('A', { overrideMass: 0.0451 });
    const b = tube('B');
    const tree = treeOf(a, b);
    show(tree, a, infoOf(0.05));
    click(spinner('Mass override', 0));
    expect(patches.at(-1)!['overrideMass']).toBeCloseTo(0.0452, 9);

    show(tree, b, infoOf(0.12));
    expect(inputNamed('Mass override').value, "B's own blank field, not A's 45.2").toBe('');
    click(spinner('Mass override', 0));
    // Seeded from B's computed 120 g (the placeholder), one 0.1 g step up.
    expect(patches.at(-1)!['overrideMass']).toBeCloseTo(0.1201, 9);
  });
});
