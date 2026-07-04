// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import type { RocketTree } from '@online-openrocket/engine';

/**
 * Round-trip of the fields added for the 2026-07-03 issue list: nose shoulder,
 * solid (filled), surface finish, mass/CG/Cd overrides, and recovery-device
 * deployment configuration. The exported XML for this same tree is validated
 * against the real OpenRocket 24.12 loader with bit-exact mass AND CG parity
 * (see docs/testing/ notes); these assertions guard the mapping.
 */
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

    const nose = back.tree.components[0]!;
    expect(nose['filled']).toBe(true);
    expect(nose['shoulderRadius']).toBeCloseTo(0.0115);
    expect(nose['shoulderLength']).toBeCloseTo(0.03);
    expect(nose['shoulderThickness']).toBeCloseTo(0.002);
    expect(nose['shoulderCapped']).toBe(true);
    expect(nose['finish']).toBe('polished');
    expect(nose['overrideMass']).toBeCloseTo(0.05);
    // Engine default for haack is 0 — a 1.0 fallback silently reshapes the nose.
    expect(nose['shapeParameter']).toBe(0);

    const body = back.tree.components[1]!;
    expect(body['finish']).toBe('rough');
    expect(body['overrideCD']).toBeCloseTo(0.4);

    const trans = back.tree.components.find((c) => c.type === 'transition')!;
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
    const mount = back.tree.components[1]!.children!.find((c) => c.type === 'innertube')!;
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
    const mount = back.tree.components[0]!.children!.find((c) => c.type === 'innertube')!;
    expect(mount['cluster']).toBeUndefined();
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
    const body = back.tree.components[1]!;

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
