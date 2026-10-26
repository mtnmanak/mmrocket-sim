import { describe, expect, it } from 'vitest';

it.each([false, true])('flags an obstructing coupler descendant beside a direct bore tube (coupler first=%s)', couplerFirst => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003,
    position: { method: 'top', offset: 0.2 } };
  const mount: ComponentNode = { type: 'innertube', length: 0.3, outerRadius: 0.01 };
  const coupler: ComponentNode = { type: 'tubecoupler', length: 0.1,
    position: { method: 'top', offset: 0 }, children: [
      { type: 'innertube', length: 0.2, outerRadius: 0.005, radialPosition: 0.02,
        position: { method: 'top', offset: 0.05 } },
    ] };
  const t: RocketTree = { components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.03,
    children: [ring, ...(couplerFirst ? [coupler, mount] : [mount, coupler])] }] };
  const ctx = solidContextFor(t, ring);
  expect(ctx.mountOuterRadius).toBeCloseTo(0.01, 12);
  expect(ctx.mountLayoutUnresolved).toBe(true);
  expect(componentLoop(ring, ctx)).toBeNull();
});

it('does not invent a bore from a centered descendant beyond its direct holder', () => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003,
    position: { method: 'top', offset: 0.2 } };
  const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.03, children: [
    ring, { type: 'innertube', length: 0.1, outerRadius: 0.01, position: { method: 'top', offset: 0 },
      children: [{ type: 'innertube', length: 0.3, outerRadius: 0.005,
        position: { method: 'top', offset: 0 } }] },
  ] }] };
  const context = solidContextFor(tree, ring);
  expect(context.mountOuterRadius).toBeUndefined();
  expect(context.mountLayoutUnresolved).toBe(true);
  expect(componentLoop(ring, context)).toBeNull();
});

it.each([{ radialPosition: 0.012 }, { cluster: '3-ring', clusterScale: 4 }])(
  'keeps the assumed kernel bore beside an automatic coupler %j', layout => {
    const ring: ComponentNode = { type: 'centeringring', id: 'automatic-coupler-ring', length: 0.003 };
    const t: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.3,
      outerRadius: 0.03, children: [ring, { type: 'tubecoupler', length: 0.3, children: [
        { type: 'innertube', length: 0.3, outerRadius: 0.005, ...layout },
      ] }] }] }] };
    const context = solidContextFor(t, ring);
    expect(context.mountOuterRadius).toBeUndefined();
    expect(context.mountLayoutUnresolved).not.toBe(true);
    expect(componentLoop(ring, context)?.boreAssumed).toBe(true);
  });

it.each([false, true].map(wrap => ['innertube', wrap] as const))(
  'flags a protruding descendant of a nonoverlapping %s holder, nested coupler=%s', (type, wrap) => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003,
    position: { method: 'top', offset: 0.2 } };
  const t: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.3,
    outerRadius: 0.03, children: [ring,
      { type: 'innertube', length: 0.3, outerRadius: 0.01 },
      { type, length: 0.1, outerRadius: 0.01, position: { method: 'top', offset: 0 }, children: [
        { type: wrap ? 'tubecoupler' : 'innertube', length: 0.2, outerRadius: 0.005,
          radialPosition: wrap ? 0 : 0.012, position: { method: 'top', offset: 0.05 },
          ...(wrap ? { children: [{ type: 'innertube' as const, length: 0.2, outerRadius: 0.005,
            radialPosition: 0.012, position: { method: 'top' as const, offset: 0 } }] } : {}) },
      ] }] }] }] };
  expect(solidContextFor(t, ring).mountLayoutUnresolved).toBe(true);
  expect(componentLoop(ring, solidContextFor(t, ring))).toBeNull();
});

it.each([0.005, 0.0095])('ignores a %s m tube inside a sibling coupler for the kernel ring bore', radius => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003 };
  const t: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.3,
    outerRadius: 0.03, children: [ring, { type: 'tubecoupler', length: 0.3, outerRadius: 0.02,
      children: [{ type: 'innertube', length: 0.3, outerRadius: radius }] }] }] }] };
  const context = solidContextFor(t, ring);
  expect(context.mountOuterRadius).toBeUndefined();
  expect(componentLoop(ring, context)?.boreAssumed).toBe(true);
});

