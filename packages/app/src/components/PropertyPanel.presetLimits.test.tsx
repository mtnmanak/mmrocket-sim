// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * A preset pick goes through the limits table on its way into the tree (seam
 * review of audit 2026-09-22). The picker is stood in for by one button that
 * applies the patch the shipped SEMROC HTC-11 row makes — `presetPatch` itself
 * is pinned against the real row in services/presetLimits.test.ts — so what this
 * pins is the PANEL's handling of whatever a pick hands it.
 */
vi.mock('./PresetPicker.js', () => ({
  PresetPicker: ({ onApply, onClose }: {
    onApply: (patch: Partial<ComponentNode>) => void; onClose: () => void;
  }) => (
    <button type="button" onClick={() => {
      onApply({ name: 'SEMROC HTC-11', outerRadius: 0.0143256, thickness: -0.010668, length: 0.0508 });
      onClose();
    }}>apply HTC-11</button>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const coupler = { id: 'c1', type: 'tubecoupler', name: 'Coupler', length: 0.05, thickness: 0.0005 } as ComponentNode;
const tree = {
  name: 'R',
  components: [{
    id: 's1', type: 'stage',
    children: [{ id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.0005, children: [coupler] }],
  }],
} as unknown as RocketTree;

const buttonNamed = (text: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))!;
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

describe('PropertyPanel — a preset pick is held to the limits table', () => {
  it('stores the repaired wall, not the negative one, and says so under the preset button', () => {
    act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={tree} node={coupler} onPatch={(p) => patches.push(p)} />
      </PrefsProvider>,
    ));
    click(buttonNamed('Choose from preset database'));
    click(buttonNamed('apply HTC-11'));
    expect(patches).toHaveLength(1);
    // The panel's typed commit and a reload both clamp a wall to 0; the pick
    // stored -10.668 mm, which only a restored session repaired — silently.
    expect(patches[0]!['thickness']).toBe(0);
    expect(patches[0]!['outerRadius']).toBe(0.0143256);
    expect(host.textContent).toContain(
      '“SEMROC HTC-11”: wall thickness -10.668 mm cannot be negative — set to 0 mm.');
  });

  it('does not carry the note to the next part selected', () => {
    const other = { id: 'c2', type: 'tubecoupler', name: 'Other', length: 0.05, thickness: 0.0005 } as ComponentNode;
    const render = (node: ComponentNode) => act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={tree} node={node} onPatch={(p) => patches.push(p)} />
      </PrefsProvider>,
    ));
    render(coupler);
    click(buttonNamed('Choose from preset database'));
    click(buttonNamed('apply HTC-11'));
    expect(host.textContent).toContain('cannot be negative');
    render(other);
    expect(host.textContent).not.toContain('cannot be negative');
  });
});
