/**
 * Watertight solid meshes for the 3D-printing export. Each printable
 * component maps to ONE closed, outward-wound triangle mesh in meters (pure
 * SI — the STL writer alone converts to mm). Revolved parts reuse the
 * kernel-exact outerProfile() curves so the printed part is the geometry the
 * engine flies; fins are flat extruded prisms (cant and airfoil cross
 * sections are deliberately dropped — the UI labels that). Slicers require
 * watertightness, so everything routes through two primitives
 * (revolveProfile / extrudePolygon) that guarantee it by construction, and
 * isWatertight()/solidVolume() exist so tests can prove it.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { ComponentNode } from '@online-openrocket/engine';
import { outerProfile } from './shapeProfile.js';
import { tubeFinRadius } from './tubefins.js';
import { finTabFront } from '../components/TreeSchematic.js';

export interface SolidMesh {
  /** xyz triples, meters */
  positions: Float64Array;
  /** vertex-index triples, CCW when viewed from OUTSIDE (right-hand normals point outward) */
  triangles: Uint32Array;
}

export interface SolidContext {
  /** inner radius of the parent tube (m) — outer radius for bulkhead/centering ring/coupler */
  parentInnerRadius?: number;
  /** outer radius of the motor-mount inner tube (m) — centering ring bore */
  mountOuterRadius?: number;
  /** parent body outer radius (m) — tube-fin auto sizing */
  bodyRadius?: number;
}

const EPS = 1e-9;
/** Curve samples for nose/transition profiles — keeps revolve volume well inside 1%. */
const PROFILE_STEPS = 64;
/** Fallback radius when the context can't size a part (matches the app's 3D-view default). */
const FALLBACK_RADIUS = 0.012;

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

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

