/**
 * splitSolid: the geometry of cutting an oversized printable part down to
 * printer-sized segments.
 *
 * The oracles are the ones solidMesh already ships — isWatertight() on every
 * segment (a slicer rejects nothing else) and solidVolume() conservation
 * (sum of segments minus the spigots that were ADDED must return the whole
 * part). Both are cheap and both catch the failure that matters: a clip that
 * produced a zero-width bridge instead of a face.
 *
 * The named case throughout is a 3" (76.2 mm) airframe with a 4:1 tangent
 * ogive nose: 304.8 mm of cone plus a 76.2 mm shoulder = 381 mm printed.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { componentLoop, isWatertight, revolveProfile, solidVolume } from './solidMesh.js';
import { outerProfile } from './shapeProfile.js';
import {
  planAxialSplit, splitBodyLoop, splitComponent, SplitError, usableBox,
  type PrinterVolume,
} from './splitSolid.js';

const node = (type: string, params: Record<string, unknown>): ComponentNode =>
  ({ type, ...params } as unknown as ComponentNode);

/** Bambu H2D and Prusa MK4S, meters. Both with the default 8 mm margin. */
const H2D: PrinterVolume = { x: 0.350, y: 0.320, z: 0.325, margin: 0.008 };
const MK4S: PrinterVolume = { x: 0.250, y: 0.210, z: 0.220, margin: 0.008 };

/**
 * Usable build box, taken from the module under test rather than restated.
 * The margin is asymmetric — twice off X and Y (inset from both bed edges),
 * ONCE off Z (the part sits on the bed, only the top needs clearance) — and
 * restating it here is how it silently drifted once already.
 */
const UZ = (p: PrinterVolume): number => usableBox(p).z;

const R3IN = 0.0381;
const CONE_L = 0.3048;
const SHOULDER_L = 0.0762;
const WALL = 0.002;

const nose3in = (extra: Record<string, unknown> = {}): ComponentNode => node('nosecone', {
  shape: 'ogive', shapeParameter: 1, length: CONE_L, aftRadius: R3IN, thickness: WALL,
  shoulderRadius: 0.0356, shoulderLength: SHOULDER_L, shoulderThickness: WALL,
  ...extra,
});

const volumeOf = (loop: Array<[number, number]>): number => {
  const mesh = revolveProfile(loop);
  expect(isWatertight(mesh)).toBe(true);
  const v = solidVolume(mesh);
  expect(v).toBeGreaterThan(0);
  return v;
};

const extentOf = (loop: Array<[number, number]>): [number, number] => [
  Math.min(...loop.map((p) => p[0])), Math.max(...loop.map((p) => p[0])),
];
const maxRadiusOf = (loop: Array<[number, number]>): number => Math.max(...loop.map((p) => p[1]));

/** Loop crossings at x, ascending — the same half-open rule crossingsAt() uses. */
const crossings = (loop: Array<[number, number]>, x: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < loop.length; i++) {
    const [px, pr] = loop[i]!;
    const [qx, qr] = loop[(i + 1) % loop.length]!;
    if (px <= x && qx > x) out.push(pr + ((qr - pr) * (x - px)) / (qx - px));
    else if (qx <= x && px > x) out.push(qr + ((pr - qr) * (x - qx)) / (px - qx));
  }
  return out.sort((a, b) => a - b);
};

/** Every segment must physically go in the machine, not just be watertight. */
const expectFitsBuildVolume = (loops: Array<Array<[number, number]>>, p: PrinterVolume): void => {
  const u = usableBox(p);
  for (const loop of loops) {
    const [a, b] = extentOf(loop);
    expect(b - a).toBeLessThanOrEqual(u.z + 1e-9);
    expect(2 * maxRadiusOf(loop)).toBeLessThanOrEqual(Math.min(u.x, u.y) + 1e-9);
  }
};

describe('planAxialSplit — the named 3" 4:1 ogive nose (381 mm printed)', () => {
  // Re-derived, not remembered. The spigot on a Ø76.2 part is
  // max(0.25*76.2, 12) = 19.05 mm, so the span is (usable Z - 19.05):
  //   H2D  317 - 19.05 = 297.95  ->  381/297.95 = 1.28  -> 2
  //   MK4S 212 - 19.05 = 192.95  ->  381/192.95 = 1.97  -> 2
  // An earlier revision asserted 3 on the MK4S. That came from a 25 mm spigot
  // estimate in the design doc, and reproducing it is what pushed usableBox()
  // into taking the margin off Z twice. Both are fixed; the arithmetic above
  // is the check.
  it('is 2 pieces on BOTH a Bambu H2D and a Prusa MK4S', () => {
    const spigot = 0.01905;
    for (const p of [H2D, MK4S]) {
      const plan = planAxialSplit(0.381, R3IN, p);
      expect(plan.fits).toBe(false);
      expect(plan.segments).toBe(Math.ceil(0.381 / (UZ(p) - spigot)));
      expect(plan.segments).toBe(2);
      expect(plan.cuts).toHaveLength(1);
      expect(plan.cuts[0]).toBeCloseTo(0.1905, 9);
      expect(plan.tallestPrint).toBeLessThanOrEqual(UZ(p) + 1e-9);
    }
  });

  it('a 5" Goblin nose needs 3 on an H2D and 4 on an MK4S', () => {
    // The case that genuinely needs more than two: 650 mm long, Ø130.81, so
    // the spigot hits its 30 mm cap. H2D 317-30 = 287 -> 650/287 = 2.27 -> 3;
    // MK4S 212-30 = 182 -> 650/182 = 3.57 -> 4. Both still fit the bed.
    expect(planAxialSplit(0.650, 0.0654, H2D).segments).toBe(3);
    expect(planAxialSplit(0.650, 0.0654, MK4S).segments).toBe(4);
  });

  it('counts the spigot toward print height — the off-by-one-segment bug', () => {
    // The spigot protrudes past the cut plane, so the usable span per segment
    // is (usable Z - spigot), not usable Z. A 400 mm part on the MK4S is the
    // case that separates them: 400/212 = 1.9 -> 2 if the spigot were free,
    // but 400/192.95 = 2.07 -> 3 once it is counted.
    expect(planAxialSplit(0.400, R3IN, { ...MK4S, spigot: 0 }).segments).toBe(2);
    expect(planAxialSplit(0.400, R3IN, MK4S).segments).toBe(3);
    // ...and the reported tallest print is the segment PLUS its spigot.
    const p = planAxialSplit(0.400, R3IN, MK4S);
    expect(p.tallestPrint).toBeCloseTo(0.400 / 3 + 0.01905, 9);
    expect(p.tallestPrint).toBeLessThanOrEqual(UZ(MK4S) + 1e-9);
  });
});

