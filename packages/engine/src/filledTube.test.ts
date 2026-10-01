import { describe, expect, it } from 'vitest';
import { OrkRocket } from './orkEngine.js';

// KB3: requires rebuilding the Java bridge into vendor/orkengine.mjs.
// Intentionally active: the stale kernel must fail, never silently skip this gate.
//
// A FILLED body tube is solid all the way through (desktop's "Filled" box,
// .ork <thickness>filled</thickness>; BodyTube.getComponentVolume). The nose
// cone and transition branches of the bridge have always called setFilled;
// the body tube's never did, so a solid tube flew as a shell of whatever wall
// the node carried.
const R = 0.0125;
const LEN = 0.2;
const RHO = 530; // pine
const build = (tube: Record<string, unknown>) => OrkRocket.buildTree({
  name: 'KB3',
  components: [
    { type: 'nosecone', id: 'nose', length: 0.06, aftRadius: R, thickness: 0.002 },
    { type: 'bodytube', id: 'body', length: LEN, outerRadius: R, thickness: 0.0005, density: RHO, ...tube },
  ],
});

describe('KB3 a filled body tube flies solid', () => {
  it('weighs its whole volume', () => {
    const solid = build({ filled: true }).componentInfo('body').mass;
    expect(Math.abs(solid - Math.PI * R * R * LEN * RHO) / solid).toBeLessThan(1e-9);
  });

  it('whatever wall the node also carries', () => {
    expect(build({ filled: true, thickness: 0.001 }).componentInfo('body').mass)
      .toBeCloseTo(build({ filled: true }).componentInfo('body').mass, 12);
  });

  it('carries the roll inertia of a solid rod, r^2/2, not a shell', () => {
    const shell = build({});
    const solid = build({ filled: true });
    const dm = solid.componentInfo('body').mass - shell.componentInfo('body').mass;
    expect(dm).toBeGreaterThan(0);
    // The extra mass is the core: a rod of radius R - wall, inertia m r^2 / 2.
    const core = R - 0.0005;
    const dIxx = solid.staticInfo().rotationalInertiaEmpty - shell.staticInfo().rotationalInertiaEmpty;
    expect(Math.abs(dIxx - (dm * core * core) / 2) / dIxx).toBeLessThan(1e-6);
  });

  it('filled: false is the shell it always was', () => {
    expect(build({ filled: false }).staticInfo().massEmpty).toBe(build({}).staticInfo().massEmpty);
  });
});
