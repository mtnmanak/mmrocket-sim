// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentInfo, ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { FIELDS, type EditorComponentType } from '../tree/schema.js';
import { makeNode } from '../tree/treeModel.js';

/**
 * A BLANK FIELD WHOSE BLANK FLIES ONE KNOWN VALUE STEPS FROM IT (seam review of
 * audit 2026-09-22). The audit made the spinner and the arrow keys inert on a
 * blank field with no figure behind it — an "auto" Cd, a "standard" time step, a
 * plugged delay — because seeding those from 0 replaced a computed value with a
 * hard zero. It is right there, and it is kept. But most blank fields on a part
 * the user has just added DO have a figure: a new fin set's cant flies 0, a new
 * parachute's lines fly 6, and a set saved with no count flies 3 fins. Those
 * went dead too, with no placeholder saying what blank meant — so the panel now
 * shows that figure and steps from it, exactly as it always has for a rail
 * button's kernel dimensions.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

/** `node` where the panel would find it: under the stage, or inside a body tube. */
const treeFor = (node: ComponentNode): RocketTree => {
  const onStage = node.type === 'nosecone' || node.type === 'transition' || node.type === 'bodytube';
  const body = { id: 'b0', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.0005,
    children: onStage || node.type === 'stage' ? [] : [node] } as unknown as ComponentNode;
  const stage = node.type === 'stage'
    ? { ...node, children: [body] }
    : { id: 's0', type: 'stage', children: onStage ? [body, node] : [body] };
  return { name: 'R', components: [stage] } as unknown as RocketTree;
};

/** A built component's figures — what the mass and CG overrides step from. */
const INFO = { length: 0.1, mass: 0.01, sectionMass: 0.01, cgX: 0.05, positionX: 0 } as unknown as ComponentInfo;

const show = (node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={treeFor(node)} node={node} info={INFO} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

const inputStarting = (name: string): HTMLInputElement =>
  [...host.querySelectorAll<HTMLInputElement>('.numfield input')]
    .find((i) => (i.getAttribute('aria-label') ?? '').startsWith(name))!;
const spin = (input: HTMLInputElement, i: 0 | 1) => act(() => {
  (input.closest('.numfield')!.querySelectorAll('button')[i] as HTMLButtonElement).click();
});

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

describe('PropertyPanel — a blank that flies one known value', () => {
  it("a new fin set's blank cant shows 0 and steps from it, both ways", () => {
    show(makeNode('trapezoidfinset'));
    const cant = inputStarting('Cant angle');
    expect(cant.value).toBe('');
    expect(cant.placeholder).toBe('default: 0');
    spin(cant, 0);
    expect(patches.at(-1)!['cant']).toBeCloseTo(0.5 * Math.PI / 180, 9);
    spin(cant, 1);
    expect(patches.at(-1)!['cant']).toBeCloseTo(-0.5 * Math.PI / 180, 9);
  });

  it("a new parachute's blank line count shows the 6 lines the kernel flies, and steps from them", () => {
    // ComponentFactory: p.setLineCount((int) dbl(node, "lineCount", 6)). Before
    // the audit ▴ seeded from 0 and committed ONE line; after it, nothing.
    show(makeNode('parachute'));
    const lines = inputStarting('Line count');
    expect(lines.placeholder).toBe('default: 6');
    spin(lines, 0);
    expect(patches.at(-1)).toEqual({ lineCount: 7 });
    spin(lines, 1);
    expect(patches.at(-1)).toEqual({ lineCount: 5 });
  });

  it('a fin set saved with no count steps from the fins it flies: 3, or 6 tubes', () => {
    // finCountDefault — the kernel constructors' own, and what every drawing uses.
    const legacy = (type: EditorComponentType) => {
      const n = makeNode(type);
      delete n['finCount'];
      return n;
    };
    show(legacy('trapezoidfinset'));
    expect(inputStarting('Fin count').placeholder).toBe('default: 3');
    spin(inputStarting('Fin count'), 0);
    expect(patches.at(-1)).toEqual({ finCount: 4 });
    act(() => root.unmount());
    root = createRoot(host);
    show(legacy('tubefinset'));
    spin(inputStarting('Fin count'), 1);
    expect(patches.at(-1)).toEqual({ finCount: 5 });
  });

  it('a blank with NO single figure behind it stays inert — the audit rule stands', () => {
    // An "auto" Cd is computed by the kernel; a density is the part type's
    // default material. Seeding either from a number would replace it.
    show(makeNode('parachute'));
    spin(inputStarting('Drag coefficient'), 0);
    show(makeNode('nosecone'));
    spin(inputStarting('Material density'), 0);
    expect(patches).toEqual([]);
  });

  /**
   * Every numeric box a newly added part shows blank, for every component type:
   * ▴ steps it unless blank has no one value. The list of those is the whole
   * exemption, each with the reason it has no number.
   */
  it('every blank field on a newly added part steps, bar the ones with no single value', () => {
    const NO_SINGLE_VALUE: Record<string, string> = {
      'Material density': "the kernel's default material for the part type",
      'Drag coefficient': 'computed by the kernel ("auto")',
      'Max motor length': '"no limit"',
      'Nozzle exit diameter': '"off"',
      'Cd on frontal area': 'from the drag class',
    };
    const dead: string[] = [];
    for (const type of Object.keys(FIELDS) as EditorComponentType[]) {
      const node = makeNode(type);
      show(node);
      for (const input of [...host.querySelectorAll<HTMLInputElement>('.numfield input')]) {
        const label = input.getAttribute('aria-label') ?? '';
        if (input.value !== '' || Object.keys(NO_SINGLE_VALUE).some((k) => label.startsWith(k))) continue;
        const before = patches.length;
        spin(input, 0);
        if (patches.length === before) dead.push(`${type}: ${label}`);
      }
      act(() => root.unmount());
      root = createRoot(host);
    }
    expect(dead).toEqual([]);
  });
});