function signedArea(loop: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i]!;
    const [x1, y1] = loop[(i + 1) % loop.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
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
export function extrudePolygon(points: Array<[number, number]>, thickness: number): SolidMesh {
  const outline = collapseLoop(points.map(([x, y]) => [x, y] as [number, number]));
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
  const faces = ShapeUtils.triangulateShape(outline.map(([x, y]) => new Vector2(x, y)), []);
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
  const rsi = rs - s.thickness;
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
  const innerR = outer.map(([, r]) => Math.max(r - wall, 0));
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
    shape: typeof node['shape'] === 'string' ? (node['shape'] as string) : 'ogive',
    param: typeof node['shapeParameter'] === 'number' ? (node['shapeParameter'] as number) : undefined,
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
 * Fin planform in (x = chordwise aft+, y = span), root edge on y = 0. The
 * tab merges into the outline along the closing root edge; for freeform fins
 * that edge only exists when both endpoints sit on y = 0.
 *
 * Exported because the DXF cut profile (services/dxfExport.ts) needs the same
 * merged contour the extruded prism uses: CAM offsets ONE closed path
 * correctly, while an outline overlapping a separate tab box cuts a slot
 * through the root. finTemplate.ts's finOutline() is the unmerged variant —
 * the SVG draws the tab as its own stroke, which is fine on paper.
 */
export function finCutOutline(node: ComponentNode): Array<[number, number]> | null {
  let pts: Array<[number, number]>;
  let rootLen: number;
  if (node.type === 'trapezoidfinset') {
    const root = num(node, 'rootChord', 0.05);
    const tip = Math.max(num(node, 'tipChord', 0.025), 0);
    const sweep = num(node, 'sweep', 0.02);
    const height = num(node, 'height', 0.03);
    pts = [[0, 0], [sweep, height], [sweep + tip, height], [root, 0]];
    rootLen = root;
  } else if (node.type === 'ellipticalfinset') {
    const root = num(node, 'rootChord', 0.05);
    const height = num(node, 'height', 0.03);
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
    rootLen = root;
  } else {
    const raw = node['points'];
    if (!Array.isArray(raw) || raw.length < 3) return null;
    pts = [];
    for (const p of raw as unknown[]) {
      if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null;
      pts.push([p[0], p[1]]);
    }
    rootLen = Math.max(0, ...pts.map((p) => p[0]));
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

  const tabH = num(node, 'tabHeight', 0);
  const tabL = num(node, 'tabLength', 0);
  if (tabH > EPS && tabL > EPS && rootLen > EPS) {
    const first = pts[0]!;
    const lastP = pts[pts.length - 1]!;
    if (Math.abs(first[1]) <= 1e-7 && Math.abs(lastP[1]) <= 1e-7) {
      const front = finTabFront(node, rootLen);
      const x0 = Math.min(Math.max(front, 0), rootLen);
      const x1 = Math.min(Math.max(front + tabL, 0), rootLen);
      if (x1 - x0 > EPS) {
        const tab: Array<[number, number]> =
          lastP[0] >= first[0]
            ? [[x1, 0], [x1, -tabH], [x0, -tabH], [x0, 0]]
            : [[x0, 0], [x0, -tabH], [x1, -tabH], [x1, 0]];
        pts = pts.concat(tab);
      }
    }
  }
  return pts;
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
  switch (node.type) {
    case 'nosecone': {
      const L = num(node, 'length', 0.1);
      const R = num(node, 'aftRadius', FALLBACK_RADIUS);
      const wall = num(node, 'thickness', 0.002);
      const { shape, param } = shapeOf(node);
      const outer = outerProfile(shape, param, L, 0, R, PROFILE_STEPS, extraX);
      const loop = bodyLoop(outer, wall, node['filled'] === true, null, shoulderOf(node, '', wall));
      return { loop, label: 'Nose cone', bodySpan: [0, L], wall };
    }
    case 'transition': {
      const L = num(node, 'length', 0.05);
      const Rf = num(node, 'foreRadius', FALLBACK_RADIUS);
      const Ra = num(node, 'aftRadius', FALLBACK_RADIUS);
      const wall = num(node, 'thickness', 0.002);
      const { shape, param } = shapeOf(node);
      const outer = outerProfile(shape, param, L, Rf, Ra, PROFILE_STEPS, extraX);
      const loop = bodyLoop(
        outer, wall, node['filled'] === true,
        shoulderOf(node, 'fore', wall), shoulderOf(node, 'aft', wall),
      );
      return { loop, label: 'Transition', bodySpan: [0, L], wall };
    }
    case 'bodytube':
    case 'innertube':
    case 'launchlug': {
      const R = num(node, 'outerRadius', FALLBACK_RADIUS);
      const wall = num(node, 'thickness', 0.001);
      const L = num(node, 'length', 0.1);
      const label = node.type === 'bodytube' ? 'Body tube' : node.type === 'innertube' ? 'Inner tube' : 'Launch lug';
      return { loop: ringLoop(R, R - wall, L), label, bodySpan: [0, L], wall };
    }
    case 'tubecoupler':
    case 'engineblock': {
      const R = ctx.parentInnerRadius && ctx.parentInnerRadius > 0 ? ctx.parentInnerRadius : FALLBACK_RADIUS;
      const wall = num(node, 'thickness', 0.001);
      const L = num(node, 'length', 0.05);
      const label = node.type === 'tubecoupler' ? 'Tube coupler' : 'Engine block';
      return { loop: ringLoop(R, R - wall, L), label, bodySpan: [0, L], wall };
    }
    case 'centeringring': {
      const R = ctx.parentInnerRadius && ctx.parentInnerRadius > 0 ? ctx.parentInnerRadius : FALLBACK_RADIUS;
      const L = num(node, 'length', 0.003);
      const bore = ctx.mountOuterRadius;
      if (typeof bore === 'number' && bore > EPS && bore < R - EPS) {
        return { loop: ringLoop(R, bore, L), label: 'Centering ring', bodySpan: [0, L], wall: R - bore };
      }
      // No bore is a bulkhead, not a ring — assume a half-radius bore and say so.
      return { loop: ringLoop(R, R * 0.5, L), label: 'Centering ring (assumed bore)', bodySpan: [0, L], wall: R * 0.5 };
    }
    case 'bulkhead': {
      const R = ctx.parentInnerRadius && ctx.parentInnerRadius > 0 ? ctx.parentInnerRadius : FALLBACK_RADIUS;
      const L = num(node, 'length', 0.003);
      return { loop: ringLoop(R, 0, L), label: 'Bulkhead', bodySpan: [0, L], wall: R };
    }
    case 'tubefinset': {
      const r = tubeFinRadius(node, ctx.bodyRadius ?? FALLBACK_RADIUS);
      const wall = Math.min(num(node, 'thickness', 0.0005), r * 0.45);
      const L = num(node, 'length', 0.1);
      return { loop: ringLoop(r, r - wall, L), label: 'Tube fin', bodySpan: [0, L], wall };
    }
    default:
      return null;
  }
}

/** Printable solid for one component (one fin / one tube fin per set), or null if unsupported. */
export function componentSolid(node: ComponentNode, ctx: SolidContext): { mesh: SolidMesh; label: string } | null {
  const revolved = componentLoop(node, ctx);
  if (revolved) return { mesh: revolveProfile(revolved.loop), label: revolved.label };
  switch (node.type) {
    case 'trapezoidfinset':
    case 'ellipticalfinset':
    case 'freeformfinset': {
      const outline = finCutOutline(node);
      if (!outline) return null;
      const mesh = extrudePolygon(outline, num(node, 'thickness', 0.003));
      const label = node.type === 'trapezoidfinset' ? 'Trapezoidal fin'
        : node.type === 'ellipticalfinset' ? 'Elliptical fin' : 'Freeform fin';
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
