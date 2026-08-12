/**
 * Splitting a printable part that does not fit the printer, in 2-D.
 *
 * WHY THERE IS NO MESH BOOLEAN HERE. Every revolved printable part — nose
 * cone, transition, body tube, inner tube, launch lug, coupler, engine block,
 * centering ring, bulkhead, tube fin — is ONE closed (x, r) loop handed to
 * solidMesh's revolveProfile(). So "cut it in half" is half-plane clipping of
 * a simple polygon plus a handful of appended points, then re-revolving.
 * revolveProfile() already guarantees a watertight, outward-wound mesh for any
 * simple closed loop, so every segment inherits that proof instead of needing
 * a CSG library, a repair pass and a new class of failure. Clipping the
 * REVOLVED mesh instead would throw all of that away.
 *
 * Units are pure SI throughout: meters, radians. The x1000 to millimeters
 * lives in services/stlExport.ts and nowhere else; the millimeter figures in
 * the human-readable `reason` strings are formatted for display only.
 *
 * THE JOINT. At a cut the FORE piece grows a male spigot and the AFT piece is
 * left exactly as the clip produced it — its bore already IS the mating
 * surface, and the flat annulus the clip left at x = c is a hard axial stop.
 * That buys two things worth stating out loud:
 *   - the land is the datum, the taper is the register. Assembled length is
 *     set by two flat faces meeting, so it is exact and does not depend on how
 *     far a taper wedges in;
 *   - the spigot is an offset of the REAL bore, so it registers along its
 *     whole length rather than only at its root.
 * See spigotOuter() for the one place that second property has to bend to
 * physics: a taper only inserts if it converges in the insertion direction.
 */
import type { ComponentNode } from '@online-openrocket/engine';
import { collapseLoop, componentLoop, type SolidContext } from './solidMesh.js';

const EPS = 1e-9;

/**
 * A printer's usable build volume, in METERS (SI, like everything upstream of
 * the STL writer). A 350 x 320 x 325 mm Bambu H2D is
 * { x: 0.350, y: 0.320, z: 0.325 }.
 */
export interface PrinterVolume {
  /** bed X (m) */
  x: number;
  /** bed Y (m) */
  y: number;
  /** maximum Z (m) */
  z: number;
  /**
   * Keep-out inset (m) applied at BOTH ends of all three axes, default 8 mm.
   * On Z the top inset is gantry/fan-duct clearance and the bottom one is the
   * brim-and-first-layer allowance; keeping it symmetric makes it one number a
   * user can reason about ("keep 8 mm clear") and errs toward one more piece
   * rather than a print that fails at layer 900.
   */
  margin?: number;
  /** joint clearance per side (m), default 0.15 mm */
  clearance?: number;
  /** override the spigot length (m); default is derived from the local diameter */
  spigot?: number;
  /** refuse to plan more than this many pieces, default 6 */
  maxSegments?: number;
  /** allow the support-free lean before deciding to cut at all, default true */
  lean?: boolean;
}

export interface SplitPlan {
  /** true iff the part prints in ONE piece (possibly leaned) — then cuts is empty */
  fits: boolean;
  /** cut planes as offsets from the FORE end of the printed part (m), evenly spaced */
  cuts: number[];
  /** pieces to print; 0 means "cannot be printed on this machine" */
  segments: number;
  /** tallest single print (m), spigot included */
  tallestPrint: number;
  /** one sentence for the UI, already in millimeters */
  reason: string;
  /** set only when the one-piece fit needed the lean */
  leanUsed?: boolean;
  /**
   * Whole degrees off vertical the certified lean actually uses. It is NOT a
   * constant: see MAX_LEAN. Set only alongside leanUsed, and the UI must quote
   * this rather than assume 30 — telling a builder "leaned 30°" when the plan
   * leaned 18 is the same class of lie the constant was.
   */
  leanDeg?: number;
}

export interface SplitJoint {
  /** per-side clearance (m), default 0.15 mm */
  clearance?: number;
  /** explicit spigot length (m); default max(0.25 x local diameter, 12 mm) capped at 30 mm */
  spigot?: number;
  /** legal cut window in loop x (m) — cuts outside it are refused */
  bodySpan?: [number, number];
  /** part wall (m); cuts must clear each end of bodySpan by this much */
  wall?: number;
}

/** Refusal with a reason the UI can show. Thrown by splitBodyLoop(). */
export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitError';
  }
}

export const DEFAULT_MARGIN = 0.008;
export const DEFAULT_CLEARANCE = 0.00015;
export const DEFAULT_MAX_SEGMENTS = 6;
/** Spigot wall: thin enough to stay stiff-but-printable, never thicker than the part's own. */
const SPIGOT_WALL = 0.0016;
const MIN_SPIGOT = 0.006;

