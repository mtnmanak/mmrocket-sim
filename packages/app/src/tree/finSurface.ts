import * as THREE from 'three';
import type { ComponentNode } from '@online-openrocket/engine';
import {
  finMacFromOutline, finSectionLaw, finSectionSpec, sectionHalfThickness, sectionProfile,
  type FinSectionSpec,
} from './finSection.js';
import type { MountSurface } from './finRoot.js';
import { chordOutline, chordRatioStations, sectionChordProblem } from './finChords.js';

/**
 * THE SHAPED FIN SURFACE AND ITS ROOT FILLETS, for the display path (N062):
 * the 3D view, the PNG snapshot and the OBJ, GLB and whole-rocket shell STL,
 * all of which draw `tree/pieces.ts`'s fin pieces. DISPLAY ONLY — nothing on
 * the flight path imports this module, and it reads only fields the node
 * already carries.
 *
 * THE FIN. `tree/finSection.ts` is the section law (half-thickness at a chord
 * fraction, for a station of a given local chord). This module lays that law
 * over a planform:
 *
 *  - The thickness at a planform point comes from the fin's OWN outline AS
 *    SEATED (finChords.ts's `seatedChordPoints`: the points first to last,
 *    root corners on the body as the kernel flies them): its leading and
 *    trailing edge at that spanwise height give the local chord and the chord
 *    fraction — not where a seated lobe is clipped by the mount. Those edges
 *    are the points from first to last WITHOUT the closing root edge
 *    (finChords.ts's `chordOutline`): a boat-tail or flare fin's last point
 *    sits on the body, and its sloped root edge is never the section's leading
 *    or trailing edge. Seated, a fin whose last point was typed at y = 0 and
 *    the same fin stored desktop-style (last point on the body) are one chord
 *    field and draw one mesh. Below the root (a fin seated on a boat tail,
 *    whose root follows the body down) the root's own chord stands in; above
 *    the tip, the tip's.
 *  - The surface covers the SEATED loops `pieces.ts` hands in (finRoot's
 *    `lobes`, or the trapezoid / ellipse) — a lobe clipped by a rising body is
 *    drawn clipped, with the thickness it has there, closed by a wall.
 *  - Each loop is cut into horizontal SLABS at every vertex height of the loop
 *    and of the own outline, so both boundaries are straight inside a slab and
 *    the slab is a closed shell of two rows of section samples: top and bottom
 *    skins at ±h, the LE and TE walls where the edge has height, and a cap at
 *    each row. Where two slabs share a row, the two caps are the same
 *    triangles facing opposite ways and cancel; where the own chord jumps (a
 *    step in a freeform outline) the caps stay and draw the step.
 *  - Every row has the SAME number of samples (finSection's profile count is
 *    chord-independent for a fixed MAC), so row i sample j joins row i+1 sample
 *    j: a NACA nose or a rounded edge keeps its cosine/angle clustering at
 *    every station. Samples falling outside the seated loop at a station are
 *    clamped onto its boundary, and collapse.
 *  - A loop a horizontal line crosses more than twice (a W- or hook-shaped
 *    freeform outline, as typed or as seated on the body) has no single chord
 *    at that height: such a fin is drawn as the flat prism. The decision is
 *    finChords.ts's `sectionChordProblem` — the same predicate the per-part
 *    print and the property panel's note ask (`finSectionFlatReason`).
 *
 * The square section never reaches this module: `pieces.ts` keeps its flat
 * prism, vertex for vertex.
 *
 * THE FILLETS (`filletRadius` > 0). Each fin root gets a concave circular
 * fillet on each side: the circle tangent to the fin's side and to the
 * mount's surface (a rolling ball — its centre is r off the fin side and r
 * off the body), from the root's leading corner to its trailing one. The
 * kernel's own fillet (FinSet.java:637-720) is the same concave arc with the
 * fin's thickness ignored, a constant section along the root; here the arc
 * meets the fin's actual side and the body's actual radius at each station,
 * so it follows a seated root down a boat tail, and its radius is FITTED to
 * the planform — never higher than the fin stands at that station, so it
 * tapers to nothing at a swept root corner instead of standing ahead of the
 * leading edge (`filletMesh`). It is built AFTER the fin's cant, against the
 * canted fin's side and root, so it turns with the fin and its foot stays on
 * the tube. A fillet is part of the fin's own piece — no piece is added. A
 * trapezoidal or elliptical root on a transition is not seated (it is drawn
 * straight at the leading edge's radius), so pieces.ts draws no fillet there
 * rather than one floating above or sunk into the body (N062 review, round 4).
 */

/** Chordwise samples across a full curved chord (finSection's resolution). */
export const FIN_SURFACE_RESOLUTION = 24;

/**
 * Chordwise fill for the straight-sided sections, drawn with their
 * breakpoints alone: an interval whose thickness rises by more than this
 * fraction of the half-stock is cut into equal parts (see `shapedFin`).
 */
const FILL_RISE = 0.25;
const STRAIGHT_LAWS: ReadonlySet<string> = new Set(['hexagonal', 'doublewedge', 'hexbluntbase', 'singlewedge']);

/** Arc steps across a fillet's concave face. */
const FILLET_ARC_STEPS = 6;

/** Vertices closer than this (m, per axis) are one: keeps every drawn vertex distinct at 0.1 µm export precision. */
const WELD = 4e-7;

/** Rows a chord refinement adds stand at least this far (m) from each other and from the slab's ends. */
const MIN_ROW_GAP = 5 * WELD;

/** Two vertex heights closer than this (m) are one station. */
const SAME_Y = 1e-9;

/** Smoothing groups: normals are averaged only within one. */
const SKIN = 0;
const WALL = 1;
const CAP = 2;
const FILLET = 3;

/** Crease angles: a smooth skin bends at most ~30° between samples; a round edge's two faces meet at up to ~85°. */
const CREASE_COS = Math.cos((50 * Math.PI) / 180);
const ROUND_EDGE_COS = Math.cos((89 * Math.PI) / 180);

type P2 = readonly [number, number];

/** A triangle mesh in metres, indexed, with a smoothing group per triangle. */
export interface FinMesh {
  pos: number[];
  /** Per vertex: on a ROUND section edge (the skin smooths across it). */
  round: boolean[];
  tri: number[];
  group: number[];
}

const emptyMesh = (): FinMesh => ({ pos: [], round: [], tri: [], group: [] });

