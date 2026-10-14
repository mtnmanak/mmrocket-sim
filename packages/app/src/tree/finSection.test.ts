import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import {
  NACA_MAX_THICKNESS_XI, PRINT_MIN_EDGE, finMacFromOutline, finSectionLaw, finSectionProfile,
  finSectionSpec, halfThickness, printableHalf, printableProfile, sectionHalfThickness, sectionProfile,
  type FinSectionSpec,
} from './finSection.js';

const T = 0.003;
const H = T / 2;
const fin = (extra: Record<string, unknown> = {}): ComponentNode =>
  ({ type: 'trapezoidfinset', thickness: T, ...extra } as ComponentNode);
const airfoil = (section?: string, extra: Record<string, unknown> = {}): ComponentNode =>
  fin({ crossSection: 'airfoil', ...(section ? { airfoilSection: section } : {}), ...extra });

/** 2∫h dξ / t by Simpson's rule on the exact law — the drawn section's area ratio. */
function areaRatio(spec: FinSectionSpec, chord: number): number {
  const n = 20000;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    s += w * sectionHalfThickness(spec, chord, i / n);
  }
  return (2 * s / (3 * n)) / spec.thickness;
}

/** Argmax of the exact law over a fine grid. */
function peak(spec: FinSectionSpec, chord: number): { xi: number; half: number } {
  let best = { xi: 0, half: -1 };
  for (let i = 0; i <= 100000; i++) {
    const xi = i / 100000;
    const h = sectionHalfThickness(spec, chord, xi);
    if (h > best.half + 1e-15) best = { xi, half: h };
  }
  return best;
}

describe('finSectionLaw — which drawing law a node takes', () => {
  it.each([
    [{}, 'square'],
    [{ crossSection: 'square' }, 'square'],
    [{ crossSection: 'bogus' }, 'square'],
    [{ crossSection: 'rounded' }, 'rounded'],
    [{ crossSection: 'ROUNDED' }, 'rounded'],
    [{ crossSection: 'airfoil' }, 'naca'],
    [{ crossSection: 'airfoil', airfoilSection: '' }, 'naca'],
    [{ crossSection: 'airfoil', airfoilSection: 'unknown' }, 'naca'],
    [{ crossSection: 'airfoil', airfoilSection: 'Hexagonal' }, 'hexagonal'],
    [{ crossSection: 'airfoil', airfoilSection: 'naca' }, 'naca'],
    [{ crossSection: 'airfoil', airfoilSection: 'doublewedge' }, 'doublewedge'],
    [{ crossSection: 'airfoil', airfoilSection: 'biconvex' }, 'biconvex'],
    [{ crossSection: 'airfoil', airfoilSection: 'hexbluntbase' }, 'hexbluntbase'],
    [{ crossSection: 'airfoil', airfoilSection: 'singlewedge' }, 'singlewedge'],
    // airfoilSection is honoured only on an airfoil cross-section: a square fin
    // stays the flat prism (hard rule 5) and a rounded one stays rounded.
    [{ crossSection: 'square', airfoilSection: 'hexagonal' }, 'square'],
    [{ airfoilSection: 'biconvex' }, 'square'],
    [{ crossSection: 'rounded', airfoilSection: 'doublewedge' }, 'rounded'],
  ])('%j → %s', (extra, law) => {
    expect(finSectionLaw(fin(extra))).toBe(law);
  });

  it('reads the kernel default thickness when the node has none', () => {
    const n = { type: 'ellipticalfinset', crossSection: 'rounded' } as ComponentNode;
    expect(finSectionSpec(n).thickness).toBe(0.003);
  });
});