/**
 * The overhang a slicer can bridge unsupported, measured from vertical. This
 * is the physical budget the lean spends.
 */
const OVERHANG_LIMIT = (45 * Math.PI) / 180;

/**
 * Ceiling on the support-free lean, radians. Leaning is checked BEFORE cutting
 * because it is free: a part that leans in is one solid print with no joint at
 * all.
 *
 * 30 deg is the CEILING, not the answer. Tipping a part by theta adds theta to
 * the overhang on the meridian that rotates outward, so the real budget is
 * (45 deg - the part's own steepest wall angle) and this constant only stops a
 * perfectly cylindrical part from lying down. It used to be applied
 * unconditionally, derived from ONE shape — a 4:1 tangent ogive, whose steepest
 * wall really is ~14.3 deg off axis (rho = (L^2+R^2)/2R = 1.238 m, slope =
 * L/sqrt(rho^2-L^2) = 0.254), leaving 30.7 deg of budget. Every other nose
 * shape is steeper at the tip and several are far steeper — measured off the
 * 64-sample profiles this file actually cuts, on a 76.2 mm base:
 *
 *   ogive 4:1  14.1 deg   ogive 2:1  28 deg    haack 4:1   24.7 deg
 *   power 0.5  45.0 deg   ellipsoid  54.0 deg
 *
 * (every entry is at 4:1 on a 76.2 mm base. power 0.5 is 45.0 deg there — it
 * reads 26.6 deg only at 8:1, which is what an earlier revision of this table
 * quoted by mistake. At 45 deg it gets no lean at all, which is the point.)
 *
 * so an ellipsoid leaned 30 deg is printing 84 deg of overhang: unsupported air
 * on the cone's underside, or supports that scar one whole side. planAxialSplit
 * now takes the profile's measured slope and leans by
 * min(MAX_LEAN, 45 deg - slope), floored to whole degrees so the number in the
 * reason string is the number the geometry was checked at.
 *
 * The near-flat orientation is deliberately NOT modelled even though it fits
 * far more: it lays the layer lines along the axis, which is exactly the
 * direction an ejection charge loads a nose shoulder, and it drags support
 * scarring down one side of the cone.
 */
const MAX_LEAN = (30 * Math.PI) / 180;

const mm = (v: number): string => (v * 1000).toFixed(1);

/** max(0.25 x local diameter, 12 mm), capped at 30 mm. */
function spigotLengthFor(diameter: number): number {
  return Math.min(Math.max(0.25 * diameter, 0.012), 0.030);
}

/**
 * The build volume minus keep-clear, in METERS.
 *
 * The margin is asymmetric on purpose, and the asymmetry is physical: X and Y
 * lose it TWICE because the part is inset from both bed edges, but Z loses it
 * ONCE because the part sits ON the bed at z = 0 and only needs headroom at the
 * top (gantry, and the slicer's own ceiling).
 *
 * An earlier revision took 2*m off Z as well, purely to reproduce a segment
 * count asserted in the brief that was itself wrong — it came from a 25 mm
 * spigot estimate, where spigotLengthFor() gives 19.05 mm on a 76.2 mm part.
 * The effect was an 8 mm band of parts (309-317 mm on an H2D) being split when
 * they would have printed whole. Do not "restore" the symmetry: the counts to
 * check against are re-derived in splitSolid.test.ts, not remembered.
 */
export function usableBox(printer: PrinterVolume): { x: number; y: number; z: number } {
  const m = Math.max(printer.margin ?? DEFAULT_MARGIN, 0);
  return { x: printer.x - 2 * m, y: printer.y - 2 * m, z: printer.z - m };
}

/**
 * How many pieces a part of `totalLength` and `maxRadius` needs, and where to
 * cut. Lengths in METERS.
 *
 * The load-bearing subtlety is the per-segment span: it is (usable Z - spigot
 * length), NOT usable Z, because the male spigot protrudes past the cut plane
 * and is part of what the printer has to build. Forgetting it is the classic
 * off-by-one-segment bug — a 381 mm part on a 220 mm Prusa plans as 2 x 190.5
 * mm, then each half turns out to be 209.6 mm tall.
 *
 * The reserved spigot is derived from `maxRadius`, i.e. the LARGEST spigot any
 * cut on this part could produce: spigotLengthFor() is monotone in diameter
 * and the local diameter at a cut can only be <= the max, so planning with the
 * max makes the plan a fixed point — wherever the cuts land, the real joints
 * are never taller than what was reserved.
 */
