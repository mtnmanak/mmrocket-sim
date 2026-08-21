import { describe, expect, it } from 'vitest';
import {
  outerProfile, shapeIsClippable, shapeParamDefault, shapeParamMax,
  shapeRadius, shapeUsesParameter,
} from './shapeProfile.js';

/**
 * Anchors are analytic identities of the kernel's Transition.Shape math
 * (issue 2026-08-11a: 2D/3D drew fixed ogive/cone regardless of shape).
 */
describe('shapeRadius — kernel Shape.getRadius port', () => {
  const R = 0.024;
  const L = 0.07;

  it('conical is linear', () => {
    expect(shapeRadius('conical', L / 2, R, L, 0)).toBeCloseTo(R / 2, 12);
    expect(shapeRadius('conical', L, R, L, 0)).toBeCloseTo(R, 12);
  });

  it('tangent ogive (param 1) is the circular-arc profile', () => {
    // Classic tangent-ogive closed form: rho = (R² + L²) / 2R.
    const rho = (R * R + L * L) / (2 * R);
    const x = L * 0.4;
    const expected = Math.sqrt(rho * rho - (L - x) * (L - x)) - (rho - R);
    expect(shapeRadius('ogive', x, R, L, 1)).toBeCloseTo(expected, 12);
    expect(shapeRadius('ogive', L, R, L, 1)).toBeCloseTo(R, 9);
  });

  it('secant ogive straightens toward conical as param → 0', () => {
    const x = L * 0.5;
    expect(shapeRadius('ogive', x, R, L, 0.0001)).toBeCloseTo(R / 2, 6);
  });

  it('ellipsoid hits R at the base and follows the half-ellipse', () => {
    expect(shapeRadius('ellipsoid', L, R, L, 0)).toBeCloseTo(R, 9);
    // Half-way: r = R·sqrt(1 - (1-t)²) with t = 0.5.
    expect(shapeRadius('ellipsoid', L / 2, R, L, 0)).toBeCloseTo(R * Math.sqrt(0.75), 9);
  });

  it('power series honors the parameter (this was hard-coded to 0.5)', () => {
    const x = L * 0.3;
    expect(shapeRadius('power', x, R, L, 0.5)).toBeCloseTo(R * Math.sqrt(0.3), 12);
    expect(shapeRadius('power', x, R, L, 1)).toBeCloseTo(R * 0.3, 12);
    expect(shapeRadius('power', x, R, L, 0.25)).toBeCloseTo(R * Math.pow(0.3, 0.25), 12);
  });

  it('parabolic honors the parameter (this was hard-coded to 1)', () => {
    const t = 0.5;
    expect(shapeRadius('parabolic', t * L, R, L, 1)).toBeCloseTo(R * (2 * t - t * t), 12);
    expect(shapeRadius('parabolic', t * L, R, L, 0)).toBeCloseTo(R * t, 12); // param 0 = cone
  });

  it('haack: LD-Haack (0) and LV-Haack (1/3) both end at R', () => {
    expect(shapeRadius('haack', L, R, L, 0)).toBeCloseTo(R, 9);
    expect(shapeRadius('haack', L, R, L, 1 / 3)).toBeCloseTo(R, 9);
    // LV-Haack is fuller than LD-Haack mid-body.
    expect(shapeRadius('haack', L / 2, R, L, 1 / 3))
      .toBeGreaterThan(shapeRadius('haack', L / 2, R, L, 0));
  });
});