function addVertex(m: FinMesh, x: number, y: number, z: number, round = false): number {
  m.pos.push(x, y, z);
  m.round.push(round);
  return m.round.length - 1;
}

function addTri(m: FinMesh, a: number, b: number, c: number, g: number): void {
  m.tri.push(a, b, c);
  m.group.push(g);
}

/* ------------------------------------------------------------------------ */
/* Slabs                                                                    */
/* ------------------------------------------------------------------------ */

interface Edge { x1: number; y1: number; x2: number; y2: number }

/** A horizontal band of a loop between two station heights, with its two (straight) boundaries. */
interface Slab { ya: number; yb: number; left: Edge; right: Edge }

function edgesOf(loop: readonly P2[]): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]!;
    const [x2, y2] = loop[(i + 1) % loop.length]!;
    if (y1 !== y2) out.push({ x1, y1, x2, y2 });
  }
  return out;
}

/** An edge's x at height y, y clamped into the edge's own span. */
function xAt(e: Edge, y: number): number {
  const lo = Math.min(e.y1, e.y2);
  const hi = Math.max(e.y1, e.y2);
  const yy = Math.min(hi, Math.max(lo, y));
  return e.x1 + ((e.x2 - e.x1) * (yy - e.y1)) / (e.y2 - e.y1);
}

function uniqueSorted(values: number[]): number[] {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1]! > SAME_Y) out.push(v);
  return out;
}

/**
 * Cut a closed loop into slabs at its own vertex heights and `extra` ones
 * inside its span. Null when a horizontal line crosses the loop other than
 * exactly twice anywhere — no single chord there.
 */
function slabsOf(loop: readonly P2[], extra: readonly number[] = []): Slab[] | null {
  if (loop.length < 3) return null;
  const own = loop.map((p) => p[1]);
  const lo = Math.min(...own);
  const hi = Math.max(...own);
  if (!(hi - lo > SAME_Y)) return null;
  const ys = uniqueSorted([...own, ...extra.filter((y) => y > lo && y < hi)]);
  const edges = edgesOf(loop);
  const slabs: Slab[] = [];
  for (let k = 0; k + 1 < ys.length; k++) {
    const ya = ys[k]!;
    const yb = ys[k + 1]!;
    const mid = (ya + yb) / 2;
    const crossing = edges.filter((e) => Math.min(e.y1, e.y2) < mid && mid < Math.max(e.y1, e.y2));
    if (crossing.length !== 2) return null;
    const [p, q] = crossing as [Edge, Edge];
    const [left, right] = xAt(p, mid) <= xAt(q, mid) ? [p, q] : [q, p];
    slabs.push({ ya, yb, left, right });
  }
  return slabs;
}

/** The own outline's chord [lead, trail] at height y, through the slab holding `hint`. */
function ownChord(slabs: readonly Slab[], y: number, hint: number): { lead: number; chord: number } {
  const first = slabs[0]!;
  const last = slabs[slabs.length - 1]!;
  const s = hint <= first.ya ? first : hint >= last.yb ? last
    : slabs.find((v) => v.ya <= hint && hint <= v.yb) ?? last;
  const yy = Math.min(s.yb, Math.max(s.ya, y));
  const lead = xAt(s.left, yy);
  const trail = xAt(s.right, yy);
  return { lead, chord: Math.max(0, trail - lead) };
}

/* ------------------------------------------------------------------------ */
/* The shaped fin                                                           */
/* ------------------------------------------------------------------------ */

export interface ShapedFin {
  /** The fin's closed surface in its own frame (x aft of the leading root corner, y out from r0, z thickness). */
  mesh: FinMesh;
  /** Half-thickness (m) of the drawn section at a planform point of that frame. */
  halfAt: (x: number, y: number) => number;
  /** Section samples per row (the chordwise resolution actually drawn). */
  samples: number;
  /** The section's sample stations along the own root chord (fin frame x): where a fillet samples the fin's side. */
  rootStations: number[];
  /**
   * How far the fin stands above a root point (x, y0) of that frame: inside
   * the drawn loops AND inside the own chord (where `halfAt` reads a real
   * section). A fillet is fitted to it (`filletMesh`).
   */
  reach: Reach;
}

interface Row { x: number[]; h: number[]; leRound: boolean; teRound: boolean }

/**
 * The shaped surface of one fin, or null when its section is square or the
 * outline (or a seated loop) has no single chord at some height — the caller
 * then draws the flat prism.
 *
 * `own` is the fin's outline AS SEATED (finChords.ts's `seatedChordPoints`
 * for a freeform fin; the trapezoid or ellipse itself otherwise) — its chords
 * are read from `chordOutline(own)`, root closing edge left out, and its MAC
 * sets the chamfer fractions; `loops` the closed
 * planform loops to cover, in the same frame (finRoot's seated `lobes`, or the
 * trapezoid / ellipse itself).
 */
