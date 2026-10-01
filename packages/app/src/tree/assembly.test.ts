import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import {
  assemblyBoundingRadius, isAssembly, resolveAssemblyRadius,
  ringInstanceOffsets,
} from './assembly.js';

/**
 * These five helpers had NO test of any kind until v0.104, and they are not
 * drawing-only. `resolveAssemblyRadius` is the single definition of where a pod
 * or a strap-on booster sits off the airframe, and `ringInstanceOffsets` is the
 * single definition of which way angle 0 points — and both are read straight
 * into an EXPORTED FILE: `services/rocksimFile.ts` writes `resolveAssemblyRadius`
 * into `<RadialLoc>` and the same `angleOffset + 2πi/count` ring into
 * `<RadialAngle>` for every `<ExternalPod>`. (That writer's own round-trip is
 * pinned in `services/rocksimFile.test.ts`; what is pinned HERE is the geometry
 * contract underneath it, so a sign flip or a gap-vs-centreline mix-up fails at
 * its source rather than in one consumer.) A pod's AXIAL length is
 * `position.axialLength` (pinned in position.test.ts) — this module's own copy,
 * `assemblyChainLength`, read a cleared length as 0 and is gone (audit
 * 2026-09-30).
 *
 * All SI: metres and radians.
 */

const node = (type: string, params: Record<string, unknown> = {}): ComponentNode =>
  ({ type, ...params } as unknown as ComponentNode);

/** A 3-part mini-rocket: 60 mm cone → 200 mm tube → 40 mm boat tail. */
const pod = (extra: Record<string, unknown> = {}): ComponentNode => node('podset', {
  children: [
    node('nosecone', { length: 0.06, aftRadius: 0.015 }),
    node('bodytube', { length: 0.2, outerRadius: 0.015 }),
    node('transition', { length: 0.04, foreRadius: 0.015, aftRadius: 0.008 }),
  ],
  ...extra,
});

describe('assemblyBoundingRadius', () => {
  it('takes the widest of the chain, per type, with a transition\'s two ends', () => {
    expect(assemblyBoundingRadius(pod())).toBeCloseTo(0.015, 12);
    // A flare: the AFT radius is the wide end, and it has to be seen.
    const flared = node('podset', {
      children: [node('transition', { length: 0.04, foreRadius: 0.01, aftRadius: 0.03 })],
    });
    expect(assemblyBoundingRadius(flared)).toBeCloseTo(0.03, 12);
  });

  it('measures a nose cone by its BASE radius, which is its widest point', () => {
    const coneOnly = node('podset', { children: [node('nosecone', { length: 0.1, aftRadius: 0.02 })] });
    expect(assemblyBoundingRadius(coneOnly)).toBeCloseTo(0.02, 12);
  });

  it('is 0 for an empty assembly, so an empty pod does not push itself off the body', () => {
    expect(assemblyBoundingRadius(node('podset', { children: [] }))).toBe(0);
    expect(assemblyBoundingRadius(node('podset'))).toBe(0);
  });

  it('reads a nose or tube with no radius at the 12 mm it flies', () => {
    // ComponentAssembly.getBoundingRadius takes each tube's and transition's
    // (a nose cone is one) radius as the kernel builds it, and a tube or nose
    // with none is the bridge's 12 mm. Read as 0, a RELATIVE pod whose tube
    // states no radius was drawn, and written to a .rkt's <RadialLoc>, 12 mm
    // closer to the core than it flies (audit 2026-09-30, the class of G9).
    const bare = node('podset', { children: [node('nosecone', { length: 0.06 }), node('bodytube', { length: 0.2 })] });
    const stated = node('podset', { children: [
      node('nosecone', { length: 0.06, aftRadius: 0.012 }), node('bodytube', { length: 0.2, outerRadius: 0.012 }),
    ] });
    expect(assemblyBoundingRadius(bare)).toBeCloseTo(0.012, 12);
    expect(resolveAssemblyRadius(bare, 0.05)).toBeCloseTo(resolveAssemblyRadius(stated, 0.05), 12);
    // An automatic transition radius has no constant: its neighbours carry it.
    const auto = node('podset', { children: [node('bodytube', { outerRadius: 0.02 }), node('transition', {})] });
    expect(assemblyBoundingRadius(auto)).toBeCloseTo(0.02, 12);
  });
});

