// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { buildPieces } from './Rocket3D.js';

const centerY = (geo: THREE.BufferGeometry): number => {
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  return c.y;
};

const base = (extra: ComponentNode[] = []): RocketTree => ({
  name: 't',
  components: [{
    type: 'stage', id: 's', name: 'Sustainer',
    children: [
      { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.024, shape: 'ogive' } as ComponentNode,
      {
        type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024,
        children: extra,
      } as ComponentNode,
    ],
  } as ComponentNode],
});

// issue 2026-08-11a: shapes drew as fixed ogive/cone regardless of selection.
describe('buildPieces — nose/transition shapes drive the geometry', () => {
  const verts = (tree: RocketTree, keyPrefix: string): Float32Array => {
    const { pieces } = buildPieces(tree);
    const p = pieces.find((pc) => pc.key.startsWith(keyPrefix))!;
    return p.geometry.getAttribute('position').array as Float32Array;
  };
  const maxDiff = (a: Float32Array, b: Float32Array): number => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
    return d;
  };
  const noseTree = (shape: string, param?: number): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage', id: 's',
      children: [
        { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.024, shape,
          ...(param !== undefined ? { shapeParameter: param } : {}) } as ComponentNode,
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024 } as ComponentNode,
      ],
    } as ComponentNode],
  });
  const transTree = (shape: string): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage', id: 's',
      children: [
        { type: 'bodytube', id: 'b1', length: 0.2, outerRadius: 0.012 } as ComponentNode,
        { type: 'transition', id: 'tr', length: 0.05, foreRadius: 0.012, aftRadius: 0.024, shape } as ComponentNode,
        { type: 'bodytube', id: 'b2', length: 0.2, outerRadius: 0.024 } as ComponentNode,
      ],
    } as ComponentNode],
  });

  it('nose cone: conical differs from ogive', () => {
    expect(maxDiff(verts(noseTree('ogive'), 'nose'), verts(noseTree('conical'), 'nose')))
      .toBeGreaterThan(0.001);
  });

  it('nose cone: shapeParameter changes a power-series profile', () => {
    expect(maxDiff(verts(noseTree('power', 0.25), 'nose'), verts(noseTree('power', 0.75), 'nose')))
      .toBeGreaterThan(0.001);
  });

  it('transition: ogive differs from conical (was always a straight cone)', () => {
    expect(maxDiff(verts(transTree('conical'), 'trans'), verts(transTree('ogive'), 'trans')))
      .toBeGreaterThan(0.0005);
  });

  it('transition lathe spans its fore/aft radii and axial slot', () => {
    const { pieces } = buildPieces(transTree('ogive'));
    const tr = pieces.find((p) => p.key.startsWith('trans'))!;
    tr.geometry.computeBoundingBox();
    const bb = tr.geometry.boundingBox!;
    // Lathe local frame before rotation: axis +Y (0..len), radius in XZ.
    expect(bb.min.y).toBeCloseTo(0, 6);
    expect(bb.max.y).toBeCloseTo(0.05, 6);
    expect(bb.max.x).toBeCloseTo(0.024, 3);
    expect(tr.position![0]).toBeCloseTo(0.2, 9); // fore end at the joint
  });
});

describe('buildPieces — off-axis pods (Phase 2)', () => {
  it('renders the core rocket unchanged when there are no pods', () => {
    const { pieces } = buildPieces(base());
    // nose + body, both on the centerline.
    expect(pieces.length).toBe(2);
    expect(pieces.every((p) => p.position && p.position[1] === 0)).toBe(true);
  });

  it('adds one off-axis chain per booster instance, ringed around the body', () => {
    const withBooster = base([{
      type: 'parallelstage', id: 'ps', instanceCount: 2, radiusOffset: 0,
      radiusMethod: 'relative', angleOffset: 0,
      position: { method: 'bottom', offset: 0 },
      children: [{ type: 'bodytube', id: 'bb', length: 0.2, outerRadius: 0.012 } as ComponentNode],
    } as ComponentNode]);
    const { pieces, maxR } = buildPieces(withBooster);

    // 2 core (nose+body) + 2 booster bodies (one per instance).
    expect(pieces.length).toBe(4);
    // Booster pieces are baked (no position field — geometry is in world space).
    const boosters = pieces.filter((p) => !p.position);
    expect(boosters.length).toBe(2);

    // RELATIVE radius: offset(0) + parentR(0.024) + podBoundingR(0.012) = 0.036.
    // The two instances (angle 0 and π) sit at +0.036 and -0.036 on the Y axis.
    const ys = boosters.map((p) => centerY(p.geometry)).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-0.036, 4);
    expect(ys[1]).toBeCloseTo(0.036, 4);
    // Camera framing radius grows to include the off-axis booster.
    expect(maxR).toBeGreaterThanOrEqual(0.036);
  });

  it('draws fins on a booster (recurses the pod chain)', () => {
    const withFinnedBooster = base([{
      type: 'parallelstage', id: 'ps', instanceCount: 1, radiusOffset: 0.01,
      radiusMethod: 'relative', angleOffset: 0,
      position: { method: 'bottom', offset: 0 },
      children: [{
        type: 'bodytube', id: 'bb', length: 0.2, outerRadius: 0.012,
        children: [{
          type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.04, tipChord: 0.02,
          sweep: 0.02, height: 0.03, position: { method: 'bottom', offset: 0 },
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode]);
    const { pieces } = buildPieces(withFinnedBooster);
    // nose + body + 1 booster body + 3 booster fins.
    expect(pieces.filter((p) => p.key.startsWith('fin')).length).toBe(3);
  });
});
