import type { ComponentNode } from '@online-openrocket/engine';
import { finSectionLaw } from './finSection.js';
import { finOnMount, type MountSurface } from './finRoot.js';
import { enclosesArea } from './polygon.js';

/**
 * WHERE A FIN'S SECTION TAKES ITS CHORDS FROM, and whether it can be shaped at
 * all (N062). Display and print only — no three.js, nothing on the flight
 * path imports it — so the property panel, `tree/pieces.ts` (through
 * `tree/finSurface.ts`) and the per-part print (`tree/solidMesh.ts`) all ask
 * the ONE question here, on the same seated lobes.
 *
 * THE CHORD OUTLINE. A drawn section is laid over a local chord: the fin's
 * own leading and trailing edge at a spanwise height. Those edges are the
 * outline's points from the first (the leading root corner) to the last (the
 * trailing root corner) — never its closing root edge. Desktop OR stores a
 * freeform fin's last point ON the body (FreeformFinSet.getFinPoints /
 * clampLastPoint, written by FreeformFinSetSaver), so on a boat tail or a
 * flare that point's y is not 0 and the closing edge slopes; read as an
 * outline edge it became the section's leading edge (boat tail) or trailing
 * edge (flare), and the whole root was drawn and printed as a knife edge.
 * So the chord outline drops that edge: below the HIGHER root endpoint the
 * leading side runs straight down from the first point's x and the trailing
 * side from the last point's x, to the lower endpoint's height, where a
 * horizontal edge (never a chord edge) closes it — from the far end of any
 * run of points lying at that corner's height, which is root, not edge. An
 * outline whose two root corners share a height comes back unchanged.
 *
 * AS SEATED, NOT AS TYPED (N062 review, round 3). The points the chords are
 * read from are the fin as the kernel flies it (`seatedChordPoints`): the
 * first..last points of finRoot's seated outline, both root corners ON the
 * body and any interior point inside it raised onto it. The app's editor keeps
 * a boat-tail or flare fin's last point at y = 0 while desktop OR stores it on
 * the body; finOnMount seats both at the same corner, so both forms of one
 * fin give one chord field — read off the typed points, the y = 0 form's
 * trailing edge ran to (c, 0) while the drawn edge ran to the body, and
 * wherever the seated edge lay ahead of the typed one the section was cut off
 * by a full-stock wall. A run of points lying ALONG the body next to a corner
 * (raised points at a rising trailing root, say) is no edge either: the chain
 * is cut at the run's far end, the fin's real corner, where the seated lobe
 * leaves the body.
 */

type P2 = readonly [number, number];

/** Two root-line points within this (m) of one height are one run (finRoot's ON_BODY). */
const RUN_TOL = 1e-9;

/** The outline the section's chords come from: the fin's points, its root closing edge left out (see above). */
export function chordOutline(points: readonly P2[]): [number, number][] {
  let out = points.map(([x, y]): [number, number] => [x, y]);
  if (out.length < 3) return out;
  const first = out[0]!;
  const last = out[out.length - 1]!;
  const low = Math.min(first[1], last[1]);
  if (first[1] > low) {
    // A run of points along the root line at the higher corner (a fin typed
    // with a flat run on y = 0, seated on a boat tail) is root, not leading
    // edge: the drop starts at the run's far end, where the leading edge
    // does — as seatedChordPoints cuts a run lying along the body (N062
    // review, round 4). From point 0 it made a step at y = 0 that no outline
    // as drawn has, and the print fell back to the flat prism.
    let a = 0;
    while (a + 2 < out.length && Math.abs(out[a + 1]![1] - first[1]) <= RUN_TOL) a++;
    out = [[out[a]![0], low], ...out.slice(a)];
  }
  if (last[1] > low) {
    let b = out.length - 1;
    while (b - 2 >= 0 && Math.abs(out[b - 1]![1] - last[1]) <= RUN_TOL) b--;
    out = [...out.slice(0, b + 1), [out[b]![0], low]];
  }
  return out;
}

/**
 * Largest chord RATIO across one row step, and the most steps a band takes
 * for it (a 6:1 band takes 10; a pointed tip, whose chord falls to nothing,
 * takes at most the cap). Below the chord floor (1 % of the band's larger
 * chord, and never under CHORD_FLOOR_M) an end counts as pointed and gets no
 * further rows.
 */
const CHORD_RATIO = 1.2;
const MAX_CHORD_STEPS = 16;
const CHORD_FLOOR = 0.01;
const CHORD_FLOOR_M = 5e-4;

/**
 * THE SPANWISE ROWS WHERE A CHORD CHANGES (N062 review, rounds 3 and 4) — one
 * rule, so the 3D view (finSurface.ts) and the per-part print (solidMesh.ts)
 * put rows in the same places. Between heights ya and yb, where the fin's own
 * chord runs linearly from ca to cb, rows go in so the chord changes by the
 * SAME ratio at every step, at most CHORD_RATIO, in an EVEN count (an odd one
 * left the view's alternating diagonals a single-wedge trapezoid 0.5 % off
 * its volume), at most MAX_CHORD_STEPS. Toward a pointed tip the steps stop
 * at the chord floor. No two rows stand closer than `minGap` (m), nor that
 * close to either end. Returns the interior heights only, ascending.
 */