export function shapedFin(
  node: ComponentNode, own: readonly P2[], loops: readonly (readonly P2[])[], thickness: number,
  resolution = FIN_SURFACE_RESOLUTION,
): ShapedFin | null {
  if (finSectionLaw(node) === 'square' || !(thickness > 0) || !loops.length) return null;
  // The one decision every path shares (finChords.ts): no single chord at some
  // height, as typed or as seated, draws the flat prism.
  if (sectionChordProblem(own, loops) !== null) return null;
  const chords = chordOutline(own);
  const ownSlabs = slabsOf(chords);
  if (!ownSlabs) return null;
  const mac = finMacFromOutline(own);
  const spec: FinSectionSpec = finSectionSpec(node, mac > 0 ? mac : undefined);
  // finSectionSpec reads the node's own thickness through kernelNum; pieces.ts
  // read the same field the same way, so the two agree — the override only
  // guards a caller passing a different stock.
  spec.thickness = thickness;
  const ownYs = chords.map((p) => p[1]);
  const ownLo = ownSlabs[0]!.ya;
  const ownHi = ownSlabs[ownSlabs.length - 1]!.yb;

  const halfAt = (x: number, y: number): number => {
    const yy = Math.min(ownHi, Math.max(ownLo, y));
    const { lead, chord } = ownChord(ownSlabs, yy, yy);
    if (!(chord > 1e-12)) return sectionHalfThickness(spec, 0, 0.5);
    return sectionHalfThickness(spec, chord, Math.min(1, Math.max(0, (x - lead) / chord)));
  };

  /**
   * CHORDWISE FILL (N062 review, round 3). A straight-sided section is drawn
   * with its breakpoints alone, so one skin quad can span a whole chamfer (a
   * rise of the full half-stock), and the twist across a row step (see
   * `chordStations`) draws it off the law in proportion to that rise. Each
   * interval rising by more than FILL_RISE of the half-stock is cut into
   * equal parts, the same number on every row (fixed here from the profile
   * at the MAC, so row i sample j still joins row i+1 sample j); the new
   * samples lie on the law, which is straight there. The curved sections
   * (rounded, NACA, biconvex) are already sampled finely enough.
   */
  const fill: number[] | null = (() => {
    if (!STRAIGHT_LAWS.has(spec.law)) return null;
    const half = spec.thickness / 2;
    const ref = sectionProfile(spec, mac > 0 ? mac : ownChord(ownSlabs, ownLo, ownLo).chord, resolution);
    const parts = ref.half.slice(1).map((hb, j) =>
      Math.max(1, Math.ceil(Math.abs(hb - ref.half[j]!) / (FILL_RISE * half) - 1e-9)));
    return parts.some((k) => k > 1) ? parts : null;
  })();

  let samples = -1;
  const rowAt = (y: number, ls: number, ts: number, hint: number): Row | null => {
    const { lead, chord } = ownChord(ownSlabs, y, Math.min(ownHi, Math.max(ownLo, hint)));
    const base = sectionProfile(spec, chord, resolution);
    if (fill && fill.length !== base.xi.length - 1) return null;
    const prof = fill ? { ...base, xi: [] as number[], half: [] as number[] } : base;
    if (fill) {
      for (let j = 0; j < base.xi.length; j++) {
        prof.xi.push(base.xi[j]!);
        prof.half.push(base.half[j]!);
        const parts = j < fill.length ? fill[j]! : 1;
        for (let k = 1; k < parts; k++) {
          const xi = base.xi[j]! + ((base.xi[j + 1]! - base.xi[j]!) * k) / parts;
          prof.xi.push(xi);
          prof.half.push(sectionHalfThickness(spec, chord, xi));
        }
      }
    }
    const n = prof.xi.length;
    if (samples < 0) samples = n;
    if (n !== samples || n < 2) return null;
    const x: number[] = [];
    const h: number[] = [];
    for (let j = 0; j < n; j++) {
      const xr = lead + prof.xi[j]! * chord;
      const xj = j === 0 ? ls : j === n - 1 ? ts : Math.min(ts, Math.max(ls, xr));
      x.push(xj);
      h.push(Math.abs(xj - xr) <= 1e-12 || !(chord > 1e-12)
        ? prof.half[j]!
        : sectionHalfThickness(spec, chord, Math.min(1, Math.max(0, (xj - lead) / chord))));
    }
    return { x, h, leRound: prof.le.kind === 'round', teRound: prof.te.kind === 'round' };
  };

  /**
   * Where a slab's boundary is NOT the own outline's edge — a lobe cut by the
   * body, a root following a boat tail below y = 0, a corner the kernel moved
   * onto the body — the section varies along that boundary (its own-chord
   * fraction runs across the section). Rows go in where that fraction meets
   * each of the section's own samples, so the cut face carries the section's
   * shape (a rounded edge, a NACA nose) rather than a straight line across it.
   */
  const boundaryStations = (s: Slab, hint: number): number[] => {
    const h = Math.min(ownHi, Math.max(ownLo, hint));
    const oa = ownChord(ownSlabs, s.ya, h);
    const ob = ownChord(ownSlabs, s.yb, h);
    const out: number[] = [];
    let xis: readonly number[] | null = null;
    for (const [edge, side] of [[s.left, 0], [s.right, 1]] as const) {
      const xa = xAt(edge, s.ya);
      const xb = xAt(edge, s.yb);
      const ea = oa.lead + side * oa.chord;
      const eb = ob.lead + side * ob.chord;
      if (Math.abs(xa - ea) <= 1e-9 && Math.abs(xb - eb) <= 1e-9) continue;
      xis ??= sectionProfile(spec, (oa.chord + ob.chord) / 2, resolution).xi;
      // xi(u) = (x(u) - lead(u)) / chord(u), each linear in u across the slab.
      for (const xi of xis) {
        const den = (xb - xa) - (ob.lead - oa.lead) - xi * (ob.chord - oa.chord);
        if (Math.abs(den) < 1e-15) continue;
        const u = (xi * oa.chord - (xa - oa.lead)) / den;
        if (u > 1e-9 && u < 1 - 1e-9) out.push(s.ya + u * (s.yb - s.ya));
      }
    }
    return out;
  };

  /**
   * A skin quad between two rows is two flat triangles over a surface that
   * twists where the chord changes (the same chord fraction sits at a
   * different x on each row). Across one step from chord ca to cb, a quad
   * whose section rises by dh between its two samples is drawn off the law by
   * up to dh * (cb - ca) / (2 (ca + cb)) at its diagonal's middle — so extra
   * rows go in, spaced so the chord changes by the SAME ratio at every step,
   * at most CHORD_RATIO (1.2: at most 4.5 % of a quad's rise, which the
   * chordwise fill above keeps to a quarter of the half-stock on the
   * straight-sided sections). Until N062's third review the steps were even
   * in y and capped at 4 a slab: a 6:1 slab drew a hexagonal ridge up to 19 %
   * of the stock off. The quads' diagonals still alternate row to row so
   * their bias cancels. The rule itself is finChords.ts's
   * chordRatioStations, shared with the per-part print since N062's fourth
   * review, so the print puts the same rows toward a pointed tip.
   */
  const chordStations = (s: Slab, hint: number): number[] => {
    const h = Math.min(ownHi, Math.max(ownLo, hint));
    return chordRatioStations(s.ya, s.yb, ownChord(ownSlabs, s.ya, h).chord, ownChord(ownSlabs, s.yb, h).chord, MIN_ROW_GAP);
  };

  const mesh = emptyMesh();
  for (const loop of loops) {
    const slabs = slabsOf(loop, ownYs);
    if (!slabs) return null;
    for (const s of slabs) {
      const hint = (s.ya + s.yb) / 2;
      const ys = uniqueSorted([s.ya, ...boundaryStations(s, hint), ...chordStations(s, hint), s.yb]);
      for (let k = 0; k + 1 < ys.length; k++) {
        const ya = ys[k]!;
        const yb = ys[k + 1]!;
        const a = rowAt(ya, xAt(s.left, ya), xAt(s.right, ya), hint);
        const b = rowAt(yb, xAt(s.left, yb), xAt(s.right, yb), hint);
        if (!a || !b) return null;
        slabShell(mesh, a, ya, b, yb, (k & 1) === 1);
      }
    }
  }
  const root = ownChord(ownSlabs, ownLo, ownLo);
  const rootStations = sectionProfile(spec, root.chord, resolution).xi.map((xi) => root.lead + xi * root.chord);
  // Inside the own chord at a height (clamped into the outline's span, as
  // halfAt reads it): strictly, so a root corner reaches nothing.
  const inChord = (x: number, y: number): boolean => {
    const yy = Math.min(ownHi, Math.max(ownLo, y));
    const { lead, chord } = ownChord(ownSlabs, yy, yy);
    return x > lead + INSIDE && x < lead + chord - INSIDE;
  };
  const reach = planformReach(loops, { outline: chords, inside: inChord });
  return { mesh: cleanMesh(mesh), halfAt, samples, rootStations, reach };
}