export function planAxialSplit(
  totalLength: number, maxRadius: number, printer: PrinterVolume, maxSlope = 0,
): SplitPlan {
  const none = (reason: string): SplitPlan =>
    ({ fits: false, cuts: [], segments: 0, tallestPrint: totalLength, reason });

  if (!(totalLength > 0) || !(maxRadius > 0)) return none('Part has no printable size.');
  const u = usableBox(printer);
  const dia = 2 * maxRadius;
  const bed = Math.min(u.x, u.y);
  if (u.z <= 0 || bed <= 0) return none('Build volume is smaller than the margin.');
  if (dia > bed + EPS) {
    return none(
      `Ø${mm(dia)} mm is wider than the ${mm(bed)} mm usable bed — no axial cut makes a part narrower.`,
    );
  }

  if (totalLength <= u.z + EPS) {
    return {
      fits: true, cuts: [], segments: 1, tallestPrint: totalLength,
      reason: `Fits upright in one piece (${mm(totalLength)} mm of ${mm(u.z)} mm).`,
    };
  }

  if (printer.lean !== false) {
    // How far this PARTICULAR part may tip before its own steepest wall eats
    // the 45 deg overhang budget. Floored to whole degrees so the angle quoted
    // in the reason is exactly the angle the bounding box was checked at.
    const slope = Math.max(maxSlope, 0);
    // +EPS before the floor: MAX_LEAN round-trips through radians as
    // 29.999999999999996 deg, and flooring that to 29 would silently shave a
    // degree off every cylinder.
    const leanDeg = Math.floor(
      (Math.min(MAX_LEAN, Math.max(OVERHANG_LIMIT - slope, 0)) * 180) / Math.PI + 1e-9,
    );
    // Below a degree there is nothing to gain and the arithmetic is noise.
    if (leanDeg >= 1) {
      const lean = (leanDeg * Math.PI) / 180;
      // Bounding box of the part tipped by `lean` off vertical. Note this is
      // only worth trying for slender parts: height = L*cos + D*sin beats L
      // only when L/D > (1 - cos)/sin = 3.73 at 30 deg, so a stubby part just
      // reports the upright answer.
      const h = totalLength * Math.cos(lean) + dia * Math.sin(lean);
      const foot = totalLength * Math.sin(lean) + dia * Math.cos(lean);
      // The leaned part is a foot x dia RECTANGLE on the bed, and a rectangle
      // goes in a rectangle one of two ways round. The old test was
      // `foot <= hypot(u.x, u.y)`, which certified placements that do not
      // exist: it never carried the part's width, and the minimal enclosing
      // square of a 247 x 60 mm rectangle is 247 mm — tilting NEVER helps
      // contain a rectangle in a square, and even a naive 45 deg placement of
      // that one needs (247+60)/sqrt(2) = 217 mm. A 390 x 60 mm part on a
      // 200 x 200 x 400 mm custom bed was told it fitted, and the 2-piece
      // split that would really have printed was suppressed.
      const onBed = (foot <= u.x + EPS && dia <= u.y + EPS)
        || (foot <= u.y + EPS && dia <= u.x + EPS);
      if (h <= u.z + EPS && onBed) {
        return {
          fits: true, cuts: [], segments: 1, tallestPrint: h, leanUsed: true, leanDeg,
          reason: `Fits in one piece leaned ${leanDeg}° off vertical (${mm(h)} mm tall) — its `
            + `steepest wall is ${Math.round((slope * 180) / Math.PI)}° off axis, so nothing `
            + 'overhangs past 45°, and there is no joint to glue.',
        };
      }
    }
  }

  const spigot = printer.spigot ?? spigotLengthFor(dia);
  const span = u.z - spigot;
  if (span <= 0) {
    return none(`A ${mm(spigot)} mm spigot leaves no usable height in ${mm(u.z)} mm of Z.`);
  }
  // -EPS so an exact multiple does not round up to a spurious extra piece.
  const n = Math.ceil(totalLength / span - 1e-9);
  const cap = printer.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  if (n > cap) {
    return none(
      `Would need ${n} pieces (limit ${cap}) — at that many joints buy the tube rather than print it.`,
    );
  }

  const cuts: number[] = [];
  for (let i = 1; i < n; i++) cuts.push((totalLength * i) / n);
  const tallestPrint = totalLength / n + spigot;
  return {
    fits: false, cuts, segments: n, tallestPrint,
    reason: `${mm(totalLength)} mm does not fit ${mm(u.z)} mm of usable Z — `
      + `${n} pieces of ${mm(totalLength / n)} mm, tallest print ${mm(tallestPrint)} mm with its spigot.`,
  };
}

/** Axial extent [x0, x1] of a loop. */
function extentOf(loop: ReadonlyArray<[number, number]>): [number, number] {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const [x] of loop) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  return [x0, x1];
}

function maxRadiusOf(loop: ReadonlyArray<[number, number]>): number {
  let r = 0;
  for (const [, v] of loop) if (v > r) r = v;
  return r;
}

