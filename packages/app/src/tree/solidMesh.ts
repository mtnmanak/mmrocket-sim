/**
 * Watertight solid meshes for the 3D-printing export. Each printable
 * component maps to a closed, outward-wound triangle mesh in meters (pure
 * SI — the STL writer alone converts to mm). Revolved parts reuse the
 * kernel-exact outerProfile() curves so the printed part is the geometry the
 * engine flies. Fins: a square (or unset) section is a flat extruded prism;
 * a rounded or airfoil section prints with its cross-section on the exposed
 * fin (tree/finSection.ts; sharp edges floored at a printable minimum edge)
 * and a flat full-thickness tab — see "THE SHAPED PRINTABLE FIN" below. Cant
 * is never baked in and fillets are not printed on the lone fin. Slicers
 * require watertightness, so everything routes through primitives
 * (revolveProfile / extrudePolygon / shapedFinSolid) that guarantee it by
 * construction or refuse, and isWatertight()/solidVolume() exist so tests can
 * prove it — the shaped fin also checks itself with them before it is used.
 */
import type { ComponentNode } from '@online-openrocket/engine';
import { kernelNum } from './kernelDefaults.js';
import { num, numOpt } from './nodeNum.js';
import { axialLength } from './position.js';
import { enclosesArea, signedArea } from './polygon.js';
import { outerProfile } from './shapeProfile.js';
import { tubeFinRadius, tubeFinWall } from './tubefins.js';
import { finRootChord, finTabSpan } from './finTab.js';
import { isTailCone, noseEnds } from './tailCone.js';
import { finOnMount, type MountedFin, type MountSurface } from './finRoot.js';
import {
  finMacFromOutline, finSectionLaw, finSectionSpec, printableHalf, PRINT_MIN_EDGE, sectionHalfThickness,
  sectionProfile, type FinSectionLaw, type FinSectionSpec,
} from './finSection.js';
import { chordOutline, chordRatioStations, finSectionFlatReason, seatedChordPoints } from './finChords.js';

export interface SolidMesh {
  /** xyz triples, meters */
  positions: Float64Array;
  /** vertex-index triples, CCW when viewed from OUTSIDE (right-hand normals point outward) */
  triangles: Uint32Array;
}

export interface SolidContext {
  /** Fin mount surface and leading-edge station in its frame (m). */
  finMount?: MountSurface;
  finFront?: number;
  /**
   * the bore the part sits in (m), resolved by tree/solidContext.ts — the outer
   * radius of a bulkhead/centering ring/coupler/engine block that states none
   * of its own (ringOuterRadius)
   */
  parentInnerRadius?: number;
  /**
   * the largest outer radius (m) among the inner tubes beside the part that
   * overlap it axially, resolved by tree/solidContext.ts as the kernel's
   * CenteringRing.getInnerRadius does — the bore of a centering ring that
   * states none of its own (centeringRingBore); unset when no tube overlaps
   */
  mountOuterRadius?: number;
  /**
   * C-A7: true when a cluster or off-centre tube needs holes that one centred
   * bore cannot represent. Concentric tubes share one centred opening.
   */
  mountLayoutUnresolved?: boolean;
  /** parent body outer radius (m) — tube-fin auto sizing */
  bodyRadius?: number;
  /** parent body's resolved wall (m), inherited by tube fins */
  bodyThickness?: number;
  /** automatic transition ends resolved from its axial neighbours (m) */
  foreRadius?: number;
  aftRadius?: number;
  /**
   * a fin set's deepest through-the-wall tab (m): the parent body's radius at
   * the tab, the smaller of its two ends (FinSet.getMaxTabHeight), resolved by
   * tree/solidContext.ts — the depth finTab.finTabSpan clamps the cut tab to
   */
  tabMaxDepth?: number;
}

const EPS = 1e-9;
/** Curve samples for nose/transition profiles — keeps revolve volume well inside 1%. */
const PROFILE_STEPS = 64;
/**
 * Fallback radius when nothing can size a part (matches the app's 3D-view
 * default). A ring-type part that lands on it is labelled "(assumed size)" —
 * see ringOuterRadius.
 */
const FALLBACK_RADIUS = 0.012;


const emptyMesh = (): SolidMesh => ({ positions: new Float64Array(0), triangles: new Uint32Array(0) });

/**
 * Drop consecutive near-identical points, including across the loop wrap.
 *
 * Exported because every consumer of a CLOSED contour needs it, not just the
 * mesh builders: a duplicated vertex is a zero-length segment, and a
 * zero-length segment has no defined edge normal — which is precisely what
 * CAM kerf/cutter compensation consumes. extrudePolygon() and revolveProfile()
 * run it internally, so the DXF writer (services/dxfExport.ts) is the one path
 * that has to call it by hand.
 */
export function collapseLoop(pts: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [x, y] of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - x) <= EPS && Math.abs(prev[1] - y) <= EPS) continue;
    out.push([x, y]);
  }
  while (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS) out.pop();
    else break;
  }
  return out;
}

/**
 * Drop every vertex EXACTLY in line with its two neighbours — the vertices
 * three's earcut drops itself when it runs out of ears (its filterPoints, on
 * the same exact test). What they leave out encloses no area: a vertex the
 * outline runs straight through, or the tip of a run the outline traverses out
 * and back — a fin with a point ON its root, say, whose closing edge returns
 * along the stretch the outline has just run. Left in, earcut dropped them and
 * extrudePolygon's face count came up one short, so two sound fins with a flat
 * run along the root were refused as crossings, printed nowhere though the 3D
 * view drew them (audit 2026-09-30, on review). Dropped first, a short count
 * again means what the guard says: an outline that crosses itself. A loop
 * this empties to fewer than three points enclosed nothing.
 */
function dropCollinear(loop: Array<[number, number]>): Array<[number, number]> {
  let out = loop;
  // Until nothing moves: a removal gives both neighbours a new neighbour, and
  // can bring two equal points together.
  for (let removed = true; removed && out.length >= 3;) {
    removed = false;
    for (let i = 0; i < out.length && out.length >= 3; i++) {
      const p = out[(i + out.length - 1) % out.length]!;
      const q = out[i]!;
      const r = out[(i + 1) % out.length]!;
      // earcut's area(p, q, r), term for term, so the two agree on exact zero.
      if ((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]) === 0) {
        out = collapseLoop([...out.slice(0, i), ...out.slice(i + 1)]);
        removed = true;
        break;
      }
    }
  }
  return out;
}

/** Poles inside an on-axis run emit no triangles — drop unreferenced vertices. */
function compact(pos: Float64Array, tris: number[]): SolidMesh {
  const nVerts = pos.length / 3;
  const used = new Uint8Array(nVerts);
  for (const t of tris) used[t] = 1;
  const map = new Int32Array(nVerts);
  let next = 0;
  for (let i = 0; i < nVerts; i++) map[i] = used[i] ? next++ : -1;
  if (next === nVerts) return { positions: pos, triangles: Uint32Array.from(tris) };
  const out = new Float64Array(next * 3);
  for (let i = 0; i < nVerts; i++) {
    const to = map[i]!;
    if (to < 0) continue;
    out[to * 3] = pos[i * 3]!;
    out[to * 3 + 1] = pos[i * 3 + 1]!;
    out[to * 3 + 2] = pos[i * 3 + 2]!;
  }
  return { positions: out, triangles: Uint32Array.from(tris.map((t) => map[t]!)) };
}

/**
 * Revolve a CLOSED (x, r) loop about the +X axis. The loop is normalized to
 * positive signed area first, so callers may traverse in either direction;
 * with that normalization the fixed emission rule below points every normal
 * outward. Points with r <= EPS become single shared axis vertices; a
 * segment between two poles lies ON the axis and emits no surface.
 */
export function revolveProfile(profile: Array<[number, number]>, segments = 96): SolidMesh {
  const loop = collapseLoop(profile.map(([x, r]) => [x, Math.max(r, 0)] as [number, number]));
  if (loop.length < 3 || segments < 3) return emptyMesh();
  if (signedArea(loop) < 0) loop.reverse();

  const n = loop.length;
  const pole = loop.map(([, r]) => r <= EPS);
  const base: number[] = [];
  let vcount = 0;
  for (let i = 0; i < n; i++) {
    base.push(vcount);
    vcount += pole[i] ? 1 : segments;
  }
  const pos = new Float64Array(vcount * 3);
  for (let i = 0; i < n; i++) {
    const [x, r] = loop[i]!;
    if (pole[i]) {
      pos[base[i]! * 3] = x;
    } else {
      for (let j = 0; j < segments; j++) {
        const th = (2 * Math.PI * j) / segments;
        const k = (base[i]! + j) * 3;
        pos[k] = x;
        pos[k + 1] = r * Math.cos(th);
        pos[k + 2] = r * Math.sin(th);
      }
    }
  }
  const tris: number[] = [];
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    if (pole[i] && pole[i2]) continue;
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments;
      if (pole[i]) {
        tris.push(base[i]!, base[i2]! + j, base[i2]! + j2);
      } else if (pole[i2]) {
        tris.push(base[i]! + j, base[i2]!, base[i]! + j2);
      } else {
        const a = base[i]! + j;
        const b = base[i]! + j2;
        const c = base[i2]! + j;
        const d = base[i2]! + j2;
        tris.push(a, c, d, a, d, b);
      }
    }
  }
  return compact(pos, tris);
}