/* ------------------------------------------------------------------------ */
/* How far the fin stands above its root                                    */
/* ------------------------------------------------------------------------ */

/** Height (m) the fin stands above a root point (x, y0) of its frame before the line up from it leaves the fin. */
export type Reach = (x: number, y0: number) => number;

/** A point this close to a loop's boundary (m) is not inside it: a root corner reaches nothing. */
const INSIDE = 1e-12;

/**
 * A boundary this close above the root point (m) is the root itself: a seated
 * root's walked chord sits off the curve the root point is read from by its
 * sagitta (micrometres on a transition's profile).
 */
const ROOT_TOL = 1e-5;

/** Heights where the vertical line at x meets a loop: its edges' crossings and a vertical edge's ends. */
function crossingsAt(loop: readonly P2[], x: number, out: number[]): void {
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]!;
    const [x2, y2] = loop[(i + 1) % loop.length]!;
    if (x1 === x2) {
      if (x1 === x) out.push(y1, y2);
      continue;
    }
    if ((x - x1) * (x - x2) <= 0) out.push(y1 + ((y2 - y1) * (x - x1)) / (x2 - x1));
  }
}

/** Whether (x, y) lies strictly inside one of the loops (even-odd, on the loop's chords at y). */
function insideLoops(loops: readonly (readonly P2[])[], x: number, y: number): boolean {
  for (const loop of loops) {
    const xs: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i]!;
      const [x2, y2] = loop[(i + 1) % loop.length]!;
      if ((y1 < y) !== (y2 < y)) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) if (x > xs[k]! + INSIDE && x < xs[k + 1]! - INSIDE) return true;
  }
  return false;
}

/**
 * The fin's reach above its root, from its planform loops — and, for a shaped
 * section, its own chord (`extra.inside` must hold too; `extra.outline`'s
 * heights are where that can change). It walks up the vertical line at x
 * from the root point, span by span between the heights where the line meets
 * a boundary, and stops at the first span whose middle is outside the fin. A
 * swept leading edge (or a forward-swept trailing edge) gives a reach that
 * falls to zero at the root corner; a vertical one, a reach that is zero AT
 * the corner and full just inside it. Nothing else reads it: display only.
 */
export function planformReach(
  loops: readonly (readonly P2[])[],
  extra?: { outline: readonly P2[]; inside: (x: number, y: number) => boolean },
): Reach {
  return (x, y0) => {
    const ys: number[] = [];
    for (const loop of loops) {
      crossingsAt(loop, x, ys);
      for (const p of loop) ys.push(p[1]);
    }
    if (extra) {
      crossingsAt(extra.outline, x, ys);
      for (const p of extra.outline) ys.push(p[1]);
    }
    let prev = y0;
    for (const c of uniqueSorted(ys.filter((y) => y > y0 + INSIDE))) {
      if (c <= y0 + ROOT_TOL) { prev = c; continue; }
      const mid = (prev + c) / 2;
      if (!insideLoops(loops, x, mid) || (extra && !extra.inside(x, mid))) break;
      prev = c;
    }
    return Math.max(0, prev - y0);
  };
}

/** One slab as a closed shell (outward winding): skins, LE/TE walls, a cap at each row. */
function slabShell(m: FinMesh, a: Row, ya: number, b: Row, yb: number, flipDiagonal: boolean): void {
  const n = a.x.length;
  const verts = (r: Row, y: number, sign: number): number[] => r.x.map((x, j) =>
    addVertex(m, x, y, sign * r.h[j]!, (j === 0 && r.leRound) || (j === n - 1 && r.teRound)));
  const tA = verts(a, ya, 1);
  const bA = verts(a, ya, -1);
  const tB = verts(b, yb, 1);
  const bB = verts(b, yb, -1);
  for (let j = 0; j + 1 < n; j++) {
    if (flipDiagonal) {
      addTri(m, tA[j]!, tA[j + 1]!, tB[j]!, SKIN);
      addTri(m, tA[j + 1]!, tB[j + 1]!, tB[j]!, SKIN);
      addTri(m, bA[j]!, bB[j]!, bA[j + 1]!, SKIN);
      addTri(m, bA[j + 1]!, bB[j]!, bB[j + 1]!, SKIN);
    } else {
      addTri(m, tA[j]!, tA[j + 1]!, tB[j + 1]!, SKIN);
      addTri(m, tA[j]!, tB[j + 1]!, tB[j]!, SKIN);
      addTri(m, bA[j]!, bB[j + 1]!, bA[j + 1]!, SKIN);
      addTri(m, bA[j]!, bB[j]!, bB[j + 1]!, SKIN);
    }
    // Cap at ya faces -y, cap at yb faces +y.
    addTri(m, tA[j]!, bA[j + 1]!, tA[j + 1]!, CAP);
    addTri(m, tA[j]!, bA[j]!, bA[j + 1]!, CAP);
    addTri(m, tB[j]!, tB[j + 1]!, bB[j + 1]!, CAP);
    addTri(m, tB[j]!, bB[j + 1]!, bB[j]!, CAP);
  }
  const l = n - 1;
  addTri(m, bA[0]!, tA[0]!, tB[0]!, WALL);
  addTri(m, bA[0]!, tB[0]!, bB[0]!, WALL);
  addTri(m, tA[l]!, bA[l]!, bB[l]!, WALL);
  addTri(m, tA[l]!, bB[l]!, tB[l]!, WALL);
}