/**
 * Steepest OUTER wall angle off the part's axis (radians) — the number the
 * lean has to spend its 45 deg overhang budget on. See MAX_LEAN.
 *
 * The outer skin is recovered as the upper envelope of the loop: at each
 * abscissa the loop carries the outer radius and the bore radius (bodyLoop()
 * builds the bore from the very same samples), and the outer one is by
 * construction the larger. Slopes are CHORDS between consecutive samples, not
 * analytic tangents, because a chord is what revolveProfile() emits and
 * therefore what the slicer sees — several shapes (haack, power, ellipsoid)
 * are vertical at the tip in closed form and would otherwise report 90 deg for
 * a facet that is nothing of the kind.
 *
 * `span` restricts the walk to the plain body. Shoulders are cylindrical, so
 * they contribute nothing but their own radial STEP, which is a face and not a
 * wall — including it would read a 2.5 mm step over one 4.76 mm sample as a
 * 28 deg wall and veto the lean on every nose that has a shoulder.
 */
function maxOuterSlope(
  loop: ReadonlyArray<[number, number]>, span?: readonly [number, number],
): number {
  const lo = span ? span[0] - EPS : -Infinity;
  const hi = span ? span[1] + EPS : Infinity;
  const skin = new Map<number, number>();
  for (const [x, r] of loop) {
    if (x < lo || x > hi) continue;
    const prev = skin.get(x);
    if (prev === undefined || r > prev) skin.set(x, r);
  }
  const xs = [...skin.keys()].sort((a, b) => a - b);
  let worst = 0;
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i]! - xs[i - 1]!;
    if (dx <= EPS) continue;
    // Magnitude, not sign: a part is printed base down, and whichever way the
    // wall runs, ONE meridian rotates outward when the part is tipped.
    const s = Math.atan2(Math.abs(skin.get(xs[i]!)! - skin.get(xs[i - 1]!)!), dx);
    if (s > worst) worst = s;
  }
  return worst;
}

/**
 * Exact volume of the solid a closed (x, r) loop sweeps about +X (m^3).
 *
 * Each edge sweeps a truncated cone, so the loop integral pi * §r^2 dx has the
 * closed form below and needs no mesh: it is the same number solidVolume()
 * reports in the limit of infinitely many facets, and printPack.ts uses it to
 * price the joints without revolving anything.
 */
export function revolvedVolume(loop: ReadonlyArray<[number, number]>): number {
  let v = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const [ax, ar] = loop[i]!;
    const [bx, br] = loop[(i + 1) % n]!;
    v += (bx - ax) * (ar * ar + ar * br + br * br);
  }
  return Math.abs((Math.PI * v) / 3);
}

/**
 * Radii where the loop crosses the plane x = c, ascending.
 *
 * This is the whole legality test for a cut plane. A plain wall gives exactly
 * two crossings — the bore and the outer skin — and Sutherland-Hodgman then
 * yields a simple polygon on each side. Anything else means the profile
 * doubles back at c (a capped shoulder emits [L+len, 0] then [L+len-cap, 0]),
 * and clipping THERE produces a zero-width bridge: a non-manifold STL that
 * Bambu Studio silently "repairs" into something that is not the part.
 *
 * Half-open rule [px, qx): a vertex sitting exactly on the plane — which is
 * what outerProfile(..., extraX) deliberately produces at a cut — is counted
 * by exactly one of its two edges, so each wall still reports one crossing.
 */
function crossingsAt(loop: ReadonlyArray<[number, number]>, c: number): number[] {
  const out: number[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const [px, pr] = loop[i]!;
    const [qx, qr] = loop[(i + 1) % n]!;
    if (px <= c && qx > c) out.push(pr + ((qr - pr) * (c - px)) / (qx - px));
    else if (qx <= c && px > c) out.push(qr + ((pr - qr) * (c - qx)) / (px - qx));
  }
  return out.sort((a, b) => a - b);
}

/** Sutherland-Hodgman against x <= c (keepLess) or x >= c. Exact: a half-plane is convex. */
function clipHalfPlane(
  loop: ReadonlyArray<[number, number]>, c: number, keepLess: boolean,
): Array<[number, number]> {
  const inside = (p: [number, number]): boolean => (keepLess ? p[0] <= c : p[0] >= c);
  const out: Array<[number, number]> = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % n]!;
    const pi = inside(p);
    if (pi) out.push(p);
    if (pi !== inside(q)) {
      const t = (c - p[0]) / (q[0] - p[0]);
      out.push([c, p[1] + (q[1] - p[1]) * t]);
    }
  }
  // A vertex exactly ON the plane makes SH emit it twice (once as an inside
  // point, once as a degenerate intersection) — collapseLoop eats the pair.
  return collapseLoop(out);
}