/**
 * Extrude a simple (possibly concave) polygon symmetrically to z = ±t/2.
 * Winding is normalized from the signed area, and each cap triangle is
 * orientation-checked individually so the triangulator's output order
 * cannot flip a normal.
 */
export async function extrudePolygon(
  points: Array<[number, number]>, thickness: number,
): Promise<SolidMesh> {
  const outline = dropCollinear(collapseLoop(points.map(([x, y]) => [x, y] as [number, number])));
  if (outline.length < 3 || !(thickness > 0)) return emptyMesh();
  if (signedArea(outline) < 0) outline.reverse();

  const m = outline.length;
  const h = thickness / 2;
  const pos = new Float64Array(m * 2 * 3);
  for (let i = 0; i < m; i++) {
    const [x, y] = outline[i]!;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = h;
    const k = (m + i) * 3;
    pos[k] = x;
    pos[k + 1] = y;
    pos[k + 2] = -h;
  }
  const { triangulateOutline } = await import('./triangulate.js');
  const faces = triangulateOutline(outline);
  // A SIMPLE polygon of m vertices ear-clips to EXACTLY m-2 triangles that
  // between them touch every vertex. three's earcut (r169, mapbox 2.2.4) does
  // not report failure — on a self-intersecting or zero-area outline its
  // cureLocalIntersections path DELETES vertices and returns fewer triangles:
  // [[0,0],[0.05,0.03],[0,0.03],[0.05,0]] (a fin planform dragged until two
  // edges cross) gives 1 of the 2 needed, and [[0,0],[0.02,0],[0.04,0],[0.05,0]]
  // (height typed to 0) gives 0. The side-wall loop below always emits a quad
  // per edge, so a short cap left the caps holed while the walls stayed —
  // an open, non-manifold "solid" that still downloaded as an STL and that a
  // slicer then silently invented a repair for. Refuse instead: every mesh
  // this function returns is watertight by construction or it is empty.
  const covered = new Uint8Array(m);
  let usable = faces.length === m - 2;
  if (usable) {
    for (const f of faces) {
      for (const v of f) {
        if (!(v >= 0 && v < m)) { usable = false; break; }
        covered[v] = 1;
      }
      if (!usable) break;
    }
  }
  if (usable) {
    for (let i = 0; i < m; i++) {
      if (!covered[i]) { usable = false; break; }
    }
  }
  if (!usable) return emptyMesh();
  const tris: number[] = [];
  for (const f of faces) {
    let a = f[0]!;
    let b = f[1]!;
    let c = f[2]!;
    const cross = (outline[b]![0] - outline[a]![0]) * (outline[c]![1] - outline[a]![1])
      - (outline[b]![1] - outline[a]![1]) * (outline[c]![0] - outline[a]![0]);
    if (cross < 0) {
      const t = b;
      b = c;
      c = t;
    }
    tris.push(a, b, c, m + a, m + c, m + b);
  }
  for (let i = 0; i < m; i++) {
    const i2 = (i + 1) % m;
    tris.push(m + i, m + i2, i2, m + i, i2, i);
  }
  return { positions: pos, triangles: Uint32Array.from(tris) };
}

interface ShoulderIn {
  radius: number;
  length: number;
  thickness: number;
  capped: boolean;
}

interface ShoulderFit {
  rs: number;
  rsi: number;
  len: number;
  /** cap disc thickness, 0 when uncapped or the shoulder went solid */
  cap: number;
  solid: boolean;
}

function fitShoulder(s: ShoulderIn | null, bodyR: number): ShoulderFit | null {
  if (!s || s.radius <= EPS || s.length <= EPS) return null;
  // Clamp to the body-end radius so the radial step at the joint plane can't
  // cross the outer curve (the profile loop must stay simple).
  const rs = Math.min(s.radius, bodyR);
  if (rs <= EPS) return null;
  // Wall CLAMPED at zero. A negative thickness makes rsi > rs, i.e. the bore
  // outside the skin, and the profile loop then self-intersects: measured on a
  // 200 mm ogive R 27 mm, shoulderThickness -0.005 gave a WATERTIGHT mesh of
  // 8.3543e-6 m^3, and thickness -0.003 gave 7.3703e-5 against the correct
  // 4.2887e-5 — +72 %, a plausible-looking wrong number on a printable part.
  // `orkFile.num` accepts any finite value, so a hand-edited or corrupt
  // <thickness> reaches here (2026-09-08 audit).
  const rsi = rs - Math.max(s.thickness, 0);
  const solid = rsi <= EPS || (s.capped && s.thickness >= s.length - EPS);
  return { rs, rsi: Math.max(rsi, 0), len: s.length, cap: solid ? 0 : s.capped ? s.thickness : 0, solid };
}

/**
 * One closed (x, r) profile loop for a nose cone or transition: outer curve
 * fore->aft, around the aft shoulder, inner curve aft->fore, around the fore
 * shoulder. Cavity mouth radii are clamped to the shoulder bore so the
 * radial steps at the joint planes never overlap the shoulder walls.
 */
function bodyLoop(
  outer: Array<[number, number]>,
  wall: number,
  filled: boolean,
  foreSpec: ShoulderIn | null,
  aftSpec: ShoulderIn | null,
): Array<[number, number]> {
  const last = outer.length - 1;
  const L = outer[last]![0];
  const Rf = outer[0]![1];
  const Ra = outer[last]![1];
  // Same clamp as fitShoulder, and for the same reason: a negative wall would
  // put the inner curve OUTSIDE the outer one.
  const w = Math.max(wall, 0);
  const innerR = outer.map(([, r]) => Math.max(r - w, 0));
  const solid = filled || innerR.every((r) => r <= EPS);
  const fs = fitShoulder(foreSpec, Rf);
  const as = fitShoulder(aftSpec, Ra);
  const loop: Array<[number, number]> = [];

  // A capped (or solid) fore shoulder closes its fore end: the end face runs
  // to the axis and the cap's inner disc is emitted after the bore below.
  if (fs) loop.push([-fs.len, fs.solid || fs.cap > 0 ? 0 : fs.rsi], [-fs.len, fs.rs], [0, fs.rs]);
  else if (solid && Rf > EPS) loop.push([0, 0]);

  for (const [x, r] of outer) loop.push([x, r]);

  if (as) {
    loop.push([L, as.rs], [L + as.len, as.rs]);
    if (as.solid) {
      loop.push([L + as.len, 0]);
      if (!solid) loop.push([L, 0]);
    } else {
      if (as.cap > 0) {
        loop.push([L + as.len, 0], [L + as.len - as.cap, 0], [L + as.len - as.cap, as.rsi], [L, as.rsi]);
      } else {
        loop.push([L + as.len, as.rsi], [L, as.rsi]);
      }
      if (solid) loop.push([L, 0]);
    }
  } else if (solid) {
    loop.push([L, 0]);
  }

  if (!solid) {
    const aftClamp = as ? (as.solid ? as.rs : as.rsi) : Infinity;
    const foreClamp = fs ? (fs.solid ? fs.rs : fs.rsi) : Infinity;
    for (let i = last; i >= 0; i--) {
      let r = innerR[i]!;
      if (i === last) r = Math.min(r, aftClamp);
      if (i === 0) r = Math.min(r, foreClamp);
      loop.push([outer[i]![0], r]);
    }
    if (fs) {
      if (fs.solid) loop.push([0, 0]);
      else {
        loop.push([0, fs.rsi]);
        if (fs.cap > 0) loop.push([-fs.len + fs.cap, fs.rsi], [-fs.len + fs.cap, 0]);
      }
    }
  } else if (fs && !fs.solid) {
    // Solid body, hollow fore shoulder: the bore is blind against the body.
    loop.push([0, 0], [0, fs.rsi]);
    if (fs.cap > 0) loop.push([-fs.len + fs.cap, fs.rsi], [-fs.len + fs.cap, 0]);
  }
  return loop;
}

/** Annular tube (or solid rod/disc when the bore closes) along +X. */
function ringLoop(outerR: number, innerR: number, length: number): Array<[number, number]> {
  const ri = Math.max(innerR, 0);
  return ri > EPS
    ? [[0, ri], [0, outerR], [length, outerR], [length, ri]]
    : [[0, 0], [0, outerR], [length, outerR], [length, 0]];
}

function shapeOf(node: ComponentNode): { shape: string; param: number | undefined } {
  return {
    shape: typeof node['shape'] === 'string' ? (node['shape'] as string) : node.type === 'transition' ? 'conical' : 'ogive',
    param: numOpt(node, 'shapeParameter'),
  };
}

function shoulderOf(node: ComponentNode, prefix: string, fallbackWall: number): ShoulderIn {
  const key = (k: string): string => (prefix ? prefix + k.charAt(0).toUpperCase() + k.slice(1) : k);
  return {
    radius: num(node, key('shoulderRadius'), 0),
    length: num(node, key('shoulderLength'), 0),
    thickness: num(node, key('shoulderThickness'), fallbackWall),
    capped: node[key('shoulderCapped')] === true,
  };
}

/**
 * Merge a tab with the seated lobes, never with the retraced full outline
 * (audit 2026-10-11, S4b-1). Lobes outside the tab stay separate closed cuts;
 * those sharing a root interval with it become one perimeter, with no cut
 * through the tab or zero-width bridge along the discarded root run.
 */
