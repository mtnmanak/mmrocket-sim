// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { presetPatch } from '../services/presets.js';

/**
 * A preset pick goes through the limits table on its way into the tree (seam
 * review of audit 2026-09-22). The picker is stood in for by one button that
 * applies the patch SEMROC HTC-11's row made as it shipped, before its inside
 * diameter was corrected at the source — `presetPatch` itself is pinned against
 * that row in services/presetLimits.test.ts — so what this
 * pins is the PANEL's handling of whatever a pick hands it.
 */
vi.mock('./PresetPicker.js', () => ({
  PresetPicker: ({ onApply, onClose }: {
    onApply: (patch: Partial<ComponentNode>, notes?: string[]) => void; onClose: () => void;
  }) => (
    <> <button type="button" onClick={() => { onApply(picked); onClose(); }}>apply catalogue row</button>
    <button type="button" onClick={() => {
      onApply({ name: 'SEMROC HTC-11', outerRadius: 0.0143256, thickness: -0.010668, length: 0.0508 },
        ['The catalogue bore was left automatic.']);
      onClose();
    }}>apply HTC-11</button></>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];
let picked: Partial<ComponentNode>;

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

function fixture(type: 'centeringring' | 'bulkhead' = 'centeringring') {
  let ring: ComponentNode = { id: 'ring', type, name: 'Stored ring', length: 0.003,
    outerRadius: 0.03195, innerRadius: 0.01242, presetManufacturer: 'EX', presetPartNo: 'Stored', checkRingFit: true };
  const body: ComponentNode = { id: 'body', type: 'bodytube', name: 'BT-80',
    length: 0.3, outerRadius: 0.033, thickness: 0.00055, children: [] };
  const fitTree: RocketTree = { name: 'Fit', components: [body] };
  picked = presetPatch(type, { kind: type === 'bulkhead' ? 'BulkHead' : 'CenteringRing',
    manufacturer: 'BalsaMachining', partNo: 'CR5060-W', description: '', length: 0.003,
    outsideDiameter: 0.04046, insideDiameter: 0.02484 });
  return { body, get ring() { return ring; }, setRing: (p: Partial<ComponentNode>) => { ring = { ...ring, ...p }; },
    render: () => {
      body.children = [ring, ...(body.children ?? []).filter(n => n.id !== ring.id)];
      act(() => root.render(<PrefsProvider><PropertyPanel tree={fitTree} node={ring}
        onPatch={p => { patches.push(p); ring = { ...ring, ...p }; }} /></PrefsProvider>));
    } };
}
const applyPick = () => { click(buttonNamed('Choose from preset database')); click(buttonNamed('apply catalogue row')); };

describe('PropertyPanel - pick-only fit', () => {
  it('updates an established status region after a repaired preset pick', () => {
    const f = fixture(); f.render();
    const regions = new Set(host.querySelectorAll('[role="status"]'));
    applyPick(); f.render();
    const note = host.querySelector('.message-caution[role="status"]')!;
    expect(note?.textContent).toMatch(/fit|Undo/);
    expect(regions.has(note)).toBe(true);
  });
  it.each(['centeringring', 'bulkhead'] as const)('opens and restores a stored %s 1 mm under its bore silently', type => {
    const f = fixture(type); f.render();
    expect(host.querySelector('.message-caution')).toBeNull();
    expect(patches).toHaveLength(0);
    f.setRing(JSON.parse(JSON.stringify(f.ring)) as ComponentNode); f.render();
    expect(host.querySelector('.message-caution')).toBeNull();
  });
  it.each(['centeringring', 'bulkhead'] as const)('warns after a misfitting %s pick with Undo advice and no resizing action', type => {
    const f = fixture(type);
    picked = { ...picked, overrideMass: 0.0521, overrideSubcomponentsMass: false };
    f.render(); applyPick(); f.render();
    const note = host.querySelector('.message-caution[role="status"]');
    expect(note?.textContent).toContain("BalsaMachining CR5060-W's catalogue outside diameter (40.46 mm [1.593 in])");
    expect(note?.textContent).toContain('smaller than the bore of BT-80 (64.9 mm [2.555 in])');
    expect(note?.textContent).toContain('The flight and print/cut exports use the catalogue dimensions just applied.');
    expect(note?.textContent).toMatch(/Undo the pick \(Ctrl\+Z\), or pick a part sized for this tube\.$/);
    expect(note?.querySelector('button')).toBeNull();
    expect(buttonNamed('Use automatic diameters')).toBeUndefined();
    expect(f.ring['outerRadius']).toBeCloseTo(0.02023, 12);
    expect(f.ring['overrideMass']).toBe(0.0521);
    expect(f.ring['presetPartNo']).toBe('CR5060-W');
    expect(patches).toHaveLength(1);
    expect(buttonNamed('Detach')).toBeDefined();
  });
  it.each(['centeringring', 'bulkhead'] as const)('hides fit advice when Undo restores the pre-pick %s under the same id', type => {
    const f = fixture(type);
    const before = { ...f.ring };
    f.render(); applyPick(); f.render();
    expect(host.querySelector('.message-caution')).not.toBeNull();
    f.setRing(before); f.render();
    expect(host.querySelector('.message-caution')).toBeNull();
  });
  it.each(['outerRadius', 'innerRadius', 'presetPartNo'] as const)('hides fit advice after a later edit of %s', key => {
    const f = fixture(); f.render(); applyPick(); f.render();
    expect(host.querySelector('.message-caution')).not.toBeNull();
    f.setRing({ [key]: key === 'presetPartNo' ? 'Other' : 0.015 }); f.render();
    expect(host.querySelector('.message-caution')).toBeNull();
  });
  it.each(['inside', 'outside'] as const)('compares only the diameter written by an %s-only custom pick', dimension => {
    const f = fixture();
    f.setRing({ outerRadius: 0.03, innerRadius: 0.009 });
    f.body.children = [{ id: 'mount', type: 'innertube', name: 'Mount', length: 0.3, outerRadius: 0.013 }];
    picked = presetPatch('centeringring', { kind: 'CenteringRing', manufacturer: 'EX', partNo: 'One diameter',
      description: '', ...(dimension === 'inside' ? { insideDiameter: 0.02484 } : { outsideDiameter: 0.04046 }) });
    f.render(); applyPick(); f.render();
    const text = host.querySelector('.message-caution')?.textContent;
    expect(text).toContain('catalogue ' + dimension + ' diameter');
    expect(text).not.toContain('catalogue ' + (dimension === 'inside' ? 'outside' : 'inside') + ' diameter');
    expect(f.ring[dimension === 'inside' ? 'outerRadius' : 'innerRadius']).toBe(dimension === 'inside' ? 0.03 : 0.009);
  });
  it('keeps an inside-only pick silent when only the retained outside diameter misfits', () => {
    const f = fixture(); f.setRing({ outerRadius: 0.03 });
    f.body.children = [{ id: 'mount', type: 'innertube', length: 0.3, outerRadius: 0.01 }];
    picked = presetPatch('centeringring', { kind: 'CenteringRing', manufacturer: 'EX', partNo: 'ID only',
      description: '', insideDiameter: 0.02484 });
    f.render(); applyPick(); f.render();
    expect(host.querySelector('.message-caution')).toBeNull();
  });
  it.each([[0.0649, 0.02], [0.0653, 0.0196], [0.062, 0.021]])('keeps a pick with OD %s m and ID %s m silent', (od, id) => {
    const f = fixture();
    f.body.children = [{ id: 'mount', type: 'innertube', length: 0.3, outerRadius: 0.01 }];
    picked = { ...picked, outerRadius: od / 2, innerRadius: id / 2 };
    f.render(); applyPick(); f.render();
    expect(host.querySelector('.message-caution')).toBeNull();
  });
  it.each([false, true])('names a too-large inner tube after the pick, motorMount=%s', motorMount => {
    const f = fixture();
    f.body.children = [{ id: 'mount', type: 'innertube', name: 'Payload tube', length: 0.3, outerRadius: 0.013, motorMount }];
    picked = { ...picked, outerRadius: 0.03245 };
    f.render(); applyPick(); f.render();
    const text = host.querySelector('.message-caution')?.textContent;
    expect(text).toContain('catalogue inside diameter (24.84 mm [0.978 in]) is smaller');
    expect(text).toContain('tube it fits around (Payload tube) (26 mm [1.024 in])');
    expect(text?.includes('motor-mount')).toBe(motorMount);
  });
  it.each(['sibling coupler', 'sibling inner tube', 'beyond parent', 'before parent', 'transition', 'nosecone', 'cluster', 'off-axis', 'overlapping tubes'] as const)(
    'keeps an uncertain pick silent: %s', layout => {
      const f = fixture();
      if (layout.startsWith('sibling')) f.body.children = [{ id: 'sleeve', type: layout === 'sibling coupler' ? 'tubecoupler' : 'innertube', length: 0.3, outerRadius: 0.03 }];
      if (layout === 'beyond parent' || layout === 'before parent') f.setRing({ position: { method: 'top', offset: layout === 'beyond parent' ? 0.3 : -0.01 } });
      if (layout === 'transition' || layout === 'nosecone') f.body.type = layout;
      if (['cluster', 'off-axis', 'overlapping tubes'].includes(layout)) {
        const mount: ComponentNode = { id: 'mount', type: 'innertube', length: 0.3, outerRadius: 0.01,
          ...(layout === 'cluster' ? { cluster: '3-row' } : {}), ...(layout === 'off-axis' ? { radialPosition: 0.01 } : {}) };
        f.body.children = [mount, ...(layout === 'overlapping tubes' ? [{ ...mount, id: 'mount2' }] : [])];
      }
      f.render(); applyPick(); f.render();
      expect(host.querySelector('.message-caution')).toBeNull();
    });
  it('clears pick advice on selection, reselection and remount', () => {
    const f = fixture(); f.render(); applyPick(); f.render();
    expect(host.querySelector('.message-caution')).not.toBeNull();
    act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={coupler} onPatch={() => {}} /></PrefsProvider>));
    f.render(); expect(host.querySelector('.message-caution')).toBeNull();
    act(() => root.unmount()); root = createRoot(host); f.render();
    expect(host.querySelector('.message-caution')).toBeNull();
  });
  it('does not call retained dimensions catalogue dimensions when a bad row writes none', () => {
    const f = fixture();
    f.setRing({ outerRadius: 0.02 });
    picked = presetPatch('centeringring', { kind: 'CenteringRing', manufacturer: 'EX', partNo: 'Bad',
      description: '', outsideDiameter: 0.02, insideDiameter: 0.03 });
    f.render(); applyPick(); f.render();
    expect(host.textContent).not.toContain('catalogue outside diameter');
  });
  it('stores the repaired wall, not the negative one, and says so under the preset button', () => {
    act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={tree} node={coupler} onPatch={(p) => { patches.push(p); }} />
      </PrefsProvider>,
    ));
    click(buttonNamed('Choose from preset database'));
    click(buttonNamed('apply HTC-11'));
    act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={{ ...coupler, ...patches[0] }}
      onPatch={p => { patches.push(p); }} /></PrefsProvider>));
    expect(patches).toHaveLength(1);
    // The panel's typed commit and a reload both clamp a wall to 0; the pick
    // stored -10.668 mm, which only a restored session repaired — silently.
    expect(patches[0]!['thickness']).toBe(0);
    expect(patches[0]!['outerRadius']).toBe(0.0143256);
    expect(host.querySelector('.message-caution[role="status"]')).not.toBeNull();
    expect(host.querySelector('.message-caution[role="status"]')?.textContent).toContain('catalogue bore was left automatic');
    expect(host.textContent).toContain(
      '“SEMROC HTC-11”: wall thickness -10.668 mm (-0.42 in) cannot be negative — set to 0 mm (0 in).');
  });

  it('does not carry the note to the next part selected', () => {
    const other = { id: 'c2', type: 'tubecoupler', name: 'Other', length: 0.05, thickness: 0.0005 } as ComponentNode;
    const render = (node: ComponentNode) => act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={tree} node={node} onPatch={(p) => { patches.push(p); }} />
      </PrefsProvider>,
    ));
    render(coupler);
    click(buttonNamed('Choose from preset database'));
    click(buttonNamed('apply HTC-11'));
    render({ ...coupler, ...patches[0] });
    expect(host.textContent).toContain('cannot be negative');
    render(other);
    expect(host.textContent).not.toContain('cannot be negative');
  });
});