describe('planAxialSplit — the decisions before cutting', () => {
  it('a part that fits prints whole: fits true, zero cuts, one segment', () => {
    const p = planAxialSplit(0.25, 0.02, H2D);
    expect(p.fits).toBe(true);
    expect(p.cuts).toEqual([]);
    expect(p.segments).toBe(1);
    expect(p.leanUsed).toBeUndefined();
    expect(p.tallestPrint).toBe(0.25);
  });

  it('leans a slender part in rather than cutting it', () => {
    // 330 mm x Ø40 upright needs 330 of the H2D's 317; tipped 30 deg it needs
    // 330*cos30 + 40*sin30 = 305.8. No joint, no glue, still support-free.
    const p = planAxialSplit(0.330, 0.020, H2D);
    expect(p.fits).toBe(true);
    expect(p.leanUsed).toBe(true);
    expect(p.cuts).toEqual([]);
    expect(p.tallestPrint).toBeCloseTo(0.330 * Math.cos(Math.PI / 6) + 0.040 * 0.5, 9);
    expect(p.reason).toMatch(/lean/i);
    // Opting out of the lean falls straight through to cutting.
    expect(planAxialSplit(0.330, 0.020, { ...H2D, lean: false }).fits).toBe(false);
  });

  it('does not pretend a lean saves a stubby part (it makes it taller)', () => {
    // L/D below 3.73 means tipping raises the bounding box, so the 381 mm
    // named case must NOT come back as a leaned one-piece print.
    expect(planAxialSplit(0.381, R3IN, H2D).leanUsed).toBeUndefined();
  });

  it('refuses a part wider than the bed — no axial cut makes it narrower', () => {
    const p = planAxialSplit(0.2, 0.15, MK4S);
    expect(p.fits).toBe(false);
    expect(p.segments).toBe(0);
    expect(p.reason).toMatch(/wider than/);
  });

  it('caps the piece count and says so', () => {
    const p = planAxialSplit(2.0, R3IN, MK4S);
    expect(p.segments).toBe(0);
    expect(p.reason).toMatch(/limit 6/);
    // A caller that really wants 11 pieces can raise the cap.
    expect(planAxialSplit(2.0, R3IN, { ...MK4S, maxSegments: 12 }).segments).toBe(11);
  });

  it('an exact multiple of the span does not round up to a spurious piece', () => {
    const span = UZ(H2D) - 0.01905;
    expect(planAxialSplit(span * 2, R3IN, H2D).segments).toBe(2);
  });
});

describe('splitBodyLoop — a 600 mm 3" body tube', () => {
  const tube = node('bodytube', { outerRadius: R3IN, thickness: WALL, length: 0.6 });

  it('splits into 3 watertight segments that each fit the machine', () => {
    const s = splitComponent(tube, {}, H2D)!;
    expect(s.plan.segments).toBe(3);
    expect(s.loops).toHaveLength(3);
    for (const loop of s.loops) volumeOf(loop);
    expectFitsBuildVolume(s.loops, H2D);
  });

  it('conserves volume: sum of segments minus the spigots is the whole part', () => {
    const whole = volumeOf(componentLoop(tube, {})!.loop);
    const s = splitComponent(tube, {}, H2D)!;
    const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);
    // Constant bore -> the running-minimum spigot is a plain cylinder, so its
    // volume is exact: PI*(S^2 - (S-ts)^2)*Ls per joint, S = bore - clearance.
    const S = R3IN - WALL - 0.00015;
    const ts = 0.0016;
    const Ls = 0.25 * 2 * R3IN;
    const spigots = 2 * Math.PI * (S ** 2 - (S - ts) ** 2) * Ls;
    expect(sum).toBeGreaterThan(whole);
    expect(Math.abs(sum - spigots - whole) / whole).toBeLessThan(0.01);
  });

  it('segments abut exactly, and only the fore piece of a joint grows', () => {
    const s = splitComponent(tube, {}, H2D)!;
    const Ls = 0.25 * 2 * R3IN;
    const spans = s.loops.map(extentOf);
    // Cut planes at 200 and 400 mm; each fore piece carries its spigot past
    // the plane, each aft piece starts exactly ON it (the land is the datum).
    expect(spans[0]![0]).toBeCloseTo(0, 12);
    expect(spans[0]![1]).toBeCloseTo(0.2 + Ls, 9);
    expect(spans[1]![0]).toBeCloseTo(0.2, 12);
    expect(spans[1]![1]).toBeCloseTo(0.4 + Ls, 9);
    expect(spans[2]![0]).toBeCloseTo(0.4, 12);
    expect(spans[2]![1]).toBeCloseTo(0.6, 12);
    // The tallest print the plan promised is the tallest one actually built.
    const tallest = Math.max(...spans.map(([a, b]) => b - a));
    expect(tallest).toBeLessThanOrEqual(s.plan.tallestPrint + 1e-9);
  });

  it('the spigot is a clearance fit inside the bore it plugs into', () => {
    const s = splitComponent(tube, {}, H2D)!;
    const bore = R3IN - WALL;
    // Nothing on the fore piece aft of the cut may reach the socket wall.
    const past = s.loops[0]!.filter(([x]) => x > 0.2 + 1e-9);
    expect(past.length).toBeGreaterThan(0);
    for (const [, r] of past) expect(r).toBeLessThanOrEqual(bore - 0.00015 + 1e-12);
    expect(Math.max(...past.map((p) => p[1]))).toBeCloseTo(bore - 0.00015, 12);
  });
});

