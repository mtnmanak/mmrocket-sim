import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode } from './orkEngine.js';

// KB5: requires rebuilding the Java bridge into vendor/orkengine.mjs.
// Intentionally active: the stale kernel must fail, never silently skip this gate.
//
// A STATED RING BORE IS NOT AUTOMATIC. A CenteringRing is born with an
// automatic bore (the outer radius of an inner tube beside it that overlaps
// it). RadiusRingComponent.setInnerRadius returns early when the new value
// equals the field — and clears innerRadiusAutomatic only past that return.
// While a tree is built, a part's position is its RAW offset until the rocket's
// events are enabled at the end (RocketComponent.setAxialOffset with no parent),
// so a ring placed 'bottom' sits at the tube's FRONT when its radii are set; if
// an inner tube lies there and the stated bore equals that tube's outer radius
// — the usual centering ring — the field already holds it, the flag stays on,
// and at the ring's real station, where nothing overlaps it, the bore resolves
// to 0 and a solid disc flies.
const RHO = 680;
const L = 0.003;
const OR = 0.0245;
const MMT_OR = 0.0095;
const tube = (ring: Record<string, unknown>) => OrkRocket.buildTree({
  name: 'KB5',
  components: [{
    type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.025, thickness: 0.0005,
    children: [
      // First, so the ring sees it while its radii are set. Its own station is
      // the top of the tube, raw and final alike.
      { type: 'innertube', id: 'mmt', length: 0.07, outerRadius: MMT_OR, thickness: 0.0005, position: { method: 'top', offset: 0 } },
      { type: 'centeringring', id: 'ring', length: L, outerRadius: OR, density: RHO, ...ring } as ComponentNode,
    ],
  }],
});
const annulus = (ir: number) => Math.PI * (OR * OR - ir * ir) * L * RHO;
const rel = (a: number, b: number) => Math.abs(a / b - 1);

describe('KB5 a ring flies the bore it states', () => {
  it('a bore equal to the tube it was beside while being built stays a bore at its real station', () => {
    const m = tube({ innerRadius: MMT_OR, position: { method: 'bottom', offset: 0 } }).componentInfo('ring').mass;
    expect(rel(m, annulus(MMT_OR))).toBeLessThan(1e-9);
  });

  it('a bore unlike the automatic one was always kept', () => {
    const m = tube({ innerRadius: 0.012, position: { method: 'bottom', offset: 0 } }).componentInfo('ring').mass;
    expect(rel(m, annulus(0.012))).toBeLessThan(1e-9);
  });

  it('a ring that states no bore stays automatic: beside the tube it takes its radius, away from it none', () => {
    const beside = tube({ position: { method: 'top', offset: 0.03 } }).componentInfo('ring').mass;
    expect(rel(beside, annulus(MMT_OR))).toBeLessThan(1e-9);
    const away = tube({ position: { method: 'bottom', offset: 0 } }).componentInfo('ring').mass;
    expect(rel(away, annulus(0))).toBeLessThan(1e-9);
  });
});