describe('outerProfile — transition semantics (kernel Transition.getRadius)', () => {
  const L = 0.05;
  const r1 = 0.012;
  const r2 = 0.024;

  it('endpoints are exactly the fore and aft radii, for every shape', () => {
    for (const shape of ['conical', 'ogive', 'ellipsoid', 'power', 'parabolic', 'haack']) {
      const pts = outerProfile(shape, undefined, L, r1, r2);
      expect(pts[0]![1]).toBeCloseTo(r1, 6);
      expect(pts[pts.length - 1]![1]).toBeCloseTo(r2, 6);
    }
  });

  it('conical transition is the straight taper', () => {
    const pts = outerProfile('conical', 0, L, r1, r2);
    const mid = pts[Math.floor(pts.length / 2)]!;
    expect(mid[1]).toBeCloseTo((r1 + r2) / 2, 9);
  });

  it('ogive differs from conical (the reported bug: all transitions drew conical)', () => {
    const cone = outerProfile('conical', 0, L, r1, r2);
    const ogive = outerProfile('ogive', 1, L, r1, r2);
    const maxDiff = Math.max(...cone.map(([, r], i) => Math.abs(r - ogive[i]![1])));
    expect(maxDiff).toBeGreaterThan(0.0005);
  });

  it('clippable shapes draw the clipped continuation (kernel default state)', () => {
    // Clipped ellipsoid: the profile is the virtual nose's continuation, so
    // it is FLATTER at the fore end than the non-clipped delta-shape would be.
    const pts = outerProfile('ellipsoid', 0, L, r1, r2);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]![1]).toBeGreaterThanOrEqual(pts[i - 1]![1] - 1e-9); // monotonic
    }
    // Clip solve reproduces r1 at x=0 within the kernel's CLIP_PRECISION.
    const interior = outerProfile('ellipsoid', 0, L, r1, r2, 1000)[1]!;
    expect(interior[1]).toBeGreaterThan(r1 - 0.0005);
  });

  it('honors an explicit clipped=false (node["clipped"]) — hand-derived radii', () => {
    // Power series, param 0.5, is closed-form BOTH ways, so the expected
    // numbers below are derived from Transition.getRadius() by hand — never
    // from this code's own output. Geometry: r1=0.012, r2=0.024, L=0.06,
    // sample at x = L/2 = 0.03 (steps=32 puts an exact sample at index 16).
    //
    // Pure shape: Shape.POWER.getRadius(ξ, R, Λ, 0.5) = R·sqrt(ξ/Λ).
    //
    // UNCLIPPED branch (getRadius: r1 + type.getRadius(x, r2−r1, length)):
    //   r = 0.012 + 0.012·sqrt(0.03/0.06) = 0.012·(1 + sqrt(0.5)) ≈ 0.0204853.
    //
    // CLIPPED branch (kernel default): calculateClip solves
    //   r1 = r2·sqrt(c/(c+L))  ⇒  r1²(c+L) = r2²c  ⇒  c = r1²L/(r2²−r1²)
    //     = (0.012²·0.06)/(0.024²−0.012²) = 8.64e−6/4.32e−4 = 0.02 exactly,
    //   then r = r2·sqrt((c+x)/(c+L)) = 0.024·sqrt(0.05/0.08)
    //     = 0.024·sqrt(0.625) ≈ 0.0189737.
    // The kernel's binary search stops at CLIP_PRECISION 1e−4 on c; with
    // ∂r/∂c ≈ 0.071 that bounds the radius error under 4e−6 — digits=5 holds.
    const L = 0.06, r1p = 0.012, r2p = 0.024;
    const unclipped = outerProfile('power', 0.5, L, r1p, r2p, 32, undefined, false);
    expect(unclipped[16]![1]).toBeCloseTo(0.012 * (1 + Math.sqrt(0.5)), 9);
    const clipped = outerProfile('power', 0.5, L, r1p, r2p, 32);
    expect(clipped[16]![1]).toBeCloseTo(0.024 * Math.sqrt(0.625), 5);
    // Explicit true is the same as absent (the kernel default).
    expect(outerProfile('power', 0.5, L, r1p, r2p, 32, undefined, true)[16]![1])
      .toBeCloseTo(clipped[16]![1], 12);
    // Both branches still hit the endpoints exactly.
    expect(unclipped[0]![1]).toBeCloseTo(r1p, 9);
    expect(unclipped[32]![1]).toBeCloseTo(r2p, 9);
  });

  it('ignores the clipped flag on non-clippable shapes (Transition.isClipped)', () => {
    // An ogive transition with a stray clipped=true must draw the ogive's
    // unclipped delta shape — the kernel returns false before reading the
    // field when the type is not clippable.
    const a = outerProfile('ogive', 1, L, r1, r2, 32);
    const b = outerProfile('ogive', 1, L, r1, r2, 32, undefined, true);
    for (let i = 0; i < a.length; i++) expect(b[i]![1]).toBe(a[i]![1]);
  });

  it('reducing transition (fore > aft) mirrors the enlarging one', () => {
    const up = outerProfile('ogive', 1, L, r1, r2);
    const down = outerProfile('ogive', 1, L, r2, r1);
    for (let i = 0; i < up.length; i++) {
      expect(down[i]![1]).toBeCloseTo(up[up.length - 1 - i]![1], 9);
    }
  });

  it('nose cone profile (fore radius 0) starts at the tip and ends at R', () => {
    const pts = outerProfile('haack', 0, 0.07, 0, 0.024);
    expect(pts[0]![1]).toBe(0);
    expect(pts[pts.length - 1]![1]).toBeCloseTo(0.024, 9);
  });

  it('equal radii degenerate to a cylinder', () => {
    const pts = outerProfile('ogive', 1, L, r2, r2);
    expect(pts.every(([, r]) => r === r2)).toBe(true);
  });
});

describe('shape metadata mirrors the kernel enum', () => {
  it('defaults', () => {
    expect(shapeParamDefault('ogive')).toBe(1);
    expect(shapeParamDefault('parabolic')).toBe(1);
    expect(shapeParamDefault('power')).toBe(0.5);
    expect(shapeParamDefault('haack')).toBe(0);
    expect(shapeParamDefault('conical')).toBe(0);
  });
  it('usesParameter / maxParameter / isClippable', () => {
    expect(shapeUsesParameter('ogive')).toBe(true);
    expect(shapeUsesParameter('ellipsoid')).toBe(false);
    expect(shapeUsesParameter('conical')).toBe(false);
    expect(shapeParamMax('haack')).toBeCloseTo(1 / 3, 12);
    expect(shapeParamMax('ogive')).toBe(1);
    expect(shapeIsClippable('ellipsoid')).toBe(true);
    expect(shapeIsClippable('power')).toBe(true);
    expect(shapeIsClippable('haack')).toBe(true);
    expect(shapeIsClippable('ogive')).toBe(false);
    expect(shapeIsClippable('conical')).toBe(false);
  });
});
