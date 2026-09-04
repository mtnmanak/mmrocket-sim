// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import type { RocketTree } from '@online-openrocket/engine';
import { shroudEnds } from '../tree/shroud.js';

/**
 * Round-trip of the fields added for the 2026-07-03 issue list: nose shoulder,
 * solid (filled), surface finish, mass/CG/Cd overrides, and recovery-device
 * deployment configuration. The exported XML for this same tree is validated
 * against the real OpenRocket 24.12 loader with bit-exact mass AND CG parity
 * (from user testing); these assertions guard the mapping.
 */
describe('.ork round-trip of fairing (camera shroud) and spill hole extensions', () => {
  const tree: RocketTree = {
    name: 'Ext',
    components: [{
      type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.02, thickness: 0.001,
      motorMount: true, caseAirframe: true,
      children: [
        {
          type: 'fairing', id: 'f1', length: 0.09, width: 0.03, height: 0.022,
          fairingShape: 'streamlined', mass: 0.052, finish: 'smooth',
          position: { method: 'middle', offset: 0.01 },
        },
        {
          type: 'trapezoidfinset', id: 'fin1', finCount: 4, rootChord: 0.06,
          tipChord: 0.03, sweep: 0.02, height: 0.04, thickness: 0.003,
          rotation: Math.PI / 4,
        },
        { type: 'tubefinset', id: 'tf1', finCount: 6, length: 0.1, thickness: 0.0005, rotation: Math.PI / 6 },
        { type: 'parachute', id: 'p1', diameter: 0.45, cd: 2.2, spillHoleDiameter: 0.1 },
      ],
    }],
  };

  it('round-trips both extension tags', () => {
    const back = importOrk(exportOrk({ name: 'Ext', tree }));
    const chain = back.tree.components[0]!.children!;
    const body = chain[0]!;
    const fairing = body.children!.find((c) => c.type === 'fairing')!;
    expect(fairing['length']).toBeCloseTo(0.09, 9);
    expect(fairing['width']).toBeCloseTo(0.03, 9);
    expect(fairing['height']).toBeCloseTo(0.022, 9);
    expect(fairing['fairingShape']).toBe('streamlined');
    expect(fairing['mass']).toBeCloseTo(0.052, 9);
    const chute = body.children!.find((c) => c.type === 'parachute')!;
    expect(chute['cd']).toBeCloseTo(2.2, 9);
    expect(chute['spillHoleDiameter']).toBeCloseTo(0.1, 9);
    // Fin-set rotation (.ork stores degrees; we keep radians).
    const fins = body.children!.find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['rotation']).toBeCloseTo(Math.PI / 4, 9);
    const tubes = body.children!.find((c) => c.type === 'tubefinset')!;
    expect(tubes['rotation']).toBeCloseTo(Math.PI / 6, 9);
    // Sub-minimum flag (2026-08-05e) rides its own extension tag.
    expect(body['motorMount']).toBe(true);
    expect(body['caseAirframe']).toBe(true);
  });
});

