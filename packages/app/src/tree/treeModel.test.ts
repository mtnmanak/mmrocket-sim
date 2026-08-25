import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { engineTree, findNode, hasParallelStage, makeNode, motorMounts, normalizeTree, splitClusterPairsTree, splitClusterTree } from './treeModel.js';
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
    // Hoerner half-round 0.55 · frontal (0.025·0.02) / (π·0.05²)
    expect(strake['overrideCD']).toBeCloseTo((0.55 * 0.025 * 0.02) / (Math.PI * 0.05 * 0.05), 9);
    const pts = strake['points'] as [number, number][];
    expect(pts[2]).toEqual([0.08, 0.02]);
  });

  it('streamlined shape ramps the profile and drops the CD', () => {
    const out = engineTree(fairingTree({ fairingShape: 'streamlined' }));
    const strake = findNode(out, 'f1')!;
    const pts = strake['points'] as [number, number][];
    expect(pts[1]![0]).toBeCloseTo(0.024, 9); // 0.3·L ramp
    expect(strake['overrideCD']).toBeCloseTo((0.25 * 0.025 * 0.02) / (Math.PI * 0.05 * 0.05), 9);
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
 */
describe('engineTree — protuberance lowering', () => {
  const protTree = (params: Record<string, unknown>): RocketTree => ({
    name: 'p',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        // 100 mm radius body ⇒ reference area π·0.1² = 0.0314159 m².
        type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.1,
        children: [{
          type: 'protuberance', id: 'x1', name: 'Bump',
          width: 0.05, height: 0.02, length: 0.1, count: 1, mass: 0,
          position: { method: 'middle', offset: 0.02 },
          ...params,
        } as unknown as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });
  const aRef = Math.PI * 0.1 * 0.1;

  it('becomes a rail button whose CD override IS frontal area × Cd ÷ reference area', () => {
    const out = engineTree(protTree({ dragClass: 'streamlinedbase' }));
    const carrier = findNode(out, 'x1')!;
    expect(carrier.type).toBe('railbutton');
    expect(carrier.name).toBe('Bump');
    // 0.10 (faired fore body) + 0.12 (blunt base) = 0.22 on 0.05 × 0.02 m².
    expect(carrier['overrideCD']).toBeCloseTo((0.22 * 0.001) / aRef, 12);
    expect(carrier['overrideMass']).toBe(0);
    expect(carrier.position).toEqual({ method: 'middle', offset: 0.02 });
  });

  it('scales linearly with count — n identical bumps are n times the area', () => {
    const one = findNode(engineTree(protTree({})), 'x1')!['overrideCD'] as number;
    const four = findNode(engineTree(protTree({ count: 4 })), 'x1')!['overrideCD'] as number;
    expect(four).toBeCloseTo(4 * one, 12);
  });

  it('drops the base-drag term for the streamlined class', () => {
    const cd = findNode(engineTree(protTree({ dragClass: 'streamlined' })), 'x1')!['overrideCD'] as number;
    expect(cd).toBeCloseTo((0.10 * 0.001) / aRef, 12);
  });

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
