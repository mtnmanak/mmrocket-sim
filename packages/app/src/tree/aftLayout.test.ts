import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { aftLayout } from './aftLayout.js';
import { kernelDefault } from './kernelDefaults.js';

it('uses zero bore for an automatic coupler inside a filled body', () => {
  const layout = aftLayout({ components: [{ type: 'bodytube', id: 'body', length: 0.3,
    outerRadius: 0.03, thickness: 0.001, filled: true, children: [
      { type: 'tubecoupler', id: 'coupler', length: 0.1 },
    ] }] }, 0);
  expect(layout.inner.find(s => s.key === 'coupler')).toMatchObject({ kind: 'circle', r: 0 });
});

it('sizes an automatic aft-view coupler at both stations inside a tapered shell', () => {
  const layout = aftLayout({ components: [{ type: 'nosecone', id: 'nose', length: 0.15,
    aftRadius: 0.045, thickness: 0.002, shape: 'conical', children: [
      { type: 'tubecoupler', id: 'coupler', length: 0.02, position: { method: 'top', offset: 0.02 } },
    ] }] }, 0);
  expect(layout.inner.find(s => s.key === 'coupler')).toMatchObject({ kind: 'circle', r: expect.closeTo(0.004, 9) });
});

it('draws an unsized launch lug at the radius the kernel flies, and keeps an explicit one', () => {
  const pRadius = 0.012, angle = 0.3, roll = 0.4;
  const layout = aftLayout({ components: [{ type: 'bodytube', id: 'body', length: 0.3, outerRadius: pRadius,
    children: [
      { type: 'launchlug', id: 'lug', angleOffset: angle },
      { type: 'launchlug', id: 'sized', angleOffset: angle, outerRadius: 0.003 },
    ] }] }, roll);
  const r = kernelDefault('launchlug', 'outerRadius')!;
  expect(r).toBeGreaterThan(0);
  for (const [id, want] of [['lug', r], ['sized', 0.003]] as const) {
    const lug = layout.outer.find(s => s.key === id);
    if (lug?.kind !== 'circle') throw new Error('Expected circle');
    expect(lug.r).toBeCloseTo(want, 12);
    expect(lug.y).toBeCloseTo((pRadius + want) * Math.cos(angle + roll), 12);
    expect(lug.z).toBeCloseTo((pRadius + want) * Math.sin(angle + roll), 12);
  }
});

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

