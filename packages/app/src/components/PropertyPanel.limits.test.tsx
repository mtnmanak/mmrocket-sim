// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The property panel enforces the same hard limits the load boundary's
 * sanitize pass applies (audit 2026-09-22, schema.ts `fieldLimit`):
 *
 *  - a fin count is capped at the kernel's 8 — a typed 12 was drawn, printed
 *    and exported as 12 while the kernel flew 8 (identical mass and CP), and
 *    the tube-fin slider ran to 12;
 *  - a tube-fin length or a camera-shroud height of 0, the left stop of their
 *    sliders, failed the whole build ("NaN … BigInt", "Unknown format
 *    conversion: g") — and autosave kept it, so it failed on every load.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const onBody = (child: Record<string, unknown>): { tree: RocketTree; node: ComponentNode } => {
  const node = child as unknown as ComponentNode;
  return {
    node,
    tree: {
      name: 'R',
      components: [{
        id: 's1', type: 'stage',
        children: [
          { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012 },
          { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005, children: [node] },
        ],
      }],
    } as unknown as RocketTree,
  };
};

const mount = ({ tree, node }: { tree: RocketTree; node: ComponentNode }) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

const box = (label: string): HTMLInputElement =>
  host.querySelector(`input[type="text"][aria-label="${label}"]`)!;
const slider = (label: string): HTMLInputElement =>
  host.querySelector(`input[type="range"][aria-label="${label}"]`)!;