/**
 * Replace the BORE end (r smallest) of the flat face a clip left at x = c with
 * `insert`, which is written bore-end-first: out along the face, aft, and back
 * to wherever it rejoins the part. If the loop happens to traverse the face
 * the other way it is inserted reversed. Winding itself is not our problem —
 * revolveProfile() normalizes it from the signed area.
 *
 * `trimX` drops the bore-path vertices between trimX and the face, which is
 * what makes the lead-in ramp local: without it, `insert`'s last point would
 * connect straight to the next surviving bore vertex — the FAR END of the
 * piece on a plain tube — and quietly taper the entire bore, adding a seventh
 * of the part's mass.
 */
function spliceAtFace(
  piece: ReadonlyArray<[number, number]>, c: number,
  insert: ReadonlyArray<[number, number]>, trimX?: number,
): Array<[number, number]> {
  const n = piece.length;
  for (let i = 0; i < n; i++) {
    const a = piece[i]!;
    const b = piece[(i + 1) % n]!;
    if (Math.abs(a[0] - c) > EPS || Math.abs(b[0] - c) > EPS) continue;
    const boreIsB = b[1] < a[1];
    const iBore = boreIsB ? (i + 1) % n : i;
    const step = boreIsB ? 1 : -1;
    const at = (k: number): number => ((k % n) + n) % n;

    const skip = new Set<number>([iBore]);
    if (trimX !== undefined) {
      // The bore path runs monotonically away from the face, so walking one
      // way and stopping at the first vertex past the ramp is enough.
      for (let d = 1; d < n - 2; d++) {
        const v = piece[at(iBore + step * d)]!;
        if (v[0] <= trimX + EPS) break;
        skip.add(at(iBore + step * d));
      }
    }

    const seq = boreIsB ? insert : [...insert].reverse();
    const out: Array<[number, number]> = [];
    for (let j = 0; j < n; j++) {
      if (j === iBore) out.push(...seq);
      else if (!skip.has(j)) out.push(piece[j]!);
    }
    return out;
  }
  throw new SplitError(`No cut face found at ${mm(c)} mm.`);
}

/**
 * Outer surface of the spigot over [c, c + len], as (x, r) samples taken at
 * the bore's own breakpoints so the polyline is EXACT rather than resampled.
 *
 * The rule is a running minimum of the bore, not the bore itself. A tapered
 * plug only inserts if it converges in the insertion direction: where the bore
 * WIDENS aft (a nose cone) an offset copy of it would be fatter at its tip
 * than the socket mouth and could not enter at all, so the running minimum
 * flattens it to a cylinder at the mouth radius. Where the bore narrows aft (a
 * reducing transition) the running minimum IS the bore, and the spigot is the
 * full-length tapered register the design asks for. Either way
 * S(x) <= bore(x) - clearance and S is non-increasing, which is exactly the
 * condition for it to slide freely to the land.
 *
 * Returns null if the bore is unusable (solid, or the profile stops being a
 * plain wall) before MIN_SPIGOT of length is available.
 */
function spigotOuter(
  loop: ReadonlyArray<[number, number]>, c: number, len: number, clearance: number, minWall: number,
): Array<[number, number]> | null {
  const xs = new Set<number>([c, c + len]);
  for (const [x] of loop) if (x > c && x < c + len) xs.add(x);
  const sorted = [...xs].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let run = Infinity;
  for (const x of sorted) {
    const cr = crossingsAt(loop, x);
    if (cr.length !== 2) break;
    run = Math.min(run, cr[0]!);
    const r = run - clearance;
    if (r <= minWall + EPS) break;
    out.push([x, r]);
  }
  if (out.length < 2 || out[out.length - 1]![0] - c < MIN_SPIGOT) return null;
  return out;
}

/**
 * Cut ONE closed (x, r) loop — the same loop bodyLoop() produces — into
 * N loops at the given cut planes, each ready for an UNMODIFIED
 * revolveProfile(). Cuts are in loop x, meters, and need not be sorted.
 *
 * Throws SplitError rather than returning a broken part: a cut inside a
 * shoulder, within one wall of an end, or anywhere the profile is not a plain
 * two-crossing wall is refused with a sentence the UI can show.
 */
