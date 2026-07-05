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