function mountedCutContours(
  mounted: MountedFin, bodyY: (x: number) => number,
  tab: ReturnType<typeof finTabSpan>,
): Array<Array<[number, number]>> {
  if (!tab) return mounted.lobes;
  const { x0, x1, depth } = tab;
  const floor = Math.min(bodyY(x0), bodyY(x1)) - depth;
  const onSurface = (x: number): [number, number] => [x, bodyY(x)];
  const surface = (from: number, to: number): Array<[number, number]> => {
    const middle = mounted.root.filter(([x]) => x > Math.min(from, to) + EPS && x < Math.max(from, to) - EPS);
    if (from > to) middle.reverse();
    return [...middle, onSurface(to)];
  };
  const separate: Array<Array<[number, number]>> = [];
  const joined: Array<Array<[number, number]>> = [];
  for (const lobe of mounted.lobes) {
    // A lobe starts on the body, follows the exposed edge to its next touch,
    // then returns along sampled root points. Keep only that exposed chain.
    const end = lobe.findIndex(([x, y], i) => i > 0 && Math.abs(y - bodyY(x)) <= EPS);
    const chain = lobe.slice(0, end + 1);
    if (chain[0]![0] > chain.at(-1)![0]) chain.reverse();
    if (chain.at(-1)![0] > x0 + EPS && chain[0]![0] < x1 - EPS) joined.push(chain);
    else separate.push(lobe);
  }
  joined.sort((a, b) => a[0]![0] - b[0]![0]);
  const start = Math.min(x0, joined[0]?.[0]?.[0] ?? x0);
  const finish = Math.max(x1, joined.at(-1)?.at(-1)?.[0] ?? x1);
  const outline: Array<[number, number]> = [onSurface(start)];
  let at = start;
  for (const chain of joined) {
    outline.push(...surface(at, chain[0]![0]), ...chain.slice(1));
    at = chain.at(-1)![0];
  }
  outline.push(...surface(at, finish), ...surface(finish, x1),
    [x1, floor], [x0, floor], onSurface(x0), ...surface(x0, start));
  return [...separate, collapseLoop(outline)];
}

/**
 * The fin's own planform points (x aft of the leading root corner, y outward,
 * root on y = 0), BEFORE any seating or tab: the outline finCutContours cuts,
 * and the outline the shaped printable fin (shapedFinSolid) takes its chords
 * from. Null when the outline is unreadable or has fewer than three points.
 */
export function finPlanformPoints(node: ComponentNode): Array<[number, number]> | null {
  let pts: Array<[number, number]>;
  // An absent dimension is the kernel's (tree/kernelDefaults.ts): the tip here
  // was 25 mm where the kernel, the 3D view and the paper template had 30
  // (audit 2026-09-30).
  if (node.type === 'trapezoidfinset') {
    const root = kernelNum(node, 'rootChord');
    const tip = Math.max(kernelNum(node, 'tipChord'), 0);
    const sweep = kernelNum(node, 'sweep');
    const height = kernelNum(node, 'height');
    pts = [[0, 0], [sweep, height], [sweep + tip, height], [root, 0]];
  } else if (node.type === 'ellipticalfinset') {
    const root = kernelNum(node, 'rootChord');
    const height = kernelNum(node, 'height');
    // A TRUE half-ellipse, not a sine hump. The kernel's own planform is
    // EllipticalFinSet.java lines 17-25 (OpenRocket 24.12):
    //   POINT_X[i] = (Math.cos(a) + 1) / 2;  POINT_Y[i] = Math.sin(a);
    // i.e. x sweeps as cos and y as sin over the SAME parameter, which is what
    // makes it an ellipse. Walking x linearly while y goes sinusoidal (the
    // shape this used to emit) encloses (2/PI)*root*height instead of the
    // ellipse's (PI/4)*root*height — 19% small, and visibly the wrong curve
    // near the leading and trailing edges. The form below is the a -> PI - t
    // relabelling of the kernel's, chosen so the walk still runs leading root
    // -> tip -> trailing root; it is byte-for-byte the expression
    // finTemplate.ts's finOutline() already used for the printable SVG, so the
    // cut template, the DXF and the printed prism now describe one curve.
    // STEPS matches finOutline()'s so the two agree vertex-for-vertex.
    //
    // This CHANGES previously-shipped STL geometry — deliberately, it is a bug
    // fix. It is app-side mesh generation only: fin aerodynamics are computed
    // by the Java kernel from rootChord/height, never from these points, so
    // there is no simulation or differential-test impact.
    const steps = 64;
    pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = (Math.PI * i) / steps;
      pts.push([(root / 2) * (1 - Math.cos(t)), height * Math.sin(t)]);
    }
  } else {
    const raw = node['points'];
    if (!Array.isArray(raw) || raw.length < 3) return null;
    pts = [];
    for (const p of raw as unknown[]) {
      // A NaN or infinite row is as unreadable as a string one (audit row
      // 522): it passed the typeof test and cut a NaN outline into the DXF.
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      pts.push([p[0], p[1]]);
    }
  }

  // An explicitly closed point list (last point repeating the first) would
  // make the tab merge retrace the root edge — treat it as open.
  while (pts.length > 1) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (Math.abs(a[0] - b[0]) <= 1e-7 && Math.abs(a[1] - b[1]) <= 1e-7) pts.pop();
    else break;
  }
  if (pts.length < 3) return null;
  return pts;
}

/**
 * Fin planforms in (x = chordwise aft+, y = span), root edge on y = 0. The
 * tab merges into the outline along the closing root edge; for freeform fins
 * that edge only exists when both endpoints sit on y = 0.
 *
 * Exported because the DXF cut profile and SVG template need the same merged
 * contours the extruded prisms use: a separate overlapping tab box cuts a
 * slot through the root. A seated fin split into lobes has one closed contour
 * per disconnected region, unless its tab joins those regions.
 *
 * `ctx` carries the body radius at the tab (`tabMaxDepth`), which the tab's
 * depth is clamped to; both exporters pass solidContextFor's.
 */
export function finCutContours(node: ComponentNode, ctx: SolidContext = {}): Array<Array<[number, number]>> | null {
  const planform = finPlanformPoints(node);
  if (!planform) return null;
  let pts = planform;

  // Seat printable and cuttable freeform roots too, including the tab's flat
  // floor below its lower surface endpoint (audit 2026-10-11, S4b-1).
  if (node.type === 'freeformfinset' && ctx.finMount) {
    const front = ctx.finFront ?? 0;
    const mounted = finOnMount(pts, front, ctx.finMount);
    const tab = finTabSpan(node, finRootChord(node), ctx.tabMaxDepth);
    const bodyY = (x: number) => ctx.finMount!.radiusAt(front + x) - mounted.r0;
    return mountedCutContours(mounted, bodyY, tab);
  }

  // The root chord and the tab come from tree/finTab.ts — the SAME two readers
  // the paper template (services/finTemplate.ts) uses, so the printed prism,
  // the DXF and the template cannot put the tab in three places. A freeform
  // fin's root chord is the LAST point's x (FinSet.getTabFrontEdge() measures
  // the tab from it), NOT the max over all points: FinPointsEditor's
  // constrain() pins only point 0 and the last point's y, so a tip trailing
  // corner may overhang the root's. Using max-x there put the tab's fore
  // corner AFT of the root trailing corner, and the closed contour then walked
  // y = 0 twice in opposite directions — points
  // [[0,0],[0.02,0.03],[0.05,0.03],[0.01,0]] with a 20x10 mm tab gave three.js's
  // ear clipper 4 cap triangles where 6 are needed, i.e. a non-watertight STL
  // and a DXF path that doubled back on itself. It also placed the tab at a
  // different station than the physics uses.
  const tab = finTabSpan(node, finRootChord(node), ctx.tabMaxDepth);
  if (tab) {
    const first = pts[0]!;
    const lastP = pts[pts.length - 1]!;
    if (Math.abs(first[1]) <= 1e-7 && Math.abs(lastP[1]) <= 1e-7) {
      const { x0, x1, depth } = tab;
      pts = pts.concat(
        lastP[0] >= first[0]
          ? [[x1, 0], [x1, -depth], [x0, -depth], [x0, 0]]
          : [[x0, 0], [x0, -depth], [x1, -depth], [x1, 0]],
      );
    }
  }
  return [pts];
}

/** Single-contour convenience reader; exporters use finCutContours for every lobe. */
export function finCutOutline(node: ComponentNode, ctx: SolidContext = {}): Array<[number, number]> | null {
  const contours = finCutContours(node, ctx);
  return contours?.length === 1 ? contours[0]! : null;
}