export function splitBodyLoop(
  loop: ReadonlyArray<[number, number]>, cuts: readonly number[], joint: SplitJoint = {},
): Array<Array<[number, number]>> {
  const src = collapseLoop(loop.map(([x, r]) => [x, Math.max(r, 0)] as [number, number]));
  if (src.length < 3) throw new SplitError('Profile is empty.');
  const sorted = [...cuts].sort((a, b) => a - b);
  if (sorted.length === 0) return [src];

  const [x0, x1] = extentOf(src);
  const clearance = Math.max(joint.clearance ?? DEFAULT_CLEARANCE, 0);

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (i > 0 && c - sorted[i - 1]! < MIN_SPIGOT) {
      throw new SplitError(`Cuts at ${mm(sorted[i - 1]!)} and ${mm(c)} mm are too close together.`);
    }
    if (!(c > x0 + EPS && c < x1 - EPS)) {
      throw new SplitError(`Cut at ${mm(c)} mm is outside the part.`);
    }
    if (joint.bodySpan) {
      const [b0, b1] = joint.bodySpan;
      // One wall thickness clear of each end of the body, and never more than
      // a quarter of the body (a 3 mm centring ring has no interior at all).
      const inset = Math.min(Math.max(joint.wall ?? 0, 0), (b1 - b0) / 4);
      if (c < b0 + inset - EPS || c > b1 - inset + EPS) {
        throw new SplitError(
          `Cut at ${mm(c)} mm lands in a shoulder or against an end face — cuts are only legal `
          + `between ${mm(b0 + inset)} and ${mm(b1 - inset)} mm, where the wall is plain. `
          + 'A shoulder is a mating surface and the profile doubles back inside it.',
        );
      }
    }
    const cr = crossingsAt(src, c);
    if (cr.length !== 2) {
      throw new SplitError(
        `The profile crosses ${mm(c)} mm ${cr.length} times — that is not a plain wall, `
        + 'and clipping there would produce a non-manifold shell.',
      );
    }
  }

  const bounds = [x0, ...sorted, x1];
  const pieces: Array<Array<[number, number]>> = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    let p: Array<[number, number]> = [...src];
    if (i > 0) p = clipHalfPlane(p, bounds[i]!, false);
    if (i + 2 < bounds.length) p = clipHalfPlane(p, bounds[i + 1]!, true);
    if (p.length < 3) throw new SplitError(`Piece ${i + 1} came out empty.`);
    pieces.push(p);
  }

  for (let k = 0; k < sorted.length; k++) {
    const c = sorted[k]!;
    const [bore, outer] = crossingsAt(src, c) as [number, number];
    const wallAtCut = outer - bore;
    // The spigot may not run past the far end of the piece it plugs into...
    const segAft = bounds[k + 2]! - c;
    // ...NOR into that piece's own lead-in ramp. When the next bound is
    // another cut, the piece this spigot enters grows a spigot of its own at
    // its far end, and doing so RAMPS ITS BORE DOWN over (clearance + ts)
    // before that cut (see the ramp below). The two features overlap whenever
    // 0.1 * segAft < clearance + ts, i.e. under about 17.5 mm of segment: a
    // Ø60 mm, 3 mm wall tube cut at 30 and 42 mm put the spigot tip at 40.80
    // mm with an OD of 26.85 mm where the bore had already ramped to 26.45 —
    // 0.4 mm of radial interference, so the joint jams 0.55 mm short of its
    // land and the assembled length is wrong. The mesh stays watertight, so
    // nothing downstream catches it; subtracting the ramp here does.
    // SPIGOT_WALL is the ceiling on the next joint's ts, so this is an upper
    // bound on the ramp and therefore conservative.
    const nextRamp = k + 1 < sorted.length
      ? Math.min(clearance + SPIGOT_WALL, 0.4 * segAft)
      : 0;
    const room = Math.max(Math.min(0.9 * segAft, segAft - nextRamp), 0);
    let len = Math.min(joint.spigot ?? spigotLengthFor(2 * outer), room);

    if (bore <= EPS) {
      // Constraint: a solid part has no bore, so there is nowhere to put an
      // internal spigot. Fall back to an on-axis stub and a matching socket —
      // the same land-is-the-datum joint, just registered on the axis.
      const rs = Math.min(0.35 * outer, 0.008);
      if (rs < 0.001 || len < MIN_SPIGOT) {
        throw new SplitError(
          `The part is solid at ${mm(c)} mm and too small (Ø${mm(2 * outer)} mm) for an on-axis `
          + 'stub — print it whole, or hollow it out first.',
        );
      }
      len = Math.min(len, 0.020);
      // The socket is cut DEEPER than the stub is long. Both used to be `len`,
      // which is zero axial clearance: the stub bottoms out at exactly the
      // moment the flat land seats, so any positive length error — elephant
      // foot on the stub's first layer, over-extrusion on the face it prints
      // against, a seam blob — holds the two flat faces apart and the
      // assembled length is no longer set by the land, which is the one
      // property this joint (and README.txt) promises. Worse, the socket is
      // blind and the stub is solid, so the 30-minute epoxy the README calls
      // for is hydraulically trapped and holds the joint open by itself. The
      // relief is a reservoir for it; the hollow-spigot path below needs
      // neither because its bore is open through.
      const relief = Math.max(clearance, 0.0003);
      const depth = len + relief;
      // ...and a 45 deg lead-in at the mouth, which starts the stub straight
      // and gives squeezed-out epoxy a fillet to sit in instead of a wedge
      // that levers the land open. rs <= 0.35 * outer keeps the chamfered
      // mouth well inside the flat face, so the loop stays simple.
      const chamfer = Math.min(0.0005, 0.25 * rs);
      // No ramp on either side: a stub and its socket both overlap the solid
      // face radially, so they are already attached to it.
      pieces[k] = spliceAtFace(pieces[k]!, c, [[c, rs], [c + len, rs], [c + len, 0]]);
      pieces[k + 1] = spliceAtFace(pieces[k + 1]!, c, [
        [c, rs + clearance + chamfer], [c + chamfer, rs + clearance],
        [c + depth, rs + clearance], [c + depth, 0],
      ]);
      continue;
    }

    const ts = Math.min(wallAtCut, SPIGOT_WALL);
    if (len < MIN_SPIGOT || ts <= EPS) {
      throw new SplitError(`No room for a spigot at ${mm(c)} mm (wall ${mm(wallAtCut)} mm).`);
    }
    const face = spigotOuter(src, c, len, clearance, ts);
    if (!face) {
      throw new SplitError(
        `The bore at ${mm(c)} mm is too shallow or too narrow to register a spigot in.`,
      );
    }
    // Aft along the spigot's outer face, across its end, then fore along its
    // inner face — and then a short ramp back out to the bore.
    //
    // The ramp is not cosmetic. The spigot's OD is (bore - clearance), so its
    // wall sits entirely INSIDE the part's bore and shares no radius with the
    // part's own wall: without something joining them the spigot is a floating
    // tube. The ramp narrows the bore from `bore` to the spigot's ID over
    // (clearance + ts), a 45° internal lead-in, which both attaches the spigot
    // and thickens the wall into a boss right where the joint is loaded.
    const back: Array<[number, number]> = [];
    for (let i = face.length - 1; i >= 0; i--) {
      const [x, r] = face[i]!;
      back.push([x, Math.max(r - ts, 0)]);
    }
    const ramp = Math.min(clearance + ts, 0.4 * (c - bounds[k]!));
    const rampR = crossingsAt(src, c - ramp)[0] ?? bore;
    pieces[k] = spliceAtFace(pieces[k]!, c, [...face, ...back, [c - ramp, rampR]], c - ramp);
  }

  return pieces.map((p) => collapseLoop(p));
}

