import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { num, numOpt } from './nodeNum.js';
import { axialLength, startFromPosition } from './position.js';
import { outerProfile } from './shapeProfile.js';
import type { SolidContext } from './solidMesh.js';

/**
 * Parent-derived diameters for the printable (STL) and cuttable (DXF) exports
 * of ONE component: rings, bulkheads, couplers and engine blocks size to the
 * bore they sit in, a centering ring's own bore comes from the inner tubes it
 * overlaps (`overlappingTubeRadius`), and a tube-fin set sizes to its body.
 * Both exporters read this SAME context, or the printed and the machined
 * version of one part would come out different sizes.
 *
 * THE BORE IS RESOLVED THE WAY THE KERNEL RESOLVES AN AUTOMATIC RADIUS
 * (audit 2026-09-22). This used to live in PropertyPanel.tsx and set the bore
 * only when the parent carried a numeric `outerRadius`. A coupler from the Add
 * menu stores `{length, thickness}` and never does — its radius is automatic —
 * and neither does a nose cone or a transition. So the standard av-bay layout,
 * a bulkhead inside a coupler, exported a 24.0 mm disc labelled plainly
 * "Bulkhead" whatever the airframe diameter, while the kernel flew the right
 * size. Now, per RadiusRingComponent/ThicknessRingComponent.getOuterRadius
 * (a part with an automatic radius takes its RadialParent's inner radius at
 * BOTH of its ends, clamped into the parent, and keeps the smaller):
 *
 *  - body tube / inner tube: outer radius less the wall, as before;
 *  - coupler: its OWN outer radius when it states one (a catalogue or
 *    imported part), else — automatic — the bore of ITS parent at the
 *    coupler's station; less its wall either way;
 *  - nose cone / transition: the profile's radius at the part's station,
 *    less the wall — except a transition radius left automatic, which the
 *    kernel takes from the neighbouring part and this does not resolve.
 *
 * Anything else leaves the bore unset, and the exporters then label the part
 * "(assumed size)" and say so under the 🖨 button rather than printing a
 * placeholder disc as if it were measured.
 */
export function solidContextFor(tree: RocketTree, node: ComponentNode): SolidContext {
  const ctx: SolidContext = {};
  const chain = node.id ? ancestry(tree, node.id) : null;
  const parent = chain?.[0];
  if (!parent) return ctx;
  const bore = boreAt(chain, 0, node);
  if (bore !== undefined) ctx.parentInnerRadius = bore;
  const pOuter = numOpt(parent, 'outerRadius');
  if (pOuter !== undefined) ctx.bodyRadius = pOuter;
  const mountOuter = overlappingTubeRadius(parent, node);
  if (mountOuter !== undefined) ctx.mountOuterRadius = mountOuter;
  return ctx;
}

/**
 * The bore an AUTOMATIC centering ring takes, as `CenteringRing.getInnerRadius`
 * finds it: the largest outer radius among the inner tubes beside the part
 * that overlap it axially — touching at an end counts, since the kernel skips
 * a tube only when the part ends before it starts or starts after it ends —
 * and none when no tube does (the kernel then flies a solid disc, and the
 * exports say the bore is assumed). Stations are in the parent's frame, as
 * `boreAt` reads them; the kernel compares the same two positions.
 *
 * This took the FIRST inner tube in the parent wherever it sat (audit
 * 2026-09-30), so a forward ring around an 18 mm payload tube printed and cut
 * with the bore of the 29 mm motor mount listed before it — and `.ork` writes
 * `auto` for every automatic ring, so that was the common case.
 */
function overlappingTubeRadius(parent: ComponentNode, node: ComponentNode): number | undefined {
  const pLen = axialLength(parent);
  const span = (n: ComponentNode): [number, number] => {
    const len = axialLength(n);
    const start = startFromPosition((n.position ?? { method: 'top', offset: 0 }) as ComponentPosition, len, pLen);
    return [start, start + len];
  };
  const [fore, aft] = span(node);
  let widest: number | undefined;
  for (const tube of parent.children ?? []) {
    if (tube.type !== 'innertube' || tube === node) continue;
    const [tubeFore, tubeAft] = span(tube);
    if (aft < tubeFore || fore > tubeAft) continue;
    const r = numOpt(tube, 'outerRadius');
    if (r !== undefined) widest = Math.max(widest ?? r, r);
  }
  return widest;
}