describe('splitComponent — revolved parts of every stripe stay watertight', () => {
  const cases: Array<[string, ComponentNode, PrinterVolume]> = [
    ['nose cone (4:1 ogive + shoulder)', nose3in(), MK4S],
    ['transition, fore and aft shoulders', node('transition', {
      shape: 'conical', length: 0.5, foreRadius: R3IN, aftRadius: 0.025, thickness: WALL,
      foreShoulderRadius: 0.0356, foreShoulderLength: 0.05, foreShoulderThickness: WALL,
      aftShoulderRadius: 0.023, aftShoulderLength: 0.05, aftShoulderThickness: WALL,
    }), H2D],
    ['body tube', node('bodytube', { outerRadius: R3IN, thickness: WALL, length: 0.6 }), H2D],
    ['tube coupler', node('tubecoupler', { thickness: 0.0015, length: 0.55 }), H2D],
  ];

  for (const [name, n, printer] of cases) {
    it(`${name}: every segment watertight, fits the volume, conserves volume`, () => {
      const ctx = { parentInnerRadius: R3IN - WALL };
      const s = splitComponent(n, ctx, printer)!;
      expect(s.plan.segments).toBeGreaterThan(1);
      expect(s.loops).toHaveLength(s.plan.segments);
      const whole = volumeOf(componentLoop(n, ctx)!.loop);
      const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);
      expectFitsBuildVolume(s.loops, printer);
      // The spigots are ADDED material, so the sum must overshoot — and by a
      // plausible amount: a leaking clip shows up here as a wild number long
      // before anyone opens the file. (A thin 2 mm-wall nose is the worst
      // case at ~7.6%: its spigots are a real fraction of a hollow shell.)
      // The exact accounting is the per-part test below.
      expect(sum).toBeGreaterThan(whole * 0.999);
      expect(sum).toBeLessThan(whole * 1.10);
    });
  }

  it('nose cone: volume conservation to 1% with the spigot accounted exactly', () => {
    const n = nose3in();
    const whole = volumeOf(componentLoop(n, {})!.loop);
    const s = splitComponent(n, {}, MK4S)!;
    // ONE cut, not two: the MK4S has 212 mm of usable Z (220 less the margin,
    // taken off the top only), the reserved spigot on Ø76.2 is 19.05 mm, so
    // the span is 192.95 and 381/192.95 = 1.97 -> 2 pieces. The old
    // expectation of two cuts came from the 204 mm a doubled Z margin gave.
    expect(s.plan.cuts).toHaveLength(Math.ceil(0.381 / (UZ(MK4S) - 0.01905)) - 1);
    expect(s.plan.cuts).toHaveLength(1);
    const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);

    // A nose bore WIDENS aft, so the running-minimum spigot is a cylinder at
    // the mouth radius; its volume is analytic from the exact profile sample.
    const ts = 0.0016;
    let spigots = 0;
    for (const c of s.plan.cuts) {
      const rOut = outerProfile('ogive', 1, CONE_L, 0, R3IN, 64, [c]).find((p) => p[0] === c)![1];
      const S = rOut - WALL - 0.00015;
      const Ls = Math.min(Math.max(0.25 * 2 * rOut, 0.012), 0.030);
      spigots += Math.PI * (S ** 2 - (S - ts) ** 2) * Ls;
    }
    expect(Math.abs(sum - spigots - whole) / whole).toBeLessThan(0.01);
  });

  it('the spigot converges toward its tip, so it can actually be inserted', () => {
    // A tapered plug only enters a socket if it narrows in the insertion
    // direction. A REDUCING transition's bore narrows aft, so the spigot is
    // the full-length tapered register: an offset copy of the real bore,
    // clearance-fit along its whole length.
    const L = 0.5, Rf = R3IN, Ra = 0.025;
    const n = node('transition', {
      shape: 'conical', length: L, foreRadius: Rf, aftRadius: Ra, thickness: WALL,
      foreShoulderRadius: 0.0356, foreShoulderLength: 0.05, foreShoulderThickness: WALL,
      aftShoulderRadius: 0.023, aftShoulderLength: 0.05, aftShoulderThickness: WALL,
    });
    const s = splitComponent(n, {}, H2D)!;
    const c = -0.05 + s.plan.cuts[0]!;
    const bore = (x: number): number => Rf + ((Ra - Rf) * x) / L - WALL;

    // Outer radius of the spigot at each of its abscissas.
    const past = s.loops[0]!.filter(([x]) => x > c + 1e-9);
    const byX = new Map<number, number>();
    for (const [x, r] of past) byX.set(x, Math.max(byX.get(x) ?? 0, r));
    const xs = [...byX.keys()].sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThan(1);

    let prev = Infinity;
    for (const x of xs) {
      const r = byX.get(x)!;
      expect(r).toBeLessThanOrEqual(prev + 1e-12);          // never grows aft
      expect(r).toBeLessThanOrEqual(bore(x) - 0.00015 + 1e-12); // clearance fit
      prev = r;
    }
    // ...and it really is a taper here, not the cylinder a widening bore gets.
    expect(byX.get(xs[xs.length - 1]!)!).toBeLessThan(byX.get(xs[0]!)! - 0.0001);
    // Offset by exactly the clearance from the real bore, at every abscissa —
    // that is what "registers along its whole length" means.
    for (const x of xs) expect(byX.get(x)!).toBeCloseTo(bore(x) - 0.00015, 9);
  });

  it('a widening bore gets a cylinder instead — an offset copy could not enter', () => {
    // A nose bore widens aft: an offset copy of it would be FATTER at its tip
    // than the socket mouth. The running minimum flattens it to a cylinder at
    // the mouth radius, which still slides to the land.
    const s = splitComponent(nose3in(), {}, MK4S)!;
    const c = s.plan.cuts[0]!;
    const past = s.loops[0]!.filter(([x]) => x > c + 1e-9);
    const byX = new Map<number, number>();
    for (const [x, r] of past) byX.set(x, Math.max(byX.get(x) ?? 0, r));
    const radii = [...byX.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    for (const r of radii) expect(r).toBeCloseTo(radii[0]!, 12);
  });

  it('a part that fits comes back whole, with no loops to zip', () => {
    const s = splitComponent(node('bodytube', { outerRadius: 0.02, thickness: 0.001, length: 0.2 }), {}, H2D)!;
    expect(s.plan.fits).toBe(true);
    expect(s.plan.segments).toBe(1);
    expect(s.loops).toEqual([]);
  });

  it('returns null for a fin (not a revolve — there is no loop to clip)', () => {
    expect(splitComponent(node('trapezoidfinset', { rootChord: 0.06 }), {}, H2D)).toBeNull();
  });
});