// ---------------------------------------------------------------------------
// N062 §3 — THE SHAPED PRINTABLE FIN
//
// A rounded or airfoil fin prints with its cross-section (tree/finSection.ts,
// the one section law every view and export shares). What is built:
//
//  - The EXPOSED fin is a "thickened planform": the planform (each seated lobe,
//    exactly the region finCutContours cuts above the root) is triangulated in
//    horizontal bands — one station at every outline vertex height, at every
//    height where the fin's own outline turns, and enough more that no band is
//    taller than 1/PRINT_SPAN_STEPS of the fin, plus the 3D view's own rows
//    where the chord collapses to a pointed tip, whose vertex carries the
//    law's thickest value (finChords.ts's chordRatioStations; N062 review,
//    round 4) — and each station carries the
//    section's own chordwise samples (finSection's sectionProfile, resolution
//    PRINT_SECTION_RESOLUTION). Every planar vertex is lifted to ±half, where
//    half is the section's half-thickness at that point, floored at the
//    printable minimum edge (finSection's PRINT_MIN_EDGE, 0.4 mm full
//    thickness, never thicker than the stock) so a slicer gets an edge it can
//    print instead of a knife edge it drops. Vertical walls of that floored
//    height close the outline. The top and bottom are graphs over one planar
//    triangulation and the walls stand on its boundary, so the solid cannot
//    cross itself; vertices are welded by index, so isWatertight holds.
//  - The chord at a point comes from the fin's OWN outline at that height,
//    AS SEATED (finChords.ts's seatedChordPoints: finPlanformPoints with its
//    root corners on the body, as the kernel flies it, so a last point typed
//    at y = 0 and one desktop OR stored on the body print one solid), its
//    root closing edge left out (finChords.ts's chordOutline: that sloped
//    edge is never the section's leading or trailing edge), widened to the
//    seated lobe where the
//    mount adds planform, never narrowed where the mount clips it, and taken at
//    the root chord below the root line (a boat-tail root). So the body does
//    not invent a sharp edge where it cuts a lobe.
//  - The TAB stays a flat full-thickness prism (it goes into a slot). It is
//    welded to the fin in ONE closed shell: where the shaped root is thinner
//    than the stock, a small step face (the tab's shoulder) closes the gap.
//  - No fillet is printed on the lone fin (a fillet is formed on the assembled
//    rocket) and the cant is not baked in, as before.
//  - Square (and unset) sections never reach this code: they keep the flat
//    prism vertex for vertex. Any fin this cannot shape exactly — a planform a
//    horizontal line crosses more than twice, as typed or as seated on the
//    body (finChords.ts's finSectionFlatReason, the one predicate the 3D view
//    and the panel share), a step in the outline at mid-height, stock no
//    thicker than the printable minimum edge, or a mesh that fails its own
//    watertight check — keeps the flat prism, and finPrintShape() says so, so
//    the panel can tell the user.
//
// The drawn and printed section's volume is NOT the mass the app flies: the
// kernel's relative volume (FinSet.java:48-54, 1.00 / 0.99 / 0.85) is
// separate, and nothing here feeds the flight path.
// ---------------------------------------------------------------------------

type Pt = [number, number];

/** Chordwise section samples across a full curved chord on the printed fin. */
const PRINT_SECTION_RESOLUTION = 32;
/** No spanwise band is taller than this fraction of the fin's height. */
const PRINT_SPAN_STEPS = 16;
/** A local chord at or below this (m) is a point — a pointed tip. */
const CHORD_EPS = 1e-9;
/** Rows added where the chord changes stand at least this far (m) apart and from a band's ends (the view's MIN_ROW_GAP). */
const PRINT_MIN_ROW_GAP = 2e-6;

/** Why a rounded/airfoil fin prints as the flat prism instead of its section. */
export type FinPrintFallback =
  /** a horizontal line crosses the outline as typed more than twice, or the outline steps at mid-height */
  | 'chords'
  /** the outline as typed has one chord at every height, but AS SEATED ON THE BODY it does not */
  | 'seated'
  /** the stock is no thicker than the printable minimum edge: no section survives the floor */
  | 'thin'
  /** the shaped mesh failed its own watertight / volume check */
  | 'mesh'
  /** nothing of the planform stands above the mount (all of it lies along the body) */
  | 'no-planform';

export type FinPrintShape =
  | { kind: 'flat' }
  /** `tab`: whether the printed fin carries a tab (it stays flat at full stock) */
  | { kind: 'shaped'; law: FinSectionLaw; minEdge: number; tab: boolean }
  | { kind: 'fallback'; law: FinSectionLaw; reason: FinPrintFallback }
  /** no STL at all: componentSolid declines this outline (it crosses itself, or encloses no area) */
  | { kind: 'refused' };

interface Band { left: [Pt, Pt]; right: [Pt, Pt] }
interface Slabs { ys: number[]; bands: Band[]; ymin: number; ymax: number }

/** x of an edge at height y — exact at its own endpoints, so two bands sharing a vertex agree bit for bit. */
function edgeX(e: [Pt, Pt], y: number): number {
  const [p, q] = e;
  if (y === p[1]) return p[0];
  if (y === q[1]) return q[0];
  return p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]);
}

/**
 * Cut a closed polygon into horizontal bands at every vertex height (plus
 * `extra` heights). Null unless every band meets the outline in exactly ONE
 * interval — two edges, left of right at both ends.
 */
function slabsOf(poly: Pt[], extra: readonly number[] = []): Slabs | null {
  const n = poly.length;
  if (n < 3) return null;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [, y] of poly) {
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  if (!(ymax > ymin)) return null;
  const ys = [...new Set(poly.map((p) => p[1]))].sort((a, b) => a - b);
  const tol = (ymax - ymin) * 1e-6;
  for (const y of extra) {
    if (y > ymin + tol && y < ymax - tol && ys.every((v) => Math.abs(v - y) > tol)) ys.push(y);
  }
  ys.sort((a, b) => a - b);
  const bands: Band[] = [];
  for (let k = 0; k + 1 < ys.length; k++) {
    const y0 = ys[k]!;
    const y1 = ys[k + 1]!;
    const mid = (y0 + y1) / 2;
    const crossing: Array<[Pt, Pt]> = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % n]!;
      if ((p[1] < mid) !== (q[1] < mid)) crossing.push([p, q]);
    }
    if (crossing.length !== 2) return null;
    let [left, right] = crossing as [[Pt, Pt], [Pt, Pt]];
    if (edgeX(left, mid) > edgeX(right, mid)) [left, right] = [right, left];
    if (!(edgeX(right, mid) - edgeX(left, mid) > 0)) return null;
    // Edges that swap order inside the band cross each other.
    if (edgeX(left, y0) > edgeX(right, y0) + EPS || edgeX(left, y1) > edgeX(right, y1) + EPS) return null;
    bands.push({ left, right });
  }
  return { ys, bands, ymin, ymax };
}

/** The fin's own outline as a chord field: [leading x, trailing x] at any height. */
interface ChordField { slabs: Slabs }

function chordField(pts: Pt[]): ChordField | null {
  const slabs = slabsOf(pts);
  if (!slabs) return null;
  // A horizontal edge strictly inside the span is a step in the leading or
  // trailing edge: the chord jumps there, and one drawn section cannot follow.
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    if (p[1] === q[1] && p[1] > slabs.ymin && p[1] < slabs.ymax && p[0] !== q[0]) return null;
  }
  return { slabs };
}

/** Chord interval at height y, clamped into the outline's own span (the root chord below it). */
function chordAt(field: ChordField, y: number): [number, number] {
  const { ys, bands, ymin, ymax } = field.slabs;
  const yc = Math.min(ymax, Math.max(ymin, y));
  let k = 0;
  while (k < bands.length - 1 && ys[k + 1]! < yc) k++;
  const band = bands[k]!;
  return [edgeX(band.left, yc), edgeX(band.right, yc)];
}

/** Fractional index of xi in a sorted sample list — the zipper's pairing key. */
function sampleKey(xis: readonly number[], xi: number): number {
  const last = xis.length - 1;
  if (xi <= xis[0]!) return 0;
  if (xi >= xis[last]!) return last;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xis[mid]! <= xi) lo = mid; else hi = mid;
  }
  const span = xis[hi]! - xis[lo]!;
  return span > 0 ? lo + (xi - xis[lo]!) / span : lo;
}

/**
 * Triangulate the strip between two chains (P below / Q above, or two wall
 * columns) by advancing whichever next vertex has the smaller key. Any
 * monotone advance tiles the strip between two parallel lines without overlap;
 * the keys only choose the diagonals. Emits (p_i, p_i+1, q_j) and
 * (p_i, q_j+1, q_j) — counter-clockwise for P below Q, left to right.
 */
function zip<T>(P: readonly T[], Q: readonly T[], key: (v: T) => number, emit: (a: T, b: T, c: T) => void): void {
  let i = 0;
  let j = 0;
  while (i < P.length - 1 || j < Q.length - 1) {
    const advanceP = j >= Q.length - 1 || (i < P.length - 1 && key(P[i + 1]!) <= key(Q[j + 1]!));
    if (advanceP) {
      emit(P[i]!, P[i + 1]!, Q[j]!);
      i++;
    } else {
      emit(P[i]!, Q[j + 1]!, Q[j]!);
      j++;
    }
  }
}

/**
 * Where the section crosses the printable floor between two samples. The floor
 * is a kink the section's own samples do not carry: without a vertex there, a
 * straight chamfer interpolated from the floored edge to its first breakpoint
 * printed ~6% too fat (measured on a hexagonal trapezoid).
 */
function floorCrossings(
  spec: FinSectionSpec, chord: number, xi: readonly number[], half: readonly number[], floorHalf: number,
): number[] {
  const out: number[] = [];
  for (let j = 0; j + 1 < xi.length; j++) {
    if ((half[j]! < floorHalf) === (half[j + 1]! < floorHalf)) continue;
    let lo = xi[j]!;
    let hi = xi[j + 1]!;
    const below = half[j]! < floorHalf;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if ((sectionHalfThickness(spec, chord, mid) < floorHalf) === below) lo = mid; else hi = mid;
    }
    out.push((lo + hi) / 2);
  }
  return out;
}

