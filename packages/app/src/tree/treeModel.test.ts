import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { OrkRocket } from '@online-openrocket/engine';
import { bodyDragReference, engineTree, fairingDeliveredCd, fairingFrontalArea, findNode, findParent, mountRadiusOf, hasParallelStage, isOnLaunchStage, makeNode, motorMounts, mountsIn, normalizeTree, protuberanceCd, protuberanceDeliveredCd, PROTUBERANCE_REF_MACH, referenceArea, resetBodyDragCache, splitClusterPairsTree, splitClusterTree } from './treeModel.js';
import { clusterOffsets } from './cluster.js';
import { allowedChildren, defaultParams, DISPLAY_NAME, FIELDS } from './schema.js';

describe('engineTree — spill-hole Cd reduction at the engine boundary', () => {
  const chuteTree = (params: Record<string, unknown>): RocketTree => ({
    name: 's',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.02,
        children: [{ type: 'parachute', id: 'p1', diameter: 0.6, ...params } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  it('reduces cd by the hole/canopy area ratio (explicit cd)', () => {
    const out = engineTree(chuteTree({ cd: 2.2, spillHoleDiameter: 0.15 }));
    const chute = findNode(out, 'p1')!;
    // 2.2 · (1 − (0.15/0.6)²) = 2.2 · 0.9375
    expect(chute['cd']).toBeCloseTo(2.0625, 9);
  });

  it('applies the reduction to the kernel default 0.8 when cd is auto', () => {
    const out = engineTree(chuteTree({ spillHoleDiameter: 0.3 }));
    expect(findNode(out, 'p1')!['cd']).toBeCloseTo(0.8 * 0.75, 9);
  });

  it('leaves the editing tree untouched and no-hole chutes alone', () => {
    const src = chuteTree({ cd: 1.5 });
    const out = engineTree(src);
    expect(findNode(out, 'p1')!['cd']).toBe(1.5);
    const withHole = chuteTree({ cd: 1.5, spillHoleDiameter: 0.1 });
    engineTree(withHole);
    expect(findNode(withHole, 'p1')!['cd']).toBe(1.5); // source unmodified
  });
});

describe('splitClusterTree — symmetric group split for combination batching', () => {
  const clusterTree = (cluster: string, extra: Record<string, unknown> = {}): RocketTree => ({
    name: 'c',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.05,
        children: [{
          type: 'innertube', id: 'm1', length: 0.1, outerRadius: 0.015,
          motorMount: true, cluster, ...extra,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  /** Union of the split groups must occupy the ORIGINAL cluster's positions. */
  const positionsMatch = (cluster: string, scale: number, rotation: number) => {
    const split = splitClusterTree(clusterTree(cluster, { clusterScale: scale, clusterRotation: rotation }), 'm1')!;
    expect(split).not.toBeNull();
    const r = 0.015;
    const original = clusterOffsets(cluster, r, scale, rotation);
    const got = split.mountIds.flatMap((id) => {
      const m = findNode(split.tree, id)!;
      return clusterOffsets(m['cluster'] as string, r,
        m['clusterScale'] as number, m['clusterRotation'] as number);
    });
    expect(got.length).toBe(original.length);
    for (const o of original) {
      const hit = got.find((g) => Math.hypot(g.y - o.y, g.z - o.z) < 1e-9);
      expect(hit, `original tube at (${o.y}, ${o.z}) missing from split`).toBeDefined();
    }
  };

  it('4-ring → two doubles on the diagonals (exact positions)', () => {
    positionsMatch('4-ring', 1, 0);
    positionsMatch('4-ring', 1.3, Math.PI / 5);
  });

  it('6-ring → two 3-rings on alternating tubes (exact positions)', () => {
    positionsMatch('6-ring', 1, 0);
    positionsMatch('6-ring', 1.15, -Math.PI / 7);
  });

  it('6-ring PAIR split → three doubles on the diagonals (exact positions)', () => {
    for (const [scale, rotation] of [[1, 0], [1.2, Math.PI / 5]] as const) {
      const split = splitClusterPairsTree(
        clusterTree('6-ring', { clusterScale: scale, clusterRotation: rotation }), 'm1')!;
      expect(split).not.toBeNull();
      expect(split.mountIds.length).toBe(3);
      expect(split.groupSize).toBe(2);
      const r = 0.015;
      const original = clusterOffsets('6-ring', r, scale, rotation);
      const got = split.mountIds.flatMap((id) => {
        const m = findNode(split.tree, id)!;
        return clusterOffsets(m['cluster'] as string, r,
          m['clusterScale'] as number, m['clusterRotation'] as number);
      });
      expect(got.length).toBe(6);
      for (const o of original) {
        expect(got.find((g) => Math.hypot(g.y - o.y, g.z - o.z) < 1e-9),
          `tube at (${o.y}, ${o.z}) missing`).toBeDefined();
      }
    }
    expect(splitClusterPairsTree(clusterTree('4-ring'), 'm1')).toBeNull();
  });

  it('returns null for non-splittable mounts', () => {
    expect(splitClusterTree(clusterTree('3-ring'), 'm1')).toBeNull();
    expect(splitClusterTree(clusterTree('single'), 'm1')).toBeNull();
    expect(splitClusterTree(clusterTree('4-ring'), 'nope')).toBeNull();
  });

  it('keeps the original tree untouched and both groups carry children', () => {
    const src = clusterTree('4-ring');
    const split = splitClusterTree(src, 'm1')!;
    expect(findNode(src, 'm1')).not.toBeNull(); // source intact
    expect(findNode(split.tree, 'm1')).toBeNull(); // replaced in the copy
    expect(split.groupSize).toBe(2);
  });
});

describe('engineTree — camera shroud (fairing) lowering', () => {
  const fairingTree = (params: Record<string, unknown>): RocketTree => ({
    name: 'f',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.6, outerRadius: 0.05,
        children: [{
          type: 'fairing', id: 'f1', length: 0.08, width: 0.025, height: 0.02,
          mass: 0.045, position: { method: 'middle', offset: 0 }, ...params,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  it('lowers to a 1-fin strake with mass + CD overrides, same id', () => {
    const out = engineTree(fairingTree({ fairingShape: 'halfround' }));
    const strake = findNode(out, 'f1')!;
    expect(strake.type).toBe('freeformfinset');
    expect(strake['finCount']).toBe(1);
    expect(strake['thickness']).toBeCloseTo(0.025, 9);
    expect(strake['overrideMass']).toBeCloseTo(0.045, 9);
    // Hoerner half-round 0.55 on the area the shroud really blocks, over the
    // rocket reference area π·0.05². The area is W·H PLUS the crescent between
    // the shroud's tangent underside and the R = 0.05 arc it sits on:
    //   a = W/2 = 0.0125
    //   gap = 2aR − R²·asin(a/R) − a·√(R²−a²) = 1.314571429989e-5
    //   area = 5.0e-4 + 1.314571429989e-5 = 5.131457142999e-4 m²
    // The literal is written out rather than calling surfaceBumpFrontalArea:
    // using the helper as its own oracle would make this assertion pass
    // against a sign error inside it.
    expect(strake['overrideCD']).toBeCloseTo(0.035934657861190, 12);
    const pts = strake['points'] as [number, number][];
    expect(pts[2]).toEqual([0.08, 0.02]);
  });

  it('streamlined shape ramps the profile and drops the CD', () => {
    const out = engineTree(fairingTree({ fairingShape: 'streamlined' }));
    const strake = findNode(out, 'f1')!;
    const pts = strake['points'] as [number, number][];
    expect(pts[1]![0]).toBeCloseTo(0.024, 9); // 0.3·L ramp
    expect(strake['overrideCD']).toBeCloseTo(0.016333935391450, 12); // cd 0.25, same area
  });

  /**
   * v0.090 — the body-curvature frontal-area correction (Eric, 2026-08-31c:
   * "if it is waiting on my call, fix it").
   *
   * These are written to fail on THREE separate mutations, because the first
   * two are the implementations somebody reaches for first:
   *   (M1) drop the correction entirely — `cdFrontal * W * H`;
   *   (M2) keep it but feed it the REFERENCE radius √(aRef/π), which is
   *        already in scope two lines above, instead of the mounting parent's;
   *   (M3) gate it on `conformal`, which reads plausible and is wrong.
   */
  describe('the frontal area is measured from the tube surface', () => {
    it('charges the crescent as well as width × height', () => {
      const out = engineTree(fairingTree({ fairingShape: 'halfround' }));
      const strake = findNode(out, 'f1')!;
      // The RATIO is the assertion that names mutation M1: reverting to W·H
      // makes this exactly 1.
      const flat = (0.55 * 0.025 * 0.02) / (Math.PI * 0.05 * 0.05);
      expect((strake['overrideCD'] as number) / flat).toBeCloseTo(1.0262914286, 9);
    });

    it('uses the MOUNTING tube radius, not the rocket reference radius', () => {
      // aRef is set by the fat tube; the shroud sits on the thin one. Both
      // radii are therefore in scope, and only the parent's is correct.
      //   parent R = 0.025 → 0.036913099383697   (correct)
      //   ref    R = 0.050 → 0.035934657861190   (mutation M2)
      //   flat W·H        → 0.035014087480217   (mutation M1)
      const out = engineTree({
        name: 'two', components: [{
          type: 'stage', id: 's1', children: [
            { type: 'bodytube', id: 'fat', length: 0.3, outerRadius: 0.05 } as ComponentNode,
            {
              type: 'bodytube', id: 'thin', length: 0.3, outerRadius: 0.025,
              children: [{
                type: 'fairing', id: 'f1', length: 0.08, width: 0.025, height: 0.02,
                mass: 0.045, fairingShape: 'halfround',
                position: { method: 'middle', offset: 0 },
              } as ComponentNode],
            } as ComponentNode,
          ],
        } as ComponentNode],
      });
      expect(findNode(out, 'f1')!['overrideCD']).toBeCloseTo(0.036913099383697, 12);
    });

    it('is not gated on the conformal tick — dead air blocks as well as material', () => {
      // The guide promises the conformal tick "changes the drawing and the
      // printed shape, not the numbers". Strict equality, because a gate on
      // isConformal() makes exactly one of these three differ.
      const cd = (params: Record<string, unknown>) =>
        findNode(engineTree(fairingTree({ fairingShape: 'halfround', ...params })), 'f1')!['overrideCD'];
      expect(cd({ conformal: false })).toBe(cd({ conformal: true }));
      expect(cd({})).toBe(cd({ conformal: true }));
    });

    it('falls back to width × height when there is no tube to be curved', () => {
      // A shroud whose parent is the stage: no mounting surface, so no
      // crescent — and, importantly, no NaN.
      const out = engineTree({
        name: 'bare', components: [{
          type: 'stage', id: 's1', children: [{
            type: 'fairing', id: 'f1', length: 0.08, width: 0.025, height: 0.02,
            mass: 0.045, fairingShape: 'halfround',
            position: { method: 'middle', offset: 0 },
          } as ComponentNode],
        } as ComponentNode],
      });
      // aRef falls back to the kernel's 0.01 m reference length here, so pin
      // the AREA rather than the ratio: cd·W·H / aRef with no crescent term.
      const cdOut = findNode(out, 'f1')!['overrideCD'] as number;
      expect(Number.isFinite(cdOut)).toBe(true);
      expect(cdOut).toBeCloseTo((0.55 * 0.025 * 0.02) / (Math.PI * 0.005 * 0.005), 9);
    });

    it('the panel helper and the engine lowering read the SAME area', () => {
      // engineTree threads the parent down its walk; fairingFrontalArea looks
      // it up with findParent. Two routes to one number is exactly how the
      // panel once printed a third of the real drag as fact, so pin that they
      // agree — on a tree where a wrong radius WOULD show, i.e. one whose
      // reference tube is not the tube the shroud is mounted on.
      const t: RocketTree = {
        name: 'two', components: [{
          type: 'stage', id: 's1', children: [
            { type: 'bodytube', id: 'fat', length: 0.3, outerRadius: 0.05 } as ComponentNode,
            {
              type: 'bodytube', id: 'thin', length: 0.3, outerRadius: 0.025,
              children: [{
                type: 'fairing', id: 'f1', length: 0.08, width: 0.025, height: 0.02,
                mass: 0.045, fairingShape: 'halfround',
                position: { method: 'middle', offset: 0 },
              } as ComponentNode],
            } as ComponentNode,
          ],
        } as ComponentNode],
      };
      const shroud = findNode(t, 'f1')!;
      expect(fairingDeliveredCd(t, shroud))
        .toBeCloseTo(findNode(engineTree(t), 'f1')!['overrideCD'] as number, 15);
      // …and it is the thin tube's number, not the fat one's.
      expect(fairingFrontalArea(t, shroud)).toBeCloseTo(5.271178265684e-4, 15);
      expect(mountRadiusOf(findParent(t, 'f1') as ComponentNode)).toBe(0.025);
    });

    it('saturates rather than going NaN when the shroud is wider than the tube', () => {
      // a = min(W/2, R) clamps at the tube radius; without the clamp this is
      // asin(1.25) = NaN and the design loses its whole drag curve.
      //   gap = R²(2 − π/2) = 0.012²·0.4292036732 = 6.180532894153e-5
      //   area = 6.0e-4 + 6.180532894153e-5 = 6.61805328942e-4
      //   aRef = π·0.012² = 4.523893421169e-4
      const out = engineTree({
        name: 'wide', components: [{
          type: 'stage', id: 's1', children: [{
            type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.012,
            children: [{
              type: 'fairing', id: 'f1', length: 0.08, width: 0.03, height: 0.02,
              mass: 0.045, fairingShape: 'halfround',
              position: { method: 'middle', offset: 0 },
            } as ComponentNode],
          } as ComponentNode],
        } as ComponentNode],
      });
      const cdOut = findNode(out, 'f1')!['overrideCD'] as number;
      expect(Number.isNaN(cdOut)).toBe(false);
      expect(cdOut).toBeCloseTo((0.55 * 6.61805328942e-4) / (Math.PI * 0.012 * 0.012), 9);
    });
  });
});

describe('off-axis assemblies (pods / parallel stages) — Phase 1 foundation', () => {
  const withPod = (): RocketTree => ({
    name: 'p',
    components: [{
      type: 'stage', id: 'c1', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'c2', length: 0.07, aftRadius: 0.012 } as ComponentNode,
        {
          type: 'bodytube', id: 'c3', length: 0.3, outerRadius: 0.024,
          children: [
            { type: 'innertube', id: 'c4', outerRadius: 0.0095, motorMount: true } as ComponentNode,
            {
              type: 'parallelstage', id: 'c5', instanceCount: 2, radiusOffset: 0, angleOffset: 0,
              children: [{
                type: 'bodytube', id: 'c6', length: 0.2, outerRadius: 0.012,
                children: [{ type: 'innertube', id: 'c7', outerRadius: 0.0095, motorMount: true } as ComponentNode],
              } as ComponentNode],
            } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    } as ComponentNode],
  });

  it('schema tables are total over the new types', () => {
    for (const t of ['podset', 'parallelstage'] as const) {
      expect(DISPLAY_NAME[t]).toBeTruthy();
      expect(FIELDS[t].length).toBeGreaterThan(0);
      expect(defaultParams(t).instanceCount).toBe(2);
    }
    // Assemblies attach to body components and hold an axial chain.
    expect(allowedChildren('bodytube')).toContain('podset');
    expect(allowedChildren('bodytube')).toContain('parallelstage');
    expect(allowedChildren('podset')).toEqual(['nosecone', 'bodytube', 'transition']);
    // parallelstage carries the separation fields; podset does not.
    expect(FIELDS.parallelstage.some((f) => f.key === 'separationEvent')).toBe(true);
    expect(FIELDS.podset.some((f) => f.key === 'separationEvent')).toBe(false);
  });

  it('exposes pod-internal motor mounts to motorMounts() (pods now build in the engine)', () => {
    const full = withPod();
    expect(motorMounts(full).map((m) => m.id).sort()).toEqual(['c4', 'c7']);
  });

  it('mountsIn scopes to a subtree and keeps the tube-type filter', () => {
    // The subtree form is what the file importers use to resolve one stage's
    // engine slot; it must honour the same filter motorMounts always had —
    // the .CDX1 importer's private copy had dropped the type check, so a
    // motorMount flag landing on any other component type would have made
    // that importer disagree with the motor panel about what a mount is.
    const full = withPod();
    const stage = full.components[0]!;
    const flaggedChute = {
      type: 'parachute', id: 'c8', motorMount: true,
    } as ComponentNode;
    stage.children!.push(flaggedChute);
    expect(mountsIn(stage.children ?? []).map((m) => m.id).sort()).toEqual(['c4', 'c7']);
    // Scoped: the pod's own subtree sees only its internal mount.
    expect(mountsIn(findNode(full, 'c5')!.children ?? []).map((m) => m.id)).toEqual(['c7']);
  });

  it('hasParallelStage detects a nested booster (drives the batch-sim gate)', () => {
    expect(hasParallelStage(withPod())).toBe(true);
    const podOnly: RocketTree = {
      name: 'p',
      components: [{
        type: 'stage', id: 's',
        children: [{ type: 'bodytube', id: 'b', length: 0.3, children: [{ type: 'podset', id: 'pd' } as ComponentNode] } as ComponentNode],
      } as ComponentNode],
    };
    // A non-separating pod is NOT a parallel stage.
    expect(hasParallelStage(podOnly)).toBe(false);
  });

  it('normalizeTree leaves a nested pod nested (top-level stage invariant holds)', () => {
    const out = normalizeTree(withPod());
    expect(out.components.every((n) => n.type === 'stage')).toBe(true);
    // The parallelstage is still nested under the body tube, never promoted.
    const booster = findNode(out, 'c5');
    expect(booster?.type).toBe('parallelstage');
    expect(out.components.some((n) => n.type === 'parallelstage')).toBe(false);
  });
});

describe('isOnLaunchStage — the launch stage is the LAST one', () => {
  // The auto-aero Mach probe's cutoff turns entirely on this flag: only
  // launch-stage motors fire off the clock. Launch and the batch runner each
  // used to hand-roll the index compare; this is the one definition now.
  const staged: RocketTree = {
    name: 'two-stage',
    components: [
      {
        type: 'stage', id: 's0', name: 'Sustainer',
        children: [{ type: 'bodytube', id: 'b0', length: 0.3, children: [{ type: 'innertube', id: 'm0', motorMount: true } as ComponentNode] } as ComponentNode],
      } as ComponentNode,
      {
        type: 'stage', id: 's1', name: 'Booster',
        children: [{ type: 'bodytube', id: 'b1', length: 0.2, motorMount: true } as ComponentNode],
      } as ComponentNode,
    ],
  };

  it('is true only for the bottom stage — stage 0 is the sustainer', () => {
    expect(isOnLaunchStage(staged, 'm0')).toBe(false);
    expect(isOnLaunchStage(staged, 'b1')).toBe(true);
  });

  it('a single-stage design launches its own (only) stage', () => {
    const single: RocketTree = { name: 's', components: [staged.components[0]!] };
    expect(isOnLaunchStage(single, 'm0')).toBe(true);
  });
});

describe('normalizeTree id reseeding', () => {
  it('mints ids past the ones in a restored tree (no duplicates after reload)', () => {
    // Simulate a restored session whose previous page load minted c500/c501.
    const restored: RocketTree = {
      name: 'r',
      components: [{
        type: 'stage', id: 'c500', name: 'Sustainer',
        children: [{ type: 'bodytube', id: 'c501', length: 0.3 } as ComponentNode],
      } as ComponentNode],
    };
    normalizeTree(restored);
    const fresh = makeNode('bodytube');
    expect(Number(fresh.id!.slice(1))).toBeGreaterThan(501);
  });
});

describe('normalizeTree mixed lists', () => {
  it('folds loose nodes into the nearest preceding stage (never nests stages)', () => {
    const mixed: RocketTree = {
      name: 'm',
      components: [
        { type: 'stage', id: 'c1', name: 'Sustainer', children: [] } as ComponentNode,
        { type: 'bodytube', id: 'c2', length: 0.3 } as ComponentNode,
      ],
    };
    const out = normalizeTree(mixed);
    expect(out.components.every((n) => n.type === 'stage')).toBe(true);
    expect(out.components).toHaveLength(1);
    expect(out.components[0]!.children!.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('normalizeTree absolute positions', () => {
  it('rewrites rocket-origin absolute offsets into parent-relative top offsets', () => {
    const tree: RocketTree = {
      name: 'a',
      components: [{
        type: 'stage', id: 's', name: 'Sustainer',
        children: [
          { type: 'bodytube', id: 'b1', length: 0.2 } as ComponentNode,
          {
            type: 'bodytube', id: 'b2', length: 0.3,
            children: [{
              type: 'launchlug', id: 'l', length: 0.05,
              position: { method: 'absolute', offset: 0.25 },
            } as ComponentNode],
          } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const out = normalizeTree(tree);
    const lug = findNode(out, 'l')!;
    // b2 starts at 0.2 from the nose tip → absolute 0.25 = 0.05 into b2.
    expect(lug.position?.method).toBe('top');
    expect(lug.position?.offset).toBeCloseTo(0.05, 12);
  });
});

/**
 * The Add menu must never offer a child the kernel refuses — doing so builds a
 * design that throws on build, which kills mass, CG, CP, drag, the 3D stats and
 * Simulate at once and autosaves the broken tree. Transition.isCompatible
 * (24.12) accepts InternalComponent or FreeformFinSet only, and NoseCone
 * inherits it, so neither takes a pod set or a booster.
 */
describe('containment matches the kernel', () => {
  it('offers no off-axis assembly on a nose cone or transition', () => {
    for (const parent of ['nosecone', 'transition'] as const) {
      const allowed = allowedChildren(parent);
      expect(allowed).not.toContain('podset');
      expect(allowed).not.toContain('parallelstage');
    }
  });

  it('still offers them on a body tube, which the kernel does accept', () => {
    expect(allowedChildren('bodytube')).toContain('podset');
    expect(allowedChildren('bodytube')).toContain('parallelstage');
  });

  it('keeps freeform fins on a transition (the one fin type it takes)', () => {
    expect(allowedChildren('transition')).toContain('freeformfinset');
    expect(allowedChildren('transition')).not.toContain('trapezoidfinset');
  });
});

/**
 * The protuberance component (§7.5e): RASAero's discrete drag bump — rail
 * guide, launch shoe, cable tunnel, camera housing, fin-root anchor. The
 * kernel has no such component, so it is lowered here onto a RailButton
 * carrying a CD override, which BarrowmanCalculator adds to total CD after
 * skipping the carrier's own friction, pressure and base drag.
 *
 * The 60 s timeouts below are on exactly the tests that build a rocket and take
 * a drag sweep through bodyDragReference; the pure ones beside them run under
 * vitest's 5 s default. They are headroom for the first kernel call in a cold
 * CI worker (deploy.yml runs `npm test` on every push), NOT a measurement of
 * these tests: this file's 40 tests take 445 ms (measured 2026-08-25b in the full
 * app suite).
 */
describe('engineTree — protuberance lowering', () => {
  const protTree = (params: Record<string, unknown>): RocketTree => ({
    name: 'p',
    components: [{
      type: 'stage', id: 's1',
      children: [
        { type: 'nosecone', id: 'n1', length: 0.4, aftRadius: 0.1, thickness: 0.002, shape: 'ogive' },
        {
          // 100 mm radius body ⇒ reference area π·0.1² = 0.0314159 m².
          type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.1,
          children: [
            {
              type: 'protuberance', id: 'x1', name: 'Bump',
              width: 0.05, height: 0.02, length: 0.1, count: 1, mass: 0,
              position: { method: 'middle', offset: 0.02 },
              ...params,
            } as unknown as ComponentNode,
            {
              type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.15, tipChord: 0.08,
              sweep: 0.06, height: 0.09, thickness: 0.004,
              position: { method: 'bottom', offset: 0 },
            } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    } as ComponentNode],
  });
  const aRef = Math.PI * 0.1 * 0.1;

  /**
   * The body-CD reference this design measures — the WHOLE model for the two
   * streamlined classes (RASAero's Streamlined Protuberance Method, TRF 197641
   * #1). Pinned so a silent change in the kernel's body drag, or in what
   * "the body" means here, shows up as a failing number rather than as a
   * quietly different protuberance drag.
   *
   * MEASURED 2026-08-25, sea level, Mach 0.3, classic aero: this 0.4 m ogive +
   * 0.5 m tube of 200 mm diameter with its 3 fins stripped.
   */
  it('measures the design\'s own body CD, fins and appendages stripped', () => {
    const body = bodyDragReference(protTree({}));
    expect(body.measured).toBe(true);
    expect(body.mach).toBe(PROTUBERANCE_REF_MACH);
    expect(body.noBase).toBeCloseTo(0.0783270, 6);
    expect(body.withBase).toBeCloseTo(0.2100270, 6);
    // The difference IS the kernel's own base CD — `noBase` is `total − base`,
    // so that much holds by construction — and this airframe's base area
    // equals its reference area (no boat tail), so it must land on the
    // kernel's base-drag law 0.12 + 0.13·M² exactly. What this pins is the law
    // itself, and that the pair is wired to the right two kernel numbers.
    expect(body.withBase - body.noBase).toBeCloseTo(0.12 + 0.13 * PROTUBERANCE_REF_MACH ** 2, 9);
    // The fins are NOT in it: the same tree with fins deleted measures the same.
    const finless: RocketTree = {
      ...protTree({}),
      components: [{
        ...protTree({}).components[0]!,
        children: [
          protTree({}).components[0]!.children![0]!,
          { ...protTree({}).components[0]!.children![1]!, children: [] } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const bare = bodyDragReference(finless);
    expect(bare.noBase).toBeCloseTo(body.noBase, 12);
    expect(bare.withBase).toBeCloseTo(body.withBase, 12);
  }, 60000);

  /**
   * REGRESSION (2026-08-25): a BODY component carrying a CD override has to
   * land in BOTH halves of the pair. BarrowmanCalculator skips an overridden
   * component in the friction, pressure and base loops (carved
   * BarrowmanCalculator.java ll. 623, 871, 950) while the kernel's `total`
   * still carries its overrideCD (ibid. :348), so the old
   * `noBase = friction + pressure` put the override in `withBase` only and
   * `withBase − noBase` stopped being the base-drag law. `<overridecd>` is
   * imported onto any component by orkFile.ts and survives the appendage
   * strip, so this is reachable from a plain .ork.
   *
   * The boat tail is load-bearing: with the tube as the aft-most symmetric
   * component, an override on it zeroes the whole base term and the bug hides.
   *
   * MEASURED 2026-08-25, M0.3, sea level, classic aero: without the override
   * 0.1583143 / 0.2057263; with a 0.05 override on the tube 0.1606667 /
   * 0.2080787. The old form gave noBase 0.1106667 there — a "base drag" of
   * 0.0974120 against the kernel's own 0.0474120.
   */
  it('keeps a component CD override in BOTH halves of the body-CD pair', () => {
    const boatTail = (over: boolean): RocketTree => ({
      name: 'ov',
      components: [{
        type: 'stage', id: 's1',
        children: [
          { type: 'nosecone', id: 'n1', length: 0.4, aftRadius: 0.1, thickness: 0.002, shape: 'ogive' },
          {
            type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.1,
            ...(over ? { overrideCD: 0.05 } : {}),
            children: [
              {
                type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.15, tipChord: 0.08,
                sweep: 0.06, height: 0.09, thickness: 0.004,
                position: { method: 'bottom', offset: 0 },
              } as ComponentNode,
            ],
          } as ComponentNode,
          {
            type: 'transition', id: 't1', shape: 'conical', length: 0.1,
            foreRadius: 0.1, aftRadius: 0.06, thickness: 0.002,
          } as ComponentNode,
        ],
      } as ComponentNode],
    });

    // The kernel's base CD for this boat tail: 0.12 + 0.13·M² over the base
    // area (120 mm), referenced to the airframe's frontal area (200 mm).
    const baseCd = (0.12 + 0.13 * PROTUBERANCE_REF_MACH ** 2) * (0.06 / 0.1) ** 2;

    const plain = bodyDragReference(boatTail(false));
    expect(plain.measured).toBe(true);
    expect(plain.noBase).toBeCloseTo(0.1583143, 6);
    expect(plain.withBase).toBeCloseTo(0.2057263, 6);
    expect(plain.withBase - plain.noBase).toBeCloseTo(baseCd, 9);

    const over = bodyDragReference(boatTail(true));
    expect(over.measured).toBe(true);
    expect(over.noBase).toBeCloseTo(0.1606667, 6);
    expect(over.withBase).toBeCloseTo(0.2080787, 6);
    // withBase − noBase IS the base-drag law, override or no override.
    expect(over.withBase - over.noBase).toBeCloseTo(baseCd, 9);
    // …and the override moved BOTH halves by the same amount (it replaces the
    // tube's own friction, so the net move is small — but equal on both).
    expect(over.withBase - plain.withBase).toBeCloseTo(over.noBase - plain.noBase, 12);
    // The retired `friction + pressure` reading, pinned as the thing that must
    // never come back: it put the whole 0.05 override into the difference.
    expect(over.withBase - over.noBase).not.toBeCloseTo(baseCd + 0.05, 3);
  }, 60000);

  it('becomes a rail button whose CD override IS frontal area × Cd ÷ reference area', () => {
    const out = engineTree(protTree({ dragClass: 'streamlinedbase' }));
    const carrier = findNode(out, 'x1')!;
    expect(carrier.type).toBe('railbutton');
    expect(carrier.name).toBe('Bump');
    // Cd = the body CD INCLUDING base drag, on 0.05 × 0.02 m² of frontal area.
    const body = bodyDragReference(protTree({}));
    expect(carrier['overrideCD']).toBeCloseTo((body.withBase * 0.001) / aRef, 12);
    expect(carrier['overrideMass']).toBe(0);
    expect(carrier.position).toEqual({ method: 'middle', offset: 0.02 });
  }, 60000);

  it('scales linearly with count — n identical bumps are n times the area', () => {
    const one = findNode(engineTree(protTree({})), 'x1')!['overrideCD'] as number;
    const four = findNode(engineTree(protTree({ count: 4 })), 'x1')!['overrideCD'] as number;
    expect(four).toBeCloseTo(4 * one, 12);
  }, 60000);

  it('drops the base-drag term for the streamlined class', () => {
    const body = bodyDragReference(protTree({}));
    const cd = findNode(engineTree(protTree({ dragClass: 'streamlined' })), 'x1')!['overrideCD'] as number;
    expect(cd).toBeCloseTo((body.noBase * 0.001) / aRef, 12);
    // …which is strictly LESS than the with-base class, by the base drag.
    const withBase = findNode(engineTree(protTree({ dragClass: 'streamlinedbase' })), 'x1')!['overrideCD'] as number;
    expect(cd).toBeLessThan(withBase);
    expect(withBase - cd).toBeCloseTo(((body.withBase - body.noBase) * 0.001) / aRef, 12);
  }, 60000);

  /**
   * The change that motivated v0.069: the streamlined classes used to be the
   * flat constants 0.10 and 0.22 regardless of the rocket. They are now the
   * design's own body CD, so the SAME bump on a different airframe gets a
   * different Cd — which is the entire content of RASAero's method and the
   * thing a constant cannot express.
   */
  it('the streamlined Cd is the design\'s body CD, so it moves with the airframe', () => {
    const fat = protTree({});
    const body = bodyDragReference(fat);
    expect(protuberanceCd(fat, findNode(fat, 'x1')!)).toBeCloseTo(body.withBase, 12);

    // A slender 60 mm sport airframe: more wetted area per unit reference
    // area, so a markedly higher body CD than the 200 mm tub above.
    const slim: RocketTree = {
      name: 'slim',
      components: [{
        type: 'stage', id: 's1',
        children: [
          { type: 'nosecone', id: 'n1', length: 0.25, aftRadius: 0.03, thickness: 0.002, shape: 'ogive' },
          { type: 'bodytube', id: 'b1', length: 1.35, outerRadius: 0.03, thickness: 0.001 } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const slimBody = bodyDragReference(slim);
    expect(slimBody.measured).toBe(true);
    expect(slimBody.noBase).toBeGreaterThan(body.noBase * 1.5);
    // …and on that airframe the method lands WELL above the retired 0.10/0.22
    // constants, which is the 2–3× shortfall the TRF 197641 #1 method exposed.
    expect(slimBody.noBase).toBeGreaterThan(0.10);
    expect(slimBody.withBase).toBeGreaterThan(0.22);
  }, 60000);

  it('follows 1.17·sin²θ for an inclined flat plate, θ in RADIANS', () => {
    const at = (deg: number) => findNode(
      engineTree(protTree({ dragClass: 'plate', plateAngle: (deg * Math.PI) / 180 })), 'x1',
    )!['overrideCD'] as number;
    expect(at(90)).toBeCloseTo((1.17 * 0.001) / aRef, 12);
    expect(at(45)).toBeCloseTo((1.17 * 0.5 * 0.001) / aRef, 12);
    expect(at(30)).toBeCloseTo((1.17 * 0.25 * 0.001) / aRef, 12);
    expect(at(0)).toBe(0);
    // Out-of-range angles clamp instead of producing nonsense.
    expect(at(200)).toBeCloseTo(at(90), 12);
    expect(at(-30)).toBe(0);
  });

  it('lets an explicit frontal Cd beat the class', () => {
    const cd = findNode(engineTree(protTree({ dragClass: 'plate', cdFrontal: 0.5 })), 'x1')!['overrideCD'] as number;
    expect(cd).toBeCloseTo((0.5 * 0.001) / aRef, 12);
  });

  it('bills a typed mass and nothing when it is left at zero', () => {
    expect(findNode(engineTree(protTree({ mass: 0.12 })), 'x1')!['overrideMass']).toBeCloseTo(0.12, 12);
    expect(findNode(engineTree(protTree({})), 'x1')!['overrideMass']).toBe(0);
  });

  it('leaves the editing tree untouched', () => {
    const src = protTree({});
    engineTree(src);
    expect(findNode(src, 'x1')!.type as string).toBe('protuberance');
  });

  it('is offered on a body tube and carries a full schema entry', () => {
    expect(allowedChildren('bodytube')).toContain('protuberance');
    expect(DISPLAY_NAME.protuberance).toBeTruthy();
    expect(FIELDS.protuberance.length).toBeGreaterThan(0);
    // A fresh one is a sane cable tunnel, not a zero-area no-op.
    const fresh = makeNode('protuberance');
    expect(fresh['dragClass']).toBe('streamlinedbase');
    expect(fresh['width'] as number).toBeGreaterThan(0);
    expect(fresh['height'] as number).toBeGreaterThan(0);
    expect(fresh['mass']).toBe(0);
  });
});

/**
 * The mass field is in the mass/CG path — deliberately, because it is trivially
 * right: the lowering sets it as an ordinary mass override on the carrier, so
 * the kernel bills it in full at the component's own station. MEASURED on the
 * ARCAS Long fixture (2026-08-25): 45 g typed → rocket mass 0.251720724 kg
 * becomes 0.296720724 (exactly +0.045), CG 0.7835511475 → 0.7846934114, which
 * is the closed-form weighted average to the last bit.
 */
describe('engineTree — a protuberance mass is billed exactly, at its own station', () => {
  it('adds the typed mass and moves CG by the weighted average', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const design = (mass: number): RocketTree => ({
      name: 'M',
      components: [{
        type: 'stage', id: 's1',
        children: [
          { type: 'nosecone', id: 'n1', length: 0.15, aftRadius: 0.026, thickness: 0.002, shape: 'ogive', density: 680 },
          {
            type: 'bodytube', id: 'b1', length: 0.6, outerRadius: 0.026, thickness: 0.001, density: 680,
            children: [{
              type: 'protuberance', id: 'x1', dragClass: 'streamlinedbase',
              width: 0.02, height: 0.01, length: 0.06, count: 1, mass,
              position: { method: 'middle', offset: 0 },
            } as unknown as ComponentNode],
          } as ComponentNode,
        ],
      } as ComponentNode],
    });
    const info = (mass: number) => {
      resetEngine();
      return OrkRocket.buildTree(engineTree(design(mass))).staticInfo();
    };
    const a = info(0);
    const b = info(0.045);
    expect(b.mass - a.mass).toBeCloseTo(0.045, 12);
    // Its station: the same one the kernel reports for the carrier component.
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(design(0.045)));
    const x = rocket.componentInfo('x1').positionX;
    expect((a.mass * a.cg + 0.045 * x) / (a.mass + 0.045)).toBeCloseTo(b.cg, 12);
    // A zero mass bills nothing at all — the default, and what an imported
    // RASAero protuberance always has (the file carries no mass data).
    expect(info(0).mass).toBe(a.mass);
  }, 60000);
});

/**
 * THE REFERENCE AREA IS THE KERNEL'S, NOT THE TREE'S FATTEST RADIUS.
 *
 * A CD override arrives at the kernel ALREADY referenced to the kernel's own
 * reference area and is summed into total CD untouched
 * (BarrowmanCalculator.calculateOverrideCD l. 1141, added at l. 348), so
 * treeModel.referenceArea has to be the area the kernel picked, exactly.
 *
 * The kernel's is ReferenceType.MAXIMUM (Rocket.java l. 64): the greatest
 * SymmetricComponent diameter and nothing else (ReferenceType.java ll. 24–40).
 * A TubeFinSet is not a SymmetricComponent — it extends Tube extends
 * ExternalComponent (TubeFinSet.java l. 20) — so tube fins fatter than the
 * airframe do not widen it, and neither do launch lugs, inner tubes, couplers,
 * centering rings, bulkheads or engine blocks, every one of which nevertheless
 * carries an `outerRadius` in this app's tree.
 *
 * This design is that trap: a 24 mm airframe wearing 40 mm tube fins. MEASURED
 * 2026-08-25 — the kernel reports refDiameter 0.024 m with the tube fins in
 * place, so the reference area is π·0.012² = 0.000452389 m² and this 200 mm²
 * bump's own method calls for +0.2030053 CD (body CD 0.459187 with base drag at
 * Mach 0.3). Taking the tube fin's 20 mm instead — what a scan of every node's
 * `outerRadius` does — is 2.7778× the area and delivers +0.0730819: a third of
 * the drag, with the property panel printing the third as fact.
 */
describe('engineTree — the protuberance reference area is the kernel\'s own', () => {
  // 3 tubes of 40 mm cannot touch each other on a 24 mm body, so the kernel
  // raises TUBE_SEPARATION here. That is honest and beside the point: the
  // subject is which components feed the reference area.
  const tubeFinTree = (): RocketTree => ({
    name: 'tf',
    components: [{
      type: 'stage', id: 's1',
      children: [
        {
          type: 'nosecone', id: 'n1', length: 0.07, aftRadius: 0.012,
          thickness: 0.002, shape: 'ogive', density: 680,
        },
        {
          type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.012,
          thickness: 0.0005, density: 680,
          children: [
            {
              type: 'tubefinset', id: 'tf1', finCount: 3, length: 0.08, outerRadius: 0.02,
              thickness: 0.0005, density: 680, position: { method: 'bottom', offset: 0 },
            } as ComponentNode,
            {
              type: 'protuberance', id: 'x1', name: 'Bump', dragClass: 'streamlinedbase',
              width: 0.02, height: 0.01, length: 0.06, count: 1, mass: 0,
              position: { method: 'middle', offset: 0 },
            } as unknown as ComponentNode,
          ],
        } as ComponentNode,
      ],
    } as ComponentNode],
  });

  it('takes the body diameter, not the tube fins — and delivers what it asks', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const tree = tubeFinTree();

    // The area itself: the body's, not the 40 mm tube fins'.
    expect(referenceArea(tree)).toBeCloseTo(Math.PI * 0.012 ** 2, 12);

    const body = bodyDragReference(tree);
    expect(body.measured).toBe(true);
    expect(body.withBase).toBeCloseTo(0.459187, 6);
    const asked = protuberanceDeliveredCd(tree, findNode(tree, 'x1')!);
    expect(asked).toBeCloseTo(0.2030053, 7);
    // The bug this pins: referencing to the tube fin instead of the body was
    // (12/20)² of the CD — 0.0730819, which is what used to be delivered.
    expect(asked * (0.012 ** 2 / 0.02 ** 2)).toBeCloseTo(0.0730819, 7);

    const strip = (ns: ComponentNode[]): ComponentNode[] => ns
      .filter((n) => n.id !== 'x1')
      .map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
    const without: RocketTree = { ...tree, components: strip(tree.components) };

    const opts = { machMin: 0.05, machMax: 3, machStep: 0.05, aoaDeg: 0 };
    const run = (t: RocketTree) => {
      resetEngine();
      const rocket = OrkRocket.buildTree(engineTree(t));
      return { info: rocket.staticInfo(), sweep: rocket.dragSweep(opts) };
    };
    const a = run(tree);
    const b = run(without);

    // The kernel agrees on the area everything is referenced to…
    expect(a.info.refDiameter).toBeCloseTo(0.024, 12);
    expect(referenceArea(tree)).toBeCloseTo(Math.PI * (a.info.refDiameter / 2) ** 2, 12);
    expect(b.info.refDiameter).toBe(a.info.refDiameter);
    // …so asked X, delivered X, at every Mach, in the override bucket alone.
    for (let i = 0; i < a.sweep.machs.length; i++) {
      expect(a.sweep.powerOff.total[i]! - b.sweep.powerOff.total[i]!).toBeCloseTo(asked, 9);
      expect(a.sweep.powerOff.friction[i]!).toBeCloseTo(b.sweep.powerOff.friction[i]!, 12);
      expect(a.sweep.powerOff.pressure[i]!).toBeCloseTo(b.sweep.powerOff.pressure[i]!, 12);
      expect(a.sweep.powerOff.base[i]!).toBeCloseTo(b.sweep.powerOff.base[i]!, 12);
    }
  }, 60000);

  it('ignores every other outerRadius in the tree — lug, mount, coupler', () => {
    // LaunchLug and TubeFinSet extend Tube; InnerTube and TubeCoupler are
    // RingComponents. None is a SymmetricComponent, and the kernel reports
    // refDiameter 0.024 for this airframe with each of them added (measured
    // 2026-08-25) — so none may move this number either.
    const base = tubeFinTree();
    const stage = base.components[0]!;
    const body = stage.children![1]!;
    const fat: RocketTree = {
      ...base,
      components: [{
        ...stage,
        children: [stage.children![0]!, {
          ...body,
          children: [
            ...body.children!,
            {
              type: 'launchlug', id: 'lg', length: 0.05, outerRadius: 0.01,
              thickness: 0.0003, position: { method: 'middle', offset: 0 },
            } as ComponentNode,
            {
              type: 'innertube', id: 'it', length: 0.07, outerRadius: 0.03,
              thickness: 0.0005, position: { method: 'bottom', offset: 0 },
            } as ComponentNode,
            { type: 'tubecoupler', id: 'tc', length: 0.05, outerRadius: 0.03, thickness: 0.0005 } as ComponentNode,
          ],
        } as ComponentNode],
      } as ComponentNode],
    };
    expect(referenceArea(fat)).toBe(referenceArea(base));
    expect(referenceArea(fat)).toBeCloseTo(Math.PI * 0.012 ** 2, 12);
  });
});

describe('referenceArea — an automatic transition radius with no neighbour', () => {
  /**
   * An absent transition radius means AUTOMATIC. With a symmetric neighbour on
   * that side the kernel copies ITS radius, which the scan has already counted,
   * so contributing 0 is right. With NO neighbour the kernel substitutes
   * SymmetricComponent.DEFAULT_RADIUS = 0.025 m instead — a radius nothing else
   * in the tree carries — and scanning the stated radii alone silently misses
   * it. Found by verification 2026-08-25b: on this 38 mm airframe the kernel
   * flies a 19 → 25 mm flare and reports refDiameter 0.050 m, where the scan
   * returned 0.038 m — 0.578x of the area, so a protuberance there under-asked
   * by 1.73x while the docblock promised "EXACTLY the kernel's own".
   */
  const airframe = (aft?: number): RocketTree => ({
    name: 'r',
    components: [{
      type: 'stage', id: 's1',
      children: [
        { type: 'nosecone', id: 'n1', length: 0.2, aftRadius: 0.019, thickness: 0.002, shape: 'ogive' },
        { type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.019, thickness: 0.001 },
        {
          type: 'transition', id: 't1', length: 0.05, foreRadius: 0.019, thickness: 0.001,
          shape: 'conical', ...(aft === undefined ? {} : { aftRadius: aft }),
        } as unknown as ComponentNode,
      ],
    } as ComponentNode],
  });

  it('takes the kernel\'s DEFAULT_RADIUS when the automatic side has nothing to copy', () => {
    // Last component, aft side automatic ⇒ 0.025 m, which beats the 0.019 body.
    expect(referenceArea(airframe())).toBeCloseTo(Math.PI * 0.025 ** 2, 12);
  });

  it('still contributes nothing when the automatic side HAS a neighbour', () => {
    // Stated aft radius: the transition can only lower the max, never raise it.
    expect(referenceArea(airframe(0.01))).toBeCloseTo(Math.PI * 0.019 ** 2, 12);
  });

  it('matches what the kernel actually builds', async () => {
    const { OrkRocket } = await import('@online-openrocket/engine');
    for (const aft of [undefined, 0.01]) {
      const tree = airframe(aft);
      const info = OrkRocket.buildTree(engineTree(tree)).staticInfo();
      expect(referenceArea(tree)).toBeCloseTo(Math.PI * (info.refDiameter / 2) ** 2, 12);
    }
  }, 60000);
});

describe('bodyDragReference caches', () => {
  const body = (radius: number): RocketTree => ({
    name: 'r',
    components: [{
      type: 'stage', id: 's1',
      children: [
        { type: 'nosecone', id: 'n1', length: 0.3, aftRadius: radius, thickness: 0.002, shape: 'ogive' },
        { type: 'bodytube', id: 'b1', length: 0.5, outerRadius: radius, thickness: 0.001 },
      ],
    } as unknown as ComponentNode],
  });

  it('is keyed on SHAPE, so a rename is free and a resize is not', () => {
    resetBodyDragCache();
    const first = bodyDragReference(body(0.05));
    expect(first.measured).toBe(true);
    // A different tree OBJECT with the same stripped shape: the WeakMap misses
    // and the shape key hits, so the answer is the identical object.
    const renamed = body(0.05);
    (renamed.components[0] as ComponentNode).name = 'Renamed stage';
    expect(bodyDragReference(renamed)).toBe(first);
    // A real geometry change must NOT hit.
    expect(bodyDragReference(body(0.06))).not.toBe(first);
  }, 60000);

  it('promotes on a hit, so the airframe in use is not the one evicted', () => {
    resetBodyDragCache();
    const hot = bodyDragReference(body(0.05));
    // Fill past the 8-entry cap, touching `hot` between each insert. Under the
    // old insert-ordered eviction the entry being asked for repeatedly was the
    // first one out; with promotion it is the last.
    for (let i = 0; i < 12; i++) {
      bodyDragReference(body(0.06 + i * 0.001));
      expect(bodyDragReference(body(0.05))).toBe(hot);
    }
  }, 60000);

  it('never caches an unmeasured probe, so one kernel failure is not permanent', () => {
    resetBodyDragCache();
    // A stage that strips to nothing: no symmetric component survives, the
    // sweep has no drag, and the fallback pair stands in.
    const empty: RocketTree = {
      name: 'r',
      components: [{
        type: 'stage', id: 's1',
        children: [{ type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.1, tipChord: 0.05, sweep: 0.03, height: 0.05, thickness: 0.003 }],
      } as unknown as ComponentNode],
    };
    // Fill the 8-slot shape cache with real airframes first, so that a cached
    // failure would have to EVICT one of them — which is how "was it cached?"
    // becomes observable at all (the fallback is a shared constant, so its
    // identity says nothing).
    const shapes = Array.from({ length: 8 }, (_, i) => 0.05 + i * 0.001);
    const before = shapes.map((r) => bodyDragReference(body(r)));
    expect(before.every((b) => b.measured)).toBe(true);

    const miss = bodyDragReference(empty);
    expect(miss.measured).toBe(false);

    // Fresh tree objects, so the WeakMap cannot answer and the SHAPE cache has
    // to. All eight must still be there: under the old code the failure was
    // written into the cache and pushed the oldest airframe out.
    shapes.forEach((r, i) => {
      expect(bodyDragReference(body(r)), `airframe ${r} was evicted by a failed probe`)
        .toBe(before[i]);
    });
  }, 60000);
});

/**
 * v0.089 — the shroud's mounting angle steers its strake's lift.
 *
 * The lowering passes `angleOffset` through as the kernel fin-set `rotation`
 * (FinSet.setBaseRotation). The physics consequence is pinned END TO END below
 * against the real kernel: at the design tab's theta = 0 a side-mounted shroud
 * (±90°) contributes its full strake CNa and a top/bottom one contributes
 * none — cna·sin²(theta − angle), the kernel's own one-fin arithmetic.
 */
describe('camera shroud mounting angle reaches the kernel', () => {
  const withShroud = (angle?: number): RocketTree => ({
    name: 'R',
    components: [{
      type: 'stage', id: 's1', children: [
        { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.025, thickness: 0.002 },
        {
          id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.025, thickness: 0.001,
          children: [
            { id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.08, tipChord: 0.04,
              sweep: 0.03, height: 0.05, thickness: 0.003, position: { method: 'bottom', offset: 0 } },
            { id: 'sh', type: 'fairing', length: 0.08, width: 0.025, height: 0.02, mass: 0.03,
              ...(angle === undefined ? {} : { angleOffset: angle }),
              position: { method: 'middle', offset: 0 } },
          ],
        },
      ],
    }],
  } as unknown as RocketTree);

  const strakeOf = (t: RocketTree) => {
    const lowered = engineTree(t);
    const body = lowered.components[0]!.children!.find((c) => c.type === 'bodytube')!;
    return body.children!.find((c) => c.type === 'freeformfinset' && c.id === 'sh')!;
  };

  it('passes angleOffset through as the kernel rotation, radians, no sign flip', () => {
    expect(strakeOf(withShroud())['rotation']).toBe(0);
    expect(strakeOf(withShroud(Math.PI / 2))['rotation']).toBeCloseTo(Math.PI / 2, 12);
  });

  it('a side-mounted shroud moves CP/CNa; a top-mounted one does not (theta = 0)', () => {
    const at = (angle: number) => OrkRocket.buildTree(engineTree(withShroud(angle))).staticInfo();
    const top = at(0);
    const side = at(Math.PI / 2);
    const opposite = at(Math.PI);

    // Top and bottom mounts are bit-identical in the static figures: the
    // strake's sin² factor is zero in the measured plane for both.
    expect(opposite.cna).toBe(top.cna);
    expect(opposite.cp).toBe(top.cp);

    // A side mount adds the strake's own CNa and pulls CP forward — the
    // full-strength case, and the one the owner cares about (a camera pointed
    // between the fins is a side mount).
    expect(side.cna).toBeGreaterThan(top.cna + 0.1);
    expect(side.cp).toBeLessThan(top.cp - 1e-4);

    // Drag does not care about the angle: the CD override is frontal-area
    // based. (Compare at fixed Mach through the sweep.)
    const sweepTop = OrkRocket.buildTree(engineTree(withShroud(0)))
      .dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 1 }).powerOff.total[0]!;
    const sweepSide = OrkRocket.buildTree(engineTree(withShroud(Math.PI / 2)))
      .dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 1 }).powerOff.total[0]!;
    expect(sweepSide).toBe(sweepTop);
  });
});