describe('splitBodyLoop — the refusals', () => {
  it('refuses a cut inside a shoulder', () => {
    const part = componentLoop(nose3in(), {})!;
    // 340 mm is inside the 304.8..381 mm aft shoulder: a mating surface, and
    // the profile doubles back in there.
    expect(() => splitBodyLoop(part.loop, [0.340], { bodySpan: part.bodySpan, wall: part.wall }))
      .toThrow(SplitError);
    expect(() => splitBodyLoop(part.loop, [0.340], { bodySpan: part.bodySpan, wall: part.wall }))
      .toThrow(/shoulder/);
    // The same cut one wall inside the body is fine.
    expect(splitBodyLoop(part.loop, [0.30], { bodySpan: part.bodySpan, wall: part.wall })).toHaveLength(2);
  });

  it('refuses a cut within one wall thickness of an end face', () => {
    const part = componentLoop(nose3in(), {})!;
    const j = { bodySpan: part.bodySpan, wall: part.wall };
    expect(() => splitBodyLoop(part.loop, [0.0005], j)).toThrow(/only legal between/);
    expect(() => splitBodyLoop(part.loop, [CONE_L - 0.0005], j)).toThrow(/only legal between/);
  });

  it('refuses a cut outside the part entirely', () => {
    const part = componentLoop(nose3in(), {})!;
    expect(() => splitBodyLoop(part.loop, [0.5], {})).toThrow(/outside/);
  });

  it('refuses a plane the profile doubles back across (4 crossings)', () => {
    // A grooved wall: any plane through the groove cuts four walls, and
    // Sutherland-Hodgman there yields a zero-width bridge, not a face.
    const groove: Array<[number, number]> = [
      [0, 0.01], [0, 0.03], [0.1, 0.03], [0.1, 0.025],
      [0.04, 0.025], [0.04, 0.015], [0.1, 0.015], [0.1, 0.01],
    ];
    expect(() => splitBodyLoop(groove, [0.07], {})).toThrow(/crosses/);
    // ...while a plane fore of the groove is a plain wall and splits fine.
    expect(splitBodyLoop(groove, [0.02], {})).toHaveLength(2);
  });

  it('no cuts is a no-op that returns the loop unchanged', () => {
    const part = componentLoop(nose3in(), {})!;
    expect(splitBodyLoop(part.loop, [])).toHaveLength(1);
  });
});

describe('solid parts have no bore — the on-axis stub-and-socket fallback', () => {
  it("filled: true splits on an axial stub, watertight, volume within 1%", () => {
    const n = nose3in({ filled: true, shoulderLength: 0 });
    const part = componentLoop(n, {})!;
    const whole = volumeOf(part.loop);
    const s = splitComponent(n, {}, MK4S)!;
    expect(s.plan.segments).toBe(2);
    expect(s.loops).toHaveLength(2);
    for (const loop of s.loops) volumeOf(loop);
    expectFitsBuildVolume(s.loops, MK4S);
    // The stub adds material and the socket removes slightly more (clearance),
    // so the sum lands just under the whole — well inside 1%.
    const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);
    expect(Math.abs(sum - whole) / whole).toBeLessThan(0.01);
    // The fore piece really does carry a stub past the cut plane.
    const c = s.plan.cuts[0]!;
    const past = s.loops[0]!.filter(([x]) => x > c + 1e-9);
    expect(past.length).toBeGreaterThan(0);
    expect(Math.max(...past.map((p) => p[1]))).toBeLessThanOrEqual(0.008 + 1e-12);
  });

  it('wall thicker than the radius is the same solid case, not a leak', () => {
    const rod = node('bodytube', { outerRadius: 0.02, thickness: 0.05, length: 0.5 });
    const whole = volumeOf(componentLoop(rod, {})!.loop);
    const s = splitComponent(rod, {}, H2D)!;
    expect(s.plan.segments).toBe(2);
    const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);
    expect(Math.abs(sum - whole) / whole).toBeLessThan(0.01);
    expectFitsBuildVolume(s.loops, H2D);
  });

  it('a middle piece carries a socket at one end and a stub at the other', () => {
    const rod = node('bodytube', { outerRadius: 0.02, thickness: 0.05, length: 0.8 });
    const whole = volumeOf(componentLoop(rod, {})!.loop);
    const s = splitComponent(rod, {}, H2D)!;
    expect(s.plan.segments).toBe(3);
    for (const loop of s.loops) volumeOf(loop);
    const [c1, c2] = s.plan.cuts as [number, number];
    const mid = s.loops[1]!;
    // Blind socket at its fore face, stub past its aft face.
    expect(Math.min(...mid.filter(([x]) => x < c1 + 0.021).map((p) => p[1]))).toBeCloseTo(0, 12);
    expect(Math.max(...mid.map((p) => p[0]))).toBeGreaterThan(c2);
    const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);
    expect(Math.abs(sum - whole) / whole).toBeLessThan(0.01);
  });

  it('refuses cleanly when a solid part is too thin even for an axial stub', () => {
    // Ø4 mm rod: 0.35 x 2 mm = 0.7 mm of stub, which is not a joint.
    const loop: Array<[number, number]> = [[0, 0], [0, 0.002], [0.5, 0.002], [0.5, 0]];
    expect(() => splitBodyLoop(loop, [0.25], {})).toThrow(/solid/);
  });
});

describe('joint parameters are caller-overridable', () => {
  const tube = node('bodytube', { outerRadius: R3IN, thickness: WALL, length: 0.6 });

  it('clearance and spigot length come from the caller', () => {
    const part = componentLoop(tube, {})!;
    const loops = splitBodyLoop(part.loop, [0.3], {
      clearance: 0.0005, spigot: 0.025, bodySpan: part.bodySpan, wall: part.wall,
    });
    const past = loops[0]!.filter(([x]) => x > 0.3 + 1e-9);
    expect(Math.max(...past.map((p) => p[0]))).toBeCloseTo(0.325, 12);
    expect(Math.max(...past.map((p) => p[1]))).toBeCloseTo(R3IN - WALL - 0.0005, 12);
    for (const loop of loops) volumeOf(loop);
  });

  it('the default joint is 0.15 mm per side and max(0.25 x D, 12 mm) capped at 30 mm', () => {
    // Ø30 tube -> 0.25*30 = 7.5 mm, so the 12 mm floor applies.
    const small = componentLoop(node('bodytube', { outerRadius: 0.015, thickness: 0.001, length: 0.6 }), {})!;
    const a = splitBodyLoop(small.loop, [0.3], { bodySpan: small.bodySpan, wall: small.wall });
    expect(Math.max(...a[0]!.map((p) => p[0]))).toBeCloseTo(0.312, 12);
    // Ø200 tube -> 0.25*200 = 50 mm, so the 30 mm cap applies.
    const big = componentLoop(node('bodytube', { outerRadius: 0.100, thickness: 0.002, length: 0.6 }), {})!;
    const b = splitBodyLoop(big.loop, [0.3], { bodySpan: big.bodySpan, wall: big.wall });
    expect(Math.max(...b[0]!.map((p) => p[0]))).toBeCloseTo(0.330, 12);
  });
});

