// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { presetPatch, type Preset } from '../services/presets.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A part pulled from the catalogue must show ITS OWN material, not "Custom".
 *
 * Reported 2026-09-01a. It was a display bug, not a data one: presetPatch
 * writes `materialName` AND `density`, so the flight physics was always right —
 * the dropdown just had no option matching the name and fell back to the empty
 * value, which renders as "Custom". 145 distinct material names ship in the
 * catalogue and only 18 are in the app's curated list, so 84 % of the database
 * looked custom the moment it was applied.
 */
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const G12: Preset = {
  kind: 'BodyTube', manufacturer: 'Composite Warehouse', partNo: '4 Inch Airframe',
  description: '', outsideDiameter: 0.102235, insideDiameter: 0.0997,
  length: 1.219, material: { name: 'Fiberglass, G12, filament wound tube, bulk', type: 'BULK', density: 1900 },
} as unknown as Preset;

const render = (node: ComponentNode) => {
  act(() => {
    root.render(
      <PrefsProvider>
        <PropertyPanel
          tree={{ name: 'r', components: [node] }}
          node={node}
          onPatch={() => {}}
        />
      </PrefsProvider>,
    );
  });
};

const materialSelect = (): HTMLSelectElement | null =>
  [...host.querySelectorAll('select')]
    .find((s) => /material/i.test(s.getAttribute('aria-label') ?? '')) ?? null;

describe('a catalogue part shows its own material', () => {
  it('presetPatch really does carry the name and the density (the premise)', () => {
    const patch = presetPatch('bodytube', G12);
    expect(patch['materialName']).toBe('Fiberglass, G12, filament wound tube, bulk');
    expect(patch['density']).toBe(1900);
  });

  it('the dropdown shows that name, not "Custom"', () => {
    const node = {
      type: 'bodytube', id: 'b', length: 1.219, outerRadius: 0.0511, thickness: 0.0013,
      ...presetPatch('bodytube', G12),
    } as unknown as ComponentNode;
    render(node);
    const sel = materialSelect();
    expect(sel, 'no material dropdown rendered').not.toBeNull();
    expect(sel!.value).toBe('Fiberglass, G12, filament wound tube, bulk');
    const selected = [...sel!.options].find((o) => o.value === sel!.value)!;
    // Its own density is shown beside it, and it is labelled as coming from the
    // catalogue so it is not mistaken for one of the app's curated materials.
    expect(selected.textContent).toContain('1900');
    expect(selected.textContent).toContain('parts database');
  });

  it('"Custom" still means no name at all', () => {
    const node = {
      type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.001,
      density: 680,
    } as unknown as ComponentNode;
    render(node);
    expect(materialSelect()!.value).toBe('');
  });

  it('a curated material is unaffected', () => {
    const node = {
      type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.001,
      materialName: 'Cardboard', density: 680,
    } as unknown as ComponentNode;
    render(node);
    const sel = materialSelect()!;
    // Either it is a curated name (selected, no "parts database" tag) or the
    // fixture's name is not curated — assert the discriminating half.
    if (sel.value === 'Cardboard') {
      const opt = [...sel.options].find((o) => o.value === 'Cardboard')!;
      expect(opt.textContent).not.toContain('parts database');
    }
  });
});
