import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finOutlineProblem } from './finOutline.js';
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
    // A converted shroud gets the same default pair a new one is born with —
    // tapered fore, flat aft (Eric, 2026-09-18, from photographs of real
    // shrouds: the flat end is where the camera looks out). A .rkt 1-fin
    // "shroud" carries no end-shape information at all, so this is a default,
    // not a conversion, and it must not drift from defaultParams('fairing').
    expect(f['fairingForeShape']).toBe('streamlined');
    expect(f['fairingAftShape']).toBe('box');
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

  /**
   * An outline the shoelace cannot measure (audit 2026-09-22, from the 8
   * September record). A bow-tie — a planform dragged until two edges cross —
   * has a signed area of zero, so the shroud converted to a 0 kg fairing and
   * the rocket silently lost its camera's mass. The kernel refuses a crossed
   * fin outline anyway, so converting is how such a design gets back to
   * building; the mass then falls back to the box the outline spans.
   */
  it('never converts a crossed outline to a 0 kg fairing', () => {
    const bowTie: [number, number][] = [[0, 0], [0.08, 0.02], [0, 0.02], [0.08, 0]];
    const f = shroudToFairing(freeform({ id: 'c1', name: 'shroud', density: 1000, points: bowTie }));
    // 0.08 × 0.02 box × 0.025 m × 1000 kg/m³ = 0.04 kg: an upper bound, never 0.
    expect(f['mass']).toBeCloseTo(0.04, 9);
    expect(f['length']).toBeCloseTo(0.08, 9);
    expect(f['height']).toBeCloseTo(0.02, 9);
  });

  it('gives an outline drawn wholly below its root line its span as a height, never a negative one', () => {
    // Math.max over y gave -0.01 here: a negative-height fairing.
    const below: [number, number][] = [[0, -0.01], [0, -0.03], [0.08, -0.03], [0.08, -0.01]];
    const f = shroudToFairing(freeform({ id: 'c1', name: 'shroud', density: 1000, points: below }));
    expect(f['height']).toBeCloseTo(0.02, 9);
    expect(f['length']).toBeCloseTo(0.08, 9);
    expect(f['mass']).toBeCloseTo(0.08 * 0.02 * 0.025 * 1000, 9);
  });

  /**
   * THE OUTLINES THE KERNEL BUILDS DO NOT MOVE (review of the audit fix
   * above). Every one of these passes finOutlineProblem — the app's copy of
   * the kernel's check — and each is pinned at what it converted to before the
   * fix: the shoelace area, the outline's maximum x and y. A first version
   * tested the closing edge for crossings too, with the kernel's
   * touch-counts segment test, so a corner ON the root line read as a
   * crossing and the mass jumped to the box (+18 % to +100 %); it also
   * measured spans, which lengthened a forward-swept outline by its overhang.
   * thickness 0.025 m × density 1000 kg/m³ = 25 kg/m² of profile area.
   */
  it.each<[string, [number, number][], number, number, number]>([
    // a flat run along the root before the leading edge rises
    ['a flat leading run', [[0, 0], [0.005, 0], [0.02, 0.02], [0.08, 0.02], [0.08, 0]], 0.03375, 0.08, 0.02],
    // a flat run along the root behind the trailing edge
    ['a flat trailing run', [[0, 0], [0.02, 0.02], [0.07, 0.02], [0.075, 0], [0.08, 0]], 0.03125, 0.08, 0.02],
    // two humps meeting on the root line
    ['two humps', [[0, 0], [0.02, 0.02], [0.04, 0], [0.06, 0.02], [0.08, 0]], 0.02, 0.08, 0.02],
    // a leading edge swept forward of point 0
    ['a forward-swept leading edge', [[0, 0], [-0.01, 0.02], [0.06, 0.02], [0.08, 0]], 0.0375, 0.08, 0.02],
    // an interior corner dipped below the root line
    ['an interior dip', [[0, 0], [0.02, -0.005], [0.04, 0.02], [0.08, 0]], 0.0125, 0.08, 0.02],
    // a corner dipped through the root line between two humps
    ['a dip through the root line', [[0, 0], [0.02, 0.02], [0.04, -0.01], [0.06, 0.02], [0.08, 0]], 0.015, 0.08, 0.02],
    // point 0 off the origin (the kernel translates it there)
    ['an outline off the origin', [[0.01, 0.005], [0.03, 0.025], [0.09, 0.005]], 0.02, 0.09, 0.025],
  ])('converts %s exactly as it always has', (_, points, mass, length, height) => {
    expect(finOutlineProblem(points)).toBeNull();
    const f = shroudToFairing(freeform({ id: 'c1', name: 'shroud', density: 1000, points }));
    expect(f['mass']).toBeCloseTo(mass, 12);
    expect(f['length']).toBeCloseTo(length, 12);
    expect(f['height']).toBeCloseTo(height, 12);
  });

  it('measures the box for an outline whose own area is exactly zero, even one the kernel accepts', () => {
    // Two lobes either side of the root line, equal and opposite: the kernel's
    // check passes (no two listed edges cross), the shoelace reads 0, and
    // before the audit this converted to 0 kg like the bow-tie.
    const zigzag: [number, number][] = [[0, 0], [0.04, 0.02], [0.04, -0.02], [0.08, 0]];
    expect(finOutlineProblem(zigzag)).toBeNull();
    const f = shroudToFairing(freeform({ id: 'c1', name: 'shroud', density: 1000, points: zigzag }));
    expect(f['mass']).toBeCloseTo(0.08 * 0.02 * 25, 12);
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