/**
 * The seven decision-logic defects an adversarial harness found. Every one of
 * these reproduced with the numbers in the test name before the fix; they are
 * kept because each is a DECISION, and a decision has no mesh oracle to catch
 * it when it regresses.
 */
describe('the lean is a real placement, not a diagonal (D1)', () => {
  it('refuses to certify a 390 x 60 mm part on a 200 x 200 x 395 bed', () => {
    // The old test was `foot <= hypot(u.x, u.y)`, which certifies a placement
    // that does not exist: the minimal enclosing SQUARE of a 247 x 60 mm
    // rectangle is 247 mm, so tilting can never contain it in a 184 mm square,
    // and even a naive 45° placement needs (247 + 60)/sqrt(2) = 217 mm.
    //
    // Z is 395 mm, not the 400 this case was first written with: the margin
    // now comes off Z ONCE, so a 400 mm machine leaves 392 mm usable and the
    // 390 mm part simply stands up — the defect would not be reachable at all.
    // 395 - 8 = 387 < 390 keeps the part needing a lean or a cut, which is
    // what the test is here to watch. Nothing else about the case moves: the
    // bed is the same 184 x 184 mm square and the footprint the same 247 x 60.
    const custom: PrinterVolume = { x: 0.200, y: 0.200, z: 0.395, margin: 0.008 };
    expect(UZ(custom)).toBeCloseTo(0.387, 12);
    expect(0.390).toBeGreaterThan(UZ(custom));   // so the lean really is tried
    const p = planAxialSplit(0.390, 0.030, custom);
    const foot = 0.390 * Math.sin(Math.PI / 6) + 0.060 * Math.cos(Math.PI / 6);
    expect(foot).toBeCloseTo(0.246962, 6);       // the leaned footprint...
    expect(foot).toBeGreaterThan(0.184);          // ...against a 184 mm usable bed
    expect(Math.hypot(0.184, 0.184)).toBeGreaterThan(foot); // what the old test asked
    // So no lean, and the 2-piece split that really does print is offered.
    expect(p.fits).toBe(false);
    expect(p.leanUsed).toBeUndefined();
    expect(p.segments).toBe(2);
    expect(p.reason).not.toMatch(/diagonal/i);
  });

  it('still leans a part that fits the bed axis-aligned', () => {
    // 330 x Ø40 leaned 30° is a 200 x 40 mm footprint on a 334 x 304 mm bed.
    const p = planAxialSplit(0.330, 0.020, H2D);
    expect(p.leanUsed).toBe(true);
    expect(p.leanDeg).toBe(30);
  });

  it('refuses the lean for a part the tilt cannot help', () => {
    // Same 395 mm machine as above (400 would leave 392 mm usable and the part
    // would stand up, so the lean would never be reached). At Ø150 over 390 mm
    // the part is far too stubby for a tilt: D/L = 0.385 is well past the
    // (1 - cos30)/sin30 = 0.268 break-even, so tipping RAISES the bounding box
    // — 390*cos30 + 150*sin30 = 412.7 mm against 387 of usable Z — and the
    // 247 x 150 mm footprint does not go on the 184 mm square bed either.
    const narrow: PrinterVolume = { x: 0.200, y: 0.200, z: 0.395, margin: 0.008 };
    expect(0.390).toBeGreaterThan(UZ(narrow));
    expect(0.390 * Math.cos(Math.PI / 6) + 0.150 * 0.5).toBeGreaterThan(UZ(narrow));
    expect(planAxialSplit(0.390, 0.075, narrow).leanUsed).toBeUndefined();
  });
});

