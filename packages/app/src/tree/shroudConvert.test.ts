import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { convertShrouds, findShroudCandidates, shroudToFairing } from './shroudConvert.js';
import { findNode } from './treeModel.js';

const PTS: [number, number][] = [[0, 0], [0, 0.02], [0.08, 0.02], [0.08, 0]];

const freeform = (params: Record<string, unknown>): ComponentNode => ({
  type: 'freeformfinset', finCount: 1, thickness: 0.025, points: PTS,
  position: { method: 'middle', offset: 0 }, ...params,
} as ComponentNode);

const wrap = (children: ComponentNode[]): RocketTree => ({
  name: 's',
  components: [{
    type: 'stage', id: 's1',
    children: [{
      type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.02, children,
    } as ComponentNode],
  } as ComponentNode],
});

describe('camera-shroud import detection (issue 2026-08-05e)', () => {
  it('finds 1-fin freeform sets named like a shroud', () => {
    const t = wrap([freeform({ id: 'c1', name: 'Camera Shroud' })]);
    expect(findShroudCandidates(t)).toEqual([{ id: 'c1', name: 'Camera Shroud' }]);
  });

  it('ignores multi-fin sets and unrelated names', () => {
    expect(findShroudCandidates(wrap([
      freeform({ id: 'c1', name: 'Camera Shroud', finCount: 3 }),
      freeform({ id: 'c2', name: 'Strake' }),
    ]))).toEqual([]);
  });
});

describe('shroud → fairing conversion', () => {
  it('derives dimensions from the outline and keeps the override mass', () => {
    const f = shroudToFairing(freeform({ id: 'c1', name: 'Camera Shroud', overrideMass: 0.05 }));
    expect(f.type).toBe('fairing');
    expect(f.id).toBe('c1');
    expect(f['length']).toBeCloseTo(0.08, 9);
    expect(f['height']).toBeCloseTo(0.02, 9);
    expect(f['width']).toBeCloseTo(0.025, 9);
    expect(f['mass']).toBeCloseTo(0.05, 9);
    expect(f['fairingShape']).toBe('halfround');
    expect(f.position).toEqual({ method: 'middle', offset: 0 });
  });

  it('estimates mass from outline area × thickness × density when no override', () => {
    const f = shroudToFairing(freeform({ id: 'c1', name: 'shroud', density: 1000 }));
    // 0.08 × 0.02 rectangle = 1.6e-3 m² × 0.025 m × 1000 kg/m³ = 0.04 kg
    expect(f['mass']).toBeCloseTo(0.04, 9);
  });

  it('replaces the node in the tree, same id, and reports it', () => {
    const t = wrap([freeform({ id: 'c1', name: 'Camera Shroud', overrideMass: 0.05 })]);
    const res = convertShrouds(t, ['c1']);
    const node = findNode(res.tree, 'c1')!;
    expect(node.type).toBe('fairing');
    expect(node.name).toBe('Camera Shroud');
    expect(res.notes.length).toBe(1);
    expect(res.notes[0]).toMatch(/Converted .* native camera shroud/);
    // Source tree untouched.
    expect(findNode(t, 'c1')!.type).toBe('freeformfinset');
  });
});