it('flags an overlapping nested tube that protrudes beyond a ring bore', () => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003 };
  const t: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.3, outerRadius: 0.03,
    children: [ring, { type: 'innertube', length: 0.3, outerRadius: 0.01, children: [
      { type: 'innertube', length: 0.3, outerRadius: 0.005, radialPosition: 0.012 },
    ] }] }] }] };
  expect(solidContextFor(t, ring).mountLayoutUnresolved).toBe(true);
});
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { componentDxf } from '../services/dxfExport.js';
import { finTemplateSvg } from '../services/finTemplate.js';
import { paperTemplateGeometry } from '../services/paperTemplates.js';
import { massObjectParentRadius, solidContextFor } from './solidContext.js';
import { componentLoop, componentSolid, finCutOutline, solidVolume } from './solidMesh.js';

/**
 * The bore a printed or cut ring-type part is sized to (audit 2026-09-22).
 *
 * The context used to set the bore only when the PARENT carried a numeric
 * `outerRadius`. A coupler from the Add menu stores `{length, thickness}` and
 * never does — its radius is automatic — so the standard av-bay layout, a
 * bulkhead inside a coupler, exported a 24.0 mm disc labelled plainly
 * "Bulkhead" whatever the airframe. Nose cones and transitions carry no
 * `outerRadius` either. The kernel resolves all three, and so must the export.
 */

const tree = (...stageKids: unknown[]): RocketTree =>
  ({ name: 'T', components: [{ id: 's1', type: 'stage', children: stageKids }] } as unknown as RocketTree);