describe('the lean angle comes from the profile, not from one shape (D2)', () => {
  const H2D_UZ = UZ(H2D);

  it('a tangent ogive still gets the full 30° — it is the shape MAX_LEAN was derived from', () => {
    // The fixture is usable Z + 5 mm = 322: the old 312 mm one is now INSIDE
    // the H2D's 317 mm and comes back as a plain upright fit, testing nothing.
    // A tangent ogive this slender (Ø39 over 322 mm) reads 7° off axis on the
    // steepest of its 64 chords, so its own budget is 45 - 7 = 38° and the 30°
    // MAX_LEAN ceiling is what binds — which is the point of the test.
    // Leaned: 322*cos30 + 39*sin30 = 278.9 + 19.5 = 298.4 mm, inside 317.
    const L = H2D_UZ + 0.005;
    expect(L).toBeGreaterThan(H2D_UZ);            // it really does need the lean
    const s = splitComponent(node('nosecone', {
      shape: 'ogive', shapeParameter: 1, length: L, aftRadius: 0.0195, thickness: WALL,
    }), {}, H2D)!;
    expect(s.plan.fits).toBe(true);
    expect(s.plan.leanUsed).toBe(true);
    expect(s.plan.leanDeg).toBe(30);
    expect(s.plan.tallestPrint).toBeCloseTo(
      L * Math.cos(Math.PI / 6) + 0.039 * Math.sin(Math.PI / 6), 9,
    );
    expect(s.plan.tallestPrint).toBeLessThanOrEqual(H2D_UZ + 1e-9);
  });

  it('an ellipsoid nose is NOT leaned — its wall is 54° off axis and would print air', () => {
    // Measured steepest wall 54.0° off the axis over the profile actually
    // built; 54 + 30 = 84° of overhang, which is unsupported air on the
    // underside. The split that avoids it is offered instead.
    // usable Z + 5 mm = 322 (the old 312 mm now fits upright and would never
    // reach the lean at all). Cut count: the reserved spigot on Ø76.2 is 19.05,
    // so the span is 317 - 19.05 = 297.95 and 322/297.95 = 1.08 -> 2 pieces.
    const L = H2D_UZ + 0.005;
    const ell = node('nosecone', { shape: 'ellipsoid', length: L, aftRadius: R3IN, thickness: WALL });
    const s = splitComponent(ell, {}, H2D)!;
    expect(L).toBeGreaterThan(H2D_UZ);            // it really does need the lean or a cut
    expect(s.plan.leanUsed).toBeUndefined();
    expect(s.plan.fits).toBe(false);
    expect(s.plan.segments).toBe(Math.ceil(L / (H2D_UZ - 0.01905)));
    expect(s.plan.segments).toBe(2);
    expect(s.loops).toHaveLength(2);
    for (const loop of s.loops) volumeOf(loop);
  });

  it('a power-0.5 nose leans by 45° minus its own wall angle, and says so', () => {
    // The wall angle here is the FIRST chord of the 64-sample profile, where
    // r = R*sqrt(x/L): atan((R/8)/(L/64)) = atan(8R/L). So R = L/16 pins it at
    // atan(0.5) = 26.565° exactly, and the lean at floor(45 - 26.565) = 18°.
    // The old fixture was 312 x Ø39 — the same 16:1 ratio — and now fits
    // upright in 317 mm, so the length moves to usable Z + 1 = 318 and the
    // radius moves WITH it to 19.875. They have to stay locked together: at
    // 318 x Ø39 the ratio would read 25.98° and the lean would be 19°, not 18.
    // Leaned: 318*cos18 + 39.75*sin18 = 302.4 + 12.3 = 314.7 mm, inside 317.
    const L = H2D_UZ + 0.001;
    const R = L / 16;
    expect(L).toBeGreaterThan(H2D_UZ);            // it really does need the lean
    expect((Math.atan(8 * R / L) * 180) / Math.PI).toBeCloseTo(26.565, 3);
    const s = splitComponent(node('nosecone', {
      shape: 'power', shapeParameter: 0.5, length: L, aftRadius: R, thickness: WALL,
    }), {}, H2D)!;
    expect(s.plan.fits).toBe(true);
    expect(s.plan.leanUsed).toBe(true);
    expect(s.plan.leanDeg).toBe(18);
    expect(s.plan.tallestPrint).toBeCloseTo(
      L * Math.cos((18 * Math.PI) / 180) + 2 * R * Math.sin((18 * Math.PI) / 180), 9,
    );
    expect(s.plan.tallestPrint).toBeLessThanOrEqual(H2D_UZ + 1e-9);
    expect(s.plan.reason).toContain('18°');
    expect(s.plan.reason).not.toContain('30°');
    // ...and the sentence names the wall angle it was derived from: 18 + 27 = 45.
    expect(s.plan.reason).toMatch(/27° off axis/);
  });

  it('a cylinder has no wall angle at all, so nothing changes for tubes', () => {
    // usable Z + 3 mm = 320, so it cannot stand up (312 now can). A cylinder's
    // wall is 0° off axis, so it spends none of the 45° budget and gets the
    // whole 30° ceiling: 320*cos30 + 76.2*sin30 = 277.1 + 38.1 = 315.2 mm,
    // inside 317.
    const L = H2D_UZ + 0.003;
    expect(L).toBeGreaterThan(H2D_UZ);
    const s = splitComponent(node('bodytube', { outerRadius: R3IN, thickness: WALL, length: L }), {}, H2D)!;
    expect(s.plan.leanUsed).toBe(true);
    expect(s.plan.leanDeg).toBe(30);
    expect(s.plan.tallestPrint).toBeCloseTo(
      L * Math.cos(Math.PI / 6) + 2 * R3IN * Math.sin(Math.PI / 6), 9,
    );
  });
});

describe('the on-axis stub bottoms out before the land does (D3)', () => {
  const solidNose = nose3in({ filled: true, shoulderLength: 0 });

  it('cuts the socket deeper than the stub, so the flat faces set the length', () => {
    const s = splitComponent(solidNose, {}, MK4S)!;
    const c = s.plan.cuts[0]!;
    const stubTip = Math.max(...s.loops[0]!.map(([x]) => x));
    // Socket floor: the on-axis point the blind bore ends at, well fore of the
    // part's own aft end face.
    const floor = Math.max(
      ...s.loops[1]!.filter(([x, r]) => x > c + 1e-9 && x < c + 0.05 && r <= 1e-9).map(([x]) => x),
    );
    // 0.25 x the local Ø where the cut lands on the cone — both branches used
    // to take this same `len`, giving 0.0000 mm of axial clearance.
    expect(stubTip - c).toBeCloseTo(0.0143429, 6);
    expect(floor - stubTip).toBeGreaterThanOrEqual(0.0003 - 1e-12);
  });

  it('chamfers the socket mouth so trapped epoxy has somewhere to go', () => {
    const s = splitComponent(solidNose, {}, MK4S)!;
    const c = s.plan.cuts[0]!;
    // Radii the socket presents at its mouth plane, and its parallel wall one
    // chamfer in. Filtered under 20 mm so the part's own outer skin (Ø57 mm
    // there) is not mistaken for the socket.
    const mouth = s.loops[1]!.filter(([x, r]) => Math.abs(x - c) <= 1e-12 && r < 0.02);
    const wall = Math.max(
      ...s.loops[1]!
        .filter(([x, r]) => x > c + 1e-9 && x < c + 0.02 && r > 1e-9 && r < 0.02)
        .map(([, r]) => r),
    );
    expect(wall).toBeCloseTo(0.008 + 0.00015, 12);          // stub radius + clearance
    expect(Math.max(...mouth.map(([, r]) => r))).toBeGreaterThan(wall + 1e-9);
  });

  it('still conserves volume: the extra relief is four hundredths of a percent', () => {
    const whole = volumeOf(componentLoop(solidNose, {})!.loop);
    const s = splitComponent(solidNose, {}, MK4S)!;
    const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);
    expect(Math.abs(sum - whole) / whole).toBeLessThan(0.01);
    expectFitsBuildVolume(s.loops, MK4S);
  });
});