/** The node's ancestors, nearest first (stage last), or null if it is not in the tree. */
function ancestry(tree: RocketTree, id: string): ComponentNode[] | null {
  const walk = (nodes: ComponentNode[], path: ComponentNode[]): ComponentNode[] | null => {
    for (const n of nodes) {
      if (n.id === id) return [...path].reverse();
      const hit = walk(n.children ?? [], [...path, n]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree.components, []);
}

/**
 * Inner radius (m) of `chain[i]` over the axial span `child` occupies inside
 * it, or undefined when it cannot be resolved. `chain[i + 1]` is that host's
 * own parent, which an automatic-radius coupler needs.
 */
function boreAt(chain: ComponentNode[], i: number, child: ComponentNode): number | undefined {
  const host = chain[i];
  if (!host) return undefined;
  switch (host.type) {
    case 'nosecone':
    case 'transition': {
      // A field the node omits reads the kernel bridge's own default
      // (ComponentFactory: nose 70 mm long, 12 mm aft radius, ogive; transition
      // 50 mm, conical; 2 mm wall), or "the way the kernel resolves it" is not
      // true of a hand-built or share-link tree. A transition radius it omits is
      // AUTOMATIC there — taken from the neighbouring part — and is not read as
      // 0 here: that came out 17.2 mm where the kernel flies 18.0, unflagged.
      // Unresolved, the part is labelled "(assumed size)" instead.
      const nose = host.type === 'nosecone';
      const L = num(host, 'length', nose ? 0.07 : 0.05);
      const foreR = nose ? 0 : numOpt(host, 'foreRadius');
      const aftR = nose ? num(host, 'aftRadius', 0.012) : numOpt(host, 'aftRadius');
      if (foreR === undefined || aftR === undefined) return undefined;
      const wall = Math.max(num(host, 'thickness', 0.002), 0);
      const len = axialLength(child);
      const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
      const x0 = Math.min(Math.max(startFromPosition(pos, len, L), 0), L);
      const x1 = Math.min(Math.max(startFromPosition(pos, len, L) + len, 0), L);
      const shape = typeof host['shape'] === 'string' ? (host['shape'] as string) : nose ? 'ogive' : 'conical';
      const param = numOpt(host, 'shapeParameter');
      const clipped = typeof host['clipped'] === 'boolean' ? (host['clipped'] as boolean) : undefined;
      // Exact samples AT the two ends (outerProfile's extraX), not the nearest
      // of the curve's regular steps.
      const prof = outerProfile(shape, param, L, foreR, aftR, 1, [x0, x1], clipped);
      const rAt = (x: number) => prof.find(([px]) => Math.abs(px - x) <= 1e-9)?.[1];
      const r0 = rAt(x0);
      const r1 = rAt(x1);
      if (r0 === undefined || r1 === undefined) return undefined;
      const r = Math.min(r0, r1) - wall;
      return Number.isFinite(r) && r > 0 ? r : undefined;
    }
    case 'tubecoupler': {
      // Automatic unless it states its own: the kernel bridge sets
      // outerRadiusAutomatic exactly when the node has no outerRadius.
      const outer = numOpt(host, 'outerRadius') ?? boreAt(chain, i + 1, host);
      if (outer === undefined) return undefined;
      const r = outer - Math.max(num(host, 'thickness', 0.0005), 0);
      return r > 0 ? r : undefined;
    }
    default: {
      // Body tube, inner tube, and any other parent stating an outer radius:
      // unchanged from the rule this replaced, 0.5 mm floor included.
      const outer = numOpt(host, 'outerRadius');
      if (outer === undefined) return undefined;
      return Math.max(0.0005, outer - num(host, 'thickness', 0.001));
    }
  }
}
