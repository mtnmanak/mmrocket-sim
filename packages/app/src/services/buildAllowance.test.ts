import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import {
  BUILD_ALLOWANCE_NAME,
  coveringMassOverride,
  findAllowance,
  placeAtStation,
  solveBallast,
  withoutAllowance,
} from './buildAllowance.js';

/**
 * The "Measured mass & CG" arithmetic (issues-2026-08-23a.md §5).
 *
 * The worked example and the impossible-station table below are the ones the
 * owner was shown when he approved the feature, so they are pinned verbatim:
 * a rocket computed at 500 g balancing 400 mm from the tip, weighed at 560 g
 * balancing at 415 mm, needs 60 g at 540 mm.
 */
describe('solveBallast', () => {
  const base = {
    computedMassKg: 0.5,
    computedCgM: 0.4,
    rocketLengthM: 1.0,
  };

  it('solves the worked example exactly', () => {
    const r = solveBallast({ ...base, measuredMassKg: 0.56, measuredCgM: 0.415 });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.massKg).toBeCloseTo(0.06, 12);
    expect(r.stationM).toBeCloseTo(0.54, 12);
  });

  it('puts the CG exactly where it was measured', () => {
    const measuredMassKg = 0.56;
    const measuredCgM = 0.415;
    const r = solveBallast({ ...base, measuredMassKg, measuredCgM });
    if (r.kind !== 'ok') throw new Error('expected a solution');
    // Re-derive the combined CG from the parts: it must be the measured one.
    const combined = (base.computedMassKg * base.computedCgM + r.massKg * r.stationM)
      / (base.computedMassKg + r.massKg);
    expect(combined).toBeCloseTo(measuredCgM, 12);
    expect(base.computedMassKg + r.massKg).toBeCloseTo(measuredMassKg, 12);
  });

  it('reports a station ahead of the nose tip as unreachable', () => {
    const r = solveBallast({ ...base, measuredMassKg: 0.56, measuredCgM: 0.35 });
    expect(r.kind).toBe('unreachable');
    if (r.kind !== 'unreachable') return;
    expect(r.stationM).toBeCloseTo(-0.0666666666, 8);
  });

  it('reports a station past the tail as unreachable', () => {
    const r = solveBallast({ ...base, measuredMassKg: 0.56, measuredCgM: 0.6 });
    expect(r.kind).toBe('unreachable');
    if (r.kind !== 'unreachable') return;
    expect(r.stationM).toBeCloseTo(2.2666666666, 8);
  });

  it('accepts the two stations from the table that ARE on the rocket', () => {
    expect(solveBallast({ ...base, measuredMassKg: 0.56, measuredCgM: 0.395 }).kind).toBe('ok');
    expect(solveBallast({ ...base, measuredMassKg: 0.56, measuredCgM: 0.415 }).kind).toBe('ok');
  });

  it('will not invent negative ballast when the model is the heavy one', () => {
    const r = solveBallast({ ...base, measuredMassKg: 0.44, measuredCgM: 0.4 });
    expect(r.kind).toBe('overweight-model');
    if (r.kind !== 'overweight-model') return;
    expect(r.excessKg).toBeCloseTo(0.06, 12);
  });

  it('says so when the build already matches', () => {
    expect(solveBallast({ ...base, measuredMassKg: 0.5, measuredCgM: 0.4 }).kind).toBe('matches');
  });

  it('separates "right mass, wrong balance" — which no added mass can fix', () => {
    const r = solveBallast({ ...base, measuredMassKg: 0.5, measuredCgM: 0.43 });
    expect(r.kind).toBe('cg-only');
    if (r.kind !== 'cg-only') return;
    expect(r.cgErrorM).toBeCloseTo(0.03, 12);
  });
});

describe('withoutAllowance', () => {
  it('is the exact inverse of adding the ballast', () => {
    // 500 g @ 400 mm plus 60 g @ 540 mm is 560 g @ 415 mm.
    const bare = withoutAllowance(0.56, 0.415, 0.06, 0.54);
    expect(bare.massKg).toBeCloseTo(0.5, 12);
    expect(bare.cgM).toBeCloseTo(0.4, 12);
  });

  it('re-solving with the same measurements asks for the same ballast', () => {
    // The re-edit path: without backing the existing allowance out first, a
    // second solve would stack a second correction on top of the first.
    const bare = withoutAllowance(0.56, 0.415, 0.06, 0.54);
    const again = solveBallast({
      computedMassKg: bare.massKg,
      computedCgM: bare.cgM,
      measuredMassKg: 0.56,
      measuredCgM: 0.415,
      rocketLengthM: 1,
    });
    if (again.kind !== 'ok') throw new Error('expected a solution');
    expect(again.massKg).toBeCloseTo(0.06, 12);
    expect(again.stationM).toBeCloseTo(0.54, 12);
  });

  it('leaves the figures alone rather than dividing by ~zero', () => {
    expect(withoutAllowance(0.06, 0.54, 0.06, 0.54)).toEqual({ massKg: 0.06, cgM: 0.54 });
  });
});