/* ------------------------------------------------------------------------ */
/* Welding and clean-up                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Weld vertices within WELD of each other, then drop every triangle that
 * collapsed and every pair of identical triangles facing opposite ways (two
 * slabs' shared caps). Both steps keep a closed surface closed: a collapsed
 * triangle uses its one real edge twice, and a cancelled pair uses each of
 * its edges once in each direction.
 */
function cleanMesh(m: FinMesh): FinMesh {
  const out = emptyMesh();
  const cells = new Map<string, number[]>();
  const map: number[] = [];
  const count = m.round.length;
  for (let i = 0; i < count; i++) {
    const x = m.pos[i * 3]!;
    const y = m.pos[i * 3 + 1]!;
    const z = m.pos[i * 3 + 2]! + 0; // -0 → 0
    const cx = Math.floor(x / WELD);
    const cy = Math.floor(y / WELD);
    const cz = Math.floor(z / WELD);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          for (const k of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (Math.abs(out.pos[k * 3]! - x) <= WELD && Math.abs(out.pos[k * 3 + 1]! - y) <= WELD
              && Math.abs(out.pos[k * 3 + 2]! - z) <= WELD) { found = k; break; }
          }
        }
      }
    }
    if (found < 0) {
      found = addVertex(out, x, y, z, m.round[i]);
      const key = `${cx},${cy},${cz}`;
      const list = cells.get(key);
      if (list) list.push(found); else cells.set(key, [found]);
    } else if (m.round[i]) {
      out.round[found] = true;
    }
    map.push(found);
  }
  // Canonical form: rotate so the smallest index leads; the reverse of
  // (a, b, c) is then (a, c, b).
  const live = new Map<string, number[]>();
  const keep: boolean[] = [];
  const tris: [number, number, number][] = [];
  for (let t = 0; t < m.group.length; t++) {
    const a = map[m.tri[t * 3]!]!;
    const b = map[m.tri[t * 3 + 1]!]!;
    const c = map[m.tri[t * 3 + 2]!]!;
    tris.push([a, b, c]);
    if (a === b || b === c || c === a) { keep.push(false); continue; }
    keep.push(true);
    const [p, q, r] = a < b && a < c ? [a, b, c] : b < c ? [b, c, a] : [c, a, b];
    const key = `${p},${q},${r}`;
    const rev = `${p},${r},${q}`;
    const twins = live.get(rev);
    if (twins && twins.length) {
      keep[twins.pop()!] = false;
      keep[t] = false;
      continue;
    }
    const list = live.get(key);
    if (list) list.push(t); else live.set(key, [t]);
  }
  for (let t = 0; t < tris.length; t++) {
    if (!keep[t]) continue;
    const [a, b, c] = tris[t]!;
    addTri(out, a, b, c, m.group[t]!);
  }
  return out;
}

/** Signed volume (m³) of a closed mesh by the divergence theorem: positive when it winds outward. */
export function meshVolume(m: FinMesh): number {
  let v = 0;
  for (let t = 0; t < m.group.length; t++) {
    const a = m.tri[t * 3]! * 3;
    const b = m.tri[t * 3 + 1]! * 3;
    const c = m.tri[t * 3 + 2]! * 3;
    const p = m.pos;
    v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
      - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
      + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  return v;
}

/* ------------------------------------------------------------------------ */
/* Cant                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Where a fin sits, for its cant and its fillets: the fin frame's own
 * station on the mount, the mount, the cant and its pivot.
 */
export interface FinPlacement {
  /** The fin's leading edge station in the mount's frame (m from its fore end). */
  front: number;
  /** The mount's radius at the leading edge: the fin frame's y = 0. */
  r0: number;
  mount: MountSurface;
  /** Whether the root follows the mount (a freeform fin, finRoot.finOnMount); else it is flat at y = 0. */
  seated: boolean;
  /** Cant (rad), already clamped. */
  cant: number;
  /** The cant pivot: half the kernel's root length, from the leading edge. */
  halfChord: number;
  /**
   * A seated fin's root as finRoot walks it (`finOnMount`'s `root`): the
   * polyline the seated loops' root edges lie on. On a curved mount its chords
   * sit off the curve between the walked stations.
   */
  rootLine?: readonly P2[];
}

/**
 * The root extension a canted fin's root vertex takes (FinSet's
 * getFinCantYOffset, audit 2026-10-11 S4b-3): its new y. The arithmetic is
 * pieces.ts's own, in the same order, so the flat prism moves exactly as it
 * always has.
 */
export function cantRootY(f: FinPlacement, x: number, y: number): number {
  const { mount, front, halfChord, cant } = f;
  const dx = Math.max(0, Math.min(mount.length, front + x)) - (front + halfChord);
  const rotatedRadius = mount.radiusAt(front + halfChord + dx * Math.cos(cant));
  const dz = dx * Math.sin(cant);
  if (Math.abs(dz) < rotatedRadius) return y - rotatedRadius + Math.sqrt(rotatedRadius ** 2 - dz ** 2);
  return y;
}

/** Whether a fin-frame vertex is a ROOT vertex — on the mount's surface — as pieces.ts tests it. */
export function onRoot(f: FinPlacement, x: number, y: number): boolean {
  return Math.abs(y - (f.mount.radiusAt(f.front + x) - f.r0)) <= 1e-7;
}

/**
 * Whether a vertex of a SHAPED fin (fin frame) is a root vertex: on the
 * mount's surface as `onRoot` tests it, or on the seated root's walked
 * polyline. The shaped mesh puts rows between the walked stations, and their
 * root ends lie on its chords, off a curved mount's surface by the chord's
 * sagitta — `onRoot` alone left them unextended under cant, a sawtooth root
 * (N062 review: 24 of 64 root vertices of a rounded fin on an ogive boat tail).
 */
export function onSeatedRoot(f: FinPlacement, x: number, y: number): boolean {
  if (onRoot(f, x, y)) return true;
  const line = f.rootLine;
  if (!line) return false;
  for (let i = 0; i + 1 < line.length; i++) {
    const [x1, y1] = line[i]!;
    const [x2, y2] = line[i + 1]!;
    if (x < Math.min(x1, x2) - 1e-9 || x > Math.max(x1, x2) + 1e-9) continue;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len > 0 && Math.abs((x - x1) * dy - (y - y1) * dx) / len <= 1e-9) return true;
  }
  return false;
}