describe('resolveAssemblyRadius', () => {
  const PARENT_R = 0.05;

  it('RELATIVE: radiusOffset 0 means the two surfaces just TOUCH', () => {
    // The identity the whole convention rests on. Centre-to-centre distance
    // with a zero gap is exactly parentR + podR; anything else means the two
    // tubes overlap or float, and the exported <RadialLoc> is wrong with it.
    const r = resolveAssemblyRadius(pod({ radiusOffset: 0 }), PARENT_R);
    expect(r).toBeCloseTo(PARENT_R + 0.015, 12);
  });

  it('RELATIVE: the offset is a GAP between surfaces, not a centreline distance', () => {
    const gap = 0.004;
    const r = resolveAssemblyRadius(pod({ radiusOffset: gap }), PARENT_R);
    expect(r - PARENT_R - assemblyBoundingRadius(pod()), 'the gap is not the surface gap')
      .toBeCloseTo(gap, 12);
  });

  it('defaults to RELATIVE when radiusMethod is absent or unrecognised', () => {
    expect(resolveAssemblyRadius(pod(), PARENT_R)).toBeCloseTo(PARENT_R + 0.015, 12);
    expect(resolveAssemblyRadius(pod({ radiusMethod: 'relative' }), PARENT_R))
      .toBeCloseTo(PARENT_R + 0.015, 12);
  });

  it('FREE: the offset is measured straight from the PARENT centreline', () => {
    // No parent radius and no pod radius in the answer — that is the whole
    // difference between the two methods, and mixing them up moves every
    // exported pod by parentR + podR (65 mm on this fixture).
    const r = resolveAssemblyRadius(pod({ radiusMethod: 'free', radiusOffset: 0.09 }), PARENT_R);
    expect(r).toBeCloseTo(0.09, 12);
    expect(r).not.toBeCloseTo(resolveAssemblyRadius(pod({ radiusOffset: 0.09 }), PARENT_R), 6);
  });
});

describe('ringInstanceOffsets', () => {
  it('puts angle 0 on +y with z = 0 — the kernel PodSet convention', () => {
    // y = r·cosθ, z = r·sinθ. Swapping the two, or negating either, rotates
    // every pod ring a quarter turn and mirrors the aft view.
    const [only] = ringInstanceOffsets(1, 0.06, 0);
    expect(only!.y).toBeCloseTo(0.06, 12);
    expect(only!.z).toBeCloseTo(0, 12);
    expect(only!.angle).toBeCloseTo(0, 12);
  });

  it('spaces N instances evenly, so a 2-up sits at ±r on y', () => {
    const two = ringInstanceOffsets(2, 0.06, 0);
    expect(two).toHaveLength(2);
    expect(two[0]!.y).toBeCloseTo(0.06, 12);
    expect(two[1]!.y).toBeCloseTo(-0.06, 12);
    expect(two[0]!.z).toBeCloseTo(0, 12);
    expect(two[1]!.z).toBeCloseTo(0, 12);

    const three = ringInstanceOffsets(3, 0.06);
    expect(three.map((i) => Math.round((i.angle * 180) / Math.PI))).toEqual([0, 120, 240]);
    // Every instance is on the same circle.
    for (const i of three) expect(Math.hypot(i.y, i.z)).toBeCloseTo(0.06, 12);
  });

  it('rotates the whole ring by angleOffset, counter-clockwise into +z', () => {
    const [first] = ringInstanceOffsets(4, 0.06, Math.PI / 2);
    expect(first!.y).toBeCloseTo(0, 12);
    expect(first!.z).toBeCloseTo(0.06, 12);
  });

  it('never returns fewer than one instance, and rounds a fractional count', () => {
    expect(ringInstanceOffsets(0, 0.06)).toHaveLength(1);
    expect(ringInstanceOffsets(-3, 0.06)).toHaveLength(1);
    expect(ringInstanceOffsets(2.4, 0.06)).toHaveLength(2);
    expect(ringInstanceOffsets(2.6, 0.06)).toHaveLength(3);
  });
});

describe('isAssembly', () => {
  it('is the two off-axis types and nothing else', () => {
    expect(isAssembly('podset')).toBe(true);
    expect(isAssembly('parallelstage')).toBe(true);
    for (const t of ['stage', 'bodytube', 'nosecone', 'transition', 'innertube', 'fairing']) {
      expect(isAssembly(t), `${t} was treated as an assembly`).toBe(false);
    }
  });
});
