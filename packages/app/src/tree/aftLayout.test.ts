import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { aftLayout } from './aftLayout.js';

const finRocket = (extra: Record<string, unknown> = {}) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{
      id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
      children: [{
        id: 'f1', type: 'trapezoidfinset', finCount: 3,
        rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, ...extra,
      }],
    }],
  }],
} as unknown as RocketTree);

  it('keys every shape uniquely, pods and clusters included', () => {
    const tree = {
      name: 'Rocket',
      components: [{
        id: 's1', type: 'stage',
        children: [{
          id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.03, motorMount: true,
          children: [
            { id: 'f1', type: 'trapezoidfinset', finCount: 4, height: 0.03 },
            { id: 'mt', type: 'innertube', length: 0.1, outerRadius: 0.009, cluster: '3-ring' },
            {
              id: 'p1', type: 'podset', instanceCount: 3, radiusOffset: 0.05,
              children: [{
                id: 'pb', type: 'bodytube', length: 0.1, outerRadius: 0.01,
                children: [{ id: 'pf', type: 'trapezoidfinset', finCount: 3, height: 0.02 }],
              }],
            },
          ],
        }],
      }],
    } as unknown as RocketTree;
    const { hulls, inner, outer } = aftLayout(tree, 0.3, { mt: { length: 0.07, diameter: 0.018 } });
    const keys = [...hulls, ...inner, ...outer].map((s) => s.key);
    // 1 core hull + 3 pod hulls; 3 cluster tubes + 3 motors; 4 + 3x3 fins.
    expect(keys).toHaveLength(4 + 6 + 13);
    expect(new Set(keys).size).toBe(keys.length);
  });

/**
 * A fin end-on is a bar from where its root meets the body to its tip, on the
 * mount it flies on (audit 2026-09-30, on review). The 3D and side views root a
 * fin at its mount's radius AT ITS LEADING EDGE (FinSet.getFinFront), with the
 * root following the body; this view still rooted every fin at the LARGEST
 * radius of a transition. Desktop's back view (FinSetShapes.uncantedShapesBack)
 * runs the bar from that radius plus the fin's lowest point to the tip.
 */
describe('a fin is drawn end-on where it is mounted', () => {
  type Fin = { kind: 'fin'; from: number; to: number };
  const finsOf = (tree: RocketTree) => aftLayout(tree, 0).outer.filter((s) => s.kind === 'fin') as unknown as Fin[];
  /** 54 -> 38 mm conical boat tail, 80 mm long; a 40 mm fin, 60 mm root, starting 20 mm in. */
  const boatTail = (fin: Record<string, unknown>): RocketTree => ({
    name: 'Rocket',
    components: [{ id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', length: 0.1, aftRadius: 0.027 },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.027 },
      { id: 't1', type: 'transition', shape: 'conical', length: 0.08, foreRadius: 0.027, aftRadius: 0.019,
        children: [{ id: 'ff', finCount: 1, thickness: 0.003, position: { method: 'bottom', offset: 0 }, ...fin }] },
    ] }],
  } as unknown as RocketTree);

  it('a freeform fin on a boat tail: tip at 25 + 40 = 65 mm, root down to the 19 mm aft corner', () => {
    const [fin] = finsOf(boatTail({ type: 'freeformfinset', points: [[0, 0], [0.02, 0.04], [0.05, 0.04], [0.06, 0]] }));
    // Drawn 27 -> 67 mm, rooted at the fore end's radius.
    expect(fin!.to).toBeCloseTo(0.065, 12);
    expect(fin!.from).toBeCloseTo(0.019, 12);
    expect(aftLayout(boatTail({ type: 'freeformfinset', points: [[0, 0], [0.02, 0.04], [0.05, 0.04], [0.06, 0]] }), 0)
      .extent).toBeCloseTo(0.065, 12);
  });

  /**
   * The same fin on a TAIL CONE (a nose cone flipped base-forward, KB2): the
   * cone it roots on is 54 mm at its FRONT and narrows to the point 80 mm aft,
   * the way the kernel flies it, not a nose cone pointing forward off the tube.
   */
  it('a freeform fin on a tail cone: tip at 20.25 + 40 mm, root down to the point', () => {
    const tailCone = (flipped: boolean): RocketTree => ({
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [
        { id: 'n1', type: 'nosecone', length: 0.1, aftRadius: 0.027 },
        { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.027 },
        { id: 't1', type: 'nosecone', shape: 'conical', length: 0.08, aftRadius: 0.027, flipped,
          children: [{ id: 'ff', type: 'freeformfinset', finCount: 1, thickness: 0.003,
            position: { method: 'bottom', offset: 0 }, points: [[0, 0], [0.02, 0.04], [0.05, 0.04], [0.06, 0]] }] },
      ] }],
    } as unknown as RocketTree);
    const [fin] = finsOf(tailCone(true));
    // 20 mm behind a 27 mm base on an 80 mm cone: 27 x (1 - 20/80) = 20.25 mm.
    expect(fin!.to).toBeCloseTo(0.02025 + 0.04, 12);
    expect(fin!.from).toBeCloseTo(0, 12);
    // Unflipped, the same cone points forward: 6.75 mm under the leading edge.
    const [plain] = finsOf(tailCone(false));
    expect(plain!.to).toBeCloseTo(0.00675 + 0.04, 12);
  });

  it('on a body tube nothing moves: tube radius to radius + height', () => {
    const fins = finsOf(finRocket());
    expect(fins).toHaveLength(3);
    for (const f of fins) {
      expect(f.from).toBeCloseTo(0.012, 12);
      expect(f.to).toBeCloseTo(0.042, 12);
    }
  });

  it('a body tube with no radius is drawn at the 12 mm it flies, fins and all', () => {
    // Read as 0, the tube was not drawn at all, and nothing on it either.
    const tree = finRocket();
    delete (tree.components[0]!.children![0]! as Record<string, unknown>)['outerRadius'];
    const { hulls } = aftLayout(tree, 0);
    expect(hulls.map((h) => (h as { r: number }).r)).toEqual([0.012]);
    const fins = finsOf(tree);
    expect(fins).toHaveLength(3);
    expect(fins[0]!.from).toBeCloseTo(0.012, 12);
  });

  it('a freeform set of fewer than three points draws nothing, as in every other view', () => {
    for (const points of [[], [[0, 0], [0.05, 0]]]) {
      expect(finsOf(boatTail({ type: 'freeformfinset', points })), JSON.stringify(points)).toHaveLength(0);
    }
  });
});

it.each(['fairing', 'protuberance', 'railbutton'])('B6 fits the outer corners of a wide %s at any roll', (type) => {
  const tree = { name: 'Wide', components: [{ type: 'stage', children: [{ type: 'bodytube', outerRadius: 0.027,
    children: [{ type, width: 0.2, height: 0.01, outerDiameter: 0.2, totalHeight: 0.01, conformal: false }],
  }] }] } as unknown as RocketTree;
  for (const roll of [0, Math.PI / 4, Math.PI / 2]) {
    expect(aftLayout(tree, roll).extent).toBeCloseTo(Math.hypot(0.027 + 0.01, 0.054), 12);
  }
});