describe('area ratios against the table in understand-0-xsec.md §4', () => {
  const C = 0.05;
  it.each([
    ['square', fin(), 1],
    ['hexagonal default (a1 = a2 = 1/3)', airfoil('hexagonal'), 1 - (1 / 3 + 1 / 3) / 2],
    // 10 mm and 20 mm over a 50 mm MAC: a1 = 0.2, a2 = 0.4.
    ['hexagonal a1 0.2 a2 0.4', airfoil('hexagonal', { airfoilLeDiamond: 0.01, airfoilTeDiamond: 0.02 }), 1 - 0.3],
    ['doublewedge default', airfoil('doublewedge'), 0.5],
    ['doublewedge ridge 0.3', airfoil('doublewedge', { airfoilLeDiamond: 0.015 }), 0.5],
    ['biconvex', airfoil('biconvex'), 2 / 3],
    ['hexbluntbase default', airfoil('hexbluntbase'), 1 - (1 / 3) / 2],
    ['hexbluntbase a1 0.2 (TE chamfer ignored)', airfoil('hexbluntbase', { airfoilLeDiamond: 0.01, airfoilTeDiamond: 0.02 }), 0.9],
    ['singlewedge', airfoil('singlewedge'), 0.5],
  ])('%s', (_label, node, expected) => {
    expect(areaRatio(finSectionSpec(node, C), C)).toBeCloseTo(expected, 6);
  });

  it('NACA 00xx (closed TE, −0.1036) is ≈ 0.68 — 0.681 against the open-TE 0.685', () => {
    for (const node of [airfoil(), airfoil('naca')]) {
      const r = areaRatio(finSectionSpec(node, C), C);
      expect(Math.abs(r - 0.685)).toBeLessThan(0.005);
      expect(r).toBeCloseTo(0.6809, 3);
    }
  });

  it('rounded: semicircular edges of radius t/2 remove (1 − π/4)·t/c', () => {
    for (const c of [0.02, 0.05, 0.2]) {
      expect(areaRatio(finSectionSpec(fin({ crossSection: 'rounded' })), c))
        .toBeCloseTo(1 - (1 - Math.PI / 4) * T / c, 5);
    }
  });
});