describe('.ork round-trip of shoulder/filled/finish/override/deployment fields', () => {
  const tree: RocketTree = {
    name: 'FeatureSample',
    components: [
      {
        type: 'nosecone', id: 'n1', length: 0.07, aftRadius: 0.012, shape: 'haack',
        filled: true, shoulderRadius: 0.0115, shoulderLength: 0.03,
        shoulderThickness: 0.002, shoulderCapped: true,
        finish: 'polished', overrideMass: 0.05,
      },
      {
        type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
        density: 680, finish: 'rough', overrideCD: 0.4,
        children: [
          {
            type: 'parachute', id: 'p1', diameter: 0.3, deployEvent: 'altitude',
            deployAltitude: 120, deployDelay: 1.5, overrideCGX: 0.01,
            position: { method: 'top', offset: 0.02 },
          },
          {
            type: 'innertube', id: 'mt', length: 0.07, outerRadius: 0.0095,
            thickness: 0.0005, motorMount: true, position: { method: 'bottom', offset: 0 },
          },
        ],
      },
      {
        type: 'transition', id: 't1', length: 0.04, foreRadius: 0.012, aftRadius: 0.009,
        thickness: 0.002, foreShoulderRadius: 0.011, foreShoulderLength: 0.02,
        aftShoulderRadius: 0.008, aftShoulderLength: 0.015,
      },
    ],
  };

  it('preserves every new field through export → import', () => {
    const back = importOrk(exportOrk({ name: 'FeatureSample', tree }));
    // Release C: imports are stage-wrapped — the chain sits in stage 0.
    const chain = back.tree.components[0]!.children!;

    const nose = chain[0]!;
    expect(nose['filled']).toBe(true);
    expect(nose['shoulderRadius']).toBeCloseTo(0.0115);
    expect(nose['shoulderLength']).toBeCloseTo(0.03);
    expect(nose['shoulderThickness']).toBeCloseTo(0.002);
    expect(nose['shoulderCapped']).toBe(true);
    expect(nose['finish']).toBe('polished');
    expect(nose['overrideMass']).toBeCloseTo(0.05);
    // Engine default for haack is 0 — a 1.0 fallback silently reshapes the nose.
    expect(nose['shapeParameter']).toBe(0);

    const body = chain[1]!;
    expect(body['finish']).toBe('rough');
    expect(body['overrideCD']).toBeCloseTo(0.4);

    const trans = chain.find((c) => c.type === 'transition')!;
    expect(trans['filled']).toBeUndefined();
    expect(trans['foreShoulderRadius']).toBeCloseTo(0.011);
    expect(trans['aftShoulderLength']).toBeCloseTo(0.015);

    const chute = body.children!.find((c) => c.type === 'parachute')!;
    expect(chute['deployEvent']).toBe('altitude');
    expect(chute['deployAltitude']).toBeCloseTo(120);
    expect(chute['deployDelay']).toBeCloseTo(1.5);
    expect(chute['overrideCGX']).toBeCloseTo(0.01);
  });

  it('keeps solid components solid (thickness element carries "filled")', () => {
    const xml = exportOrk({ name: 'FeatureSample', tree });
    expect(xml).toContain('<thickness>filled</thickness>');
    expect(xml).toContain('<deployevent>altitude</deployevent>');
    expect(xml).toContain('<overridemass>0.05</overridemass>');
  });
});

