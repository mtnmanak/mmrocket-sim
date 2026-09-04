// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * Two things the property panel got wrong for everyone, not only for screen
 * readers: controls with no accessible name, and a schema step of 0 reaching a
 * slider that then had one usable position.
 *
 * The `.field` blocks render `<label>` as a SIBLING with no htmlFor, so the
 * visible text names nothing. NumField and every <select> in the file pass an
 * explicit aria-label; the range inputs, the Name box and the colour picker
 * did not.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREFS_KEY = 'online-openrocket.prefs.v1';

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const treeWith = (node: Record<string, unknown>): RocketTree => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage', children: [
      { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.027, thickness: 0.001,
        children: [node] },
    ],
  }],
} as unknown as RocketTree);

const mount = (tree: RocketTree, node: Record<string, unknown>) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node as unknown as ComponentNode}
      onPatch={(p) => patches.push(p as Record<string, unknown>)} />
  </PrefsProvider>,
));

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

const sliders = () => [...host.querySelectorAll('input[type="range"]')] as HTMLInputElement[];

describe('every control has a name', () => {
  const TUBE = { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.027, thickness: 0.001 };

  it('names each ValueSlider after its own field, in the display unit', () => {
    // A body tube renders several sliders. Announced as a bare "slider" with a
    // number they were indistinguishable — and they write straight into the
    // flight model.
    mount(treeWith(TUBE), TUBE);
    const names = sliders().map((s) => s.getAttribute('aria-label'));
    expect(names.every((n) => !!n && n.trim() !== '')).toBe(true);
    expect(names).toContain('Length (mm)');
    // Each slider's name matches the NumField above it, so the pair reads as
    // one control rather than two unrelated ones.
    const numFieldNames = [...host.querySelectorAll('.numfield input')]
      .map((i) => i.getAttribute('aria-label'));
    for (const n of names) expect(numFieldNames).toContain(n);
  });

  it('names the Name box and the colour picker', () => {
    mount(treeWith(TUBE), TUBE);
    const name = host.querySelector('input[aria-label="Component name"]') as HTMLInputElement;
    expect(name).toBeTruthy();
    expect(name.value).toBe('');
    expect(host.querySelector('input[type="color"]')!.getAttribute('aria-label'))
      .toBe('Component color');
  });

  it('names the Position offset slider', () => {
    const fin = {
      id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.08, tipChord: 0.04,
      sweep: 0.03, height: 0.05, thickness: 0.003, position: { method: 'bottom', offset: 0 },
    };
    mount(treeWith(fin), fin);
    expect(sliders().some((s) => s.getAttribute('aria-label') === 'Position offset')).toBe(true);
  });
});

describe('the spill-hole field', () => {
  const CHUTE = {
    id: 'p1', type: 'parachute', diameter: 0.3, cd: 0.8, spillHoleDiameter: 0.02,
  };

  const spillSlider = () =>
    sliders().find((s) => (s.getAttribute('aria-label') ?? '').startsWith('Spill hole'))!;

  it('steps by 1 mm in mm, not by 1 of whatever unit is selected', () => {
    // schema.ts passes 0 as lenMM's step for this one field, and `?? 1` let it
    // through to niceStep(0), which returns 1 — a step of 1 in the DISPLAY
    // unit. With Preferences → length in metres the slider ran 0…0.285 in
    // steps of 1: one reachable position, and no vent settable at all.
    mount(treeWith(CHUTE), CHUTE);
    expect(Number(spillSlider().step)).toBeCloseTo(1, 12); // mm
  });

  it('keeps a usable step when the length unit is metres', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ units: { length: 'm' } }));
    mount(treeWith(CHUTE), CHUTE);
    const s = spillSlider();
    expect(Number(s.step)).toBeCloseTo(0.001, 12);
    // …and the range is still 0 to 95 % of the canopy, so there are hundreds
    // of reachable positions rather than one.
    expect((Number(s.max) - Number(s.min)) / Number(s.step)).toBeGreaterThan(100);
  });

  it('caps the vent at 0.95 x the canopy — the number treeModel already flies', () => {
    // treeModel.ts:1149 clamps the FLOWN hole to 0.95·D silently, so the panel
    // could show a vent the rocket was not flying on the one control that
    // scales descent Cd.
    mount(treeWith(CHUTE), CHUTE);
    expect(Number(spillSlider().max)).toBeCloseTo(285, 3); // 0.95 x 300 mm
    const box = [...host.querySelectorAll('.numfield input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Spill hole')) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(box, '1000');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // NumField rejects a value above max outright, so nothing is committed —
    // rather than storing a metre-wide hole in a 300 mm canopy.
    expect(patches.filter((p) => 'spillHoleDiameter' in p)).toEqual([]);
  });

  it('leaves fields that declare a real step alone', () => {
    // Canopy diameter declares step 10 (mm). The `|| 1` must not swallow it.
    mount(treeWith(CHUTE), CHUTE);
    const canopy = sliders()
      .find((s) => (s.getAttribute('aria-label') ?? '').startsWith('Canopy diameter'))!;
    expect(Number(canopy.step)).toBeCloseTo(10, 12);
  });
});

