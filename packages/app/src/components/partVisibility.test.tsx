// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { ComponentTree } from './ComponentTree.js';
import { TreeSchematic } from './TreeSchematic.js';
import { AftView } from './AftView.js';
import { buildPieces } from '../tree/pieces.js';
import { layoutSchematic } from '../tree/schematicLayout.js';
import { exportOrk } from '../services/orkFile.js';
import { engineTree } from '../tree/treeModel.js';
import { togglePartVisibility } from '../tree/partVisibility.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree = {
  name: 'Visibility test', components: [{ id: 'stage', type: 'stage', name: 'Sustainer', children: [
    { id: 'nose', type: 'nosecone', name: 'Nose', length: 0.1, aftRadius: 0.012,
      shoulderLength: 0.02, shoulderRadius: 0.01 },
    { id: 'body', type: 'bodytube', name: 'Airframe', length: 0.3, outerRadius: 0.012, children: [
      { id: 'fins', type: 'freeformfinset', name: 'Freeform fins', finCount: 3, crossSection: 'airfoil',
        points: [[0, 0], [0.02, 0.03], [0.04, 0.03], [0.06, 0]], thickness: 0.002 },
      { id: 'mount', type: 'innertube', name: 'Mount', length: 0.1, outerRadius: 0.008, motorMount: true,
        children: [{ id: 'ring', type: 'centeringring', name: 'Ring', length: 0.005, outerRadius: 0.007 }] },
      { id: 'pod', type: 'podset', name: 'Pods', instanceCount: 2, radiusOffset: 0.02, children: [
        { id: 'podbody', type: 'bodytube', name: 'Pod tube', length: 0.12, outerRadius: 0.006 },
      ] },
    ] },
    { id: 'tail', type: 'bodytube', name: 'Tail', length: 0.1, outerRadius: 0.01 },
  ] }],
} as unknown as RocketTree;
const motors = { mount: { length: 0.08, diameter: 0.013, label: 'C6-5' } };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('C-B20 view-only hiding', () => {
  it.each([0, 0.3])('omits a hidden subtree, motors, labels and hit targets from the 2D drawing at roll %s', roll => {
    act(() => root.render(<TreeSchematic tree={tree} info={null} motors={motors} roll={roll}
      hiddenIds={new Set(['body'])} selectedId="fins" onSelect={() => {}} />));
    const names = [...host.querySelectorAll('[aria-label^="Select "]')].map(e => e.getAttribute('aria-label'));
    expect(names).toEqual(['Select Nose', 'Select Tail']);
    expect(host.textContent).not.toContain('C6-5');
    expect(host.textContent).not.toContain('Freeform fins');
  });

  it('omits hidden stage descendants and their aft-view motor shapes', () => {
    act(() => root.render(<AftView tree={tree} motors={motors} hiddenIds={new Set(['stage'])} />));
    expect(host.querySelectorAll('svg circle, svg polygon, svg path')).toHaveLength(0);
  });

  it('hides an inner mount and its nested parts without hiding siblings in the aft view', () => {
    act(() => root.render(<AftView tree={tree} motors={motors} hiddenIds={new Set(['mount'])} />));
    const titles = [...host.querySelectorAll('svg title')].map(e => e.textContent);
    expect(titles).not.toContain('Mount');
    expect(titles).not.toContain('Ring');
    expect(titles).not.toContain('Motor');
    expect(titles).toContain('Freeform fins ×3');
  });

  it('keeps the visible tail at the same station when the preceding body is hidden', () => {
    const options = { scale: 1000, cy: 100, x0: 20, roll: 0, idPrefix: 'test' };
    const before = layoutSchematic(tree, options);
    const after = layoutSchematic(tree, { ...options, hiddenIds: new Set(['body']) });
    expect(after.shapes.filter(s => s.part?.id === 'tail')).toEqual(before.shapes.filter(s => s.part?.id === 'tail'));
    expect(after.extents.has('fins')).toBe(false);
    expect(after.grips.has('mount')).toBe(false);
  });

  it('removes hidden 3D meshes including pod instances, keeps tail placement, and leaves the design intact', () => {
    const json = JSON.stringify(tree);
    const engineBefore = engineTree(tree);
    // The writer mints UUIDs for this editor-ID fixture on every save.
    const withoutFreshIds = (xml: string) => xml.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');
    const orkBefore = withoutFreshIds(exportOrk({ tree, name: tree.name ?? 'Rocket' }));
    const full = buildPieces(tree, motors);
    const hidden = buildPieces(tree, motors, new Set(['body']));
    const empty = buildPieces(tree, motors, new Set(['stage']));
    try {
      expect(full.pieces.length).toBeGreaterThan(4);
      expect(hidden.pieces).toHaveLength(2);
      expect(empty.pieces).toHaveLength(0);
      expect(hidden.totalLen).toBe(full.totalLen);
      expect(hidden.pieces[1]!.position).toEqual(full.pieces.at(-1)!.position);
      expect(JSON.stringify(tree)).toBe(json);
      expect(engineTree(tree)).toEqual(engineBefore);
      expect(withoutFreshIds(exportOrk({ tree, name: tree.name ?? 'Rocket' }))).toBe(orkBefore);
    } finally {
      for (const p of [...full.pieces, ...hidden.pieces, ...empty.pieces]) p.geometry.dispose();
    }
  });

  it('removes hidden nose shoulders, child decoration and every pod instance while preserving other parts', () => {
    const options = { scale: 1000, cy: 100, x0: 20, roll: 0, idPrefix: 'test', motors };
    const before = layoutSchematic(tree, options);
    const after = layoutSchematic(tree, { ...options, hiddenIds: new Set(['nose', 'mount', 'pod']) });
    expect(before.shapes.some(s => s.key.includes('shoulder'))).toBe(true);
    expect(after.shapes.some(s => s.key.includes('shoulder') || s.part?.id === 'podbody')).toBe(false);
    expect(after.shapes.some(s => s.text === 'C6-5')).toBe(false);
    expect(after.shapes.filter(s => s.part?.id === 'body')).toEqual(before.shapes.filter(s => s.part?.id === 'body'));
    expect(after.shapes.filter(s => s.part?.id === 'fins')).toEqual(before.shapes.filter(s => s.part?.id === 'fins'));
  });

  it('removes child fin meshes, clustered mount motors and pod copies from 3D without hiding the airframe', () => {
    const full = buildPieces(tree, motors);
    const hidden = buildPieces(tree, motors, new Set(['fins', 'mount', 'pod']));
    try {
      expect(full.pieces).toHaveLength(10);
      expect(hidden.pieces).toHaveLength(3);
      expect(hidden.pieces.map(p => p.color)).toEqual([full.pieces[0]!.color, full.pieces[1]!.color, full.pieces.at(-1)!.color]);
    } finally {
      for (const p of [...full.pieces, ...hidden.pieces]) p.geometry.dispose();
    }
  });

  it('exposes an eye control on every row, retains hidden selection, and offers Show all with adjacent advice', () => {
    let selected: string | null = null;
    function Harness() {
      const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
      return <ComponentTree tree={tree} selectedId={selected} onSelect={id => { selected = id; }}
        hiddenIds={hiddenIds} onToggleVisibility={id => setHiddenIds(ids => togglePartVisibility(tree, ids, id))}
        onShowAll={() => setHiddenIds(new Set())} onMove={() => {}} onDelete={() => {}}
        onDuplicate={() => {}} onAdd={() => {}} onAddStage={() => {}} clipboard={null}
        onCopy={() => {}} onCut={() => {}} onPaste={() => {}} />;
    }
    act(() => root.render(<Harness />));
    const eye = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(host.querySelectorAll('.tree-visibility')).toHaveLength(9);
    expect(host.textContent).toContain('Hidden parts still count in mass, CG, aerodynamics and every flight number.');
    const hide = eye('Hide Airframe in views');
    hide.focus();
    act(() => hide.click());
    expect(document.activeElement).toBe(eye('Show Airframe in views'));
    expect(selected).toBeNull();
    expect(eye('Show Freeform fins in views').getAttribute('aria-pressed')).toBe('true');
    const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find(e => e.querySelector('.tree-label')?.textContent === 'Freeform fins')!;
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(selected).toBe('fins');
    act(() => eye('Show Freeform fins in views').click());
    expect(eye('Hide Freeform fins in views').getAttribute('aria-pressed')).toBe('false');
    act(() => eye('Hide Airframe in views').click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === 'Show all')!.click());
    expect(eye('Hide Airframe in views').getAttribute('aria-pressed')).toBe('false');
  });
});