/** Nose 150 mm + tube 500 mm + tube 350 mm = 1.0 m of airframe. */
const TREE: RocketTree = {
  components: [{
    type: 'stage',
    id: 'stage1',
    children: [
      { type: 'nosecone', id: 'nose', length: 0.15, aftRadius: 0.025, thickness: 0.002 },
      { type: 'bodytube', id: 'tubeA', length: 0.5, outerRadius: 0.025, thickness: 0.001 },
      { type: 'bodytube', id: 'tubeB', length: 0.35, outerRadius: 0.025, thickness: 0.001 },
    ],
  }],
} as unknown as RocketTree;

describe('placeAtStation', () => {
  it('puts the component MIDPOINT at the requested station', () => {
    // A mass component's CG is its own midpoint, so a 20 mm part wanting its
    // CG at 540 mm must start at 530 mm — 380 mm into tubeA (which starts at 150).
    const p = placeAtStation(TREE, 0.54, 0.02);
    expect(p).not.toBeNull();
    expect(p!.parentId).toBe('tubeA');
    expect(p!.offset).toBeCloseTo(0.38, 12);
  });

  it('lands in the nose cone for a forward station', () => {
    const p = placeAtStation(TREE, 0.08, 0.02);
    expect(p!.parentId).toBe('nose');
    expect(p!.offset).toBeCloseTo(0.07, 12);
  });

  it('lands in the aft tube for a rearward station', () => {
    const p = placeAtStation(TREE, 0.9, 0.02);
    expect(p!.parentId).toBe('tubeB');
    // tubeB starts at 0.65; front wants 0.89 -> offset 0.24
    expect(p!.offset).toBeCloseTo(0.24, 12);
  });

  it('clamps to the airframe rather than returning nothing', () => {
    expect(placeAtStation(TREE, -0.5, 0.02)!.parentId).toBe('nose');
    expect(placeAtStation(TREE, 99, 0.02)!.parentId).toBe('tubeB');
  });

  it('gives up on a design with no body components at all', () => {
    expect(placeAtStation({ components: [] } as unknown as RocketTree, 0.5, 0.02)).toBeNull();
  });
});

describe('findAllowance', () => {
  it('finds the component by its name, wherever it sits', () => {
    const withBallast = {
      components: [{
        type: 'stage',
        id: 'stage1',
        children: [{
          type: 'bodytube',
          id: 'tubeA',
          length: 0.5,
          children: [
            { type: 'masscomponent', id: 'other', name: 'Altimeter', mass: 0.02 },
            { type: 'masscomponent', id: 'ba', name: BUILD_ALLOWANCE_NAME, mass: 0.06 },
          ],
        }],
      }],
    } as unknown as RocketTree;
    expect(findAllowance(withBallast)?.id).toBe('ba');
  });

  it('returns null when the design carries none', () => {
    expect(findAllowance(TREE)).toBeNull();
  });
});

/**
 * A mass override with the subcomponents flag replaces the mass of everything
 * inside it — so ballast added under it weighs exactly nothing. v0.073 shipped
 * that as a SILENT no-op: type your scale reading, press Apply, a component
 * appears in the tree, and no number moves. RASAero .CDX1 imports pin every
 * stage this way, so it is reachable by anyone importing one and then weighing
 * their build.
 */
describe('coveringMassOverride — what would swallow a Build allowance', () => {
  const rocket = (stagePatch: Record<string, unknown> = {}): RocketTree => ({
    name: 'R',
    components: [{
      id: 'stage1', type: 'stage', name: 'Sustainer', ...stagePatch,
      children: [
        { id: 'nose', type: 'nosecone', name: 'Nose', length: 0.1, children: [] },
        { id: 'tube', type: 'bodytube', name: 'Body', length: 0.3, children: [] },
      ],
    }] as unknown as RocketTree['components'],
  });

  it('an ordinary design has nothing in the way', () => {
    expect(coveringMassOverride(rocket(), 0.2, 0.02)).toBeNull();
  });

  it('finds the stage that stands in for its children', () => {
    const found = coveringMassOverride(
      rocket({ overrideMass: 2, overrideSubcomponentsMass: true }), 0.2, 0.02);
    expect(found?.id).toBe('stage1');
  });

  it('needs BOTH the flag and a value — the kernel’s own rule', () => {
    // The flag rides along in .ork files whether or not a value is set;
    // testing it alone would tell a user their number is being covered when
    // it is doing exactly what they typed.
    expect(coveringMassOverride(
      rocket({ overrideSubcomponentsMass: true }), 0.2, 0.02)).toBeNull();
    expect(coveringMassOverride(
      rocket({ overrideMass: 2 }), 0.2, 0.02)).toBeNull();
  });

  it('catches an override on the HOST body component, not just an ancestor', () => {
    // ancestorsOf() starts at the parent, so the component the ballast is
    // placed inside has to be tested separately.
    const t = rocket();
    const tube = (t.components[0] as unknown as { children: Record<string, unknown>[] }).children[1]!;
    tube['overrideMass'] = 0.4;
    tube['overrideSubcomponentsMass'] = true;
    // Station 0.2 m lands in the body tube (nose is 0-0.1, tube 0.1-0.4).
    expect(coveringMassOverride(t, 0.2, 0.02)?.id).toBe('tube');
    // ...and a station in the nose is unaffected by the tube's override.
    expect(coveringMassOverride(t, 0.05, 0.02)).toBeNull();
  });
});
