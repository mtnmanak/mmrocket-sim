/**
 * The fin cross-section LAW for drawing and printing (N062) — the ONE place the
 * app turns a fin's section options into a thickness distribution.
 *
 * DISPLAY / EXPORT ONLY. Nothing on the flight path imports this module, and it
 * reads only the fields the node already carries (`crossSection`,
 * `airfoilSection`, `airfoilLeDiamond`, `airfoilTeDiamond`, `finLeRadius`,
 * `thickness`). The kernel's mass factor for a section (FinSet.java:48-54,
 * SQUARE 1.00 / ROUNDED 0.99 / AIRFOIL 0.85, applied at FinSet.java:1720-1723)
 * is a separate number and is NOT this law: a drawn or printed section's volume
 * need not equal the mass the app flies.
 *
 * A fin is constant stock of maximum thickness t, so the SAME section is applied
 * at every spanwise station, scaled to that station's local chord c. Chord
 * fraction ξ = x / c runs 0 (leading edge) → 1 (trailing edge); the value is the
 * HALF-thickness in metres (the surface sits at ±h about the fin's mid-plane).
 *
 * Which law (source: engine-java/patches/info/openrocket/core/aerodynamics/
 * barrowman/FinSetCalc.java, "FinSetCalc" below):
 *
 *  - `square` (and absent, and any unknown value — ComponentFactory.java
 *    crossSectionOf, :1032-1039): t/2 everywhere, `flat: true`. Callers keep the
 *    flat prism for it, vertex for vertex. Blunt LE and TE of height t
 *    (FinSetCalc:1222-1223 stagnation + :1232-1233 full base drag).
 *  - `rounded`: semicircular LE and TE of radius t/2, flat between — the shape
 *    the classic fit implies (FinSetCalc:1210-1221 round-LE fit, :1234-1235
 *    half base drag). Where the local chord is too short for two t/2 arcs
 *    (c < t/0.9, i.e. only near a pointed tip) each edge becomes a quarter
 *    ELLIPSE of chordwise semi-axis 0.45·c and height t/2, leaving a flat of
 *    0.1·c — a documented approximation that keeps the profile continuous in c
 *    and its samples strictly increasing.
 *  - `airfoil` with NO `airfoilSection`: NACA 4-digit symmetric 00xx with the
 *    closed-TE coefficient −0.1036, maximum thickness t at ξ ≈ 0.30 — round LE,
 *    sharp TE, matching the classic airfoil branch (round-LE fit, zero base drag,
 *    FinSetCalc:1210-1221 and :1237 "Airfoil assumed to have zero base drag")
 *    and desktop OR's RASAero export name "Subsonic NACA". The Kbf/Supersonic
 *    models price a sharp biconvex for this case instead (FinSetCalc:1201-1207,
 *    "K=4/3, biconvex"); one drawn shape cannot follow the aerodynamics
 *    preference, and the NACA is the one the label "Airfoil" and desktop name.
 *    The raw polynomial peaks at 1.00012·t; it is scaled by 1/1.00012 so the
 *    drawing is never thicker than t.
 *  - `airfoilSection` — honoured ONLY when `crossSection` is `airfoil`. It CAN be
 *    stored on a square or rounded fin (the panel shows the field for every
 *    planar fin set, formatLoss.ts:309-311 names that case, and the kernel
 *    gate at FinSetCalc:1161 does not check crossSection), but a square fin
 *    stays the flat prism (N062 hard rule 5) and a rounded fin stays rounded:
 *    the drawing follows the cross-section the user picked, as every
 *    import/export label does. The shapes, exactly sectionPressureCD
 *    (FinSetCalc:1263-1360):
 *      a1 = clamp(airfoilLeDiamond / MAC, 0.05, 0.95), unset (≤ 0) ⇒ default;
 *      a2 = clamp(airfoilTeDiamond / MAC, 0.05, 0.95), likewise   (:1269-1272)
 *      hexagonal    linear 0→t/2 over a1, flat, t/2→0 over a2; defaults 1/3
 *                   each (:1279-1284). If a1 + a2 > 1 (chamfers that overlap,
 *                   each clamped to 0.95 of the MAC) both ramps are scaled by
 *                   1/(a1+a2) to meet AT full thickness: a diamond with its
 *                   ridge at ξ = a1/(a1+a2), so the drawn and printed fin is
 *                   always the stock its Thickness field says. The aero
 *                   model's own fractions (F = 1/a1 + 1/a2) are unchanged.
 *      naca         as plain airfoil above; its LE radius is the NACA law's own
 *                   1.1019·τ²·c, so `finLeRadius` is ignored (:1285-1288).
 *      doublewedge  ridge at m = a1 clamped to 0.1–0.9, default 0.5 (:1289-1293).
 *      biconvex     h = 2t·ξ(1−ξ) (:1294-1296, F = 16/3).
 *      hexbluntbase LE chamfer a1 (default 1/3), flat to a blunt TE of height t
 *                   (:1297-1302, baseFrac 1). a2 is not read, as in the kernel.
 *      singlewedge  h = (t/2)·ξ, sharp LE, blunt TE of height t (:1303-1306).
 *    The chamfers are fractions taken of the MAC, as the aero model takes them,
 *    and applied as fractions of each station's LOCAL chord. Pass the fin's MAC
 *    (`finMacFromOutline` computes it as FinSetCalc.calculateFinGeometry does,
 *    :417-571); without one the local chord stands in for it.
 *  - `finLeRadius` r > 0 on any section above except `naca` (the kernel charges
 *    it as swept-cylinder bluntness on a 2r frontal height, FinSetCalc:1342-
 *    1355): the LE becomes a circle of radius r_e = min(r, peak half-thickness)
 *    centred at x = r_e on the chord line (so the LE stays at ξ = 0 and the
 *    planform is untouched), joined to the section by the upper tangent — the
 *    least concave profile over both, i.e. their convex hull. For a straight
 *    ramp the tangent runs from the circle to the top of the ramp; for the
 *    biconvex it is the common tangent of the circle and the arc. Never thicker
 *    than the section's peak (≤ t/2). It is not applied to `square`,
 *    `rounded` or plain `airfoil`: the classic branch never reads it.
 *
 * Sampling (`sectionProfile`): the NUMBER of samples depends only on the fin and
 * the resolution, never on the local chord, so a mesher can join station i
 * sample j to station i+1 sample j as a structured grid. Round edges are
 * angle-sampled (cosine-type clustering at the edge), the NACA is cosine-spaced
 * over the whole chord, straight-sided sections get their breakpoints only.
 * Samples are strictly increasing in ξ for a positive chord. The count is
 * constant only for a fixed MAC: pass the fin's MAC, or the chamfer fractions
 * (and the hexagonal breakpoint count) follow the local chord instead.
 */