/**
 * Even chordwise fill inside any SLOPED gap wider than 1/PRINT_CHORD_FILL of
 * the chord. A straight chamfer needs no vertex to be straight across one
 * station, but between two stations of different chord a triangle spanning
 * it interpolates the wrong thickness: a single-wedge trapezoid printed 0.5%
 * thin with its breakpoints alone. Flat runs at full thickness are left alone.
 */
const PRINT_CHORD_FILL = 16;

function chordFill(xi: readonly number[], half: readonly number[], H: number): number[] {
  const out: number[] = [];
  for (let j = 0; j + 1 < xi.length; j++) {
    const gap = xi[j + 1]! - xi[j]!;
    if (half[j] === H && half[j + 1] === H) continue;
    const parts = Math.ceil(gap * PRINT_CHORD_FILL - 1e-9);
    for (let s = 1; s < parts; s++) out.push(xi[j]! + (gap * s) / parts);
  }
  return out;
}

/** A planar vertex of the exposed fin. */
interface PV {
  id: number;
  lobe: number;
  x: number;
  y: number;
  /** printable half-thickness here, m */
  half: number;
  /** pairing key along its station */
  key: number;
  /** on the tab's shoulder: welded to the tab's vertices */
  junction: boolean;
}

interface LobePlanar { tris: Array<[PV, PV, PV]>; boundary: Array<[PV, PV]> }

/**
 * One lobe's planar band triangulation with each vertex's printable
 * half-thickness. Null when the lobe is not one interval at every height.
 */
function lobePlanar(
  poly: Pt[], field: ChordField, spec: FinSectionSpec, lobe: number, ids: { next: number },
): LobePlanar | null {
  // Stations: the lobe's own vertices, the outline's turning heights (so the
  // chord field is linear inside every band) and an even spanwise subdivision.
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [, y] of poly) {
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  const extra = field.slabs.ys.slice();
  const coarse = slabsOf(poly, extra);
  if (!coarse) return null;
  const maxBand = (ymax - ymin) / PRINT_SPAN_STEPS;
  for (let k = 0; k + 1 < coarse.ys.length; k++) {
    const ya = coarse.ys[k]!;
    const yb = coarse.ys[k + 1]!;
    const gap = yb - ya;
    const parts = Math.ceil(gap / maxBand - 1e-9);
    for (let s = 1; s < parts; s++) extra.push(ya + (gap * s) / parts);
    // And where the fin's own chord collapses to a point (a pointed tip), the
    // rows the 3D view puts there (finChords.ts's chordRatioStations, the one
    // rule both paths share), so the print follows the law up to the view's
    // last row. The chord field is linear inside every coarse band. Elsewhere
    // the even subdivision above keeps the print within 2 % of the law.
    const [la, ra] = chordAt(field, ya);
    const [lb, rb] = chordAt(field, yb);
    if (Math.min(ra - la, rb - lb) <= CHORD_EPS) {
      extra.push(...chordRatioStations(ya, yb, ra - la, rb - lb, PRINT_MIN_ROW_GAP));
    }
  }
  const slabs = slabsOf(poly, extra);
  if (!slabs) return null;
  const { ys, bands } = slabs;
  const t = spec.thickness;
  const H = t / 2;
  // A station whose chord has collapsed to a point (a pointed tip): every
  // chord fraction of the section meets there, so it carries the law's
  // thickest value at that chord — as the view's tip row does — floored
  // (below) only where the law itself is below the printable edge. Until
  // N062's fourth review it carried the section's EDGE value, floored to
  // 0.4 mm, and the whole top band tapered from full stock down to it.
  const tipHalf = Math.max(...sectionProfile(spec, 0, PRINT_SECTION_RESOLUTION).half);
  const floorHalf = Math.min(PRINT_MIN_EDGE, t) / 2;

  const stations: PV[][] = [];
  for (let k = 0; k < ys.length; k++) {
    const y = ys[k]!;
    const exact: number[] = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const band of [k > 0 ? bands[k - 1] : undefined, k < bands.length ? bands[k] : undefined]) {
      if (!band) continue;
      const l = edgeX(band.left, y);
      const r = edgeX(band.right, y);
      exact.push(l, r);
      lo = Math.min(lo, l);
      hi = Math.max(hi, r);
    }
    for (const [vx, vy] of poly) if (vy === y && vx >= lo - EPS && vx <= hi + EPS) exact.push(vx);
    const [uL, uR] = chordAt(field, y);
    const L = Math.min(uL, lo);
    const c = Math.max(uR, hi) - L;
    const profile = c > CHORD_EPS ? sectionProfile(spec, c, PRINT_SECTION_RESOLUTION) : null;
    const cand: Array<{ x: number; exact: boolean }> = exact.map((x) => ({ x, exact: true }));
    if (profile) {
      const extraXi = [...floorCrossings(spec, c, profile.xi, profile.half, floorHalf),
        ...chordFill(profile.xi, profile.half, H)];
      for (const xi of [...profile.xi, ...extraXi]) {
        const x = L + xi * c;
        if (x > lo + EPS && x < hi - EPS) cand.push({ x, exact: false });
      }
    }
    cand.sort((a, b) => a.x - b.x);
    const merged: Array<{ x: number; exact: boolean }> = [];
    for (const p of cand) {
      const prev = merged[merged.length - 1];
      if (prev && p.x - prev.x <= EPS) {
        if (p.exact && !prev.exact) merged[merged.length - 1] = p;
        continue;
      }
      merged.push(p);
    }
    stations.push(merged.map(({ x }) => {
      let half = tipHalf;
      let key = 0;
      if (profile) {
        const xi = Math.min(1, Math.max(0, (x - L) / c));
        half = sectionHalfThickness(spec, c, xi);
        key = sampleKey(profile.xi, xi);
      }
      half = printableHalf(half, t);
      if (H - half <= 1e-9 * H) half = H;
      return { id: ids.next++, lobe, x, y, half, key, junction: false };
    }));
  }

  const tris: Array<[PV, PV, PV]> = [];
  for (let k = 0; k < bands.length; k++) {
    const band = bands[k]!;
    const y0 = ys[k]!;
    const y1 = ys[k + 1]!;
    const pick = (row: PV[], l: number, r: number): PV[] => row.filter((p) => p.x >= l - EPS && p.x <= r + EPS);
    const lower = pick(stations[k]!, edgeX(band.left, y0), edgeX(band.right, y0));
    const upper = pick(stations[k + 1]!, edgeX(band.left, y1), edgeX(band.right, y1));
    if (lower.length === 0 || upper.length === 0 || (lower.length === 1 && upper.length === 1)) return null;
    zip(lower, upper, (p) => p.key, (a, b, c) => tris.push([a, b, c]));
  }

  // Boundary: the directed edges whose reverse no triangle uses.
  const edges = new Set<string>();
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]] as const) edges.add(`${u.id}>${v.id}`);
  const boundary: Array<[PV, PV]> = [];
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      if (!edges.has(`${v.id}>${u.id}`)) boundary.push([u, v]);
    }
  }
  return { tris, boundary };
}

function distToSegment(x: number, y: number, p: Pt, q: Pt): number {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  const s = len2 > 0 ? Math.min(1, Math.max(0, ((x - p[0]) * dx + (y - p[1]) * dy) / len2)) : 0;
  return Math.hypot(x - (p[0] + s * dx), y - (p[1] + s * dy));
}

/** Insert stations x0/x1 into the flagged (root) edges they fall strictly inside. */
function splitRootEdges(poly: Pt[], root: boolean[], xs: readonly number[], at: (x: number) => Pt): { poly: Pt[]; root: boolean[] } {
  const out: Pt[] = [];
  const flags: boolean[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    out.push(p);
    flags.push(root[i]!);
    if (!root[i]) continue;
    const inside = xs.filter((x) => x > Math.min(p[0], q[0]) + EPS && x < Math.max(p[0], q[0]) - EPS);
    inside.sort((a, b) => (q[0] >= p[0] ? a - b : b - a));
    for (const x of inside) {
      out.push(at(x));
      flags.push(true);
    }
  }
  return { poly: out, root: flags };
}

type ShapedResult = { mesh: SolidMesh; tab: boolean } | { fail: FinPrintFallback };

/**
 * The shaped printable solid of one fin (see the block comment above), or why
 * it cannot be built. Callers have already sent square sections, a zero
 * thickness and an unreadable outline down the flat-prism path.
 */