describe('peak thickness, sharp edges, blunt bases, symmetry', () => {
  const C = 0.05;
  it('NACA peaks at exactly t/2 near ξ = 0.30, never above', () => {
    expect(Math.abs(NACA_MAX_THICKNESS_XI - 0.30)).toBeLessThan(0.005);
    const p = peak(finSectionSpec(airfoil(), C), C);
    expect(p.half).toBeCloseTo(H, 12);
    expect(p.half).toBeLessThanOrEqual(H);
    expect(Math.abs(p.xi - 0.30)).toBeLessThan(0.005);
  });

  it.each([
    ['biconvex', airfoil('biconvex'), 0.5],
    ['doublewedge default', airfoil('doublewedge'), 0.5],
    ['doublewedge ridge 0.3', airfoil('doublewedge', { airfoilLeDiamond: 0.015 }), 0.3],
    ['hexagonal (first ξ of the plateau)', airfoil('hexagonal'), 1 / 3],
    ['singlewedge (at the base)', airfoil('singlewedge'), 1],
  ])('%s: t/2 at ξ = %#', (_l, node, xi) => {
    const p = peak(finSectionSpec(node, C), C);
    expect(p.half).toBeCloseTo(H, 12);
    expect(p.xi).toBeCloseTo(xi, 4);
  });

  it('hexagonal holds t/2 across the plateau between the chamfers', () => {
    const spec = finSectionSpec(airfoil('hexagonal', { airfoilLeDiamond: 0.01, airfoilTeDiamond: 0.02 }), C);
    for (const xi of [0.2, 0.3, 0.45, 0.6]) expect(sectionHalfThickness(spec, C, xi)).toBeCloseTo(H, 12);
    expect(sectionHalfThickness(spec, C, 0.1)).toBeCloseTo(H / 2, 12);
    expect(sectionHalfThickness(spec, C, 0.8)).toBeCloseTo(H / 2, 12);
  });

  it('hexagonal chamfers that overlap scale to meet AT t/2, ridge at a1/(a1+a2)', () => {
    // 40 mm + 40 mm on a 50 mm MAC: a1 = a2 = 0.8 — a diamond, full stock at mid-chord.
    const spec = finSectionSpec(airfoil('hexagonal', { airfoilLeDiamond: 0.04, airfoilTeDiamond: 0.04 }), C);
    expect(spec.a1).toBeCloseTo(0.8, 12); // the aero model's own fractions are unchanged
    expect(spec.a2).toBeCloseTo(0.8, 12);
    const p = peak(spec, C);
    expect(p.xi).toBeCloseTo(0.5, 4);
    expect(p.half).toBe(H);
    expect(areaRatio(spec, C)).toBeCloseTo(0.5, 6);
    // Unequal, at the 0.95 clamp and below it: the ridge sits at a1/(a1+a2), always t/2.
    for (const [le, te] of [[0.08, 0.08], [0.03, 0.04], [0.045, 0.01]] as const) {
      const sp = finSectionSpec(airfoil('hexagonal', { airfoilLeDiamond: le, airfoilTeDiamond: te }), C);
      const sum = sp.a1 + sp.a2;
      expect(sum).toBeGreaterThan(1);
      expect(peak(sp, C).half).toBeCloseTo(H, 7);
      expect(sectionHalfThickness(sp, C, sp.a1 / sum)).toBe(H);
      expect(sectionHalfThickness(sp, C, sp.a1 / sum / 2)).toBeCloseTo(H / 2, 12);
      const prof = sectionProfile(sp, C);
      expect(Math.max(...prof.half)).toBe(H);
    }
  });

  it.each([
    ['naca', airfoil(), 'round', 'sharp'],
    ['rounded', fin({ crossSection: 'rounded' }), 'round', 'round'],
    ['hexagonal', airfoil('hexagonal'), 'sharp', 'sharp'],
    ['doublewedge', airfoil('doublewedge'), 'sharp', 'sharp'],
    ['biconvex', airfoil('biconvex'), 'sharp', 'sharp'],
    ['hexbluntbase', airfoil('hexbluntbase'), 'sharp', 'blunt'],
    ['singlewedge', airfoil('singlewedge'), 'sharp', 'blunt'],
    ['square', fin(), 'blunt', 'blunt'],
  ])('%s: LE %s, TE %s, zero at every non-blunt edge, blunt height t', (_l, node, le, te) => {
    const prof = finSectionProfile(node, C);
    expect(prof.le.kind).toBe(le);
    expect(prof.te.kind).toBe(te);
    const spec = finSectionSpec(node, C);
    for (const [edge, xi, i] of [[prof.le, 0, 0], [prof.te, 1, prof.half.length - 1]] as const) {
      if (edge.kind === 'blunt') {
        expect(edge.height).toBe(T);
        expect(sectionHalfThickness(spec, C, xi)).toBe(H);
        expect(prof.half[i]).toBe(H);
      } else {
        expect(edge.height).toBe(0);
        expect(sectionHalfThickness(spec, C, xi)).toBeCloseTo(0, 15);
        expect(prof.half[i]).toBeCloseTo(0, 15);
      }
    }
  });

  it.each([
    ['rounded', fin({ crossSection: 'rounded' })],
    ['biconvex', airfoil('biconvex')],
    ['doublewedge default', airfoil('doublewedge')],
    ['hexagonal default', airfoil('hexagonal')],
    ['hexagonal equal chamfers', airfoil('hexagonal', { airfoilLeDiamond: 0.012, airfoilTeDiamond: 0.012 })],
  ])('%s is fore-aft symmetric', (_l, node) => {
    const spec = finSectionSpec(node, C);
    for (let i = 0; i <= 50; i++) {
      const xi = i / 50;
      expect(sectionHalfThickness(spec, C, xi)).toBeCloseTo(sectionHalfThickness(spec, C, 1 - xi), 12);
    }
  });

  it('every law stays within [0, t/2] everywhere', () => {
    const nodes = [fin(), fin({ crossSection: 'rounded' }), airfoil(), ...['hexagonal', 'naca', 'doublewedge',
      'biconvex', 'hexbluntbase', 'singlewedge'].map((s) => airfoil(s, { finLeRadius: 0.0008 }))];
    for (const node of nodes) {
      for (const c of [0, 0.001, 0.003, 0.05]) {
        const spec = finSectionSpec(node, 0.05);
        for (let i = 0; i <= 400; i++) {
          const h = sectionHalfThickness(spec, c, i / 400);
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThanOrEqual(H);
        }
      }
    }
  });
});