import type { ComponentNode } from '@online-openrocket/engine';
import { kernelNum } from './kernelDefaults.js';

export type FinSectionLaw =
  | 'square' | 'rounded' | 'naca'
  | 'hexagonal' | 'doublewedge' | 'biconvex' | 'hexbluntbase' | 'singlewedge';

/** How an edge ends: sharp (zero thickness), round (zero thickness, vertical tangent) or blunt (a flat face). */
export type FinEdgeKind = 'sharp' | 'round' | 'blunt';

export interface FinEdge {
  kind: FinEdgeKind;
  /** Full height of the flat edge face in metres — 0 unless `kind` is 'blunt'. */
  height: number;
}

/** A fin's section, resolved once per fin (everything here is chord-independent). */
export interface FinSectionSpec {
  law: FinSectionLaw;
  /** Maximum thickness t, metres. */
  thickness: number;
  /** LE chamfer fraction (hexagonal, hexbluntbase), NaN where unused. */
  a1: number;
  /** TE chamfer fraction (hexagonal), NaN where unused. */
  a2: number;
  /** Doublewedge ridge fraction m, NaN where unused. */
  ridge: number;
  /** LE bluntness radius r, metres (0 = none; always 0 for square/rounded/naca). */
  leRadius: number;
}

export interface FinSectionProfile {
  law: FinSectionLaw;
  /** True for square: callers keep the flat prism, unchanged. */
  flat: boolean;
  thickness: number;
  /** The local chord this profile was sampled at, metres. */
  chord: number;
  /** Chord fractions, xi[0] = 0, xi[last] = 1. */
  xi: number[];
  /** Half-thickness at each xi, metres, 0 ≤ half ≤ thickness / 2. */
  half: number[];
  le: FinEdge;
  te: FinEdge;
}

