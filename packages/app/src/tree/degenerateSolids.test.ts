import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import {
  componentLoop, componentSolid, isWatertight, revolveProfile, solidVolume,
} from './solidMesh.js';
import { buildPieces } from './pieces.js';
import { cloneSubtree } from './treeModel.js';

const ctx = { bodyRadius: 0.027, parentInnerRadius: 0.025 };
const nose = (over: Record<string, unknown> = {}): ComponentNode =>
  ({ type: 'nosecone', id: 'n', length: 0.2, aftRadius: 0.027, thickness: 0.002,
    shape: 'ogive', ...over }) as ComponentNode;

/**
 * `isWatertight` is topology and finiteness only — by design, and its docstring
 * says so. That leaves a whole family of meshes it waves through: a revolved
 * profile that closes on itself is perfectly manifold and encloses NOTHING.
 * These are the ones the 2026-09-08 audit measured, at the layer that offered
 * them for download.
 */
describe('a printable solid must actually be a solid', () => {
  it('refuses a zero-wall shell that isWatertight() calls sound', async () => {
    // Measured before the fix: 24,384 triangles, volume -3.6180e-20 m^3,
    // isWatertight() === true, componentSolid returned it, and the button
    // beside the field downloaded it. `thickness` has smin: 0 and the panel
    // clamps only its maximum, so one drag to the left stop reaches this.
    const loop = componentLoop(nose({ thickness: 0 }), ctx);
    expect(loop, 'the loop is still built — the guard is downstream').not.toBeNull();
    const raw = revolveProfile(loop!.loop);
    expect(isWatertight(raw), 'this is exactly why isWatertight is not enough').toBe(true);
    expect(Math.abs(solidVolume(raw))).toBeLessThan(1e-9);

    expect(await componentSolid(nose({ thickness: 0 }), ctx)).toBeNull();
  });

  it('still returns a real shell at a real wall thickness', async () => {
    const got = await componentSolid(nose(), ctx);
    expect(got).not.toBeNull();
    expect(solidVolume(got!.mesh)).toBeCloseTo(4.2887e-5, 7);
  });

  it('refuses a negative wall rather than reporting an inflated volume', async () => {
    // The dangerous one, and it takes BOTH fixes. A negative thickness put the
    // bore OUTSIDE the skin, so the profile self-intersected and produced a
    // WATERTIGHT mesh with a plausible-looking wrong volume: 7.3703e-5 against
    // the correct 4.2887e-5, +72 %, on a part someone was about to print.
    //
    //   the CLAMP stops the inflated number being computed at all;
    //   the VOLUME GUARD then declines what the clamp leaves, which is the same
    //   zero-volume shell a thickness of 0 gives.
    //
    // Declining is the same answer an unprintable component type already gets.
    // What must never happen again is a FILE containing that 7.37e-5 solid.
    expect(await componentSolid(nose({ thickness: -0.003 }), ctx)).toBeNull();
    expect(await componentSolid(nose({ thickness: -1 }), ctx)).toBeNull();
  });

  it('never returns the self-intersected volume a negative shoulder wall used to give', async () => {
    const got = await componentSolid(
      nose({ aftShoulderLength: 0.02, aftShoulderRadius: 0.024, aftShoulderThickness: -0.005 }), ctx);
    // Either it declines, or it returns a real positive watertight volume. What
    // it must NOT do is hand back the 8.3543e-6 m^3 self-intersected solid.
    if (got) {
      expect(solidVolume(got.mesh)).toBeGreaterThan(0);
      expect(isWatertight(got.mesh)).toBe(true);
      expect(Math.abs(solidVolume(got.mesh) - 8.3543e-6)).toBeGreaterThan(1e-7);
    }
  });
});

/**
 * The display/STL path, which validated far less than the print path did — the
 * same asymmetry as the `points` reader.
 */
