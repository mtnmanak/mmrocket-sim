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
    // v0.088: two ends, and a converted shroud gets the default pair. A
    // RockSim 1-fin "shroud" carries no end-shape information at all, so this
    // is a default, not a conversion.
    expect(f['fairingForeShape']).toBe('streamlined');
    expect(f['fairingAftShape']).toBe('halfround');
    expect(f['conformal']).toBe(true);
    expect(f.position).toEqual({ method: 'middle', offset: 0 });
  });

  it('estimates mass from outline area × thickness × density when no override', () => {
    const f = shroudToFairing(freeform({ id: 'c1', name: 'shroud', density: 1000 }));
    // 0.08 × 0.02 rectangle = 1.6e-3 m² × 0.025 m × 1000 kg/m³ = 0.04 kg
    expect(f['mass']).toBeCloseTo(0.04, 9);
  });

  /**
   * The clocking has to survive the conversion. A fin set stores its angle
   * about the body axis as `rotation` (rocksimFile.ts writes it from RockSim's
   * <RadialAngle> on the freeform branch, orkFile.ts from .ork <rotation>); a
   * fairing stores the same angle as `angleOffset` (schema.ts MOUNT_ANGLE).
   * Both are radians about the same zero, so dropping `rotation` relocated a
   * deliberately clocked shroud to 0° — which MOUNT_ANGLE's own note calls out
   * as exactly where an unrotated fin set puts fin 1, so the camera landed on
   * the fin line in all three views, mountAngle's rail and wake warnings
   * changed on a part nobody had moved, and the next save persisted the 0.
   */
  it('carries the fin set\'s rotation across as the fairing\'s angleOffset', () => {
    const sixty = (60 * Math.PI) / 180;
    const f = shroudToFairing(freeform({ id: 'c1', name: 'Camera Shroud', rotation: sixty }));
    expect(f['angleOffset']).toBeCloseTo(sixty, 12);
    // Through the tree walk too, since that is the path the import offer takes.
    const res = convertShrouds(wrap([freeform({ id: 'c1', name: 'shroud', rotation: -Math.PI / 2 })]), ['c1']);
    expect(findNode(res.tree, 'c1')!['angleOffset']).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('defaults the angle to 0 when the set was never clocked', () => {
    // Emitted unconditionally rather than left absent: every reader falls back
    // to num(n,'angleOffset',0), so 0 and absent behave the same, and an
    // unconditional key is the testable one.
    expect(shroudToFairing(freeform({ id: 'c1', name: 'shroud' }))['angleOffset']).toBe(0);
    // A non-numeric rotation (a malformed import) must not become NaN.
    expect(shroudToFairing(freeform({ id: 'c1', name: 'shroud', rotation: 'top' }))['angleOffset']).toBe(0);
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