describe('chamfer and ridge fractions follow sectionPressureCD (FinSetCalc:1269-1306)', () => {
  const mac = 0.05;
  it('a1, a2 = clamp(length / MAC, 0.05, 0.95); unset, zero or negative take the defaults', () => {
    expect(finSectionSpec(airfoil('hexagonal', { airfoilLeDiamond: 0.001 }), mac).a1).toBe(0.05);
    expect(finSectionSpec(airfoil('hexagonal', { airfoilTeDiamond: 0.06 }), mac).a2).toBe(0.95);
    expect(finSectionSpec(airfoil('hexagonal', { airfoilLeDiamond: 0.01 }), mac).a1).toBeCloseTo(0.2, 15);
    for (const v of [undefined, 0, -0.01, Number.NaN]) {
      const s = finSectionSpec(airfoil('hexagonal', { airfoilLeDiamond: v, airfoilTeDiamond: v }), mac);
      expect([s.a1, s.a2]).toEqual([1 / 3, 1 / 3]);
      expect(finSectionSpec(airfoil('hexbluntbase', { airfoilLeDiamond: v }), mac).a1).toBe(1 / 3);
      expect(finSectionSpec(airfoil('doublewedge', { airfoilLeDiamond: v }), mac).ridge).toBe(0.5);
    }
  });

  it('the doublewedge ridge is clamped again to 0.1–0.9', () => {
    expect(finSectionSpec(airfoil('doublewedge', { airfoilLeDiamond: 0.003 }), mac).ridge).toBe(0.1);
    expect(finSectionSpec(airfoil('doublewedge', { airfoilLeDiamond: 0.049 }), mac).ridge).toBe(0.9);
    expect(finSectionSpec(airfoil('doublewedge', { airfoilLeDiamond: 0.02 }), mac).ridge).toBeCloseTo(0.4, 15);
  });

  it('the fraction is taken of the MAC and applied to every local chord', () => {
    const node = airfoil('hexagonal', { airfoilLeDiamond: 0.01, airfoilTeDiamond: 0.01 });
    const atRoot = finSectionProfile(node, 0.08, { mac });
    const atTip = finSectionProfile(node, 0.02, { mac });
    [0, 0.2, 0.8, 1].forEach((v, i) => expect(atRoot.xi[i]).toBeCloseTo(v, 15));
    expect(atRoot.xi.length).toBe(4);
    expect(atTip.xi).toEqual(atRoot.xi);
    expect(atRoot.half).toEqual([0, H, H, 0]);
    // Without a MAC the local chord stands in for it (10 + 10 mm on 20 mm: the
    // chamfers meet at mid-chord) — which is why a mesher passes the MAC.
    expect(finSectionProfile(node, 0.02).xi).toEqual([0, 0.5, 1]);
  });
});