describe('S4b-3 pod children inherit their instance roll', () => {
  const podRocket = (children: ComponentNode[], type: 'podset' | 'parallelstage' = 'podset'): RocketTree => ({
    components: [{ type: 'bodytube', id: 'core', length: 0.4, outerRadius: 0.025,
      children: [{ type, id: 'pods', instanceCount: 2, radiusMethod: 'free', radiusOffset: 0.06,
        angleOffset: 0.2, children: [{ type: 'bodytube', id: 'podtube', length: 0.1, outerRadius: 0.01, children }] }] }],
  });
  const fin: ComponentNode = { type: 'trapezoidfinset', id: 'podfin', finCount: 1, rotation: 0,
    rootChord: 0.05, tipChord: 0.02, height: 0.03 };

  it.each([0, 0.4])('opposite pod fins point away from the core at roll %s', roll => {
    const fins = aftLayout(podRocket([fin]), roll).outer.filter(s => s.kind === 'fin');
    expect(fins).toHaveLength(2);
    for (const [i, f] of fins.entries()) {
      if (f.kind !== 'fin') throw new Error('Expected fin');
      const angle = roll + 0.2 + i * Math.PI;
      expect(f.angle).toBeCloseTo(angle, 12);
      expect(f.y * Math.cos(f.angle) + f.z * Math.sin(f.angle)).toBeCloseTo(0.06, 12);
    }
  });

  it.each([0, 0.4])('nested pods accumulate both instance angles at roll %s', roll => {
    const nested: ComponentNode = { type: 'podset', id: 'nested', instanceCount: 2,
      radiusMethod: 'free', radiusOffset: 0.025, angleOffset: 0.3,
      children: [{ type: 'bodytube', length: 0.08, outerRadius: 0.005, children: [fin] }] };
    const fins = aftLayout(podRocket([nested]), roll).outer.filter(s => s.kind === 'fin');
    expect(fins).toHaveLength(4);
    for (const [i, f] of fins.entries()) {
      if (f.kind !== 'fin') throw new Error('Expected fin');
      const parentAngle = roll + 0.2 + Math.floor(i / 2) * Math.PI;
      const angle = parentAngle + 0.3 + (i % 2) * Math.PI;
      expect(f.angle).toBeCloseTo(angle, 12);
      expect(f.y).toBeCloseTo(0.06 * Math.cos(parentAngle) + 0.025 * Math.cos(angle), 12);
      expect(f.z).toBeCloseTo(0.06 * Math.sin(parentAngle) + 0.025 * Math.sin(angle), 12);
    }
  });

  it.each(['podset', 'parallelstage'] as const)('rotates every angular child of a %s, including clustered-tube children', type => {
    const children: ComponentNode[] = [
      { type: 'tubefinset', id: 'tf', finCount: 1, outerRadius: 0.003, rotation: 0.3 },
      { type: 'fairing', id: 'fairing', angleOffset: 0.3 },
      { type: 'protuberance', id: 'bump', angleOffset: 0.3 } as unknown as ComponentNode,
      { type: 'launchlug', id: 'lug', angleOffset: 0.3, outerRadius: 0.002 },
      { type: 'railbutton', id: 'button', angleOffset: 0.3 },
      { type: 'innertube', id: 'inner', outerRadius: 0.002, length: 0.08, cluster: 'double',
        radialPosition: 0.004, radialDirection: 0.3, children: [fin] },
    ];
    const roll = 0.4;
    const layout = aftLayout(podRocket(children, type), roll);
    for (let i = 0; i < 2; i++) {
      const angle = roll + 0.2 + i * Math.PI;
      const cy = 0.06 * Math.cos(angle), cz = 0.06 * Math.sin(angle);
      for (const id of ['fairing', 'bump', 'button']) {
        const shape = layout.outer.filter(s => s.key.split('#')[0] === id)[i]!;
        expect(shape.kind).toBe('shroud');
        if (shape.kind !== 'shroud') throw new Error('Expected shroud');
        expect(shape.angle).toBeCloseTo(angle + 0.3, 12);
      }
      for (const [id, d] of [['tf', 0.013], ['lug', 0.012]] as const) {
        const shape = layout.outer.filter(s => s.key.split('#')[0] === id)[i]!;
        expect(shape.y).toBeCloseTo(cy + d * Math.cos(angle + 0.3), 12);
        expect(shape.z).toBeCloseTo(cz + d * Math.sin(angle + 0.3), 12);
      }
      const tubes = layout.inner.filter(s => s.key.split('#')[0] === 'inner').slice(i * 2, i * 2 + 2);
      expect(tubes).toHaveLength(2);
      // The cluster's mean is its independently clocked radial offset.
      expect((tubes[0]!.y + tubes[1]!.y) / 2).toBeCloseTo(cy + 0.004 * Math.cos(angle + 0.3), 12);
      expect((tubes[0]!.z + tubes[1]!.z) / 2).toBeCloseTo(cz + 0.004 * Math.sin(angle + 0.3), 12);
      // Its pattern vector rotates with the pod too.
      const dy = tubes[1]!.y - tubes[0]!.y, dz = tubes[1]!.z - tubes[0]!.z;
      expect(dy * Math.sin(angle + 0.3) - dz * Math.cos(angle + 0.3)).toBeCloseTo(0, 12);
      const fins = layout.outer.filter(s => s.kind === 'fin').slice(i * 2, i * 2 + 2);
      expect(fins).toHaveLength(2);
      for (const f of fins) if (f.kind === 'fin') expect(f.angle).toBeCloseTo(angle, 12);
    }
  });
});

it('S4b-g2 includes bulkheads and rings inside nested couplers in the aft view', () => {
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'body', outerRadius: 0.027, length: 0.3,
    children: [{ type: 'tubecoupler', id: 'coupler', length: 0.1, outerRadius: 0.025, children: [
      { type: 'bulkhead', id: 'bulkhead', name: 'Av-bay bulkhead', length: 0.003, outerRadius: 0.024 },
      { type: 'tubecoupler', id: 'nested', length: 0.06, outerRadius: 0.023, children: [
        { type: 'centeringring', id: 'ring', name: 'Av-bay ring', length: 0.003, outerRadius: 0.022 },
      ] },
    ] }] }] };
  const inner = aftLayout(tree, 0).inner;
  expect(inner.map(s => s.title)).toEqual(['tubecoupler', 'Av-bay bulkhead', 'tubecoupler', 'Av-bay ring']);
  expect(inner.find(s => s.title === 'Av-bay bulkhead')).toMatchObject({ kind: 'circle', r: 0.024 });
  expect(aftLayout(tree, 0, undefined, new Set(['coupler'])).inner).toHaveLength(0);
});

it('S4a-2 draws no aft circles for a zero-radius tube-fin set', () => {
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.027,
    children: [{ type: 'tubefinset', id: 'tf', length: 0.05, finCount: 6, outerRadius: 0 }] }] };
  expect(aftLayout(tree, 0).outer).toHaveLength(0);
});

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