describe('.ork round-trip of cluster configuration', () => {
  const tree: RocketTree = {
    name: 'ClusterSample',
    components: [
      { type: 'nosecone', length: 0.12, aftRadius: 0.033, thickness: 0.002 },
      {
        type: 'bodytube', length: 0.45, outerRadius: 0.033, thickness: 0.001,
        children: [
          {
            type: 'innertube', id: 'mt', length: 0.075, outerRadius: 0.0095,
            thickness: 0.0005, motorMount: true,
            cluster: '3-ring', clusterScale: 1.25, clusterRotation: Math.PI / 6,
            position: { method: 'bottom', offset: 0 },
          },
        ],
      },
    ],
  };

  it('preserves cluster pattern/scale/rotation (degrees in the file, radians inside)', () => {
    const xml = exportOrk({ name: 'ClusterSample', tree });
    expect(xml).toContain('<clusterconfiguration>3-ring</clusterconfiguration>');
    expect(xml).toContain('<clusterscale>1.25</clusterscale>');
    // Desktop stores rotation in degrees.
    expect(xml).toMatch(/<clusterrotation>29\.99999+\d*<\/clusterrotation>|<clusterrotation>30<\/clusterrotation>/);

    const back = importOrk(xml);
    const mount = back.tree.components[0]!.children![1]!.children!.find((c) => c.type === 'innertube')!;
    expect(mount['cluster']).toBe('3-ring');
    expect(mount['clusterScale']).toBeCloseTo(1.25);
    expect(mount['clusterRotation']).toBeCloseTo(Math.PI / 6, 9);
  });

  it('omits nothing for single mounts (back-compat: literal single)', () => {
    const plain: RocketTree = {
      components: [
        { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005, children: [
          { type: 'innertube', id: 'mt', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
        ] },
      ],
    };
    const xml = exportOrk({ name: 'Plain', tree: plain });
    expect(xml).toContain('<clusterconfiguration>single</clusterconfiguration>');
    const back = importOrk(xml);
    const mount = back.tree.components[0]!.children![0]!.children!.find((c) => c.type === 'innertube')!;
    expect(mount['cluster']).toBeUndefined();
  });
});

describe('.ork round-trip of serial stages (Release C)', () => {
  const staged: RocketTree = {
    name: 'TwoStage',
    components: [
      {
        type: 'stage', id: 's0', name: 'Sustainer',
        children: [
          { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
          {
            type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
            children: [
              { type: 'innertube', id: 'smount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
              { type: 'parachute', diameter: 0.35 },
            ],
          },
        ],
      },
      {
        type: 'stage', id: 's1', name: 'Booster', separationEvent: 'burnout', separationDelay: 0.5,
        children: [
          {
            type: 'bodytube', length: 0.12, outerRadius: 0.012, thickness: 0.0005,
            children: [
              { type: 'innertube', id: 'bmount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
            ],
          },
        ],
      },
    ],
  };
  const motors = {
    smount: { designation: 'I224-15A', diameter: 0.029, length: 0.365, delay: 15, ignitionEvent: 'burnout', ignitionDelay: 1 },
    bmount: { designation: 'J420R', diameter: 0.038, length: 0.35, delay: 0 },
  };

  it('round-trips stages, separation, and per-mount motors with ignition', () => {
    const xml = exportOrk({ name: 'TwoStage', tree: staged, motors });
    expect(xml).toContain('<separationevent>burnout</separationevent>');
    expect(xml).toContain('<separationdelay>0.5</separationdelay>');
    expect(xml).toContain('<stage number="1" active="true"/>');
    expect(xml).toContain('<ignitionevent>burnout</ignitionevent>');

    const back = importOrk(xml);
    expect(back.tree.components.map((s) => s.name)).toEqual(['Sustainer', 'Booster']);
    const booster = back.tree.components[1]!;
    expect(booster['separationEvent']).toBe('burnout');
    expect(booster['separationDelay']).toBeCloseTo(0.5);
    // Sustainer stage carries no separation fields (top stage never separates).
    expect(back.tree.components[0]!['separationEvent']).toBeUndefined();

    // Both motors, on their own mounts, ignition preserved.
    const refs = Object.values(back.motors);
    expect(refs.length).toBe(2);
    const sus = refs.find((r) => r.designation === 'I224-15A')!;
    expect(sus.ignitionEvent).toBe('burnout');
    expect(sus.ignitionDelay).toBeCloseTo(1);
    const boo = refs.find((r) => r.designation === 'J420R')!;
    expect(boo.ignitionEvent).toBe('automatic');
    expect(boo.delay).toBe(0);
  });
});

describe('.ork round-trip of fin tabs', () => {
  const tree: RocketTree = {
    name: 'TabSample',
    components: [
      { type: 'nosecone', id: 'n1', length: 0.07, aftRadius: 0.012 },
      {
        type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
        children: [
          {
            type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.05,
            tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003,
            tabHeight: 0.008, tabLength: 0.03, tabOffset: -0.005, tabOffsetMethod: 'bottom',
            position: { method: 'bottom', offset: 0 },
          },
          {
            type: 'freeformfinset', id: 'f2', finCount: 4, thickness: 0.002,
            points: [[0, 0], [0.02, 0.03], [0.045, 0.03], [0.05, 0]],
            tabHeight: 0.006, tabLength: 0.02,
            position: { method: 'bottom', offset: -0.06 },
          },
        ],
      },
    ],
  };

  it('preserves tab depth/length/offset/method through export → import', () => {
    const back = importOrk(exportOrk({ name: 'TabSample', tree }));
    const body = back.tree.components[0]!.children![1]!;

    const trap = body.children!.find((c) => c.type === 'trapezoidfinset')!;
    expect(trap['tabHeight']).toBeCloseTo(0.008);
    expect(trap['tabLength']).toBeCloseTo(0.03);
    expect(trap['tabOffset']).toBeCloseTo(-0.005);
    expect(trap['tabOffsetMethod']).toBe('bottom');

    const ff = body.children!.find((c) => c.type === 'freeformfinset')!;
    expect(ff['tabHeight']).toBeCloseTo(0.006);
    expect(ff['tabLength']).toBeCloseTo(0.02);
    expect(ff['tabOffsetMethod']).toBe('middle'); // default when unspecified
  });

  it('writes desktop-compatible elements (legacy + modern tabposition)', () => {
    const xml = exportOrk({ name: 'TabSample', tree });
    expect(xml).toContain('<tabheight>0.008</tabheight>');
    expect(xml).toContain('<tablength>0.03</tablength>');
    expect(xml).toContain('<tabposition relativeto="end">-0.005</tabposition>');
    expect(xml).toContain('<tabposition relativeto="bottom">-0.005</tabposition>');
  });

  it('omits tab elements entirely when there is no tab', () => {
    const noTab: RocketTree = {
      components: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012 },
        {
          type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
          children: [{
            type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03,
            sweep: 0.02, height: 0.03, thickness: 0.003,
          }],
        },
      ],
    };
    expect(exportOrk({ name: 'x', tree: noTab })).not.toContain('tabheight');
  });
});

/**
 * Measured mass & CG (issues-2026-08-23b #3). The "Build allowance" ballast
 * the box inserts is an ordinary mass component and has always saved; the two
 * numbers the user WEIGHED did not, so re-opening a file left the box blank
 * and the gap it reports unrecoverable.
 *
 * They go in as a rocket-level extension pair, SI like everything else in the
 * format, emitted only when set — the `<nozzleexitdiameter>` precedent, so a
 * design that never used the feature round-trips byte-identically and desktop
 * OpenRocket warns-and-skips exactly as it does for our other extensions.
 */
describe('.ork round-trip of measured mass & CG', () => {
  const tree: RocketTree = {
    name: 'Weighed',
    components: [{
      type: 'stage', id: 's1', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'n1', length: 0.15, aftRadius: 0.025, thickness: 0.002 },
        { type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.025, thickness: 0.001 },
      ],
    }],
  } as unknown as RocketTree;

  it('carries both numbers across a save and re-open', () => {
    const xml = exportOrk({ name: 'Weighed', tree, measured: { massKg: 0.56, cgM: 0.415 } });
    expect(xml).toMatch(/<measuredmass>0\.56<\/measuredmass>/);
    expect(xml).toMatch(/<measuredcg>0\.415<\/measuredcg>/);

    const back = importOrk(xml);
    expect(back.measured?.massKg).toBeCloseTo(0.56, 12);
    expect(back.measured?.cgM).toBeCloseTo(0.415, 12);
  });

  it('carries one number when only one was typed', () => {
    const xml = exportOrk({ name: 'Weighed', tree, measured: { massKg: 0.56, cgM: null } });
    expect(xml).toMatch(/<measuredmass>/);
    expect(xml).not.toMatch(/<measuredcg>/);

    const back = importOrk(xml);
    expect(back.measured?.massKg).toBeCloseTo(0.56, 12);
    expect(back.measured?.cgM).toBeNull();
  });

  it('writes nothing at all when the feature was never used', () => {
    // A design that never touched the box must produce the same file as before
    // the feature existed — the rule every extension element here follows.
    const plain = exportOrk({ name: 'Weighed', tree });
    expect(plain).not.toMatch(/<measured/);
    // Identical but for the freshly-minted ids (component ids and the minted
    // flight-configuration id), which every export re-mints.
    const stripIds = (x: string) =>
      x.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID');
    expect(stripIds(exportOrk({ name: 'Weighed', tree, measured: { massKg: null, cgM: null } })))
      .toBe(stripIds(plain));
  });

  it('reports nothing for a file that carries no measurements', () => {
    expect(importOrk(exportOrk({ name: 'Weighed', tree })).measured).toBeUndefined();
  });

  it('ignores nonsense rather than importing a negative or unparseable mass', () => {
    const xml = exportOrk({ name: 'Weighed', tree, measured: { massKg: 0.56, cgM: 0.415 } })
      .replace('<measuredmass>0.56</measuredmass>', '<measuredmass>-3</measuredmass>')
      .replace('<measuredcg>0.415</measuredcg>', '<measuredcg>nope</measuredcg>');
    const back = importOrk(xml);
    expect(back.measured?.massKg ?? null).toBeNull();
    expect(back.measured?.cgM ?? null).toBeNull();
  });
});