describe('LE bluntness radius', () => {
  const C = 0.05;
  it('rounds the LE with a circle of radius r, tangent into the section, never above t/2', () => {
    const r = 0.0005;
    const node = airfoil('hexagonal', { finLeRadius: r });
    const spec = finSectionSpec(node, C);
    expect(spec.leRadius).toBe(r);
    const h = (x: number): number => sectionHalfThickness(spec, C, x / C);
    // On the arc: h = √(r² − (r − x)²), so the frontal height is 2r near the LE.
    for (const x of [1e-5, 1e-4, 2e-4]) expect(h(x)).toBeCloseTo(Math.sqrt(r * r - (r - x) ** 2), 12);
    // It thickens the wedge near the LE (blunter), and leaves the plateau alone.
    const bare = finSectionSpec(airfoil('hexagonal'), C);
    expect(h(0.0003)).toBeGreaterThan(sectionHalfThickness(bare, C, 0.0003 / C));
    for (const xi of [0.4, 0.5, 0.9, 1]) expect(sectionHalfThickness(spec, C, xi)).toBe(sectionHalfThickness(bare, C, xi));
    // Tangent: the slope just before and just after the tangent point agree.
    const slopes: number[] = [];
    for (let i = 1; i < 4000; i++) {
      const x = (i / 4000) * (C / 3);
      slopes.push((h(x + 1e-7) - h(x - 1e-7)) / 2e-7);
    }
    for (let i = 1; i < slopes.length; i++) expect(slopes[i]!).toBeLessThanOrEqual(slopes[i - 1]! + 1e-3);
    expect(finSectionProfile(node, C).le.kind).toBe('round');
  });

  it('caps the radius at the section’s peak half-thickness', () => {
    const spec = finSectionSpec(airfoil('doublewedge', { finLeRadius: 0.01 }), C);
    const h = (x: number): number => sectionHalfThickness(spec, C, x / C);
    for (const x of [1e-4, 5e-4, 1e-3]) expect(h(x)).toBeCloseTo(Math.sqrt(H * H - (H - x) ** 2), 12);
    expect(peak(spec, C).half).toBeCloseTo(H, 12);
  });

  it('biconvex: common tangent with the arc, convex hull stays concave', () => {
    const spec = finSectionSpec(airfoil('biconvex', { finLeRadius: 0.0004 }), C);
    const bare = finSectionSpec(airfoil('biconvex'), C);
    let prevSlope = Number.POSITIVE_INFINITY;
    for (let i = 1; i < 2000; i++) {
      const xi = i / 2000;
      const hh = sectionHalfThickness(spec, C, xi);
      expect(hh).toBeGreaterThanOrEqual(sectionHalfThickness(bare, C, xi) - 1e-15);
      const slope = (sectionHalfThickness(spec, C, xi + 1e-7) - sectionHalfThickness(spec, C, xi - 1e-7)) / 2e-7;
      expect(slope).toBeLessThanOrEqual(prevSlope + 1e-6);
      prevSlope = slope;
    }
    for (const xi of [0.5, 0.7, 1]) expect(sectionHalfThickness(spec, C, xi)).toBeCloseTo(sectionHalfThickness(bare, C, xi), 15);
  });

  it('is not read by naca (its nose radius is the law’s own), rounded, square or plain airfoil', () => {
    for (const node of [airfoil('naca', { finLeRadius: 0.001 }), airfoil(undefined, { finLeRadius: 0.001 }),
      fin({ crossSection: 'rounded', finLeRadius: 0.001 }), fin({ finLeRadius: 0.001 })]) {
      const spec = finSectionSpec(node, C);
      expect(spec.leRadius).toBe(0);
      const plain = finSectionSpec({ ...node, finLeRadius: 0 } as ComponentNode, C);
      for (let i = 0; i <= 20; i++) expect(sectionHalfThickness(spec, C, i / 20)).toBe(sectionHalfThickness(plain, C, i / 20));
    }
  });

  it('singlewedge with a radius: blunt base kept, LE round', () => {
    const prof = finSectionProfile(airfoil('singlewedge', { finLeRadius: 0.0005 }), C);
    expect(prof.le.kind).toBe('round');
    expect(prof.te).toEqual({ kind: 'blunt', height: T });
    expect(prof.half[prof.half.length - 1]).toBe(H);
  });
});