function shapedFinSolid(
  node: ComponentNode, ctx: SolidContext, pts: Pt[], chordPts: Pt[], spec: FinSectionSpec,
): ShapedResult {
  const t = spec.thickness;
  const H = t / 2;
  const field = chordField(chordOutline(chordPts));
  if (!field) return { fail: 'chords' };

  // The exposed region (lobes, with their root edges flagged), the tab, and
  // the body surface the tab's top follows — exactly as finCutContours cuts.
  let lobes: Array<{ poly: Pt[]; root: boolean[] }>;
  let tab: ReturnType<typeof finTabSpan> = null;
  let floorY = 0;
  let surface: (x: number) => Pt = (x) => [x, 0];
  let rootPts: Pt[] = [];
  if (node.type === 'freeformfinset' && ctx.finMount) {
    const front = ctx.finFront ?? 0;
    const mount = ctx.finMount;
    const mounted = finOnMount(pts, front, mount);
    const bodyY = (x: number): number => mount.radiusAt(front + x) - mounted.r0;
    surface = (x) => [x, bodyY(x)];
    rootPts = mounted.root;
    lobes = mounted.lobes.map((lobe) => {
      // A lobe runs from a body point along its exposed edge to the next body
      // point, then back along the body: the edges from there on are root.
      const end = lobe.findIndex(([x, y], i) => i > 0 && Math.abs(y - bodyY(x)) <= EPS);
      return { poly: lobe.map(([x, y]) => [x, y] as Pt), root: lobe.map((_, i) => end > 0 && i >= end) };
    });
    tab = finTabSpan(node, finRootChord(node), ctx.tabMaxDepth);
    if (tab) floorY = Math.min(bodyY(tab.x0), bodyY(tab.x1)) - tab.depth;
  } else {
    const poly = pts.map(([x, y]) => [x, y] as Pt);
    const first = poly[0]!;
    const last = poly[poly.length - 1]!;
    // finCutContours' own test for a root on y = 0 (and the only case it hangs the tab on).
    const rooted = Math.abs(first[1]) <= 1e-7 && Math.abs(last[1]) <= 1e-7;
    if (rooted) {
      first[1] = 0;
      last[1] = 0;
      tab = finTabSpan(node, finRootChord(node), ctx.tabMaxDepth);
      if (tab) floorY = -tab.depth;
    }
    lobes = [{ poly, root: poly.map((_, i) => rooted && i === poly.length - 1) }];
  }
  if (lobes.length === 0) return { fail: 'no-planform' };
  if (tab) lobes = lobes.map((l) => splitRootEdges(l.poly, l.root, [tab!.x0, tab!.x1], surface));

  // Planar meshes, and the tab's shoulder (junction) edges on each.
  const ids = { next: 0 };
  const planar: LobePlanar[] = [];
  const junctionEdges = new Set<string>();
  const jkey = (p: { x: number; y: number }): string => `J${p.x},${p.y}`;
  for (let l = 0; l < lobes.length; l++) {
    const { poly, root } = lobes[l]!;
    const mesh = lobePlanar(poly, field, spec, l, ids);
    if (!mesh) return { fail: 'chords' };
    planar.push(mesh);
    if (!tab) continue;
    const segs: Array<[Pt, Pt]> = [];
    for (let i = 0; i < poly.length; i++) if (root[i]) segs.push([poly[i]!, poly[(i + 1) % poly.length]!]);
    const onRoot = (x: number, y: number): boolean => segs.some(([p, q]) => distToSegment(x, y, p, q) <= EPS);
    for (const [u, v] of mesh.boundary) {
      if (Math.min(u.x, v.x) < tab.x0 - EPS || Math.max(u.x, v.x) > tab.x1 + EPS) continue;
      if (!onRoot(u.x, u.y) || !onRoot(v.x, v.y) || !onRoot((u.x + v.x) / 2, (u.y + v.y) / 2)) continue;
      u.junction = true;
      v.junction = true;
      junctionEdges.add(`${jkey(u)}>${jkey(v)}`);
    }
  }

  // Lifted vertices, welded by identity and height: a junction vertex is one
  // planar point the fin and the tab share, so where the fin is full stock
  // there its top IS the tab's top.
  const pos: number[] = [];
  const index = new Map<string, number>();
  const vertex = (id: string, x: number, y: number, z: number): number => {
    const k = `${id}|${z}`;
    let i = index.get(k);
    if (i === undefined) {
      i = pos.length / 3;
      pos.push(x, y, z);
      index.set(k, i);
    }
    return i;
  };
  const fid = (p: PV): string => (p.junction ? jkey(p) : `L${p.lobe}:${p.id}`);
  const ft = (p: PV): number => vertex(fid(p), p.x, p.y, p.half);
  const fb = (p: PV): number => vertex(fid(p), p.x, p.y, -p.half);
  const tris: number[] = [];
  const tri = (a: number, b: number, c: number): void => {
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  };
  const z = (i: number): number => pos[i * 3 + 2]!;
  const dedup = (col: number[]): number[] => col.filter((v, i) => i === 0 || v !== col[i - 1]);
  /** The wall over boundary edge s -> e (solid on its left), columns bottom to top. */
  const wall = (colS: number[], colE: number[]): void => zip(dedup(colE), dedup(colS), z, tri);

  for (const mesh of planar) {
    for (const [a, b, c] of mesh.tris) {
      tri(ft(a), ft(b), ft(c));
      tri(fb(a), fb(c), fb(b));
    }
    for (const [u, v] of mesh.boundary) {
      if (u.junction && v.junction && junctionEdges.has(`${jkey(u)}>${jkey(v)}`)) continue;
      wall([fb(u), ft(u)], [fb(v), ft(v)]);
    }
  }

  if (tab) {
    // The tab's top: the shoulder points the fin shares, and the body surface
    // (its ends, and the root stations between) wherever no lobe stands.
    const junctionPV = new Map<string, PV>();
    for (const mesh of planar) for (const [u, v] of mesh.boundary) for (const p of [u, v]) if (p.junction) junctionPV.set(jkey(p), p);
    const cand: Array<{ x: number; y: number; pv?: PV }> = [...junctionPV.values()].map((pv) => ({ x: pv.x, y: pv.y, pv }));
    for (const [x, y] of [surface(tab.x0), surface(tab.x1), ...rootPts.filter(([x]) => x > tab!.x0 + EPS && x < tab!.x1 - EPS)]) {
      cand.push({ x, y });
    }
    cand.sort((a, b) => a.x - b.x || (a.pv ? -1 : 1));
    const top: Array<{ x: number; y: number; pv?: PV }> = [];
    for (const p of cand) {
      const prev = top[top.length - 1];
      if (prev && p.x - prev.x <= EPS) {
        if (p.pv && !prev.pv) top[top.length - 1] = p;
        continue;
      }
      top.push(p);
    }
    if (top.length < 2 || top.some((p) => !(p.y > floorY + EPS))) return { fail: 'mesh' };
    const tid = (i: number): string => (top[i]!.pv ? jkey(top[i]!.pv!) : `T${i}`);
    const tt = (i: number): number => vertex(tid(i), top[i]!.x, top[i]!.y, H);
    const tb = (i: number): number => vertex(tid(i), top[i]!.x, top[i]!.y, -H);
    const flt = (i: number): number => vertex(`F${i}`, top[i]!.x, floorY, H);
    const flb = (i: number): number => vertex(`F${i}`, top[i]!.x, floorY, -H);
    /** A tab column: split at the fin's own edge heights where the fin stands on it. */
    const tcol = (i: number): number[] => {
      const pv = top[i]!.pv;
      return pv ? [tb(i), fb(pv), ft(pv), tt(i)] : [tb(i), tt(i)];
    };
    const K = top.length - 1;
    for (let i = 0; i < K; i++) {
      // Planar strip (floor_i, floor_i+1, top_i+1, top_i), lifted to ±t/2.
      tri(flt(i), flt(i + 1), tt(i + 1));
      tri(flt(i), tt(i + 1), tt(i));
      tri(flb(i), tb(i + 1), flb(i + 1));
      tri(flb(i), tb(i), tb(i + 1));
      wall([flb(i), flt(i)], [flb(i + 1), flt(i + 1)]);
      // The top edge, walked as the tab walks it (right to left).
      const s = i + 1;
      const e = i;
      const ps = top[s]!.pv;
      const pe = top[e]!.pv;
      if (ps && pe && junctionEdges.has(`${jkey(pe)}>${jkey(ps)}`)) {
        // The fin stands on this edge: only the shoulder steps remain.
        wall([ft(ps), tt(s)], [ft(pe), tt(e)]);
        wall([tb(s), fb(ps)], [tb(e), fb(pe)]);
      } else {
        wall(tcol(s), tcol(e));
      }
    }
    wall([flb(K), flt(K)], tcol(K));
    wall(tcol(0), [flb(0), flt(0)]);
  }

  const mesh: SolidMesh = { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris) };
  if (!isWatertight(mesh) || !(solidVolume(mesh) > 0)) return { fail: 'mesh' };
  return { mesh, tab: tab !== null };
}

/** The section law and the shaped build for a fin node, or the reason it stays flat. */
function shapedFinFor(node: ComponentNode, ctx: SolidContext): { shape: FinPrintShape; mesh?: SolidMesh } {
  const pts = finPlanformPoints(node);
  const law = finSectionLaw(node);
  const t = kernelNum(node, 'thickness');
  if (law === 'square' || !pts || !(t > 0)) return { shape: { kind: 'flat' } };
  // Stock no thicker than the printable minimum edge is floored flat at every
  // point: the "section" would be a uniform slab, so say it is the prism.
  if (t <= PRINT_MIN_EDGE) return { shape: { kind: 'fallback', law, reason: 'thin' } };
  // The one chord predicate the 3D view and the panel's note share, on the
  // same seat (finChords.ts).
  const flat = finSectionFlatReason(node, node.type === 'freeformfinset' ? ctx.finMount : undefined, ctx.finFront ?? 0);
  if (flat) return { shape: { kind: 'fallback', law, reason: flat === 'seated' ? 'seated' : 'chords' } };
  // The chords — and the MAC that sets the chamfer fractions — of the fin AS
  // SEATED, as the 3D view reads them (finChords.ts's seatedChordPoints).
  const chordPts = node.type === 'freeformfinset' && ctx.finMount
    ? seatedChordPoints(pts, ctx.finFront ?? 0, ctx.finMount)
    : pts;
  const spec = finSectionSpec(node, finMacFromOutline(chordPts));
  const built = shapedFinSolid(node, ctx, pts, chordPts, spec);
  if ('fail' in built) return { shape: { kind: 'fallback', law, reason: built.fail } };
  return { shape: { kind: 'shaped', law, minEdge: PRINT_MIN_EDGE, tab: built.tab }, mesh: built.mesh };
}

