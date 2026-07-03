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