/**
 * v0.088 — the camera shroud's two end shapes and its conformal flag.
 *
 * These are the same class of field as the v0.087 data loss: values this app
 * writes into its own `<fairing>` extension element, which are silently reset
 * to a default if the reader ever stops reading them. The v0.087 lesson was
 * that a write-only field destroys a design on the next save, so every one of
 * them is pinned here.
 */
describe('.ork round-trip of the v0.088 shroud fields', () => {
  const shroud = (over: Record<string, unknown>): RocketTree => ({
    name: 'Shroud',
    components: [{
      type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.027, thickness: 0.001,
      children: [{
        type: 'fairing', id: 'f1', length: 0.09, width: 0.03, height: 0.022,
        mass: 0.052, position: { method: 'middle', offset: 0 }, ...over,
      }],
    }],
  } as unknown as RocketTree);

  const back = (tree: RocketTree) => {
    const t = importOrk(exportOrk({ name: 'Shroud', tree })).tree;
    return t.components[0]!.children![0]!.children!.find((c) => c.type === 'fairing')!;
  };

  it('keeps two DIFFERENT end shapes', () => {
    const f = back(shroud({ fairingForeShape: 'streamlined', fairingAftShape: 'halfround' }));
    expect(f['fairingForeShape']).toBe('streamlined');
    expect(f['fairingAftShape']).toBe('halfround');
    // A two-ended shroud must NOT write the legacy whole-part tag: an older
    // build of this app reads it and would take half the shroud for the whole.
    const xml = exportOrk({
      name: 'Shroud',
      tree: shroud({ fairingForeShape: 'streamlined', fairingAftShape: 'halfround' }),
    });
    expect(xml.includes('fairingshape')).toBe(false);
  });

  it('keeps the conformal flag in BOTH states, and absent means conformal', () => {
    expect(back(shroud({ conformal: false }))['conformal']).toBe(false);
    expect(back(shroud({ conformal: true }))['conformal']).toBe(true);
    // Never set at all: it must come back as conformal, not as undefined-then-
    // rendered-unchecked. This is the default-ON contract.
    expect(back(shroud({}))['conformal']).toBe(true);
  });

  it('migrates a pre-v0.088 single shape onto both ends and does not lose it', () => {
    // Written the way v0.087 wrote it. `shroudEnds` migrates on read; the next
    // save must round-trip the migrated pair, still agreeing with itself.
    const f = back(shroud({ fairingShape: 'box' }));
    const ends = shroudEnds(f);
    expect(ends).toEqual({ fore: 'box', aft: 'box' });
    // And a second trip is stable — the fixed point matters, because that is
    // where a lossy migration shows up.
    const twice = back(shroud(f as unknown as Record<string, unknown>));
    expect(shroudEnds(twice)).toEqual({ fore: 'box', aft: 'box' });
  });
});