/** Whether two segments cross at a point strictly inside both (touching does not count). */
function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/**
 * Whether componentSolid declines this fin set's STL — synchronously, for the
 * panel, on the outlines extrudePolygon is handed: no stock, no cut contour,
 * or a contour that, after the same clean-up extrudePolygon runs, has fewer
 * than three points, encloses no area, or crosses itself. (extrudePolygon's
 * own test is three's ear-clipper, loaded on demand; a crossing that only
 * touches can still fail it at export, where the panel's export note says so.)
 */
function finPrintRefused(node: ComponentNode, ctx: SolidContext): boolean {
  if (!(kernelNum(node, 'thickness') > 0)) return true;
  const contours = finCutContours(node, ctx);
  if (!contours?.length) return true;
  return contours.some((c) => {
    const loop = dropCollinear(collapseLoop(c.map(([x, y]) => [x, y] as Pt)));
    if (loop.length < 3 || !enclosesArea(loop)) return true;
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue; // neighbours across the wrap
        if (properCross(loop[i]!, loop[(i + 1) % n]!, loop[j]!, loop[(j + 1) % n]!)) return true;
      }
    }
    return false;
  });
}

/**
 * What the per-part 🖨 STL of this fin set holds — synchronous, for the panel:
 *  - `refused`: no STL — the outline crosses itself or encloses no area;
 *  - `flat`: a square (or unset) section, the flat prism as always;
 *  - `shaped`: the fin's cross-section, sharp edges floored at `minEdge` (m),
 *    with a flat full-stock tab when `tab`;
 *  - `fallback`: a rounded/airfoil fin this cannot shape (see FinPrintFallback),
 *    printed as the flat prism instead — say so where the user looks.
 * Non-fin nodes read `flat`.
 */
export function finPrintShape(node: ComponentNode, ctx: SolidContext = {}): FinPrintShape {
  if (node.type !== 'trapezoidfinset' && node.type !== 'ellipticalfinset' && node.type !== 'freeformfinset') {
    return { kind: 'flat' };
  }
  if (finPrintRefused(node, ctx)) return { kind: 'refused' };
  return shapedFinFor(node, ctx).shape;
}

/**
 * The closed (x, r) profile ONE revolved printable part is built from, plus
 * the two facts the loop alone cannot carry.
 *
 * Exported for tree/splitSolid.ts, which cuts oversized parts into
 * printer-sized segments by clipping this 2-D loop and re-revolving — never
 * by a boolean on the triangle soup. That consumer needs `bodySpan` because
 * bodyLoop() DOUBLES BACK inside shoulder spans (see the aft-cap branch), so
 * a cut plane there would slice a zero-width bridge instead of a face, and it
 * needs `wall` to keep cuts away from the end faces.
 */
export interface PrintableLoop {
  /** closed (x, r) loop, meters, ready for revolveProfile() */
  loop: Array<[number, number]>;
  label: string;
  /** [x0, x1] of the PLAIN BODY in loop x — shoulders deliberately excluded */
  bodySpan: [number, number];
  /** nominal wall thickness as authored (m) */
  wall: number;
  /**
   * The part's OUTER diameter is a placeholder, not a measurement: nothing
   * stated it and the context could not resolve the bore it sits in (see
   * ringOuterRadius). The label says "(assumed size)" and printOffer puts a
   * warning under the 🖨 button.
   */
  sizeAssumed?: boolean;
  /**
   * A centering ring's HOLE is a placeholder: no stated bore and no inner tube
   * overlapping the ring gives one that fits (centeringRingBore), so it is cut
   * at half the OD. The label says "(assumed bore)" and printOffer says so
   * under the 🖨 button too — the label alone sits inside the file, where an
   * automatic ring aft of its motor tube printed a hole the motor cannot pass
   * with nothing on screen (audit 2026-09-30 review).
   */
  boreAssumed?: boolean;
}

/**
 * The outer radius (m) a ring-type part — coupler, engine block, centering
 * ring, bulkhead — is printed or cut at, and whether it had to be ASSUMED.
 * Shared by componentLoop and the DXF writer, so the printed and the machined
 * version of one part cannot come out different sizes.
 *
 * In the kernel's order (audit 2026-09-22): the part's OWN outer radius when
 * it states one — a catalogue part, and every RockSim ring, carries its OD, and
 * the kernel bridge flies that radius — then the bore it sits in
 * (tree/solidContext.ts resolves it the way the kernel resolves an automatic
 * radius). Only when neither exists does it fall back to FALLBACK_RADIUS, and
 * then it SAYS so. It used to take the bore alone and fall back silently: a
 * bulkhead in a coupler from the Add menu exported as a 24.0 mm disc labelled
 * plainly "Bulkhead" whatever the airframe diameter.
 */
export function ringOuterRadius(node: ComponentNode, ctx: SolidContext): { r: number; assumed: boolean } {
  const own = numOpt(node, 'outerRadius');
  if (own !== undefined && own > EPS) return { r: own, assumed: false };
  const bore = ctx.parentInnerRadius;
  if (bore !== undefined && Number.isFinite(bore) && bore > EPS) return { r: bore, assumed: false };
  return { r: FALLBACK_RADIUS, assumed: true };
}

/**
 * The bore (m) a centering ring of outer radius `R` is cut to, before the
 * fits-inside-R check its two callers (componentLoop, the DXF writer) make —
 * undefined when nothing gives one; null when automatic hole placement cannot
 * represent the mount layout and fabrication must refuse it.
 *
 * The same order as ringOuterRadius, and the kernel's: the ring's OWN stated
 * inner radius first — every .ork and .rkt ring that states an ID carries one,
 * and CenteringRing.getInnerRadius flies it, consulting the sibling inner tubes
 * only when the radius is automatic — then the OD of the widest inner tube that
 * overlaps the ring (`ctx.mountOuterRadius`). The exports read the
 * mount alone until the 2026-09-22 audit's review, so an imported ring of OD 40
 * / ID 29 mm in a tube with no inner tube printed and cut with a made-up 20 mm
 * bore labelled "no motor mount found". A stated zero is a solid disc.
 * Unresolved mount layouts refuse fabrication even with a stated bore.
 */
export function centeringRingBore(node: ComponentNode, ctx: SolidContext, R: number): number | null | undefined {
  const own = numOpt(node, 'innerRadius');
  if (ctx.mountLayoutUnresolved) return null;
  if (own !== undefined && own >= 0 && own < R - EPS) return own;
  return ctx.mountOuterRadius;
}

/**
 * Profile loop for one revolved printable component, or null if this type is
 * not a revolve (fins) or not printable at all.
 *
 * `extraX` (meters, loop x) is forwarded to outerProfile() so a caller that
 * intends to cut at those abscissas gets exact samples there instead of
 * chords. Loop x and profile x share an origin — a fore shoulder occupies
 * negative x — so no translation is needed.
 */