describe('sampled profiles for meshing', () => {
  const chords = [0, 1e-4, 0.001, 0.0025, 0.003, 0.004, 0.01, 0.05, 0.3];
  const nodes: [string, ComponentNode][] = [
    ['square', fin()],
    ['rounded', fin({ crossSection: 'rounded' })],
    ['airfoil (NACA)', airfoil()],
    ['naca', airfoil('naca')],
    ['hexagonal', airfoil('hexagonal', { airfoilLeDiamond: 0.01, airfoilTeDiamond: 0.015 })],
    ['doublewedge', airfoil('doublewedge')],
    ['biconvex', airfoil('biconvex')],
    ['hexbluntbase', airfoil('hexbluntbase')],
    ['singlewedge', airfoil('singlewedge')],
    ['hexagonal + LE radius', airfoil('hexagonal', { finLeRadius: 0.0006 })],
    ['doublewedge + LE radius ≥ t/2', airfoil('doublewedge', { finLeRadius: 0.004 })],
    ['biconvex + LE radius', airfoil('biconvex', { finLeRadius: 0.0005 })],
    ['hexbluntbase + LE radius', airfoil('hexbluntbase', { finLeRadius: 0.0005 })],
    ['singlewedge + LE radius', airfoil('singlewedge', { finLeRadius: 0.0005 })],
  ];

  it.each(nodes)('%s: same sample count at every chord, ξ from 0 to 1, increasing, on the law', (_l, node) => {
    const mac = 0.05;
    const counts = new Set<number>();
    for (const c of chords) {
      const prof = finSectionProfile(node, c, { mac });
      counts.add(prof.xi.length);
      expect(prof.half.length).toBe(prof.xi.length);
      expect(prof.xi[0]).toBe(0);
      expect(prof.xi[prof.xi.length - 1]).toBe(1);
      for (const h of prof.half) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(H);
      }
      if (c > 0) {
        for (let i = 1; i < prof.xi.length; i++) expect(prof.xi[i]!).toBeGreaterThan(prof.xi[i - 1]!);
        const spec = finSectionSpec(node, mac);
        // 1e-10 m: the exact law's √(1 − u²) at u = 1 − ε is ~2e-11 m off its 0.
        prof.xi.forEach((xi, i) => expect(prof.half[i]).toBeCloseTo(sectionHalfThickness(spec, c, xi), 10));
      }
    }
    expect(counts.size).toBe(1);
  });

  it('square is the flat prism: two samples at t/2, flagged flat', () => {
    const prof = finSectionProfile(fin(), 0.05);
    expect(prof).toMatchObject({ flat: true, law: 'square', xi: [0, 1], half: [H, H] });
    for (const node of nodes.slice(1)) expect(finSectionProfile(node[1], 0.05).flat).toBe(false);
  });

  it('round edges are clustered (cosine-type), straight sections carry breakpoints only', () => {
    const naca = finSectionProfile(airfoil(), 0.05);
    expect(naca.xi.length).toBe(25);
    expect(naca.xi[1]! - naca.xi[0]!).toBeLessThan((naca.xi[13]! - naca.xi[12]!) / 10);
    const rounded = finSectionProfile(fin({ crossSection: 'rounded' }), 0.05);
    expect(rounded.xi.length).toBe(14);
    expect(rounded.xi[1]! - rounded.xi[0]!).toBeLessThan(rounded.xi[6]! - rounded.xi[5]!);
    expect(finSectionProfile(airfoil('doublewedge'), 0.05).xi).toEqual([0, 0.5, 1]);
    expect(finSectionProfile(airfoil('singlewedge'), 0.05).xi).toEqual([0, 1]);
    // Resolution scales the curved sections.
    expect(sectionProfile(finSectionSpec(airfoil()), 0.05, 48).xi.length).toBe(49);
    expect(sectionProfile(finSectionSpec(airfoil()), 0.05, 1).xi.length).toBe(5);
  });

  it('the sampled rounded edge is the semicircle of radius t/2 on a long chord', () => {
    const c = 0.05;
    const prof = finSectionProfile(fin({ crossSection: 'rounded' }), c);
    for (let i = 0; i < 7; i++) {
      const x = prof.xi[i]! * c;
      expect(Math.hypot(x - H, prof.half[i]!)).toBeCloseTo(H, 12);
    }
  });

  it('halfThickness(node, ξ) is the spec-level law', () => {
    const node = airfoil('hexagonal', { airfoilLeDiamond: 0.01 });
    expect(halfThickness(node, 0.1, { chord: 0.05, mac: 0.05 })).toBeCloseTo(H / 2, 12);
    expect(halfThickness(fin(), 0.5, { chord: 0.05 })).toBe(H);
  });
});