/**
 * v0.103 — the rail button's five other dimensions, and its material.
 *
 * Until this release the .ork reader took `outerdiameter` and nothing else,
 * and the writer emitted SIX literals over whatever the user had: material
 * Delrin 1420, innerdiameter 0.008, height 0.0097, baseheight 0.002,
 * flangeheight 0.002, screwheight 0.0. So a desktop file's real button was
 * destroyed on the first save this app made — the same write-only-field
 * data-loss shape as v0.087, but on a part that also flies: total height sets
 * the drag reference area (RailButtonCalc.java:57-60) AND, a second time, the
 * boundary-layer velocity discount (:85-92), so the error is superlinear.
 *
 * Both directions are asserted. The IMPORT half proves the keys arrive; the
 * EXPORT half is the one that catches a regression back to `<height>0.0097`.
 */
describe('.ork round-trip of the rail-button geometry fields', () => {
  const button = (over: Record<string, unknown>): RocketTree => ({
    name: 'Buttons',
    components: [{
      type: 'bodytube', id: 'b1', length: 0.9, outerRadius: 0.027, thickness: 0.001,
      children: [{
        type: 'railbutton', id: 'rb1', name: 'RB',
        position: { method: 'middle', offset: 0 }, ...over,
      }],
    }],
  } as unknown as RocketTree);

  const back = (tree: RocketTree) => {
    const t = importOrk(exportOrk({ name: 'Buttons', tree })).tree;
    return t.components[0]!.children![0]!.children!.find((c) => c.type === 'railbutton')!;
  };

  // SS Wild Bash 20260623v0.ork's RB1515S pair — the tallest real button in the
  // corpus (14.224 mm against the 9.7 mm we used to fly), and one of the three
  // corpus files carrying its own density, where the Delrin literal used to
  // inflate button mass by +42 % on every save.
  const WILD_BASH = {
    outerDiameter: 0.012446, innerDiameter: 0.007366, totalHeight: 0.014224,
    baseHeight: 0.0047625, flangeHeight: 0.0047625, screwHeight: 0,
    instanceCount: 2, instanceSeparation: 0.5,
    density: 997.0129438821765, materialName: 'PLA',
  };
  // ninja_4in_54mm-MMT.ork's RB-10-D — the only corpus button with a NON-ZERO
  // screw height, which is mass-only (RailButton.java:301-308) and appears in
  // no drag term at all.
  const RB_10_D = {
    outerDiameter: 0.0070612, innerDiameter: 0.0039116, totalHeight: 0.006858,
    baseHeight: 0.0011, flangeHeight: 0.0011, screwHeight: 0.002921,
    density: 1263.44,
  };

  it('carries all six dimensions out and back, on a taller-than-default button', () => {
    const b = back(button(WILD_BASH));
    expect(b['outerDiameter']).toBeCloseTo(0.012446, 9);
    expect(b['innerDiameter']).toBeCloseTo(0.007366, 9);
    expect(b['totalHeight']).toBeCloseTo(0.014224, 9);
    expect(b['baseHeight']).toBeCloseTo(0.0047625, 9);
    expect(b['flangeHeight']).toBeCloseTo(0.0047625, 9);
    expect(b['screwHeight']).toBe(0);
    expect(b['instanceCount']).toBe(2);
  });

  it('keeps a non-zero screw height, which only mass can see', () => {
    expect(back(button(RB_10_D))['screwHeight']).toBeCloseTo(0.002921, 9);
    expect(back(button(RB_10_D))['totalHeight']).toBeCloseTo(0.006858, 9);
  });

  it('writes the node values, not the old literals', () => {
    const xml = exportOrk({ name: 'Buttons', tree: button(WILD_BASH) });
    expect(xml).toContain('<outerdiameter>0.012446</outerdiameter>');
    expect(xml).toContain('<innerdiameter>0.007366</innerdiameter>');
    expect(xml).toContain('<height>0.014224</height>');
    expect(xml).toContain('<baseheight>0.0047625</baseheight>');
    expect(xml).toContain('<flangeheight>0.0047625</flangeheight>');
    expect(xml).toContain('<screwheight>0</screwheight>');
    // Every one of the five geometry literals, named. These are what a desktop
    // file's real button was being replaced with on save.
    expect(xml).not.toContain('<innerdiameter>0.008</innerdiameter>');
    expect(xml).not.toContain('<height>0.0097</height>');
    expect(xml).not.toContain('<baseheight>0.002</baseheight>');
    expect(xml).not.toContain('<flangeheight>0.002</flangeheight>');
    expect(xml).not.toContain('<screwheight>0.0</screwheight>');
  });

  it("keeps the design's own material density instead of stamping Delrin 1420", () => {
    const xml = exportOrk({ name: 'Buttons', tree: button(WILD_BASH) });
    expect(xml).toContain('density="997.0129438821765"');
    expect(xml).not.toContain('density="1420.0"');
    expect(back(button(WILD_BASH)).density).toBeCloseTo(997.0129438821765, 9);
    // A 1263.44 kg/m3 button is a different part again.
    expect(back(button(RB_10_D)).density).toBeCloseTo(1263.44, 9);
  });

  it('falls back to the kernel constructor, not to Cardboard, for an undimensioned button', () => {
    // A button carrying nothing but a position — an old localStorage design, or
    // the pre-v0.103 shape of every button this app created. Every layer has to
    // agree on what it is, because the engine flies it as the RailButton
    // constructor's own part (RailButton.java:58-66: OD 9.7, ID 8.0, height
    // 9.7, base 2.0, flange 2.0 mm, Delrin 1420). The generic material() helper
    // would have written Cardboard 680 here, which is the same class of quiet
    // corruption in the other direction.
    const xml = exportOrk({ name: 'Buttons', tree: button({}) });
    expect(xml).toContain('<outerdiameter>0.0097</outerdiameter>');
    expect(xml).toContain('<innerdiameter>0.008</innerdiameter>');
    expect(xml).toContain('<height>0.0097</height>');
    expect(xml).toContain('<baseheight>0.002</baseheight>');
    expect(xml).toContain('<flangeheight>0.002</flangeheight>');
    // Delrin verbatim, and Cardboard nowhere INSIDE the button (the parent body
    // tube legitimately writes Cardboard, so the check has to be scoped).
    expect(xml).toContain('<material type="bulk" density="1420.0" group="Plastics">Delrin</material>');
    const block = xml.slice(xml.indexOf('<railbutton>'), xml.indexOf('</railbutton>'));
    expect(block).not.toContain('Cardboard');
  });

  it('reads a file that omits an element as the kernel default rather than zero', () => {
    // Desktop writes all six, but a hand-edited or older file may not. A zero
    // height would be a degenerate part; the constructor's value is what the
    // engine would have flown anyway.
    const partial = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
      <name>P</name><subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>B</name><length>0.9</length><thickness>0.001</thickness><radius>0.027</radius>
          <subcomponents>
            <railbutton><name>RB</name><outerdiameter>0.01575</outerdiameter></railbutton>
          </subcomponents>
        </bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const rb = importOrk(partial).tree.components[0]!.children![0]!.children!
      .find((c) => c.type === 'railbutton')!;
    expect(rb['outerDiameter']).toBeCloseTo(0.01575, 9);
    expect(rb['totalHeight']).toBeCloseTo(0.0097, 9);
    expect(rb['innerDiameter']).toBeCloseTo(0.008, 9);
    expect(rb['baseHeight']).toBeCloseTo(0.002, 9);
    expect(rb['flangeHeight']).toBeCloseTo(0.002, 9);
    expect(rb['screwHeight']).toBe(0);
  });
});