export function componentLoop(
  node: ComponentNode, ctx: SolidContext, extraX?: readonly number[],
): PrintableLoop | null {
  // AN ABSENT DIMENSION IS THE KERNEL'S (audit 2026-09-30): every length is
  // `axialLength` and every stated wall or radius `kernelNum`, the bridge's own
  // defaults (tree/kernelDefaults.ts). Each case kept its own until then — an
  // engine block printed 50 mm long where 5 mm flies, a body tube 100 mm with a
  // 1 mm wall where 300 mm with 0.3 mm flies — with nothing to say so. Only an
  // AUTOMATIC radius uses context; an unresolved end or ring radius keeps a
  // placeholder and says when its size is assumed.
  switch (node.type) {
    case 'nosecone': {
      const L = axialLength(node);
      const R = kernelNum(node, 'aftRadius');
      const wall = kernelNum(node, 'thickness');
      const { shape, param } = shapeOf(node);
      // No `clipped` argument on purpose: NoseCone.isClipped() is always false
      // in the kernel, and a zero radius at either end makes outerProfile's
      // clip branch unreachable anyway (it needs r1 > 0). Only the transition
      // below can clip. A TAIL CONE (flipped) prints base forward with its
      // shoulder at the front, the cone NoseCone.setFlipped flies.
      const tailCone = isTailCone(node);
      const { fore, aft } = noseEnds(node, R);
      const outer = outerProfile(shape, param, L, fore, aft, PROFILE_STEPS, extraX);
      const shoulder = shoulderOf(node, '', wall);
      const loop = bodyLoop(outer, wall, node['filled'] === true,
        tailCone ? shoulder : null, tailCone ? null : shoulder);
      return { loop, label: tailCone ? 'Tail cone' : 'Nose cone', bodySpan: [0, L], wall };
    }
    case 'transition': {
      const L = axialLength(node);
      const fore = numOpt(node, 'foreRadius') ?? ctx.foreRadius;
      const aft = numOpt(node, 'aftRadius') ?? ctx.aftRadius;
      const assumed = fore === undefined || aft === undefined;
      const Rf = fore ?? FALLBACK_RADIUS;
      const Ra = aft ?? FALLBACK_RADIUS;
      const wall = kernelNum(node, 'thickness');
      const { shape, param } = shapeOf(node);
      // node['clipped'] (.ork <shapeclipped>) MUST ride along, exactly as
      // Rocket3D.tsx and schematicLayout.ts forward it: absent = the kernel
      // default (clipped), an explicit false = the unclipped delta shape.
      // Dropping it printed the clipped continuation for a transition drawn
      // and flown unclipped — on a 76.2 mm -> 38.1 mm power (p=0.5) reducer
      // 100 mm long the two profiles differ by up to 3.49 mm in RADIUS
      // (7.0 mm on diameter) and 285.0 vs 323.0 cm^3 of solid — 13% of the
      // filament — so the printed part did not mate with the airframe it was
      // designed against.
      const outer = outerProfile(
        shape, param, L, Rf, Ra, PROFILE_STEPS, extraX,
        typeof node['clipped'] === 'boolean' ? (node['clipped'] as boolean) : undefined,
      );
      const loop = bodyLoop(
        outer, wall, node['filled'] === true,
        shoulderOf(node, 'fore', wall), shoulderOf(node, 'aft', wall),
      );
      return {
        loop, label: assumed ? 'Transition (assumed size)' : 'Transition', bodySpan: [0, L], wall,
        ...(assumed ? { sizeAssumed: true } : {}),
      };
    }
    case 'bodytube':
    case 'innertube':
    case 'launchlug': {
      const R = kernelNum(node, 'outerRadius');
      const wall = kernelNum(node, 'thickness');
      const L = axialLength(node);
      const label = node.type === 'bodytube' ? 'Body tube' : node.type === 'innertube' ? 'Inner tube' : 'Launch lug';
      // A solid body tube (KB3) prints as the rod it flies as.
      const bore = node.type === 'bodytube' && node['filled'] === true ? 0 : R - wall;
      return { loop: ringLoop(R, bore, L), label, bodySpan: [0, L], wall };
    }
    case 'tubecoupler':
    case 'engineblock': {
      const { r: R, assumed } = ringOuterRadius(node, ctx);
      const wall = kernelNum(node, 'thickness');
      const L = axialLength(node);
      const label = (node.type === 'tubecoupler' ? 'Tube coupler' : 'Engine block')
        + (assumed ? ' (assumed size)' : '');
      return {
        loop: ringLoop(R, R - wall, L), label, bodySpan: [0, L], wall,
        ...(assumed ? { sizeAssumed: true } : {}),
      };
    }
    case 'centeringring': {
      const { r: R, assumed } = ringOuterRadius(node, ctx);
      const L = axialLength(node);
      const bore = centeringRingBore(node, ctx, R);
      if (bore === null) return null;
      const size = assumed ? { sizeAssumed: true } : {};
      if (typeof bore === 'number' && (bore > EPS || (bore === 0 && numOpt(node, 'innerRadius') === 0)) && bore < R - EPS) {
        return {
          loop: ringLoop(R, bore, L), label: `Centering ring${assumed ? ' (assumed size)' : ''}`,
          bodySpan: [0, L], wall: R - bore, ...size,
        };
      }
      // No bore is a bulkhead, not a ring — assume a half-radius bore and say so.
      return {
        loop: ringLoop(R, R * 0.5, L),
        label: assumed ? 'Centering ring (assumed size and bore)' : 'Centering ring (assumed bore)',
        bodySpan: [0, L], wall: R * 0.5, boreAssumed: true, ...size,
      };
    }
    case 'bulkhead': {
      const { r: R, assumed } = ringOuterRadius(node, ctx);
      const L = axialLength(node);
      return {
        loop: ringLoop(R, 0, L), label: assumed ? 'Bulkhead (assumed size)' : 'Bulkhead',
        bodySpan: [0, L], wall: R, ...(assumed ? { sizeAssumed: true } : {}),
      };
    }
    case 'tubefinset': {
      const r = tubeFinRadius(node, ctx.bodyRadius ?? FALLBACK_RADIUS);
      if (!(r > 0)) return null;
      // No kernel constant: an absent wall inherits the parent tube's.
      const wall = tubeFinWall(node, r, ctx.bodyThickness);
      const L = axialLength(node);
      return { loop: ringLoop(r, r - wall, L), label: 'Tube fin', bodySpan: [0, L], wall };
    }
    default:
      return null;
  }
}

/**
 * The smallest solid worth writing to a printable file, m^3 — 1 mm^3.
 *
 * A revolved profile can close on itself and produce a watertight mesh of ZERO
 * or NEGATIVE volume, which `isWatertight` cannot see (it is topology and
 * finiteness only, by design). Measured on a 200 mm ogive, R 27 mm:
 *
 *   thickness 0.002 -> volume  4.2887e-5 m^3   (a real shell)
 *   thickness 0     -> volume -3.6180e-20 m^3, 24,384 triangles, watertight
 *
 * `thickness` is a `lenMM` field with `smin: 0` and PropertyPanel clamps only
 * its maximum, so one drag of the slider to its left stop reaches it, and the
 * download button beside it then writes the result. Found by the 2026-09-08
 * audit.
 */
const MIN_PRINTABLE_VOLUME_M3 = 1e-9;

/** Printable solid for one component (one fin / one tube fin per set), or null if unsupported. */
export async function componentSolid(
  node: ComponentNode, ctx: SolidContext,
): Promise<{ mesh: SolidMesh; label: string } | null> {
  const revolved = componentLoop(node, ctx);
  if (revolved) {
    const mesh = revolveProfile(revolved.loop);
    // The volume oracle, in production. It existed only so tests could prove
    // this module (its docstring says so) while nothing on the shipping path
    // ever asked it a question — and the one question worth asking is whether
    // the thing about to be written is a solid at all. Declining is the same
    // answer an unprintable type already gets.
    if (solidVolume(mesh) < MIN_PRINTABLE_VOLUME_M3) return null;
    return { mesh, label: revolved.label };
  }
  switch (node.type) {
    case 'trapezoidfinset':
    case 'ellipticalfinset':
    case 'freeformfinset': {
      const contours = finCutContours(node, ctx);
      if (!contours?.length) return null;
      const meshes = await Promise.all(contours.map(outline => extrudePolygon(outline, kernelNum(node, 'thickness'))));
      // extrudePolygon returns EMPTY rather than an open shell when the
      // planform cannot be triangulated (edges that cross, a zero-height
      // outline). Report that the same way an unprintable type reports it —
      // null — so the caller declines instead of writing a non-manifold STL.
      if (meshes.some(mesh => mesh.triangles.length === 0)) return null;
      const label = node.type === 'trapezoidfinset' ? 'Trapezoidal fin'
        : node.type === 'ellipticalfinset' ? 'Elliptical fin' : 'Freeform fin';
      // N062: a rounded or airfoil fin prints with its cross-section. The flat
      // prisms above still run first, so every outline the flat path refuses
      // (crossing edges, no area) is refused here too; a fin the shaped path
      // cannot build keeps the flat prism (finPrintShape says so).
      const shaped = shapedFinFor(node, ctx);
      if (shaped.mesh) return { mesh: shaped.mesh, label };
      const mesh: SolidMesh = {
        positions: new Float64Array(meshes.reduce((n, m) => n + m.positions.length, 0)),
        triangles: new Uint32Array(meshes.reduce((n, m) => n + m.triangles.length, 0)),
      };
      let positionOffset = 0, triangleOffset = 0;
      for (const part of meshes) {
        mesh.positions.set(part.positions, positionOffset);
        mesh.triangles.set(part.triangles.map(i => i + positionOffset / 3), triangleOffset);
        positionOffset += part.positions.length;
        triangleOffset += part.triangles.length;
      }
      return { mesh, label };
    }
    default:
      return null;
  }
}

/** Signed volume via divergence theorem, m^3. Positive = outward winding. */
export function solidVolume(mesh: SolidMesh): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3;
    const b = t[i + 1]! * 3;
    const c = t[i + 2]! * 3;
    const bx = p[b]!;
    const by = p[b + 1]!;
    const bz = p[b + 2]!;
    const cx = p[c]!;
    const cy = p[c + 1]!;
    const cz = p[c + 2]!;
    v += p[a]! * (by * cz - bz * cy) + p[a + 1]! * (bz * cx - bx * cz) + p[a + 2]! * (bx * cy - by * cx);
  }
  return v / 6;
}

/** True iff every undirected edge is shared by EXACTLY two triangles in OPPOSITE directions. */
export function isWatertight(mesh: SolidMesh): boolean {
  const p = mesh.positions;
  const t = mesh.triangles;
  if (t.length === 0 || t.length % 3 !== 0) return false;
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) return false;
  }
  const vcount = p.length / 3;
  const edges = new Map<number, [number, number]>();
  const use = (a: number, b: number): boolean => {
    if (a === b || a >= vcount || b >= vcount) return false;
    const key = a < b ? a * vcount + b : b * vcount + a;
    let e = edges.get(key);
    if (!e) {
      e = [0, 0];
      edges.set(key, e);
    }
    e[a < b ? 0 : 1]++;
    return true;
  };
  for (let i = 0; i < t.length; i += 3) {
    if (!use(t[i]!, t[i + 1]!) || !use(t[i + 1]!, t[i + 2]!) || !use(t[i + 2]!, t[i]!)) return false;
  }
  for (const [fwd, rev] of edges.values()) {
    if (fwd !== 1 || rev !== 1) return false;
  }
  return true;
}