describe('finMacFromOutline — FinSetCalc.calculateFinGeometry', () => {
  it('a rectangle’s MAC is its chord', () => {
    expect(finMacFromOutline([[0, 0], [0, 0.03], [0.05, 0.03], [0.05, 0]])).toBeCloseTo(0.05, 12);
  });
  it('a trapezoid comes within 1 % of (2/3)(cr + ct − cr·ct/(cr + ct))', () => {
    const cr = 0.05;
    const ct = 0.03;
    const exact = (2 / 3) * (cr + ct - cr * ct / (cr + ct));
    expect(Math.abs(finMacFromOutline([[0, 0], [0.02, 0.03], [0.05, 0.03], [0.05, 0]]) / exact - 1)).toBeLessThan(0.01);
  });
  it('degenerate outlines read 0', () => {
    expect(finMacFromOutline([[0, 0], [1, 0]])).toBe(0);
    expect(finMacFromOutline([[0, 0], [1, 0], [2, 0]])).toBe(0);
  });
});

describe('printable minimum edge', () => {
  it('is 0.4 mm', () => expect(PRINT_MIN_EDGE).toBe(0.0004));

  it('floors at half the minimum edge and never exceeds t/2', () => {
    expect(printableHalf(0, T)).toBe(0.0002);
    expect(printableHalf(0.0001, T)).toBe(0.0002);
    expect(printableHalf(0.0009, T)).toBe(0.0009);
    expect(printableHalf(H, T)).toBe(H);
    // Stock thinner than the minimum edge: the floor is the stock itself.
    expect(printableHalf(0, 0.0003)).toBe(0.00015);
    expect(printableHalf(0, T, 0.01)).toBe(H);
    expect(printableHalf(0, T, 0)).toBe(0);
  });

  it('turns sharp and round edges into blunt faces of the minimum edge height', () => {
    const raw = finSectionProfile(airfoil(), 0.05);
    const prof = printableProfile(raw);
    expect(prof.le).toEqual({ kind: 'blunt', height: 0.0004 });
    expect(prof.te).toEqual({ kind: 'blunt', height: 0.0004 });
    expect(prof.half[0]).toBe(0.0002);
    expect(prof.half[prof.half.length - 1]).toBe(0.0002);
    expect(Math.max(...prof.half)).toBe(Math.max(...raw.half));
    expect(raw.half).toEqual(finSectionProfile(airfoil(), 0.05).half);
    const blunt = printableProfile(finSectionProfile(airfoil('singlewedge'), 0.05));
    expect(blunt.te).toEqual({ kind: 'blunt', height: T });
    const flat = finSectionProfile(fin(), 0.05);
    expect(printableProfile(flat)).toBe(flat);
  });
});

describe('isolation: the flight path never imports the section law', () => {
  // Walk the RUNTIME relative-import closure of the two flight entry points
  // (`import type` / `export type` are erased, so they are not followed); the
  // drawing law must not be in it (N062 hard rule 1).
  const here = dirname(fileURLToPath(import.meta.url));
  const src = resolve(here, '..');
  function closure(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:import|export)\s(?!type\s)[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const spec = (m[1] ?? m[2])!.replace(/\.js$/, '');
        const base = resolve(dirname(file), spec);
        const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(p));
        if (hit) stack.push(hit);
      }
    }
    return seen;
  }
  it.each(['services/buildDesign.ts', 'services/simulateDesign.ts'])('%s', (entry) => {
    const files = [...closure(resolve(src, entry))].map((f) => f.replace(/\\/g, '/'));
    expect(files.length).toBeGreaterThan(3);
    // The walker does follow the flight path's runtime imports (a helper this module shares).
    expect(files.some((f) => f.endsWith('/tree/kernelDefaults.ts'))).toBe(true);
    expect(files.filter((f) => /\/tree\/finSection\.ts$/.test(f))).toEqual([]);
  });
});