describe('buildPieces refuses degenerate fin sets instead of drawing them', () => {
  const withFins = (fin: Record<string, unknown>): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage', id: 's',
      children: [{
        type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024,
        children: [{ type: 'trapezoidfinset', id: 'f', finCount: 3, thickness: 0.003,
          rootChord: 0.06, tipChord: 0.03, height: 0.04, sweep: 0.02, ...fin } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  const zeroAreaFacets = (tree: RocketTree): number => {
    let n = 0;
    for (const p of buildPieces(tree).pieces) {
      const pos = p.geometry.attributes['position']!.array;
      const idx = p.geometry.index;
      const tri = idx ? idx.array : null;
      const count = tri ? tri.length / 3 : pos.length / 9;
      for (let i = 0; i < count; i++) {
        const [a, b, c] = tri ? [tri[i * 3]!, tri[i * 3 + 1]!, tri[i * 3 + 2]!] : [i * 3, i * 3 + 1, i * 3 + 2];
        const ax = pos[a * 3]!, ay = pos[a * 3 + 1]!, az = pos[a * 3 + 2]!;
        const bx = pos[b * 3]!, by = pos[b * 3 + 1]!, bz = pos[b * 3 + 2]!;
        const cx = pos[c * 3]!, cy = pos[c * 3 + 1]!, cz = pos[c * 3 + 2]!;
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (Math.hypot(nx, ny, nz) / 2 < 1e-12) n++;
      }
    }
    return n;
  };

  it('draws a healthy fin set', () => {
    expect(buildPieces(withFins({})).pieces.length).toBeGreaterThan(1);
    expect(zeroAreaFacets(withFins({}))).toBe(0);
  });

  it('skips a zero-thickness set rather than extruding coincident caps', () => {
    // Measured: 228 triangles of which 24 had exactly zero area, and the
    // whole-rocket STL still wrote 11,484 bytes. solidMesh.extrudePolygon
    // refuses this outright; this path did not.
    const pieces = buildPieces(withFins({ thickness: 0 })).pieces;
    expect(pieces.some((p) => p.key.startsWith('fin'))).toBe(false);
    expect(zeroAreaFacets(withFins({ thickness: 0 }))).toBe(0);
  });

  it('skips a self-intersecting freeform planform', () => {
    // The exact fixture solidMesh.test.ts uses to prove ITS refusal. three's
    // earcut silently deletes vertices it cannot triangulate, so the caps came
    // out holed while the side walls stayed complete — 222 triangles against a
    // sound 228, which is why nothing noticed.
    const tree = withFins({});
    const tube = tree.components[0]!.children![0]!;
    tube.children = [{
      type: 'freeformfinset', id: 'ff', finCount: 3, thickness: 0.003,
      points: [[0, 0], [0.05, 0.03], [0, 0.03], [0.05, 0]],
    } as unknown as ComponentNode];
    expect(buildPieces(tree).pieces.some((p) => p.key.startsWith('fin'))).toBe(false);
  });
});

describe('cloneSubtree is the deep copy its name claims', () => {
  it('does not alias the points array, or its rows, with the original', () => {
    const src = {
      type: 'freeformfinset', id: 'f',
      points: [[0, 0], [0.05, 0.03], [0.05, 0]],
      position: { method: 'bottom', offset: -0.01 },
    } as unknown as ComponentNode;
    const copy = cloneSubtree(src);
    expect(copy['points']).not.toBe(src['points']);
    expect((copy['points'] as unknown[])[0]).not.toBe((src['points'] as unknown[])[0]);
    expect(copy.position).not.toBe(src.position);
    // Same VALUES, different objects — that is the whole point.
    expect(copy['points']).toEqual(src['points']);
    expect(copy.position).toEqual(src.position);
    expect(copy.id).not.toBe(src.id);
  });

  it('mutating the copy in place cannot reach the original', () => {
    // The failure this prevents: duplicate a freeform fin, drag a point on the
    // copy, and watch the original change too.
    const src = { type: 'freeformfinset', id: 'f', points: [[0, 0], [1, 1]] } as unknown as ComponentNode;
    const copy = cloneSubtree(src);
    (copy['points'] as number[][])[0]![0] = 99;
    expect((src['points'] as number[][])[0]![0]).toBe(0);
  });

  it('deep-copies through children too', () => {
    const src = {
      type: 'bodytube', id: 'b',
      children: [{ type: 'freeformfinset', id: 'f', points: [[0, 0], [1, 1]] } as unknown as ComponentNode],
    } as ComponentNode;
    const copy = cloneSubtree(src);
    expect(copy.children![0]!['points']).not.toBe(src.children![0]!['points']);
  });
});
