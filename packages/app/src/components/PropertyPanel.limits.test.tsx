// @vitest-environment happy-dom
import { act } from 'react';
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

describe('PropertyPanel — fin count stops at the kernel\'s 8', () => {
  it('refuses a typed 12 on a planar fin set, and takes 8', () => {
    mount(onBody({ id: 'f1', type: 'trapezoidfinset', name: 'Fins', finCount: 4,
      rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 }));
    type(box('Fin count'), '12');
    expect(patches).toEqual([]);
    expect(box('Fin count').getAttribute('aria-invalid')).toBe('true');
    type(box('Fin count'), '8');
    expect(patches).toEqual([{ finCount: 8 }]);
    expect(slider('Fin count').max).toBe('8');
  });

  it('the tube-fin slider stops at 8, not 12', () => {
    mount(onBody({ id: 't1', type: 'tubefinset', name: 'Tubes', finCount: 6, length: 0.1, thickness: 0.0005 }));
    expect(slider('Fin count').max).toBe('8');
    type(box('Fin count'), '12');
    expect(patches).toEqual([]);
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