const find = (t: RocketTree, id: string): ComponentNode => {
  const walk = (ns: ComponentNode[]): ComponentNode | undefined => {
    for (const n of ns) {
      if (n.id === id) return n;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(t.components)!;
};

const bulkhead = { id: 'bh', type: 'bulkhead', length: 0.004 };

describe('solidContextFor — the bore a part sits in', () => {
  it('a bulkhead in an Add-menu coupler: the coupler takes the body bore, less its own wall', () => {
    // 3" airframe, R 38.1 mm, 1 mm wall -> coupler OD 37.1 (automatic),
    // coupler wall 0.5 mm -> the bulkhead's bore 36.6 mm.
    const t = tree({
      id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.6,
      children: [{ id: 'c1', type: 'tubecoupler', length: 0.15, thickness: 0.0005, children: [bulkhead] }],
    });
    const ctx = solidContextFor(t, find(t, 'bh'));
    expect(ctx.parentInnerRadius).toBeCloseTo(0.0366, 12);
    // ...and the printed disc is that size, not the 12 mm fallback.
    const loop = componentLoop(find(t, 'bh'), ctx)!;
    expect(loop.label).toBe('Bulkhead');
    expect(loop.sizeAssumed).toBeUndefined();
    expect(Math.max(...loop.loop.map(([, r]) => r))).toBeCloseTo(0.0366, 12);
  });

  it('a coupler that states its own OD (a catalogue part) is sized by it', () => {
    const t = tree({
      id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.6,
      children: [{ id: 'c1', type: 'tubecoupler', outerRadius: 0.0365, length: 0.15, thickness: 0.001, children: [bulkhead] }],
    });
    expect(solidContextFor(t, find(t, 'bh')).parentInnerRadius).toBeCloseTo(0.0355, 12);
  });

  it('the coupler itself, automatic, takes the body tube bore', () => {
    const t = tree({
      id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.6,
      children: [{ id: 'c1', type: 'tubecoupler', length: 0.15, thickness: 0.0005 }],
    });
    const c = find(t, 'c1');
    const loop = componentLoop(c, solidContextFor(t, c))!;
    expect(loop.label).toBe('Tube coupler');
    expect(Math.max(...loop.loop.map(([, r]) => r))).toBeCloseTo(0.0371, 12);
  });

  it('a bulkhead in a nose cone: the profile radius at its station, less the wall', () => {
    // Conical, L 200 mm, R 30 mm, 2 mm wall. A 4 mm bulkhead flush with the
    // aft end spans x = 196..200 mm; the kernel keeps the SMALLER end's inner
    // radius: 30 * 196/200 - 2 = 27.4 mm.
    const t = tree({
      id: 'n1', type: 'nosecone', shape: 'conical', length: 0.2, aftRadius: 0.03, thickness: 0.002,
      children: [{ ...bulkhead, position: { method: 'bottom', offset: 0 } }],
    });
    expect(solidContextFor(t, find(t, 'bh')).parentInnerRadius).toBeCloseTo(0.0274, 12);
  });

  it('a bulkhead with NO position is sized at the station it flies at: the aft end', () => {
    // The kernel flies a bulkhead with no position from the BOTTOM of its
    // parent (InternalComponent), so this is the 27.4 mm case above. Read as
    // Top (until 2026-10-01) it sat at the tip, where there is no bore at all.
    const t = tree({
      id: 'n1', type: 'nosecone', shape: 'conical', length: 0.2, aftRadius: 0.03, thickness: 0.002,
      children: [bulkhead],
    });
    expect(solidContextFor(t, find(t, 'bh')).parentInnerRadius).toBeCloseTo(0.0274, 12);
  });

  it('a bulkhead in a transition: the same rule, on the transition profile', () => {
    // Conical 30 -> 20 mm over 100 mm; bulkhead at x = 10..14 mm, where the
    // radius is 29.0..28.6 mm; less 2 mm of wall -> 26.6 mm.
    const t = tree({
      id: 't1', type: 'transition', shape: 'conical', length: 0.1, foreRadius: 0.03, aftRadius: 0.02,
      thickness: 0.002, children: [{ ...bulkhead, position: { method: 'top', offset: 0.01 } }],
    });
    expect(solidContextFor(t, find(t, 'bh')).parentInnerRadius).toBeCloseTo(0.0266, 12);
  });

  it('a nose or transition that omits a field reads the KERNEL bridge defaults', () => {
    // ComponentFactory: nose length 70 mm, aft radius 12 mm, ogive; transition
    // conical. A conical nose stating nothing else: a 4 mm bulkhead flush aft
    // spans x = 66..70 mm -> 12 * 66/70 - 2 = 9.3143 mm. (The old 100 mm / 0
    // fallbacks gave no bore at all.)
    const nose = tree({
      id: 'n1', type: 'nosecone', shape: 'conical',
      children: [{ ...bulkhead, position: { method: 'bottom', offset: 0 } }],
    });
    expect(solidContextFor(nose, find(nose, 'bh')).parentInnerRadius).toBeCloseTo((0.012 * 66) / 70 - 0.002, 12);
    // A transition with no shape is conical, as the kernel and the schematic
    // draw it — the same 26.6 mm as the conical transition above, not the
    // ogive's figure.
    const tr = tree({
      id: 't1', type: 'transition', length: 0.1, foreRadius: 0.03, aftRadius: 0.02,
      thickness: 0.002, children: [{ ...bulkhead, position: { method: 'top', offset: 0.01 } }],
    });
    expect(solidContextFor(tr, find(tr, 'bh')).parentInnerRadius).toBeCloseTo(0.0266, 12);
  });

  it('B6 resolves the bore inside an automatic transition', () => {
    // No foreRadius: the kernel takes it from the tube ahead. Read as 0, a
    // bulkhead flush aft came out at 17.2 mm where the kernel flies 18.0 mm,
    // and was not flagged.
    const t = tree(
      { id: 'b0', type: 'bodytube', outerRadius: 0.025, thickness: 0.001, length: 0.2 },
      {
        id: 't1', type: 'transition', shape: 'conical', length: 0.1, aftRadius: 0.02, thickness: 0.002,
        children: [{ ...bulkhead, position: { method: 'bottom', offset: 0 } }],
      },
    );
    const node = find(t, 'bh');
    const ctx = solidContextFor(t, node);
    expect(ctx.parentInnerRadius).toBeCloseTo(0.018, 12);
    expect(componentLoop(node, ctx)!.label).toBe('Bulkhead');
  });

  it('a body tube is unchanged: outer radius less the wall', () => {
    const t = tree({
      id: 'b1', type: 'bodytube', outerRadius: 0.0245, thickness: 0.0008, length: 0.4,
      children: [bulkhead, { id: 'mm', type: 'innertube', outerRadius: 0.0146, thickness: 0.0005, length: 0.1 }],
    });
    expect(solidContextFor(t, find(t, 'bh'))).toEqual({
      parentInnerRadius: expect.closeTo(0.0237, 12), bodyRadius: 0.0245, bodyThickness: 0.0008, mountOuterRadius: 0.0146,
    });
  });

  it('resolves nothing it cannot — and the part then SAYS its size is assumed', async () => {
    // A bulkhead at the very tip of a nose: the kernel's inner radius there is
    // zero, so there is no bore to size from.
    const t = tree({
      id: 'n1', type: 'nosecone', shape: 'conical', length: 0.2, aftRadius: 0.03, thickness: 0.002,
      children: [{ ...bulkhead, position: { method: 'top', offset: 0 } }],
    });
    const node = find(t, 'bh');
    const ctx = solidContextFor(t, node);
    expect(ctx.parentInnerRadius).toBeUndefined();
    const loop = componentLoop(node, ctx)!;
    expect(loop.label).toBe('Bulkhead (assumed size)');
    expect(loop.sizeAssumed).toBe(true);
    const solid = await componentSolid(node, ctx);
    expect(solid!.label).toBe('Bulkhead (assumed size)');
    // A node outside the tree, or with no id, gets an empty context.
    expect(solidContextFor(t, { type: 'bulkhead' } as ComponentNode)).toEqual({});
    expect(solidContextFor(t, { id: 'nope', type: 'bulkhead' } as ComponentNode)).toEqual({});
  });
});

/**
 * AN AUTOMATIC CENTERING RING'S BORE (audit 2026-09-30). The kernel's
 * `CenteringRing.getInnerRadius` takes the largest outer radius among the
 * inner tubes beside the ring that overlap it axially — touching at an end
 * counts — and 0 when none does. The export context took the FIRST inner tube
 * in the parent wherever it sat, so a forward ring around an 18 mm payload
 * tube printed and DXF-cut with the 29 mm motor mount's bore, listed first.
 * `.ork` writes `auto` for every automatic ring, so that is the common case.
 */
describe('an automatic centering ring is bored to the inner tubes it overlaps', () => {
  /**
   * A 3" airframe 0.8 m long: a 29 mm mount at the aft end (listed first,
   * 0.50–0.80 m) and an 18 mm payload tube forward (0.10–0.25 m).
   */
  const twoTubes = (...rings: Record<string, unknown>[]) => tree({
    id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.8,
    children: [
      { id: 'mmt', type: 'innertube', outerRadius: 0.0153, thickness: 0.0005, length: 0.3,
        position: { method: 'bottom', offset: 0 } },
      { id: 'pay', type: 'innertube', outerRadius: 0.0095, thickness: 0.0005, length: 0.15,
        position: { method: 'top', offset: 0.1 } },
      ...rings,
    ],
  });
  /** A 3 mm automatic ring whose fore face is `at` metres down the airframe. */
  const ring = (id: string, at: number) =>
    ({ id, type: 'centeringring', length: 0.003, position: { method: 'top', offset: at } });

  it('a forward ring around the payload tube takes the payload tube, not the first tube listed', () => {
    const t = twoTubes(ring('fwd', 0.12));
    const node = find(t, 'fwd');
    const ctx = solidContextFor(t, node);
    expect(ctx.mountOuterRadius, 'the forward ring took the 29 mm mount listed first').toBe(0.0095);
    // …and the printed part has that bore: its inner face sits at 9.5 mm…
    const loop = componentLoop(node, ctx)!;
    expect(loop.label).toBe('Centering ring');
    expect(Math.min(...loop.loop.map(([, r]) => r))).toBeCloseTo(0.0095, 12);
    // …and so does the cut file (OD: the 74.2 mm airframe bore).
    expect(componentDxf(node, ctx, 'T')!.text).toContain('OD 74.2 mm | bore 19.0 mm');
  });

  it('a ring around the motor mount still takes the motor mount', () => {
    const t = twoTubes({ id: 'aft', type: 'centeringring', length: 0.003, position: { method: 'bottom', offset: 0 } });
    expect(solidContextFor(t, find(t, 'aft')).mountOuterRadius).toBe(0.0153);
  });

  it('a ring that no inner tube passes through has no bore to take', () => {
    // 0.35 m is between the two tubes. The kernel flies it as a solid disc
    // (inner radius 0); the export says its bore is assumed, as it does with
    // no inner tube in the airframe at all.
    const t = twoTubes(ring('gap', 0.35));
    const node = find(t, 'gap');
    const ctx = solidContextFor(t, node);
    expect(ctx.mountOuterRadius, 'a ring nowhere near a tube was bored to one').toBeUndefined();
    expect(componentLoop(node, ctx)!.label).toBe('Centering ring (assumed bore)');
    // The cut file says why without sending the builder to look for a mount
    // that is there, 0.15 m aft of this ring.
    const text = componentDxf(node, ctx, 'T')!.text;
    expect(text).toContain('no motor mount passes through this ring');
    expect(text).not.toContain('no motor mount found');
  });

  it('touching a tube at either end counts, as the kernel’s overlap test does', () => {
    // The payload tube spans 0.10–0.25 m. A ring ending exactly at its fore
    // end, and one starting exactly at its aft end, both count
    // (`pos2 < 0 || pos1 > length` is the kernel's skip); one a tenth of a
    // millimetre clear of either end does not.
    const t = twoTubes(ring('foreTouch', 0.097), ring('aftTouch', 0.25), ring('foreClear', 0.0969), ring('aftClear', 0.2501));
    expect(solidContextFor(t, find(t, 'foreTouch')).mountOuterRadius).toBe(0.0095);
    expect(solidContextFor(t, find(t, 'aftTouch')).mountOuterRadius).toBe(0.0095);
    expect(solidContextFor(t, find(t, 'foreClear')).mountOuterRadius).toBeUndefined();
    expect(solidContextFor(t, find(t, 'aftClear')).mountOuterRadius).toBeUndefined();
  });

  it('a ring two tubes pass through takes the larger, as the kernel does', () => {
    const t = twoTubes(
      { id: 'pay2', type: 'innertube', outerRadius: 0.012, thickness: 0.0005, length: 0.15,
        position: { method: 'top', offset: 0.1 }, radialPosition: 0.02 },
      ring('both', 0.12),
    );
    expect(solidContextFor(t, find(t, 'both')).mountOuterRadius).toBe(0.012);
  });
});

/**
 * A FIN TAB NO DEEPER THAN THE BODY (audit 2026-09-30). The kernel clamps a
 * tab's depth to the parent's radius at the tab — the smaller of its two ends
 * (`FinSet.getMaxTabHeight`) — and the side view clamps its drawn tab; the
 * STL, the DXF and the paper template cut the raw depth. A `.rkt` tab on a
 * minimum-diameter airframe is the way in: a 30 mm tab on a tube 39.0 mm
 * across (radius 19.5 mm; its 38.0 mm bore takes a 38 mm motor).
 */
describe('a fin tab is cut no deeper than the body at the tab', () => {
  /**
   * A 38 mm minimum-diameter airframe: 39.0 mm OD (radius 19.5 mm), 38.0 mm
   * bore. 100 mm root, 60 mm tab centred on it, 30 mm deep.
   */
  const minDiameter = () => tree({
    id: 'b1', type: 'bodytube', outerRadius: 0.0195, thickness: 0.0005, length: 0.6,
    children: [{
      id: 'fins', type: 'trapezoidfinset', finCount: 3, rootChord: 0.1, tipChord: 0.05, sweep: 0.05,
      height: 0.06, thickness: 0.003, tabHeight: 0.03, tabLength: 0.06,
      position: { method: 'bottom', offset: 0 },
    }],
  });

  it('the context carries the body radius at the tab', () => {
    const t = minDiameter();
    expect(solidContextFor(t, find(t, 'fins')).tabMaxDepth).toBe(0.0195);
  });

  it('on a transition it is the SMALLER radius of the tab’s two ends', () => {
    // Conical 30 → 20 mm over 100 mm. A 60 mm freeform root, aft-flush, starts
    // at 40 mm; its 20 mm tab 10 mm from the fin's front spans 50–70 mm, where
    // the radius is 25 → 23 mm.
    const t = tree({
      id: 't1', type: 'transition', shape: 'conical', length: 0.1, foreRadius: 0.03, aftRadius: 0.02, thickness: 0.002,
      children: [{
        id: 'ff', type: 'freeformfinset', finCount: 3, thickness: 0.003,
        points: [[0, 0], [0.02, 0.03], [0.05, 0.03], [0.06, 0]],
        tabHeight: 0.03, tabLength: 0.02, tabOffset: 0.01, tabOffsetMethod: 'top',
        position: { method: 'bottom', offset: 0 },
      }],
    });
    expect(solidContextFor(t, find(t, 'ff')).tabMaxDepth).toBeCloseTo(0.023, 12);
    // With no fore neighbour, the automatic fore end is the kernel's 25 mm.
    delete (find(t, 't1') as Record<string, unknown>)['foreRadius'];
    expect(solidContextFor(t, find(t, 'ff')).tabMaxDepth).toBeCloseTo(0.0215, 12);
  });

  it('the printed prism, the DXF and the paper template all cut the clamped 19.5 mm', async () => {
    const t = minDiameter();
    const node = find(t, 'fins');
    const ctx = solidContextFor(t, node);
    // The prism's outline reaches 19.5 mm below the root line, not 30.
    expect(Math.min(...finCutOutline(node, ctx)!.map(([, y]) => y))).toBeCloseTo(-0.0195, 12);
    const solid = await componentSolid(node, ctx);
    expect(solid!.mesh.positions.length).toBeGreaterThan(0);
    let lowest = Infinity;
    for (let i = 1; i < solid!.mesh.positions.length; i += 3) lowest = Math.min(lowest, solid!.mesh.positions[i]!);
    expect(lowest).toBeCloseTo(-0.0195, 12);
    expect(componentDxf(node, ctx, 'T')!.text).toContain('TTW tab 19.5 mm deep');
    expect(finTemplateSvg(node, 'T', ctx)).toContain('tab 19.5 mm deep');
  });
});

describe('ring parts take their OWN stated outer radius first', () => {
  it('as the kernel does: a RockSim or catalogue ring carries its OD, and flies it', async () => {
    const own = { type: 'bulkhead', outerRadius: 0.02, length: 0.004 } as unknown as ComponentNode;
    const s = await componentSolid(own, { parentInnerRadius: 0.0245 });
    expect(s!.label).toBe('Bulkhead');
    expect(solidVolume(s!.mesh)).toBeCloseTo(Math.PI * 0.02 ** 2 * 0.004, 7);
    for (const type of ['tubecoupler', 'engineblock', 'centeringring']) {
      const loop = componentLoop({ type, outerRadius: 0.02, thickness: 0.001, length: 0.01 } as unknown as ComponentNode,
        { parentInnerRadius: 0.0245, mountOuterRadius: 0.009 })!;
      expect(Math.max(...loop.loop.map(([, r]) => r)), type).toBe(0.02);
    }
  });
});

it.each([['bodytube', 0.0003], ['innertube', 0.0005]] as const)('B6 omitted %s wall sizes the bulkhead to the kernel bore', (type, wall) => {
  const t = tree({ id: 'tube', type, outerRadius: 0.025, children: [bulkhead] });
  expect(solidContextFor(t, find(t, 'bh')).parentInnerRadius).toBeCloseTo(0.025 - wall, 12);
});

/**
 * The radius a recovery device's AUTOMATIC packed radius takes
 * (MassObject.getMaxParentRadius), which a catalogue canopy pick resolves to.
 */
describe('massObjectParentRadius', () => {
  const chute = { id: 'c', type: 'parachute' };
  it('a body tube: its inner radius; a solid one, none', () => {
    const t = tree({ id: 'b', type: 'bodytube', length: 0.5, outerRadius: 0.05, thickness: 0.001, children: [chute] });
    expect(massObjectParentRadius(t, 'c')).toBeCloseTo(0.049, 12);
    const solid = tree({ id: 'b', type: 'bodytube', length: 0.5, outerRadius: 0.05, filled: true, children: [chute] });
    expect(massObjectParentRadius(solid, 'c')).toBe(0);
  });
  it('a nose cone: its base radius, no wall off', () => {
    const t = tree({ id: 'n', type: 'nosecone', length: 0.2, aftRadius: 0.04, thickness: 0.002, children: [chute] });
    expect(massObjectParentRadius(t, 'c')).toBe(0.04);
  });
  it('a transition: the larger end, an automatic one resolved from its neighbour', () => {
    const t = tree(
      { id: 'b', type: 'bodytube', length: 0.3, outerRadius: 0.03, thickness: 0.001 },
      { id: 't', type: 'transition', length: 0.1, aftRadius: 0.02, children: [chute] },
    );
    expect(massObjectParentRadius(t, 'c')).toBeCloseTo(0.03, 12);
  });
  it('a coupler with no radius of its own: the bore it sits in, less its wall', () => {
    const t = tree({
      id: 'b', type: 'bodytube', length: 0.5, outerRadius: 0.05, thickness: 0.001,
      children: [{ id: 'cp', type: 'tubecoupler', length: 0.1, thickness: 0.002, children: [chute] }],
    });
    expect(massObjectParentRadius(t, 'c')).toBeCloseTo(0.047, 12);
  });
  it('none for a part not in the tree', () => {
    expect(massObjectParentRadius(tree(), 'c')).toBe(0);
  });
});

describe('C-A7: a ring around more than one centred tube', () => {
  const ringIn = (...tubes: Record<string, unknown>[]) => {
    const t = tree({ id: 'bt', type: 'bodytube', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
      ...tubes.map((f, i) => ({ id: `mmt${i}`, type: 'innertube', length: 0.1, outerRadius: 0.01, thickness: 0.0005, ...f })),
      { id: 'cr', type: 'centeringring', length: 0.003 },
    ] });
    return solidContextFor(t, find(t, 'cr'));
  };
  it('flags clusters and off-centre tubes, while concentric tubes share one opening', () => {
    expect(ringIn({}).mountLayoutUnresolved).toBeUndefined();
    expect(ringIn({}).mountOuterRadius).toBe(0.01);
    expect(ringIn({ cluster: '3-ring' }).mountLayoutUnresolved).toBe(true);
    expect(ringIn({ radialPosition: 0.012 }).mountLayoutUnresolved).toBe(true);
    expect(ringIn({}, { outerRadius: 0.008 }).mountLayoutUnresolved).toBeUndefined();
  });
  it.each([undefined, 0.02])('exports concentric 20/15 mm sleeves with bore radius %s', async innerRadius => {
    const t = tree({ id: 'bt', type: 'bodytube', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
      { id: 'sleeve', type: 'innertube', length: 0.3, outerRadius: 0.02 },
      { id: 'mount', type: 'innertube', length: 0.3, outerRadius: 0.015, motorMount: true },
      { id: 'ring', type: 'centeringring', length: 0.003, innerRadius },
    ] });
    const ring = find(t, 'ring'), ctx = solidContextFor(t, ring);
    expect(componentLoop(ring, ctx)).not.toBeNull();
    expect(await componentSolid(ring, ctx)).not.toBeNull();
    expect(componentDxf(ring, ctx, 'Sleeves')).not.toBeNull();
    expect(paperTemplateGeometry(ring, ctx).circles).toEqual([0.03 - 0.001, 0.02]);
  });
  it('keeps a stated ninja-style bore where centred tubes touch end-to-end', async () => {
    const t = tree({ id: 'bt', type: 'bodytube', length: 0.5, outerRadius: 0.0508, thickness: 0.0013, children: [
      { id: 'mount', type: 'innertube', length: 0.4, outerRadius: 0.0287,
        position: { method: 'top', offset: 0 } },
      { id: 'retainer', type: 'innertube', length: 0.016, outerRadius: 0.029,
        position: { method: 'top', offset: 0.4 } },
      { id: 'ring', type: 'centeringring', length: 0.00635, outerRadius: 0.0494919, innerRadius: 0.0287401,
        position: { method: 'top', offset: 0.4 - 0.00635 } },
    ] });
    const ring = find(t, 'ring'), ctx = solidContextFor(t, ring);
    expect(componentLoop(ring, ctx)).not.toBeNull();
    expect(await componentSolid(ring, ctx)).not.toBeNull();
    expect(componentDxf(ring, ctx, 'Ninja')).not.toBeNull();
    expect(paperTemplateGeometry(ring, ctx).circles).toEqual([0.0494919, 0.0287401]);
  });
  it('refuses Goblin-style four off-axis 75 mm mounts even with a stated 80 mm ID', async () => {
    const t = tree({ id: 'bt', type: 'bodytube', length: 1, outerRadius: 0.1016, thickness: 0.0021, children: [
      ...[0, 1, 2, 3].map(i => ({ id: `mount${i}`, type: 'innertube', length: 1, outerRadius: 0.0375,
        radialPosition: 0.0566, radialDirection: i * Math.PI / 2, motorMount: true })),
      { id: 'ring', type: 'centeringring', length: 0.003, outerRadius: 0.0995, innerRadius: 0.04 },
    ] });
    const ring = find(t, 'ring'), ctx = solidContextFor(t, ring);
    expect(componentLoop(ring, ctx)).toBeNull();
    expect(await componentSolid(ring, ctx)).toBeNull();
    expect(componentDxf(ring, ctx, 'Goblin')).toBeNull();
    expect(() => paperTemplateGeometry(ring, ctx)).toThrow(/holes/);
  });
});