/** Cant a SHAPED fin-frame mesh in place: extend its root vertices to the tube, then turn it about the pivot. */
export function cantMesh(m: FinMesh, f: FinPlacement): void {
  if (f.cant === 0) return;
  const c = Math.cos(f.cant);
  const s = Math.sin(f.cant);
  for (let i = 0; i < m.round.length; i++) {
    const x = m.pos[i * 3]!;
    const y = m.pos[i * 3 + 1]!;
    const z = m.pos[i * 3 + 2]!;
    const yy = onSeatedRoot(f, x, y) ? cantRootY(f, x, y) : y;
    m.pos[i * 3] = f.halfChord + (x - f.halfChord) * c + z * s;
    m.pos[i * 3 + 1] = yy;
    m.pos[i * 3 + 2] = -(x - f.halfChord) * s + z * c;
  }
}

/* ------------------------------------------------------------------------ */
/* Fillets                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * A stretch of root on the body, with the stations to sample along it (fin
 * frame x), and whether each end is a root CORNER of the planform (rather
 * than where the mount ends under a fin that runs on past it).
 */
export interface RootRun { stations: number[]; corners: [boolean, boolean] }

/**
 * The root runs of a fin's planform loops: for each loop, the span between
 * its first and last vertex on the mount's surface, cut to the mount's own
 * length (no fillet hangs past a tube's end), sampled at the loop's on-body
 * vertices and at `extra` stations inside it.
 */
export function rootRuns(
  f: FinPlacement, loops: readonly (readonly P2[])[], extra: readonly number[] = [],
): RootRun[] {
  const runs: RootRun[] = [];
  const lo = -f.front;
  const hi = f.mount.length - f.front;
  for (const loop of loops) {
    const on = loop.filter(([x, y]) => Math.abs(y - rootY(f, x)) <= 1e-9).map(([x]) => x);
    if (on.length < 2) continue;
    const a = Math.max(lo, Math.min(...on));
    const b = Math.min(hi, Math.max(...on));
    const corners: [boolean, boolean] = [Math.min(...on) >= lo, Math.max(...on) <= hi];
    if (!(b - a > 1e-6)) continue;
    const xs = [a, b, ...on, ...extra].filter((x) => x >= a && x <= b).sort((p, q) => p - q);
    const stations: number[] = [];
    for (const x of xs) if (!stations.length || x - stations[stations.length - 1]! > 1e-6) stations.push(x);
    if (stations[stations.length - 1]! < b) stations[stations.length - 1] = b;
    if (stations.length >= 2) runs.push({ stations, corners });
  }
  return runs;
}

