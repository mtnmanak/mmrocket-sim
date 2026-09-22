import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { solidContextFor } from './solidContext.js';
import { componentLoop, componentSolid, solidVolume } from './solidMesh.js';

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

  it('a transition radius left AUTOMATIC is not read as 0 — the part says its size is assumed', () => {
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
    expect(ctx.parentInnerRadius).toBeUndefined();
    expect(componentLoop(node, ctx)!.label).toBe('Bulkhead (assumed size)');
  });

  it('a body tube is unchanged: outer radius less the wall', () => {
    const t = tree({
      id: 'b1', type: 'bodytube', outerRadius: 0.0245, thickness: 0.0008, length: 0.4,
      children: [bulkhead, { id: 'mm', type: 'innertube', outerRadius: 0.0146, thickness: 0.0005, length: 0.1 }],
    });
    expect(solidContextFor(t, find(t, 'bh'))).toEqual({
      parentInnerRadius: expect.closeTo(0.0237, 12), bodyRadius: 0.0245, mountOuterRadius: 0.0146,
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
