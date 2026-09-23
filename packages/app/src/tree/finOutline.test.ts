import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finOutlineIntersection, finOutlineProblem, kernelFinPoints } from './finOutline.js';
import { engineTree } from './treeModel.js';

/**
 * The contract this file pins is not "some outlines are rejected" — it is that
 * this module rejects EXACTLY what the kernel's FreeformFinSet.intersects()
 * rejects. Stricter and Eric's freeform designs stop being editable; looser and
 * the kernel's refusal (buildTree throws — `Fin set "<name>": its outline
 * crosses or touches itself…` since 2026-09-22, `Unknown format conversion: g`
 * before — and the design loses mass/CG/CP/stability/exports/Launch) gets
 * through again.
 *
 * The last describe block therefore runs the same outlines through the real
 * kernel and asserts the two agree.
 */

/** The editor's own starting outline: a 4-point clipped-delta fin. */
const GOOD: [number, number][] = [[0, 0], [0.020, 0.030], [0.045, 0.030], [0.060, 0]];

describe('finOutlineProblem — degenerate outlines', () => {
  it('accepts the editor default and a plain triangle', () => {
    expect(finOutlineProblem(GOOD)).toBeNull();
    expect(finOutlineProblem([[0, 0], [0.02, 0.03], [0.05, 0]])).toBeNull();
  });

  it('rejects fewer than 3 points', () => {
    expect(finOutlineProblem([[0, 0], [0.05, 0]])).toMatch(/at least 3 points/);
    expect(finOutlineProblem([])).toMatch(/at least 3 points/);
    expect(finOutlineProblem(undefined)).toMatch(/at least 3 points/);
  });

  it('rejects a non-finite coordinate', () => {
    expect(finOutlineProblem([[0, 0], [NaN, 0.03], [0.05, 0]])).toMatch(/Point 2/);
    expect(finOutlineProblem([[0, 0], [0.02, Infinity], [0.05, 0]])).toMatch(/Point 2/);
  });

  it('rejects two consecutive points in the same place', () => {
    // The zero-tip-chord case both importers already collapse by hand.
    const dup: [number, number][] = [[0, 0], [0.02, 0.03], [0.02, 0.03], [0.05, 0]];
    expect(finOutlineProblem(dup)).toMatch(/Points 2 and 3 are in the same place/);
  });

  it('still accepts points 0.1 mm apart — the table can type that', () => {
    // The display unit is rounded to 4 decimals; in millimetres that is 1e-7 m,
    // a hundred times the 1e-9 m "same point" window.
    expect(finOutlineProblem([[0, 0], [0.02, 0.03], [0.0200001, 0.03], [0.05, 0]])).toBeNull();
  });

  it('rejects a trailing corner at or forward of the leading one', () => {
    // The kernel's fin length is points[last].x - points[0].x, so this is a fin
    // of zero (or negative) root chord, not merely an odd-looking one.
    expect(finOutlineProblem([[0, 0], [0.02, 0.03], [0, 0]])).toMatch(/no root chord/);
    expect(finOutlineProblem([[0, 0], [0.02, 0.03], [-0.01, 0]])).toMatch(/no root chord/);
  });

  it('allows a point forward of the leading root corner', () => {
    // Negative interior x is a forward-swept tip. The kernel accepts it
    // (clampInteriorPoint only clamps y), so the editor must not refuse it.
    expect(finOutlineProblem([[0, 0], [-0.010, 0.030], [0.040, 0.030], [0.060, 0]])).toBeNull();
  });
});