/** The seated root polyline's y at x (fin frame, before cant), or null off it or without one. */
function rootLineY(f: FinPlacement, x: number): number | null {
  const line = f.rootLine;
  if (!line) return null;
  for (let i = 0; i + 1 < line.length; i++) {
    const [x1, y1] = line[i]!;
    const [x2, y2] = line[i + 1]!;
    if (x < Math.min(x1, x2) - 1e-12 || x > Math.max(x1, x2) + 1e-12) continue;
    return x1 === x2 ? Math.max(y1, y2) : y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
  return null;
}

/** The root's fin-frame y at x before cant: on the mount for a seated fin, else the flat y = 0. */
function rootY(f: FinPlacement, x: number): number {
  return f.seated ? f.mount.radiusAt(f.front + x) - f.r0 : 0;
}

/** The body radius under a fin-frame axial station (a flat-rooted fin's body is its r0 cylinder). */
function bodyR(f: FinPlacement, x: number): number {
  return f.seated ? f.mount.radiusAt(f.front + x) : f.r0;
}

type V3 = [number, number, number];

/** Points in one fillet ring: D, A, the arc's inner points, B and two on the body. */
const RING = 2 + (FILLET_ARC_STEPS - 1) + 1 + 2;

/** A fillet's fitted radius may differ from a straight line between two stations by this much of r before a station goes in between. */
const FIT_TOL = 0.05;

/** The most times a station gap is halved to follow a fitted radius. */
const FIT_DEPTH = 6;

/**
 * The fillets of one fin, after its cant, as closed shells (one per root run
 * and side). `halfAt` is the fin's drawn half-thickness at a fin-frame
 * planform point; `reach` how far the fin stands above a root point
 * (`ShapedFin.reach`, or `planformReach` of the prism's loops).
 *
 * FITTED TO THE PLANFORM (N062 review). At each root station x the fillet's
 * radius is min(r, reach(x)): it never stands higher than the fin does at x,
 * so it never stands ahead of a swept leading edge or aft of a forward-swept
 * trailing edge, and its top foot always lies on the fin's real side — inside
 * its own chord at that height, where `halfAt` reads a real section. It
 * is zero at each root corner, so the fillet tapers to nothing there: along a
 * swept edge's own slope, and where the edge above the corner is vertical or
 * overhangs it, in one short step (1/64 of the station gap) — the fillet ends
 * all but flush with the edge. Where the run stops at the mount's end instead,
 * it ends at full size. Stations go in where the fitted radius bends between
 * the run's own stations. Null when there is nothing to draw.
 */
export function filletMesh(
  f: FinPlacement, runs: readonly RootRun[], radius: number, halfAt: (x: number, y: number) => number,
  reach: Reach,
): FinMesh | null {
  if (!(radius > 0) || !runs.length) return null;
  const c = Math.cos(f.cant);
  const s = Math.sin(f.cant);
  const n: V3 = [s, 0, c]; // the fin side's normal (+z turned by the cant)
  const m = emptyMesh();
  for (const run of runs) {
    const first = run.stations[0]!;
    const last = run.stations[run.stations.length - 1]!;
    const fitted = (x: number): number => ((x === first && run.corners[0]) || (x === last && run.corners[1])
      ? 0
      : Math.max(0, Math.min(radius, reach(x, rootLineY(f, x) ?? rootY(f, x)))));
    const stations = fitStations(run.stations, fitted, radius);
    for (const side of [1, -1]) {
      const rings: V3[][] = [];
      for (const [x, r] of stations) {
        const ring = filletRing(f, x, side, r, n, halfAt);
        if (!ring) { rings.length = 0; break; }
        rings.push(ring);
      }
      if (rings.length >= 2) sweepShell(m, rings);
    }
  }
  if (!m.group.length) return null;
  const out = cleanMesh(m);
  return out.group.length ? out : null;
}

/**
 * The run's stations with their fitted radius, and more between two of them
 * wherever the fitted radius is not straight between them (a swept edge
 * meeting the full radius, a vertical edge at a corner): each gap is halved
 * while its middle departs from the straight line by more than FIT_TOL of r.
 */
function fitStations(xs: readonly number[], fitted: (x: number) => number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const split = (a: number, ra: number, b: number, rb: number, depth: number): void => {
    if (depth < FIT_DEPTH && b - a > 1e-6) {
      const mid = (a + b) / 2;
      const rm = fitted(mid);
      if (Math.abs(rm - (ra + rb) / 2) > FIT_TOL * r) {
        split(a, ra, mid, rm, depth + 1);
        split(mid, rm, b, rb, depth + 1);
        return;
      }
    }
    out.push([b, rb]);
  };
  let prev = xs[0]!;
  let rPrev = fitted(prev);
  out.push([prev, rPrev]);
  for (const x of xs.slice(1)) {
    const rx = fitted(x);
    split(prev, rPrev, x, rx, 0);
    prev = x;
    rPrev = rx;
  }
  return out;
}

/**
 * One fillet cross-section at fin-frame station x on `side`, of radius r (the
 * fitted one): the fin-side foot D at the body, the arc's top foot A on the
 * fin side, the concave arc to its foot B on the body, and the body back from
 * B to D. D sits on the fin's side AT THE ROOT and A exactly on it at A's
 * own height (solved, see below), and an arc point the fin's side stands
 * outside (a section thickening
 * towards the root) is moved out onto it, so no point of the fillet lies
 * inside the fin. A radius of zero is the ring collapsed onto D: the shell
 * ends in a point there.
 */
function filletRing(
  f: FinPlacement, x: number, side: number, r: number, n: V3, halfAt: (x: number, y: number) => number,
): V3[] | null {
  const { r0, halfChord, cant } = f;
  const cc = Math.cos(cant);
  const sc = Math.sin(cant);
  const y0 = rootLineY(f, x) ?? rootY(f, x);
  // The root point under the station, turned with the fin (its height is the body's).
  const px = cant === 0 ? x : halfChord + (x - halfChord) * cc;
  const pz = cant === 0 ? 0 : -(x - halfChord) * sc;
  const onBody = (qz: number, R: number): number | null => {
    const d = R * R - qz * qz;
    return d > 0 ? Math.sqrt(d) - r0 : null;
  };
  const hRoot = Math.max(0, halfAt(x, y0));
  const dx = px + side * hRoot * n[0];
  const dz = pz + side * hRoot * n[2];
  const dy = onBody(dz, bodyR(f, dx));
  if (dy === null) return null;
  const D: V3 = [dx, dy, dz];
  const collapsed = (): V3[] => Array.from({ length: RING }, (): V3 => [D[0], D[1], D[2]]);
  if (!(r > 1e-9)) return collapsed();

  // The ball touches the fin side at A, beside its centre C and level with
  // it; C stands r off the side and r off the body. So A's half-thickness h
  // solves h = halfAt(x, cy(h)), where cy(h) is the centre's height with the
  // ball r + h off the fin's mid-plane. g(h) = halfAt(x, cy(h)) - h is >= 0
  // at h = 0 and <= 0 once h reaches the stock's half (halfAt never exceeds
  // it): bracket from the root's own half-thickness, then bisect to
  // convergence. (Three fixed-point steps, unchecked, left A up to 0.5 mm off
  // the side where the section changes quickly with height — N062 review.)
  const centre = (h: number): V3 | null => {
    const off = side * (h + r);
    const cx = px + off * n[0];
    const cz = pz + off * n[2];
    const cy = onBody(cz, bodyR(f, cx) + r);
    return cy === null ? null : [cx, cy, cz];
  };
  const sideAt = (cy: number): number => Math.max(0, halfAt(x, Math.max(y0, cy)));
  const g = (h: number): number | null => {
    const c = centre(h);
    return c === null ? null : sideAt(c[1]) - h;
  };
  let lo = 0;
  let hi = Math.max(hRoot, 1e-9);
  let gHi = g(hi);
  if (gHi === null) return null;
  for (let k = 0; gHi > 0 && k < 64; k++) {
    lo = hi;
    hi *= 2;
    gHi = g(hi);
    if (gHi === null) return null;
  }
  for (let k = 0; k < 200 && hi - lo > 1e-13; k++) {
    const mid = (lo + hi) / 2;
    const gm = g(mid);
    if (gm === null) return null;
    if (gm > 0) lo = mid; else hi = mid;
  }
  const C = centre((lo + hi) / 2);
  if (!C) return null;
  // A exactly on the fin side at its own height (where halfAt steps, on the
  // face of the step the bisection closed on).
  const hA = sideAt(C[1]);
  const A: V3 = [px + side * hA * n[0], C[1], pz + side * hA * n[2]];
  const rho = Math.hypot(C[1] + r0, C[2]);
  if (!(rho > r)) return null;
  if (!(A[1] - D[1] > 1e-7)) return collapsed();
  const inward: V3 = [0, -(C[1] + r0) / rho, -C[2] / rho];
  const B: V3 = [C[0], C[1] + r * inward[1], C[2] + r * inward[2]];

  /** A point moved out onto the fin's side where the side stands outside it (fin frame: undo the cant). */
  const outsideFin = (q: V3): V3 => {
    const u = q[0] - halfChord;
    const fx = halfChord + u * cc - q[2] * sc;
    const fz = u * sc + q[2] * cc;
    const side2 = Math.max(0, halfAt(fx, Math.max(y0, q[1])));
    if (side * fz >= side2) return q;
    const z2 = side * side2;
    const v = fx - halfChord;
    return [halfChord + v * cc + z2 * sc, q[1], -v * sc + z2 * cc];
  };

  const ring: V3[] = [D, A];
  // Arc A → B about C: slerp between the two foot directions.
  const u1: V3 = [-side * n[0], 0, -side * n[2]];
  const u2 = inward;
  const dot = Math.min(1, Math.max(-1, u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]));
  const om = Math.acos(dot);
  for (let k = 1; k < FILLET_ARC_STEPS; k++) {
    const t = k / FILLET_ARC_STEPS;
    const w1 = om > 1e-9 ? Math.sin((1 - t) * om) / Math.sin(om) : 1 - t;
    const w2 = om > 1e-9 ? Math.sin(t * om) / Math.sin(om) : t;
    ring.push(outsideFin([C[0] + r * (w1 * u1[0] + w2 * u2[0]), C[1] + r * (w1 * u1[1] + w2 * u2[1]),
      C[2] + r * (w1 * u1[2] + w2 * u2[2])]));
  }
  ring.push(B);
  // The body from B back towards D, on its surface.
  for (const t of [1 / 3, 2 / 3]) {
    const q: V3 = [B[0] + (D[0] - B[0]) * t, B[1] + (D[1] - B[1]) * t, B[2] + (D[2] - B[2]) * t];
    const R = bodyR(f, q[0]);
    const rr = Math.hypot(q[1] + r0, q[2]);
    if (rr > 0) { q[1] = (q[1] + r0) * (R / rr) - r0; q[2] = q[2] * (R / rr); }
    ring.push(q);
  }
  return ring;
}