export interface ComponentSplit {
  plan: SplitPlan;
  label: string;
  /**
   * Revolved volume of the WHOLE part before any cut (m^3). It is the
   * denominator the UI prices the joints against — the segments carry spigots
   * and bosses that are ADDED material, and on a thin-walled part that is a
   * third of the filament.
   */
  wholeVolume: number;
  /** fore -> aft; empty when the part prints whole or cannot be split */
  loops: Array<Array<[number, number]>>;
}

/**
 * Where n-1 cut planes may actually go, in loop x.
 *
 * planAxialSplit() spaces cuts evenly over the part because it is handed a
 * length and a radius and knows nothing else. splitBodyLoop() then REFUSES any
 * cut that lands in a shoulder — correctly; the profile doubles back in there
 * — and the whole plan collapsed to segments: 0 even when a perfectly legal
 * placement existed two millimetres away. The named 3" nose at 5 pieces put
 * its fourth cut on 304.8 mm, the exact cone/shoulder boundary, and reported
 * "cannot be split" for a part that splits into five printable pieces.
 *
 * Two placements are tried, in order:
 *   - the even one, NUDGED: each cut is raised only as far as it must be and
 *     then capped, so a plan that was already legal comes back untouched
 *     (the named H2D/MK4S cases must not move);
 *   - pushed aft: every cut as late as it may go, which maximises reach and is
 *     the placement to beat when the legal window is the binding constraint.
 * Only if both fail for every piece count up to the cap do we refuse.
 *
 * `need` carries the tail: after cut i there are (n - i) pieces left and none
 * may exceed `span`, so the cut cannot sit fore of x1 - (n - i) * span. `cap`
 * carries the head and the window. If need > cap this piece count is
 * impossible and the caller tries one more piece.
 */
function placeCuts(
  x0: number, x1: number, lo: number, hi: number,
  n: number, span: number, minPiece: number, pushAft: boolean,
): number[] | null {
  const cuts: number[] = [];
  let prev = x0;
  for (let i = 1; i < n; i++) {
    const cap = Math.min(hi, prev + span, x1 - minPiece);
    const need = Math.max(lo, prev + minPiece, x1 - (n - i) * span);
    if (need > cap + EPS) return null;
    const even = x0 + ((x1 - x0) * i) / n;
    cuts.push(pushAft ? cap : Math.min(Math.max(even, need), cap));
    prev = cuts[i - 1]!;
  }
  if (x1 - prev > span + EPS) return null;
  return cuts;
}