describe('a spigot stops clear of the next joint lead-in ramp (D4)', () => {
  // The harness case: Ø60 mm, 3 mm wall, cut at 30 and 42 mm. A 12 mm middle
  // piece let the spigot claim 0.9 x 12 = 10.8 mm while the piece's own bore
  // had already ramped down 1.75 mm before its aft cut — 0.4 mm of radial
  // interference, and the joint jams 0.55 mm short of its land.
  const tube = node('bodytube', { outerRadius: 0.030, thickness: 0.003, length: 0.100 });

  it('the spigot never reaches the ramp the next joint cut into the same bore', () => {
    const part = componentLoop(tube, {})!;
    const loops = splitBodyLoop(part.loop, [0.030, 0.042], {
      bodySpan: part.bodySpan, wall: part.wall,
    });
    const tip = Math.max(...loops[0]!.map(([x]) => x));
    // Where the middle piece's bore starts narrowing for its OWN joint at 42 mm.
    const rampStart = 0.042 - Math.min(0.00015 + 0.0016, 0.4 * 0.012);
    expect(rampStart).toBeCloseTo(0.04025, 9);
    expect(tip).toBeLessThanOrEqual(rampStart + 1e-12);
  });

  it('and it is a clearance fit at every abscissa, not just at its root', () => {
    const part = componentLoop(tube, {})!;
    const loops = splitBodyLoop(part.loop, [0.030, 0.042], {
      bodySpan: part.bodySpan, wall: part.wall,
    });
    const tip = Math.max(...loops[0]!.map(([x]) => x));
    for (let i = 0; i <= 20; i++) {
      const x = 0.030 + ((tip - 0.030) * i) / 20;
      if (i === 0 || i === 20) continue;
      const spigotOd = Math.max(...crossings(loops[0]!, x));
      const mateBore = Math.min(...crossings(loops[1]!, x));
      expect(spigotOd).toBeLessThanOrEqual(mateBore + 1e-12);
    }
    for (const loop of loops) volumeOf(loop);
  });
});

describe('cuts are nudged out of shoulders instead of failing the plan (D5)', () => {
  it('the named 3" nose at 5 pieces: the 304.8 mm cut moves, it does not kill the plan', () => {
    // Even spacing puts cut 4 exactly on the cone/shoulder boundary, which
    // splitBodyLoop rightly refuses — and the whole part then reported
    // segments: 0 even though 5 legal pieces exist.
    const small: PrinterVolume = { x: 0.120, y: 0.120, z: 0.116, margin: 0.008 };
    const s = splitComponent(nose3in(), {}, small)!;
    expect(s.plan.segments).toBe(5);
    expect(s.loops).toHaveLength(5);
    expect(s.plan.cuts).toHaveLength(4);
    // Every cut inside the plain body, one wall clear of the shoulder.
    for (const c of s.plan.cuts) {
      expect(c).toBeGreaterThanOrEqual(WALL - 1e-12);
      expect(c).toBeLessThanOrEqual(CONE_L - WALL + 1e-12);
    }
    expect(s.plan.cuts[3]).toBeCloseTo(CONE_L - WALL, 9);
    for (const loop of s.loops) volumeOf(loop);
    expectFitsBuildVolume(s.loops, small);
    expect(s.plan.reason).toMatch(/shoulder/i);
  });

  it('a nose whose shoulder is a third of the part still splits', () => {
    const stubby = node('nosecone', {
      shape: 'ogive', shapeParameter: 1, length: 0.200, aftRadius: R3IN, thickness: WALL,
      shoulderRadius: 0.0356, shoulderLength: 0.100, shoulderThickness: WALL,
    });
    const machine: PrinterVolume = { x: 0.150, y: 0.150, z: 0.130, margin: 0 };
    const s = splitComponent(stubby, {}, machine)!;
    expect(s.plan.segments).toBeGreaterThanOrEqual(3);
    expect(s.loops).toHaveLength(s.plan.segments);
    for (const c of s.plan.cuts) expect(c).toBeLessThanOrEqual(0.200 - WALL + 1e-12);
    for (const loop of s.loops) volumeOf(loop);
    expectFitsBuildVolume(s.loops, machine);
  });

  it('an even split that was already legal is left exactly as it was', () => {
    // The named case must not move: same cuts, same reason, same tallest.
    // On the MK4S the 381 mm nose is 2 pieces (212 mm of usable Z less the
    // 19.05 mm reserved spigot = 192.95 of span, 381/192.95 = 1.97), so there
    // is ONE cut and it sits at the halfway point, 190.5 mm. That is inside
    // the 0..304.8 mm cone and more than one wall clear of either end, so the
    // nudge has nothing to do and planAxialSplit's own sentence survives.
    // (Three pieces, cut at 127 and 254, was the doubled-Z-margin answer.)
    const s = splitComponent(nose3in(), {}, MK4S)!;
    expect(s.plan.cuts).toEqual([expect.closeTo(0.381 / 2, 12)]);
    expect(s.plan.cuts).toEqual([expect.closeTo(0.1905, 12)]);
    expect(s.plan.reason).toBe(planAxialSplit(0.381, R3IN, MK4S).reason);
  });

  it('refuses only when no legal placement exists, and says why', () => {
    // 20 mm of body, 400 mm of shoulder: every cut has to live in an 16 mm
    // window, and no set of them makes 420 mm printable.
    const allShoulder = node('nosecone', {
      shape: 'ogive', shapeParameter: 1, length: 0.020, aftRadius: R3IN, thickness: WALL,
      shoulderRadius: 0.0356, shoulderLength: 0.400, shoulderThickness: WALL,
    });
    const s = splitComponent(allShoulder, {}, MK4S)!;
    expect(s.plan.segments).toBe(0);
    expect(s.loops).toEqual([]);
    expect(s.plan.reason).toMatch(/shoulder|end face/i);
  });
});

/**
 * The sweep. Every fix above is a DECISION, and a decision that is right on the
 * case that motivated it can still be wrong two shapes over — the constant this
 * batch removed was itself correct for the one shape it was measured on. So:
 * every nose profile the app can build, against machines from an A1 mini to a
 * Prusa XL, checked against the invariants that must survive all of it.
 */