const SECTION_NAMES: ReadonlySet<string> = new Set([
  'hexagonal', 'naca', 'doublewedge', 'biconvex', 'hexbluntbase', 'singlewedge',
]);

/** Chordwise semi-axis cap of a `rounded` edge, as a fraction of the local chord. */
const ROUND_EDGE_MAX_FRACTION = 0.45;

const DEFAULT_RESOLUTION = 24;

/** NACA 00xx half-thickness as a multiple of t (peak ≈ 0.50006), closed TE. */
function nacaRaw(xi: number): number {
  const x = Math.min(1, Math.max(0, xi));
  return 5 * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

/** The raw NACA peak (≈ 0.50006 at ξ ≈ 0.2998), found once by golden-section search. */
const NACA_PEAK: { xi: number; value: number } = (() => {
  let lo = 0.1;
  let hi = 0.6;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 200; i++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (nacaRaw(a) < nacaRaw(b)) lo = a; else hi = b;
  }
  const xi = (lo + hi) / 2;
  return { xi, value: nacaRaw(xi) };
})();

/** ξ of the NACA maximum thickness (≈ 0.30). */
export const NACA_MAX_THICKNESS_XI = NACA_PEAK.xi;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function str(node: ComponentNode, key: string): string {
  const v = node[key];
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** The drawing law a fin node takes (see the header for every rule). */
export function finSectionLaw(node: ComponentNode): FinSectionLaw {
  const cross = str(node, 'crossSection');
  if (cross === 'rounded') return 'rounded';
  if (cross !== 'airfoil') return 'square';
  const section = str(node, 'airfoilSection');
  return SECTION_NAMES.has(section) ? (section as FinSectionLaw) : 'naca';
}

function nonNegative(node: ComponentNode, key: string): number {
  const v = node[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Resolve a fin's section once: law, thickness and the chamfer/ridge fractions
 * (FinSetCalc:1269-1306), with the MAC the chamfer lengths are divided by.
 */
export function finSectionSpec(node: ComponentNode, mac?: number): FinSectionSpec {
  const law = finSectionLaw(node);
  const tRaw = kernelNum(node, 'thickness');
  const thickness = Number.isFinite(tRaw) && tRaw > 0 ? tRaw : 0;
  const spec: FinSectionSpec = { law, thickness, a1: Number.NaN, a2: Number.NaN, ridge: Number.NaN, leRadius: 0 };
  if (law === 'square' || law === 'rounded' || law === 'naca') return spec;

  const m = mac !== undefined && Number.isFinite(mac) && mac > 0 ? mac : Number.NaN;
  const le = nonNegative(node, 'airfoilLeDiamond');
  const te = nonNegative(node, 'airfoilTeDiamond');
  // FinSetCalc:1269-1272 — unset (or no usable MAC) reads NaN and takes the default.
  const a1 = le > 0 && m > 0 ? clamp(le / m, 0.05, 0.95) : Number.NaN;
  const a2 = te > 0 && m > 0 ? clamp(te / m, 0.05, 0.95) : Number.NaN;
  switch (law) {
    case 'hexagonal':
      spec.a1 = Number.isNaN(a1) ? 1 / 3 : a1;
      spec.a2 = Number.isNaN(a2) ? 1 / 3 : a2;
      break;
    case 'doublewedge':
      spec.ridge = Number.isNaN(a1) ? 0.5 : clamp(a1, 0.1, 0.9);
      break;
    case 'hexbluntbase':
      spec.a1 = Number.isNaN(a1) ? 1 / 3 : a1;
      break;
    default:
      break;
  }
  spec.leRadius = nonNegative(node, 'finLeRadius');
  return spec;
}

/** Peak half-thickness and the first ξ that reaches it, for the sections a LE radius can apply to. */
function peakOf(spec: FinSectionSpec): { xi: number; half: number } {
  const H = spec.thickness / 2;
  switch (spec.law) {
    case 'hexagonal': {
      const s = spec.a1 + spec.a2;
      return { xi: s < 1 ? spec.a1 : spec.a1 / s, half: H };
    }
    case 'doublewedge': return { xi: spec.ridge, half: H };
    case 'biconvex': return { xi: 0.5, half: H };
    case 'hexbluntbase': return { xi: spec.a1, half: H };
    case 'singlewedge': return { xi: 1, half: H };
    case 'naca': return { xi: NACA_PEAK.xi, half: H };
    default: return { xi: 0, half: H };
  }
}

/** The section's own half-thickness at ξ, no LE radius — the "envelope". */
function envelope(spec: FinSectionSpec, chord: number, xi: number): number {
  const H = spec.thickness / 2;
  const x = clamp(xi, 0, 1);
  switch (spec.law) {
    case 'square': return H;
    case 'rounded': {
      const rx = roundedRx(spec, chord);
      const d = x < rx ? rx - x : x > 1 - rx ? x - (1 - rx) : 0;
      const u = d / rx;
      return H * Math.sqrt(Math.max(0, 1 - u * u));
    }
    case 'naca': return H * nacaRaw(x) / NACA_PEAK.value;
    case 'hexagonal': {
      // Overlapping chamfers (a1 + a2 > 1) scale to meet at full thickness.
      const s = Math.max(1, spec.a1 + spec.a2);
      return H * ramp(Math.min((x * s) / spec.a1, ((1 - x) * s) / spec.a2));
    }
    case 'doublewedge': return H * ramp(Math.min(x / spec.ridge, (1 - x) / (1 - spec.ridge)));
    case 'biconvex': return H * 4 * x * (1 - x);
    case 'hexbluntbase': return H * ramp(x / spec.a1);
    case 'singlewedge': return H * x;
  }
}

/**
 * A ramp's fraction of full height, clamped to [0, 1] and snapped to exactly 1
 * within 1e-12, so a breakpoint like ξ = 1 − a2 sits on the plateau exactly
 * rather than 2e-16 below it (the mesher's flat top stays flat).
 */
function ramp(v: number): number {
  return v >= 1 - 1e-12 ? 1 : Math.max(0, v);
}

/** A `rounded` edge's chordwise semi-axis as a fraction of the local chord. */
function roundedRx(spec: FinSectionSpec, chord: number): number {
  const H = spec.thickness / 2;
  return chord > 0 ? Math.min(H / chord, ROUND_EDGE_MAX_FRACTION) : ROUND_EDGE_MAX_FRACTION;
}

/**
 * The LE-radius hull at one local chord, in metres: a circle of radius r centred
 * at (r, 0), arc from the LE to the tangent point T (circle angle `theta`,
 * measured from +x, so the LE is angle π), a straight tangent T → Q, then the
 * section itself from Q aft.
 *
 * Degenerate case: when r equals the peak half-thickness and the peak sits at
 * exactly x = r, T and Q coincide; `sectionProfile` then ends its arc samples
 * one step short of T so the samples stay strictly increasing.
 */
interface LeHull { r: number; theta: number; tx: number; ty: number; qx: number; qy: number }

function leHull(spec: FinSectionSpec, chord: number): LeHull | null {
  if (!(spec.leRadius > 0) || spec.law === 'naca' || spec.law === 'square' || spec.law === 'rounded') return null;
  if (!(chord > 0) || !(spec.thickness > 0)) return null;
  const peak = peakOf(spec);
  const r = Math.min(spec.leRadius, peak.half);
  if (!(r > 0)) return null;

  if (spec.law === 'biconvex') {
    // Common upper tangent of the circle and h(x) = A x − B x², bisected on q
    // in [0, c/2]: f(q) = s(r − q) + h(q) − r√(1+s²), f(0) < 0 ≤ f(c/2).
    const t = spec.thickness;
    const A = 2 * t / chord;
    const B = 2 * t / (chord * chord);
    const f = (q: number): number => {
      const s = A - 2 * B * q;
      return s * (r - q) + (A * q - B * q * q) - r * Math.sqrt(1 + s * s);
    };
    let lo = 0;
    let hi = chord / 2;
    if (f(hi) >= 0) {
      for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < 0) lo = mid; else hi = mid;
      }
      const q = hi;
      const s = A - 2 * B * q;
      const n = Math.sqrt(1 + s * s);
      const tx = r - r * s / n;
      const ty = r / n;
      if (tx <= q) {
        const theta = Math.atan2(ty, tx - r);
        return { r, theta, tx, ty, qx: q, qy: A * q - B * q * q };
      }
    }
    // The circle's tangent point lies past the arc's peak (a chord shorter
    // than the radius): fall through to the tangent to the peak itself.
  }

  // Tangent from the external point P (the top of the LE ramp) to the circle.
  const px = peak.xi * chord;
  const py = peak.half;
  const dx = px - r;
  const d = Math.hypot(dx, py);
  const theta = d > r ? clamp(Math.atan2(py, dx) + Math.acos(clamp(r / d, -1, 1)), Math.PI / 2, Math.PI) : Math.PI / 2;
  const tx = r + r * Math.cos(theta);
  const ty = r * Math.sin(theta);
  return { r, theta, tx: Math.min(tx, px), ty: Math.min(ty, py), qx: px, qy: py };
}

function hullHalf(hull: LeHull, spec: FinSectionSpec, chord: number, x: number): number {
  if (x <= hull.tx) {
    const u = hull.r - x;
    return Math.sqrt(Math.max(0, hull.r * hull.r - u * u));
  }
  if (x < hull.qx) {
    const span = hull.qx - hull.tx;
    return span > 0 ? hull.ty + (hull.qy - hull.ty) * (x - hull.tx) / span : hull.qy;
  }
  return envelope(spec, chord, x / chord);
}

/** Half-thickness (metres) of a resolved section at chord fraction ξ and local chord c. */
export function sectionHalfThickness(spec: FinSectionSpec, chord: number, xi: number): number {
  const hull = leHull(spec, chord);
  const h = hull ? hullHalf(hull, spec, chord, clamp(xi, 0, 1) * chord) : envelope(spec, chord, xi);
  return clamp(h, 0, spec.thickness / 2);
}

function edgesOf(spec: FinSectionSpec): { le: FinEdge; te: FinEdge } {
  const t = spec.thickness;
  const sharp: FinEdge = { kind: 'sharp', height: 0 };
  const round: FinEdge = { kind: 'round', height: 0 };
  const blunt: FinEdge = { kind: 'blunt', height: t };
  let le: FinEdge;
  let te: FinEdge;
  switch (spec.law) {
    case 'square': le = blunt; te = blunt; break;
    case 'rounded': le = round; te = round; break;
    case 'naca': le = round; te = sharp; break;
    case 'hexbluntbase':
    case 'singlewedge': le = sharp; te = blunt; break;
    default: le = sharp; te = sharp; break;
  }
  if (spec.leRadius > 0 && spec.law !== 'square' && spec.law !== 'rounded' && spec.law !== 'naca') le = round;
  return { le: { ...le }, te: { ...te } };
}

/** Breakpoints of a straight-sided section (fin-constant). */
function polygonalXi(spec: FinSectionSpec): number[] {
  switch (spec.law) {
    case 'hexagonal': {
      const s = spec.a1 + spec.a2;
      return s < 1 - 1e-12 ? [0, spec.a1, 1 - spec.a2, 1] : [0, spec.a1 / s, 1];
    }
    case 'doublewedge': return [0, spec.ridge, 1];
    case 'hexbluntbase': return [0, spec.a1, 1];
    case 'singlewedge': return [0, 1];
    default: return [0, 1];
  }
}

function cosineXi(n: number): number[] {
  const out: number[] = [];
  for (let j = 0; j <= n; j++) out.push(j === n ? 1 : (1 - Math.cos(Math.PI * j / n)) / 2);
  return out;
}

function uniformXi(n: number): number[] {
  const out: number[] = [];
  for (let j = 0; j <= n; j++) out.push(j / n);
  return out;
}

/** Sample a resolved section at one local chord (see the header for the spacing rules). */
export function sectionProfile(spec: FinSectionSpec, chord: number, resolution = DEFAULT_RESOLUTION): FinSectionProfile {
  const res = Math.max(4, Math.round(Number.isFinite(resolution) ? resolution : DEFAULT_RESOLUTION));
  const arcK = Math.max(2, Math.round(res / 4));
  const biconvexN = Math.max(4, Math.round(res / 2));
  const H = spec.thickness / 2;
  const { le, te } = edgesOf(spec);
  const c = Number.isFinite(chord) && chord > 0 ? chord : 0;
  const out = (xi: number[], half: number[]): FinSectionProfile => ({
    law: spec.law, flat: spec.law === 'square', thickness: spec.thickness, chord: c,
    xi, half: half.map((h) => clamp(h, 0, H)), le, te,
  });
  const byEnvelope = (xi: number[]): FinSectionProfile => out(xi, xi.map((x) => envelope(spec, c, x)));

  switch (spec.law) {
    case 'square':
      return out([0, 1], [H, H]);
    case 'rounded': {
      const rx = roundedRx(spec, c);
      const xi: number[] = [];
      const half: number[] = [];
      for (let j = 0; j <= arcK; j++) {
        const phi = (Math.PI / 2) * j / arcK;
        xi.push(rx * (1 - Math.cos(phi)));
        half.push(H * Math.sin(phi));
      }
      for (let j = arcK; j >= 0; j--) {
        const phi = (Math.PI / 2) * j / arcK;
        xi.push(1 - rx * (1 - Math.cos(phi)));
        half.push(H * Math.sin(phi));
      }
      xi[0] = 0;
      xi[xi.length - 1] = 1;
      return out(xi, half);
    }
    case 'naca':
      return byEnvelope(cosineXi(res));
    default:
      break;
  }

  const rest = spec.law === 'biconvex' ? biconvexN : polygonalXi(spec).filter((x) => x > peakOf(spec).xi).length;
  if (spec.leRadius > 0) {
    // Fixed count: (arcK + 1) arc samples, Q, then the section aft of Q.
    const count = arcK + 2 + rest;
    const hull = leHull(spec, c);
    if (!hull) return byEnvelope(uniformXi(count - 1));
    const xi: number[] = [];
    const half: number[] = [];
    // T and Q coincide only in the degenerate case named at leHull; then the
    // arc stops one step short of T so no two samples share a ξ.
    const touching = hull.qx - hull.tx <= 1e-9 * c;
    const steps = touching ? arcK + 1 : arcK;
    for (let j = 0; j <= arcK; j++) {
      const phi = Math.PI - (Math.PI - hull.theta) * j / steps;
      const exactT = j === arcK && !touching;
      xi.push((exactT ? hull.tx : hull.r + hull.r * Math.cos(phi)) / c);
      half.push(exactT ? hull.ty : hull.r * Math.sin(phi));
    }
    xi[0] = 0;
    half[0] = 0;
    xi.push(hull.qx / c);
    half.push(hull.qy);
    if (spec.law === 'biconvex') {
      for (let j = 1; j <= rest; j++) {
        const x = hull.qx + (c - hull.qx) * j / rest;
        xi.push(j === rest ? 1 : x / c);
        half.push(envelope(spec, c, j === rest ? 1 : x / c));
      }
    } else {
      const peakXi = peakOf(spec).xi;
      for (const x of polygonalXi(spec).filter((v) => v > peakXi)) {
        xi.push(x);
        half.push(envelope(spec, c, x));
      }
    }
    xi[xi.length - 1] = 1;
    return out(xi, half);
  }
  return byEnvelope(spec.law === 'biconvex' ? uniformXi(biconvexN) : polygonalXi(spec));
}

/**
 * Mean aerodynamic chord of a fin outline exactly as FinSetCalc.calculateFinGeometry
 * computes it (:449-571): 48 spanwise strips, each strip's chord = trailing −
 * leading extent of the outline at that height (edges skipped by the kernel
 * MathUtil.equals(y1, y2, 0.001) relative / near-zero rule), MAC = Σc² / Σc.
 * Points are the fin frame
 * (x aft of the root LE, y outward, root at y = 0); the loop closes on itself.
 */
export function finMacFromOutline(points: readonly (readonly [number, number])[]): number {
  const DIVISIONS = 48;
  const n = points.length;
  if (n < 3) return 0;
  let span = 0;
  for (const [, y] of points) span = Math.max(span, y);
  if (!(span > 0)) return 0;
  const lead = new Array<number>(DIVISIONS).fill(Number.POSITIVE_INFINITY);
  const trail = new Array<number>(DIVISIONS).fill(Number.NEGATIVE_INFINITY);
  for (let p = 1; p <= n; p++) {
    const [x1, y1] = points[p - 1]!;
    const [x2, y2] = points[p % n]!;
    const absY2 = Math.abs(y2);
    if (absY2 < 0.0005 ? Math.abs(y1) < 0.0005 : Math.abs(y1 - y2) < 0.001 * absY2) continue;
    let i1 = clamp(Math.trunc(y1 * 1.0001 / span * (DIVISIONS - 1)), 0, DIVISIONS - 1);
    let i2 = clamp(Math.trunc(y2 * 1.0001 / span * (DIVISIONS - 1)), 0, DIVISIONS - 1);
    if (i1 > i2) [i1, i2] = [i2, i1];
    for (let i = i1; i <= i2; i++) {
      const y = i * span / (DIVISIONS - 1);
      const x = clamp((y - y2) / (y1 - y2) * x1 + (y1 - y) / (y1 - y2) * x2, Math.min(x1, x2), Math.max(x1, x2));
      if (x < lead[i]!) lead[i] = x;
      if (x > trail[i]!) trail[i] = x;
    }
  }
  let sum2 = 0;
  let sum = 0;
  for (let i = 0; i < DIVISIONS; i++) {
    const l = lead[i]!;
    const t = trail[i]!;
    const len = Number.isFinite(l) && Number.isFinite(t) ? t - l : 0;
    sum2 += len * len;
    sum += len;
  }
  return sum > 0 ? sum2 / sum : 0;
}

/**
 * The printable minimum edge, metres (0.4 mm): the per-part 🖨 STL floors every
 * edge at this full thickness so a slicer gets a printable edge — a fabrication
 * choice, never thicker than the fin stock t.
 */
export const PRINT_MIN_EDGE = 0.0004;

/** Half-thickness floored at a minimum edge (full thickness `minEdge`), never above t/2. */
export function printableHalf(half: number, thickness: number, minEdge = PRINT_MIN_EDGE): number {
  const H = thickness / 2;
  const floor = Math.min(Math.max(0, minEdge), thickness) / 2;
  return Math.min(H, Math.max(half, floor));
}