/**
 * v0.103 — an explicit zero mounting angle is a VALUE, not an absence.
 *
 * `readMountAngle` used to skip `deg === 0`, so a desktop file storing
 * `<angleoffset>0.0</angleoffset>` — a lug at the top of the airframe — yielded
 * a node with no key at all. That was invisible until ComponentFactory started
 * bridging the angle to the kernel, where an absent key would have meant the
 * constructor's default of PI: the sentinel would have turned a deliberate 0
 * into a flown 180, silently, which is the exact inverse of the v0.087 bug the
 * reader was written to fix in the first place.
 */
describe('.ork mounting angle: zero is a value, not an absence', () => {
  const at = (degText: string) => `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>A</name><subcomponents><stage><name>S</name><subcomponents>
      <bodytube><name>B</name><length>0.5</length><thickness>0.001</thickness><radius>0.027</radius>
        <subcomponents>
          <launchlug><name>L</name><radius>0.003</radius><length>0.04</length><thickness>0.0005</thickness>
            <angleoffset method="relative">${degText}</angleoffset></launchlug>
          <railbutton><name>RB</name><outerdiameter>0.0097</outerdiameter>
            <angleoffset method="relative">${degText}</angleoffset></railbutton>
        </subcomponents>
      </bodytube>
    </subcomponents></stage></subcomponents></rocket></openrocket>`;

  const kids = (xml: string) => importOrk(xml).tree.components[0]!.children![0]!.children!;

  it('keeps an explicit zero as an explicit zero on both parts', () => {
    const c = kids(at('0.0'));
    expect(c.find((n) => n.type === 'launchlug')!['angleOffset']).toBe(0);
    expect(c.find((n) => n.type === 'railbutton')!['angleOffset']).toBe(0);
  });

  it('still reads a real angle, and still leaves a missing element absent', () => {
    const c = kids(at('90.0'));
    expect(c.find((n) => n.type === 'launchlug')!['angleOffset']).toBeCloseTo(Math.PI / 2, 9);
    const noTag = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
      <name>A</name><subcomponents><stage><name>S</name><subcomponents>
        <bodytube><name>B</name><length>0.5</length><thickness>0.001</thickness><radius>0.027</radius>
          <subcomponents>
            <launchlug><name>L</name><radius>0.003</radius><length>0.04</length><thickness>0.0005</thickness></launchlug>
          </subcomponents>
        </bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    expect(kids(noTag)[0]!['angleOffset']).toBeUndefined();
  });

  it('survives a save and re-open at zero', () => {
    const once = importOrk(at('0.0')).tree;
    const twice = importOrk(exportOrk({ name: 'A', tree: once })).tree;
    const c = twice.components[0]!.children![0]!.children!;
    expect(c.find((n) => n.type === 'launchlug')!['angleOffset']).toBe(0);
    expect(c.find((n) => n.type === 'railbutton')!['angleOffset']).toBe(0);
  });
});