/** Sweep equal rings into a closed shell, end caps fanned from each ring's first point, wound outward. */
function sweepShell(m: FinMesh, rings: V3[][]): void {
  const shell = emptyMesh();
  const k = rings[0]!.length;
  const ids = rings.map((ring) => ring.map((p) => addVertex(shell, p[0], p[1], p[2])));
  for (let i = 0; i + 1 < ids.length; i++) {
    for (let q = 0; q < k; q++) {
      const a = ids[i]![q]!;
      const b = ids[i]![(q + 1) % k]!;
      const c = ids[i + 1]![(q + 1) % k]!;
      const d = ids[i + 1]![q]!;
      addTri(shell, a, b, c, FILLET);
      addTri(shell, a, c, d, FILLET);
    }
  }
  const first = ids[0]!;
  const last = ids[ids.length - 1]!;
  for (let q = 1; q + 1 < k; q++) {
    addTri(shell, first[0]!, first[q + 1]!, first[q]!, CAP);
    addTri(shell, last[0]!, last[q]!, last[q + 1]!, CAP);
  }
  const flip = meshVolume(shell) < 0;
  const base = m.round.length;
  for (let i = 0; i < shell.round.length; i++) {
    addVertex(m, shell.pos[i * 3]!, shell.pos[i * 3 + 1]!, shell.pos[i * 3 + 2]!);
  }
  for (let t = 0; t < shell.group.length; t++) {
    const a = shell.tri[t * 3]! + base;
    const b = shell.tri[t * 3 + 1]! + base;
    const c = shell.tri[t * 3 + 2]! + base;
    if (flip) addTri(m, a, c, b, shell.group[t]!); else addTri(m, a, b, c, shell.group[t]!);
  }
}

/* ------------------------------------------------------------------------ */
/* To three.js                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Non-indexed positions and normals of a mesh: each corner's normal averages
 * the faces of its own smoothing group around that vertex that bend from its
 * face by less than the crease angle (a round section edge allows more, so a
 * NACA nose stays round where a sharp trailing edge stays sharp).
 */
function flatten(m: FinMesh, pos: number[], nor: number[]): void {
  const nt = m.group.length;
  const fn: number[] = new Array<number>(nt * 3);
  const unit: number[] = new Array<number>(nt * 3);
  const incident: number[][] = Array.from({ length: m.round.length }, () => []);
  for (let t = 0; t < nt; t++) {
    const a = m.tri[t * 3]!;
    const b = m.tri[t * 3 + 1]!;
    const c = m.tri[t * 3 + 2]!;
    const p = m.pos;
    const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    fn[t * 3] = nx; fn[t * 3 + 1] = ny; fn[t * 3 + 2] = nz;
    unit[t * 3] = len > 0 ? nx / len : 0;
    unit[t * 3 + 1] = len > 0 ? ny / len : 0;
    unit[t * 3 + 2] = len > 0 ? nz / len : 0;
    incident[a]!.push(t); incident[b]!.push(t); incident[c]!.push(t);
  }
  for (let t = 0; t < nt; t++) {
    const g = m.group[t]!;
    for (let k = 0; k < 3; k++) {
      const v = m.tri[t * 3 + k]!;
      const limit = g === SKIN && m.round[v] ? ROUND_EDGE_COS : CREASE_COS;
      let sx = 0, sy = 0, sz = 0;
      for (const o of incident[v]!) {
        if (m.group[o] !== g) continue;
        const d = unit[t * 3]! * unit[o * 3]! + unit[t * 3 + 1]! * unit[o * 3 + 1]! + unit[t * 3 + 2]! * unit[o * 3 + 2]!;
        if (o !== t && d < limit) continue;
        sx += fn[o * 3]!; sy += fn[o * 3 + 1]!; sz += fn[o * 3 + 2]!;
      }
      let len = Math.hypot(sx, sy, sz);
      if (!(len > 0)) { sx = unit[t * 3]!; sy = unit[t * 3 + 1]!; sz = unit[t * 3 + 2]!; len = Math.hypot(sx, sy, sz); }
      if (!(len > 0)) { sx = 0; sy = 1; sz = 0; len = 1; }
      pos.push(m.pos[v * 3]!, m.pos[v * 3 + 1]!, m.pos[v * 3 + 2]!);
      nor.push(sx / len, sy / len, sz / len);
    }
  }
}

/** One BufferGeometry (non-indexed, position + normal) from meshes, after an optional existing geometry's triangles. */
export function finGeometry(meshes: readonly (FinMesh | null)[], before?: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  if (before) {
    const g = before.index ? before.toNonIndexed() : before;
    const bp = g.getAttribute('position');
    const bn = g.getAttribute('normal');
    for (let i = 0; i < bp.count; i++) {
      pos.push(bp.getX(i), bp.getY(i), bp.getZ(i));
      nor.push(bn ? bn.getX(i) : 0, bn ? bn.getY(i) : 0, bn ? bn.getZ(i) : 1);
    }
    if (g !== before) g.dispose();
  }
  for (const m of meshes) if (m) flatten(m, pos, nor);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}