describe('finOutlineProblem — self-intersection', () => {
  it('flags the audit case: point 3 dragged back across edge 1-2', () => {
    const crossed: [number, number][] = [[0, 0], [0.020, 0.030], [0.005, 0.020], [0.060, 0]];
    const hit = finOutlineIntersection(crossed);
    // Edge 0 (P1->P2) against edge 2 (P3->P4) — the only pair 2 apart.
    expect(hit).toEqual({ target: 0, comparison: 2 });
    expect(finOutlineProblem(crossed)).toMatch(/crosses itself — edge 1–2 meets edge 3–4/);
  });

  it('never compares adjacent edges, so a 3-point fin is always simple', () => {
    // Segments 0 and 1 share P2; the kernel skips index pairs less than 2
    // apart, and so must this. A sharp spike is a legal fin, not a crossing.
    expect(finOutlineIntersection([[0, 0], [0.001, 0.20], [0.002, 0]])).toBeNull();
  });

  it('counts a mere touch as a crossing, the way Line2D does', () => {
    // P4 sits exactly ON edge 1-2. Java's relativeCCW returns 0 for a colinear
    // point inside the segment, so linesIntersect is true — a sign-of-cross-
    // product shortcut would return false here and let the crash through.
    const touching: [number, number][] = [[0, 0], [0.020, 0.040], [0.030, 0.030], [0.010, 0.020], [0.050, 0]];
    expect(finOutlineIntersection(touching)).not.toBeNull();
  });

  it('accepts a 32-point sampled ellipse (the RockSim shape-code-1 import)', () => {
    const pts: [number, number][] = [[0, 0]];
    const root = 0.06;
    const height = 0.04;
    for (let i = 1; i <= 16; i++) {
      const t = (i / 16) * (Math.PI / 2);
      pts.push([root / 2 - (root / 2) * Math.cos(t), height * Math.sin(t)]);
    }
    for (let i = 15; i >= 1; i--) {
      const t = (i / 16) * (Math.PI / 2);
      pts.push([root / 2 + (root / 2) * Math.cos(t), height * Math.sin(t)]);
    }
    pts.push([root, 0]);
    expect(finOutlineProblem(pts)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The outline the kernel tests: translated, then snapped to 2.5 m
// ---------------------------------------------------------------------------

/**
 * Audit 2026-09-22: the validator checked the drawn points while the kernel
 * snaps x/y past 2.5 m to 2.5 BEFORE its intersection test, so an outline
 * could validate clean and still crash the build with the %g error. These
 * three outlines are the ones the kernel-agreement block below also builds.
 */
const SNAP_CROSSES: [number, number][] = [[0, 0], [2.6, 1], [2.7, 2], [3, 0]];
const SNAP_MERGES: [number, number][] = [[0, 0], [2.6, 1], [2.7, 1], [3, 0]];
const SNAP_SAFE: [number, number][] = [[0, 0], [1, 2.6], [2, 2.7], [2.2, 0]];

describe('kernelFinPoints — FreeformFinSet.setPoints, transcribed', () => {
  it('snaps x and y past 2.5 m to 2.5 m and leaves the rest alone', () => {
    expect(kernelFinPoints(SNAP_CROSSES)).toEqual([[0, 0], [2.5, 1], [2.5, 2], [2.5, 0]]);
    expect(kernelFinPoints(GOOD)).toEqual(GOOD);
  });

  it('keeps x on a point past 2.5 m on BOTH axes — the kernel builds the y snap from the original', () => {
    expect(kernelFinPoints([[0, 0], [3, 4], [3.5, 0]])).toEqual([[0, 0], [3, 2.5], [2.5, 0]]);
  });

  it('measures from the first point, as the kernel translates it to the origin first', () => {
    expect(kernelFinPoints([[1, 1], [3.7, 2], [4, 1]])).toEqual([[0, 0], [2.5, 1], [2.5, 0]]);
    // Within the kernel's 1e-12 squared-distance window it does NOT translate.
    expect(kernelFinPoints([[1e-7, 0], [3, 1], [4, 0]])).toEqual([[1e-7, 0], [2.5, 1], [2.5, 0]]);
  });
});

describe('finOutlineProblem — on the outline the kernel tests', () => {
  it('refuses an outline that only crosses itself once snapped', () => {
    expect(finOutlineIntersection(SNAP_CROSSES)).toBeNull(); // clean as drawn
    expect(finOutlineProblem(SNAP_CROSSES)).toMatch(/crosses itself once the simulator pulls every point/);
    expect(finOutlineProblem(SNAP_CROSSES)).toMatch(/edge 1–2 meets edge 3–4/);
  });

  it('refuses two points the snap puts in one place', () => {
    expect(finOutlineProblem(SNAP_MERGES)).toMatch(/Points 2 and 3 land in the same place/);
  });

  it('still accepts a snapped outline that stays simple', () => {
    expect(finOutlineProblem(SNAP_SAFE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Kernel agreement
// ---------------------------------------------------------------------------

const treeWithPoints = (points: [number, number][]): RocketTree => ({
  name: 'fin outline probe',
  components: [{
    type: 'stage', id: 's1',
    children: [
      { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.019, thickness: 0.001 } as ComponentNode,
      {
        type: 'bodytube', id: 'bt', length: 0.4, outerRadius: 0.019, thickness: 0.001,
        children: [{
          type: 'freeformfinset', id: 'fins', finCount: 3, thickness: 0.003,
          points, position: { method: 'bottom', offset: 0 },
        } as ComponentNode],
      } as ComponentNode,
    ],
  } as ComponentNode],
});

describe('finOutlineProblem agrees with the kernel', () => {
  it('accepts what buildTree accepts and rejects what buildTree dies on', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');

    resetEngine();
    expect(finOutlineProblem(GOOD)).toBeNull();
    const ok = OrkRocket.buildTree(engineTree(treeWithPoints(GOOD))).staticInfo();
    expect(Number.isFinite(ok.mass)).toBe(true);
    expect(ok.mass).toBeGreaterThan(0);

    // The two outlines the guard exists for. Both throw out of buildTree (the
    // kernel refuses them and the bridge says so by name), which is why the
    // editor must never commit them.
    for (const bad of [
      [[0, 0], [0.020, 0.030], [0.005, 0.020], [0.060, 0]] as [number, number][],
      [[0, 0], [0.020, 0.030], [0.020, 0.030], [0.060, 0]] as [number, number][],
      // Clean as drawn, crossing or merging once the kernel snaps to 2.5 m.
      SNAP_CROSSES,
      SNAP_MERGES,
    ]) {
      expect(finOutlineProblem(bad)).not.toBeNull();
      resetEngine();
      expect(() => OrkRocket.buildTree(engineTree(treeWithPoints(bad)))).toThrow();
    }

    // And the snapped outline that stays simple builds, so it must validate.
    expect(finOutlineProblem(SNAP_SAFE)).toBeNull();
    resetEngine();
    expect(OrkRocket.buildTree(engineTree(treeWithPoints(SNAP_SAFE))).staticInfo().mass).toBeGreaterThan(0);
  }, 120000);
});