/**
 * End-to-end: plan a component's split and produce the segment loops. Returns
 * null for anything that is not a revolved part (fins are flat prisms; they
 * are split by nothing here).
 *
 * Deliberately two-pass. The first pass builds the loop to measure the part,
 * the second REBUILDS it with the cut planes handed to outerProfile() as
 * extraX so each cut lands on an exact curve sample instead of on a chord.
 *
 * Callers: `plan.fits` means export the single existing solid — never re-emit
 * a one-piece part as a one-entry zip. `plan.segments === 0` means refuse and
 * show `plan.reason`.
 */
export function splitComponent(
  node: ComponentNode, ctx: SolidContext, printer: PrinterVolume,
): ComponentSplit | null {
  const first = componentLoop(node, ctx);
  if (!first) return null;
  const [x0, x1] = extentOf(first.loop);
  const total = x1 - x0;
  const maxRadius = maxRadiusOf(first.loop);
  const wholeVolume = revolvedVolume(first.loop);
  const plan = planAxialSplit(total, maxRadius, printer, maxOuterSlope(first.loop, first.bodySpan));
  if (plan.fits || plan.segments < 2) {
    return { plan, label: first.label, wholeVolume, loops: [] };
  }

  const u = usableBox(printer);
  const spigot = printer.spigot ?? spigotLengthFor(2 * maxRadius);
  const span = u.z - spigot;
  const clearance = Math.max(printer.clearance ?? DEFAULT_CLEARANCE, 0);
  // The shortest piece a joint can be built on: MIN_SPIGOT of plug, plus the
  // lead-in ramp the piece's own aft joint cuts out of the same bore (D4).
  const minPiece = MIN_SPIGOT + clearance + SPIGOT_WALL;
  const [b0, b1] = first.bodySpan;
  // The same window splitBodyLoop() enforces, so a placement that passes here
  // is one it will accept — plus room at each end for the joint itself.
  const inset = Math.min(Math.max(first.wall, 0), (b1 - b0) / 4);
  const lo = Math.max(b0 + inset, x0 + minPiece);
  const hi = Math.min(b1 - inset, x1 - minPiece);

  const cap = printer.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  let cuts: number[] | null = null;
  let n = plan.segments;
  for (; n <= cap; n++) {
    cuts = placeCuts(x0, x1, lo, hi, n, span, minPiece, false)
      ?? placeCuts(x0, x1, lo, hi, n, span, minPiece, true);
    if (cuts) break;
  }
  if (!cuts) {
    return {
      plan: {
        fits: false, cuts: [], segments: 0, tallestPrint: plan.tallestPrint,
        reason: `${mm(total)} mm needs at least ${plan.segments} pieces, but every cut has to `
          + `land between ${mm(lo)} and ${mm(hi)} mm — the rest of the part is shoulder or end `
          + 'face, where a joint cannot go, and no set of cuts inside that window prints.',
      },
      label: first.label,
      wholeVolume,
      loops: [],
    };
  }

  // A plan that was already legal keeps its own numbers and its own sentence:
  // the named cases must be byte-identical to what they were before shoulders
  // were considered at all.
  const moved = n !== plan.segments
    || cuts.some((c, i) => Math.abs(c - (x0 + plan.cuts[i]!)) > EPS);
  let used = plan;
  if (moved) {
    const ends = [x0, ...cuts, x1];
    const lens = ends.slice(1).map((e, i) => e - ends[i]!);
    used = {
      fits: false,
      cuts: cuts.map((c) => c - x0),
      segments: n,
      tallestPrint: Math.max(...lens) + spigot,
      reason: `${mm(total)} mm does not fit ${mm(u.z)} mm of usable Z — ${n} pieces of `
        + `${mm(Math.min(...lens))}-${mm(Math.max(...lens))} mm, spaced to keep every cut out of `
        + `the shoulders, tallest print ${mm(Math.max(...lens) + spigot)} mm with its spigot.`,
    };
  }

  const exact = componentLoop(node, ctx, cuts) ?? first;
  try {
    const loops = splitBodyLoop(exact.loop, cuts, {
      clearance: printer.clearance ?? DEFAULT_CLEARANCE,
      spigot: printer.spigot,
      bodySpan: exact.bodySpan,
      wall: exact.wall,
    });
    return { plan: used, label: exact.label, wholeVolume, loops };
  } catch (err) {
    const reason = err instanceof SplitError ? err.message : String(err);
    return {
      plan: { fits: false, cuts: [], segments: 0, tallestPrint: used.tallestPrint, reason },
      label: exact.label,
      wholeVolume,
      loops: [],
    };
  }
}