describe('auto-place rail buttons targets the CG the kernel flies', () => {
  /**
   * The forward button goes AT the CG. Resolving its offset with
   * axialLength's 25 mm `packedLength` fallback — a rail button carries no
   * length key — put it 12.5 mm aft of the CG on the app's own default
   * 'middle' method, and 25 mm aft on 'bottom'.
   */
  const rocket = (method: string): RocketTree => ({
    name: 'R',
    components: [{
      id: 's1', type: 'stage', children: [
        { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.027 },
        {
          id: 'b1', type: 'bodytube', length: 1, outerRadius: 0.027, thickness: 0.001,
          children: [{
            id: 'rb', type: 'railbutton', outerDiameter: 0.0097, angleOffset: 0,
            position: { method, offset: 0 },
          }],
        },
      ],
    }],
  } as unknown as RocketTree);

  /** The kernel reports a rail button's own station in `info.positionX`. */
  const info = (method: string) => ({
    length: 0.05, mass: 0.002, sectionMass: 0.002, cgX: 0,
    positionX: method === 'top' ? 0.1 : method === 'middle' ? 0.6 : 1.1,
  });

  const place = (method: string) => {
    const tree = rocket(method);
    const node = tree.components[0]!.children![1]!.children![0]!;
    act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={tree} node={node}
          info={info(method) as never}
          rocketInfo={{ length: 1.1, cg: 0.55 } as never}
          onPatch={(p) => patches.push(p as Record<string, unknown>)} />
      </PrefsProvider>,
    ));
    const btn = [...host.querySelectorAll('button')]
      .find((b) => /Auto-place rail buttons/.test(b.textContent ?? ''))!;
    expect(btn, 'the auto-place button should be offered').toBeTruthy();
    expect(btn.disabled, 'and enabled for this rocket').toBe(false);
    act(() => { btn.click(); });
    return patches.at(-1)!;
  };

  for (const method of ['top', 'middle', 'bottom']) {
    it(`lands the forward button exactly on the CG (${method})`, () => {
      const patch = place(method);
      const pos = patch['position'] as { method: string; offset: number };
      // Parent tube starts 0.1 m aft of the nose tip and is 1 m long; the CG
      // is at 0.55 m, i.e. 0.45 m into the tube. A zero-length component:
      // top -> 0.45, middle -> 0.45 - 0.5, bottom -> 0.45 - 1.
      const expected = method === 'top' ? 0.45 : method === 'middle' ? -0.05 : -0.55;
      expect(pos.method).toBe(method);
      expect(pos.offset).toBeCloseTo(expected, 9);
      // The aft button is an inch off the tail, so the separation is fixed.
      expect(patch['instanceCount']).toBe(2);
      expect(patch['instanceSeparation'] as number).toBeCloseTo(1.1 - 0.0254 - 0.55, 9);
    });
  }
});