export function chordRatioStations(ya: number, yb: number, ca: number, cb: number, minGap: number): number[] {
  const big = Math.max(ca, cb);
  if (!(big > 0) || ca === cb) return [];
  const floor = Math.min(big, Math.max(CHORD_FLOOR * big, CHORD_FLOOR_M));
  const fa = Math.max(ca, floor);
  const fb = Math.max(cb, floor);
  let steps = Math.min(MAX_CHORD_STEPS,
    Math.ceil(Math.abs(Math.log(fb / fa)) / Math.log(CHORD_RATIO) - 1e-9));
  if (steps > 1 && steps % 2 === 1) steps = Math.min(MAX_CHORD_STEPS, steps + 1);
  const out: number[] = [];
  let last = ya;
  for (let i = 1; i < steps; i++) {
    // The chord is linear in y across the band: the row where it reaches the
    // i-th geometric step between the two ends.
    const c = fa * (fb / fa) ** (i / steps);
    const y = ya + ((c - ca) / (cb - ca)) * (yb - ya);
    if (y - last >= minGap && yb - y >= minGap) {
      out.push(y);
      last = y;
    }
  }
  return out;
}

/** A seated point within this (m) of the body's surface lies on it (finRoot's ON_BODY). */
const ON_BODY = 1e-9;

/**
 * The fin's points AS SEATED on `mount` with its leading edge at `front` (m
 * from the mount's fore end): finOnMount's outline from the first point to the
 * last — root corners on the body, interior points inside it raised — with a
 * run along the body at either end cut back to the corner where the fin
 * leaves it (see the header). Without a mount, the points as typed.
 */
export function seatedChordPoints(
  points: readonly P2[], front = 0, mount?: MountSurface,
): [number, number][] {
  if (!mount || points.length < 3) return points.map(([x, y]): [number, number] => [x, y]);
  const mounted = finOnMount(points, front, mount);
  const chain = mounted.outline.slice(0, points.length);
  const on = ([x, y]: P2): boolean => Math.abs(y - (mount.radiusAt(front + x) - mounted.r0)) <= ON_BODY;
  let a = 0;
  while (a + 1 < chain.length && on(chain[a + 1]!)) a++;
  let b = chain.length - 1;
  while (b - 1 > a && on(chain[b - 1]!)) b--;
  return b - a >= 2 ? chain.slice(a, b + 1) : chain;
}

/**
 * Whether every horizontal line through a closed loop crosses it exactly
 * twice — one interval, one chord — between each pair of its vertex heights.
 * Horizontal edges cross nothing. False for a loop with no height.
 */
export function singleChord(loop: readonly P2[]): boolean {
  if (loop.length < 3) return false;
  const ys = [...new Set(loop.map((p) => p[1]))].filter(Number.isFinite).sort((a, b) => a - b);
  if (ys.length < 2) return false;
  for (let k = 0; k + 1 < ys.length; k++) {
    const mid = (ys[k]! + ys[k + 1]!) / 2;
    let crossings = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i]!;
      const q = loop[(i + 1) % loop.length]!;
      if ((p[1] < mid) !== (q[1] < mid)) crossings++;
    }
    if (crossings !== 2) return false;
  }
  return true;
}

/**
 * Why a shaped section cannot be laid over a fin, or null when it can. The
 * section is laid over the fin AS SEATED: null when the chord outline of
 * `seated` (`seatedChordPoints`) and every seated lobe have one chord at every
 * height. Otherwise:
 *  - `outline`: the fin's own chord outline AS TYPED (`own`) already has more
 *    than one chord at some height — a W, a hook, a notch below a lobe;
 *  - `seated`: the outline as typed is fine, but AS SEATED ON THE BODY it or
 *    one of its lobes is not (a corner raised onto a rising transition above
 *    an interior point, say).
 * `lobes` are the seated planform loops the fin is drawn or printed over;
 * `seated` defaults to `own` (a fin judged off its mount, or a caller that
 * already passes the seated points).
 */
export function sectionChordProblem(
  own: readonly P2[], lobes: readonly (readonly P2[])[], seated: readonly P2[] = own,
): 'outline' | 'seated' | null {
  const typedOk = singleChord(chordOutline(own));
  const seatedOk = seated === own ? typedOk : singleChord(chordOutline(seated));
  if (seatedOk && !lobes.some((l) => enclosesArea(l) && !singleChord(l))) return null;
  return typedOk ? 'seated' : 'outline';
}

/** The node's freeform points when every row is a finite pair, else null. */
function freeformPoints(node: ComponentNode): [number, number][] | null {
  const raw = node['points'];
  return Array.isArray(raw) && raw.length >= 3 && raw.every((r) => Array.isArray(r) && r.length >= 2
    && Number.isFinite(r[0]) && Number.isFinite(r[1]))
    ? (raw as [number, number][]).map(([x, y]): [number, number] => [x, y])
    : null;
}

/**
 * THE predicate: whether a fin set with a rounded or airfoil section is drawn
 * and printed as the flat prism anyway because it has no single chord at some
 * height (see `sectionChordProblem`), computed on the lobes as SEATED on
 * `mount` with the fin's leading edge at `front` (m from the mount's fore
 * end) — `tree/solidContext.ts`'s `finMount` / `finFront`, the same seat
 * `pieces.ts` draws. Without a mount only the outline as typed is judged.
 * Null for a square section (always the prism) and for trapezoid and
 * elliptical sets (always one chord).
 */
export function finSectionFlatReason(
  node: ComponentNode, mount?: MountSurface, front = 0,
): 'outline' | 'seated' | null {
  if (finSectionLaw(node) === 'square' || node.type !== 'freeformfinset') return null;
  const pts = freeformPoints(node);
  if (!pts) return null;
  const lobes = mount ? finOnMount(pts, front, mount).lobes : [];
  return sectionChordProblem(pts, lobes, mount ? seatedChordPoints(pts, front, mount) : pts);
}