/** Native setter + input event — how React sees a real keystroke. */
const type = (el: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('PropertyPanel — an entry that converts to infinity is refused', () => {
  it('flags a deployment-altitude overflow even without a density ceiling', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { distance: 'km' } }));
    mount(onBody({ id: 'p1', type: 'parachute', deployEvent: 'altitude', deployAltitude: 300 }));
    const el = box('Deploy altitude (AGL) (km)');
    act(() => el.focus());
    type(el, '1e306');
    expect(patches).toEqual([]);
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  it('a density of 1e306 g/cm³ (1e309 kg/m³) commits nothing', () => {
    // Finite as typed, infinite in SI: stored, the kernel flew the default
    // density while a saved .ork wrote density="Infinity" (claim check of the
    // v0.141 notes). A value that stays finite still commits.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { density: 'g/cm³' } }));
    mount(onBody({ id: 'i1', type: 'innertube', name: 'Mount', length: 0.07, outerRadius: 0.009,
      thickness: 0.0005, density: 1100 }));
    const el = box('Material density (g/cm³)');
    act(() => { el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    type(el, '1e306');
    expect(patches).toEqual([]);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    type(el, '2');
    expect(patches).toEqual([{ density: 2000, materialName: undefined }]);
  });
});

describe('PropertyPanel — bulk density ceiling', () => {
  it.each(['g/cm³', 'kg/m³', 'oz/in³', 'lb/ft³'])('keeps key-by-key prefixes within the ceiling in %s', (unit) => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { density: unit } }));
    const { tree, node } = onBody({ id: 'i1', type: 'innertube', name: 'Mount', length: 0.07,
      outerRadius: 0.009, thickness: 0.0005, density: 1100 });
    function Live() {
      const [n, setN] = useState(node);
      return <PropertyPanel tree={tree} node={n} onPatch={(p) => {
        patches.push(p); setN((old) => ({ ...old, ...p }) as ComponentNode);
      }} />;
    }
    act(() => root.render(<PrefsProvider><Live /></PrefsProvider>));
    const el = box(`Material density (${unit})`);
    act(() => el.focus());
    for (const draft of ['1', '1e', '1e3', '1e30', '1e306']) type(el, draft);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) expect(patch['density']).toBeLessThanOrEqual(30_000);
    const count = patches.length;
    type(el, '1e306');
    expect(patches).toHaveLength(count);
    act(() => el.blur());
    expect(el.value).not.toBe('1e306');
  });

  it('accepts the bulk ceiling and refuses a value above it', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { density: 'g/cm³' } }));
    mount(onBody({ id: 'i1', type: 'innertube', density: 1100 }));
    const el = box('Material density (g/cm³)');
    act(() => el.focus());
    type(el, '30');
    expect(patches).toEqual([{ density: 30_000, materialName: undefined }]);
    type(el, '31');
    expect(patches).toHaveLength(1);
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('PropertyPanel — fin count stops at the kernel\'s 8', () => {
  it('takes a typed 12 on a planar fin set as 8, flagged until blur', () => {
    mount(onBody({ id: 'f1', type: 'trapezoidfinset', name: 'Fins', finCount: 4,
      rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 }));
    // Typing needs focus: NumField shows its draft (and so its error flag)
    // only while the input is focused (audit 2026-09-22, the spinner-draft fix).
    act(() => { box('Fin count').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    type(box('Fin count'), '12');
    expect(patches).toEqual([{ finCount: 8 }]);
    expect(box('Fin count').getAttribute('aria-invalid')).toBe('true');
    expect(slider('Fin count').max).toBe('8');
  });

  it('typed a keystroke at a time, 12 ends as 8 fins — not the 1 committed on the way', () => {
    // Every draft commits live, so "12" is "1" and then "12". Refusing the
    // "12" at the field's max left the 1 stored: a user asking for twelve fins
    // got ONE (review of audit 2026-09-22). The panel is live here — each
    // patch goes back onto the node, as App does — so blur shows what stuck.
    function Live({ tree, node }: { tree: RocketTree; node: ComponentNode }) {
      const [n, setN] = useState(node);
      return <PropertyPanel tree={tree} node={n}
        onPatch={(p) => { patches.push(p); setN((o) => ({ ...o, ...p }) as ComponentNode); }} />;
    }
    const { tree, node } = onBody({ id: 'f1', type: 'trapezoidfinset', name: 'Fins', finCount: 4,
      rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 });
    act(() => root.render(<PrefsProvider><Live tree={tree} node={node} /></PrefsProvider>));
    const el = box('Fin count');
    act(() => { el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    type(el, '1');
    type(el, '12');
    act(() => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(patches).toEqual([{ finCount: 1 }, { finCount: 8 }]);
    expect(box('Fin count').value).toBe('8');
  });

  it('the tube-fin slider stops at 8, not 12, and a typed 12 is 8', () => {
    mount(onBody({ id: 't1', type: 'tubefinset', name: 'Tubes', finCount: 6, length: 0.1, thickness: 0.0005 }));
    expect(slider('Fin count').max).toBe('8');
    type(box('Fin count'), '12');
    expect(patches).toEqual([{ finCount: 8 }]);
  });
});

/**
 * The CG override and the position Offset are typed into boxes of their own,
 * outside the schema fields' commit, and went straight to the design (audit
 * 2026-09-30, `PropertyPanel.tsx:1377`, `:1492`). Typed 5000 m, they stored and
 * flew 5000 m, and the next reload's sanitize pass cut them to 1000 m with a
 * note — moving the numbers after the fact. The limit is the load boundary's:
 * no part of a real rocket sits, or balances, a kilometre away.
 */
describe('PropertyPanel — the CG override and the Offset keep to the ±1 km limit', () => {
  const mountTube = () => mount(onBody({ id: 'i1', type: 'innertube', name: 'Mount', length: 0.07,
    outerRadius: 0.009, thickness: 0.0005, position: { method: 'top', offset: 0.01 } }));

  it('a typed Offset of ±5 km is stored as ±1000 m; an ordinary one is untouched', () => {
    mountTube();
    type(box('Position offset'), '5000000'); // mm
    type(box('Position offset'), '-5000000');
    type(box('Position offset'), '120');
    expect(patches).toEqual([
      { position: { method: 'top', offset: 1000 } },
      { position: { method: 'top', offset: -1000 } },
      { position: { method: 'top', offset: 0.12 } },
    ]);
  });

  it('a typed CG override of ±5 km is stored as ±1000 m; an ordinary one is untouched', () => {
    mountTube();
    type(box('CG override, from component top'), '5000000');
    type(box('CG override, from component top'), '-5000000');
    type(box('CG override, from component top'), '35');
    expect(patches).toEqual([{ overrideCGX: 1000 }, { overrideCGX: -1000 }, { overrideCGX: 0.035 }]);
  });

  it('holds the limit in SI whatever the display unit: 50,000 in is 1270 m, stored as 1000', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'in' } }));
    mountTube();
    type(box('Position offset'), '50000');
    type(box('CG override, from component top'), '50000');
    expect(patches).toEqual([{ position: { method: 'top', offset: 1000 } }, { overrideCGX: 1000 }]);
  });
});

describe('PropertyPanel — a value the kernel cannot build is never stored', () => {
  it('a tube-fin length of 0 is stored as the 0.1 mm minimum', () => {
    mount(onBody({ id: 't1', type: 'tubefinset', name: 'Tubes', finCount: 6, length: 0.1, thickness: 0.0005 }));
    type(box('Length (mm)'), '0');
    expect(patches).toEqual([{ length: 0.0001 }]);
  });

  it('a camera-shroud height of 0 (the slider\'s left stop) is stored as the minimum', () => {
    mount(onBody({ id: 'h1', type: 'fairing', name: 'Shroud', length: 0.08, width: 0.025, height: 0.02,
      fairingForeShape: 'box', fairingAftShape: 'box' }));
    act(() => {
      const el = slider('Height (off the surface) (mm)');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '0');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(patches).toEqual([{ height: 0.0001 }]);
  });

  it('an ordinary value passes through untouched', () => {
    mount(onBody({ id: 't1', type: 'tubefinset', name: 'Tubes', finCount: 6, length: 0.1, thickness: 0.0005 }));
    type(box('Length (mm)'), '75');
    expect(patches).toEqual([{ length: 0.075 }]);
  });
});
