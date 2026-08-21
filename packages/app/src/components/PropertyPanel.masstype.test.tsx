// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The mass-component Type picker (altimeter/tracker/…). The values are the
 * kernel's MassComponentType names lowercased — orkFile.ts round-trips them
 * verbatim, so the select must offer exactly those strings.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const mass = {
  id: 'm1', type: 'masscomponent', name: 'Ballast',
  mass: 0.01, length: 0.02, radius: 0.005, position: { method: 'top', offset: 0.02 },
} as unknown as ComponentNode;

const tree = {
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{ id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005, children: [mass] }],
  }],
} as unknown as RocketTree;

/** The panel has other selects (position method); find ours by its options. */
const typeSelect = (): HTMLSelectElement =>
  [...host.querySelectorAll('select')].find(
    (s) => [...s.options].some((o) => o.value === 'altimeter'),
  ) as HTMLSelectElement;

const pick = (el: HTMLSelectElement, value: string) => act(() => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

const mount = (node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={(p) => patches.push(p)} />
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

describe('PropertyPanel — mass-component Type picker', () => {
  it('offers the 8 kernel types in order and shows "Mass component" when unset', () => {
    mount(mass);
    const sel = typeSelect();
    expect(sel).toBeTruthy();
    expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([
      ['masscomponent', 'Mass component'],
      ['altimeter', 'Altimeter'],
      ['flightcomputer', 'Flight computer'],
      ['deploymentcharge', 'Deployment charge'],
      ['tracker', 'Tracker'],
      ['payload', 'Payload'],
      ['recoveryhardware', 'Recovery hardware'],
      ['battery', 'Battery'],
    ]);
    // Sparse node (no massComponentType) displays the default.
    expect(sel.value).toBe('masscomponent');
    expect(sel.selectedOptions[0]!.textContent).toBe('Mass component');
  });

  it('picking a type patches the raw serialized value', () => {
    mount(mass);
    pick(typeSelect(), 'altimeter');
    expect(patches).toEqual([{ massComponentType: 'altimeter' }]);
  });

  it('a node imported with a type shows it', () => {
    mount({ ...mass, massComponentType: 'tracker' } as unknown as ComponentNode);
    expect(typeSelect().value).toBe('tracker');
  });
});