describe('the invariants hold across the shape x machine matrix', () => {
  const SHAPES: Array<[string, number | undefined]> = [
    ['conical', undefined], ['ogive', 1], ['ogive', 0.6], ['ellipsoid', undefined],
    ['power', 0.5], ['power', 0.75], ['parabolic', 1], ['haack', 0], ['haack', 1 / 3],
  ];
  const MACHINES: Array<[string, PrinterVolume]> = [
    ['A1 mini', { x: 0.180, y: 0.180, z: 0.180, margin: 0.008 }],
    ['MK4S', MK4S],
    ['H2D', H2D],
    ['Prusa XL', { x: 0.360, y: 0.360, z: 0.360, margin: 0.008 }],
  ];

  for (const [shape, param] of SHAPES) {
    for (const [machine, printer] of MACHINES) {
      it(`${shape}${param === undefined ? '' : ` ${param}`} on a ${machine}`, () => {
        const n = node('nosecone', {
          shape, shapeParameter: param, length: 0.340, aftRadius: R3IN, thickness: WALL,
          shoulderRadius: 0.0356, shoulderLength: 0.0762, shoulderThickness: WALL,
        });
        const part = componentLoop(n, {})!;
        const s = splitComponent(n, {}, printer)!;

        if (s.plan.fits) {
          // A certified one-piece fit must really go in the machine, upright
          // or leaned, and a lean must name the angle it was checked at.
          const u = usableBox(printer);
          expect(s.plan.tallestPrint).toBeLessThanOrEqual(u.z + 1e-9);
          if (s.plan.leanUsed) expect(s.plan.leanDeg).toBeGreaterThanOrEqual(1);
          expect(s.loops).toEqual([]);
          return;
        }
        if (s.plan.segments === 0) {
          // A refusal must be clean: nothing emitted, and a sentence to show.
          expect(s.loops).toEqual([]);
          expect(s.plan.reason.length).toBeGreaterThan(20);
          return;
        }

        expect(s.loops).toHaveLength(s.plan.segments);
        const whole = volumeOf(part.loop);
        const sum = s.loops.reduce((a, loop) => a + volumeOf(loop), 0);
        expect(sum).toBeGreaterThan(whole * 0.99);
        expect(sum).toBeLessThan(whole * 1.15);
        expectFitsBuildVolume(s.loops, printer);

        const [x0, x1] = extentOf(part.loop);
        const [b0, b1] = part.bodySpan;
        const inset = Math.min(part.wall, (b1 - b0) / 4);
        let prev = -Infinity;
        s.plan.cuts.forEach((offset, i) => {
          const c = x0 + offset;
          // In the plain body, one wall clear of each end, strictly ordered.
          expect(c).toBeGreaterThanOrEqual(b0 + inset - 1e-12);
          expect(c).toBeLessThanOrEqual(b1 - inset + 1e-12);
          expect(c).toBeGreaterThan(prev);
          prev = c;
          // Every spigot is a clearance fit in the piece it plugs into, along
          // its whole length — including where that piece's own joint has
          // already ramped its bore down (D4).
          const tip = Math.max(...s.loops[i]!.map(([x]) => x));
          for (let k = 1; k < 20; k++) {
            const x = c + ((tip - c) * k) / 20;
            const od = Math.max(...crossings(s.loops[i]!, x));
            const bore = Math.min(...crossings(s.loops[i + 1]!, x));
            expect(od).toBeLessThanOrEqual(bore + 1e-12);
          }
        });
        // Segment lengths still account for the whole part exactly.
        const ends = [x0, ...s.plan.cuts.map((o) => x0 + o), x1];
        expect(ends[ends.length - 1]! - ends[0]!).toBeCloseTo(x1 - x0, 12);
      });
    }
  }
});

describe('outerProfile extraX is purely additive', () => {
  const shapes: Array<[string, number | undefined]> = [
    ['conical', undefined], ['ogive', 1], ['ogive', 0.6], ['ellipsoid', undefined],
    ['power', 0.5], ['parabolic', 1], ['haack', 0], ['haack', 1 / 3],
  ];

  it('omitting it, or passing an empty list, is bit-identical to before', () => {
    for (const [shape, param] of shapes) {
      for (const [f, a] of [[0, 0.024], [0.012, 0.024], [0.024, 0.012], [0.02, 0.02]] as const) {
        const base = outerProfile(shape, param, 0.07, f, a, 32);
        const empty = outerProfile(shape, param, 0.07, f, a, 32, []);
        expect(empty).toHaveLength(base.length);
        for (let i = 0; i < base.length; i++) {
          // Object.is, not toBeCloseTo: "bit-identical" means bit-identical.
          expect(Object.is(empty[i]![0], base[i]![0])).toBe(true);
          expect(Object.is(empty[i]![1], base[i]![1])).toBe(true);
        }
      }
    }
  });

  it('merges exact samples, sorted and deduped, leaving the ladder untouched', () => {
    const base = outerProfile('ogive', 1, CONE_L, 0, R3IN, 64);
    const merged = outerProfile('ogive', 1, CONE_L, 0, R3IN, 64, [0.254, 0.127, 0.127]);
    expect(merged).toHaveLength(base.length + 2);
    expect(merged.map((p) => p[0])).toEqual([...merged.map((p) => p[0])].sort((x, y) => x - y));
    for (const c of [0.127, 0.254]) {
      const hit = merged.filter((p) => p[0] === c);
      expect(hit).toHaveLength(1);
      // Exactly on the curve, not on a chord between samples.
      const rho = (R3IN ** 2 + CONE_L ** 2) / (2 * R3IN);
      expect(hit[0]![1]).toBeCloseTo(Math.sqrt(rho ** 2 - (CONE_L - c) ** 2) - (rho - R3IN), 9);
    }
    // Every original sample survives untouched.
    for (const p of base) expect(merged).toContainEqual(p);
  });

  it('ignores extras outside the span and keeps the endpoints single', () => {
    const merged = outerProfile('conical', 0, 0.05, 0.012, 0.024, 8, [-0.01, 0.06, 0, 0.05, NaN]);
    expect(merged).toHaveLength(9);
    expect(merged[0]![0]).toBe(0);
    expect(merged[8]![0]).toBe(0.05);
  });

  it('the cut plane a split uses lands on the true curve', () => {
    // Without the merge the cut would land on a chord. For this cone the
    // sagitta is ~2 um, so both halves still mate — but "the printed part is
    // the geometry the engine flies" should be literally true.
    const c = 0.1905;
    const part = componentLoop(nose3in(), {}, [c])!;
    const onPlane = part.loop.filter((p) => p[0] === c);
    expect(onPlane).toHaveLength(2); // outer skin and bore
    const rho = (R3IN ** 2 + CONE_L ** 2) / (2 * R3IN);
    const exact = Math.sqrt(rho ** 2 - (CONE_L - c) ** 2) - (rho - R3IN);
    expect(Math.max(...onPlane.map((p) => p[1]))).toBeCloseTo(exact, 12);
    expect(Math.min(...onPlane.map((p) => p[1]))).toBeCloseTo(exact - WALL, 12);
  });
});
