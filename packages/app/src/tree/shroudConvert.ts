import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finOutlineIntersection } from './finOutline.js';
import { num } from './nodeNum.js';
import { signedArea } from './polygon.js';

/**
 * Hand-rolled camera shrouds (issue 2026-08-05e): RockSim has no shroud
 * component, so builders model them as 1-fin freeform sets named "Camera
 * Shroud" or similar. On import we detect those and offer to convert them to
 * the native `fairing` component (v0.034) — which carries the Hoerner
 * protuberance drag + slender-strake CP model instead of pretending to be a
 * lifting fin.
 */

export interface ShroudCandidate {
  id: string;
  name: string;
}

const NAME_RE = /shroud|camera|fairing/i;


/** 1-fin freeform sets whose name reads like a shroud/camera cover. */
export function findShroudCandidates(tree: RocketTree): ShroudCandidate[] {
  const out: ShroudCandidate[] = [];
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      if (
        n.type === 'freeformfinset'
        && Math.round(num(n, 'finCount', 3)) === 1
        && n.id
        && NAME_RE.test(n.name ?? '')
      ) {
        out.push({ id: n.id, name: n.name ?? 'Camera shroud' });
      }
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
  return out;
}

/**
 * The side-profile area the mass estimate uses, m² (points are [x along body,
 * y off surface], m): the outline's own area when it is a simple polygon,
 * else the box it spans.
 *
 * A crossed outline — a planform dragged until two edges cross — has a
 * shoelace area of ZERO (its lobes cancel), and until audit 2026-09-22 that
 * converted to a 0 kg fairing: the rocket silently lost its camera's mass.
 * The kernel refuses a crossed fin outline anyway, so converting is how such
 * a design gets back to building; the box is an upper bound (twice a bow-tie's
 * lobes), which the conversion note already tells the user to check. The same
 * box stands in when there is no outline to measure at all.
 */
function profileArea(pts: [number, number][], length: number, height: number): number {
  // The closing edge (back along the root) is part of the polygon the area is
  // of, so it is checked too — finOutlineIntersection, like the kernel, tests
  // only the edges between the listed points.
  const simple = pts.length >= 3 && finOutlineIntersection([...pts, pts[0]!]) === null;
  const area = simple ? Math.abs(signedArea(pts)) : 0;
  return area > 0 ? area : length * height;
}

/** Builds the fairing node a candidate freeform set becomes (same id/position). */
export function shroudToFairing(n: ComponentNode): ComponentNode {
  const pts = (n['points'] as [number, number][] | undefined) ?? [];
  // EXTENTS, not maxima: Math.max over y read an outline drawn below its root
  // line as a NEGATIVE height (audit 2026-09-22). For an outline that starts
  // at the origin with its root on y = 0 — every one the kernel accepts — the
  // extent IS the maximum, so no valid shroud moves.
  const extent = (k: 0 | 1) => Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k]));
  const length = pts.length ? extent(0) : 0.08;
  const height = pts.length ? extent(1) : 0.02;
  const width = num(n, 'thickness', 0.025);
  const override = n['overrideMass'];
  const mass = typeof override === 'number' && override > 0
    ? override
    : profileArea(pts, length, height) * width * num(n, 'density', 680);
  const out: ComponentNode = {
    type: 'fairing',
    id: n.id,
    name: n.name ?? 'Camera shroud',
    length,
    width,
    height,
    // A one-fin shroud in a .rkt carries no end-shape information, so these are
    // defaults and must be THE SAME defaults a new shroud is born with — see
    // END_SHAPES in schema.ts.
    fairingForeShape: 'streamlined',
    fairingAftShape: 'box',
    conformal: true,
    mass,
    // THE CLOCKING SURVIVES THE CONVERSION. A fin set stores its angle about
    // the body axis as `rotation` (the kernel's baseRotation — rocksimFile.ts
    // writes it from RockSim's <RadialAngle>, orkFile.ts from .ork <rotation>),
    // and every surface-mounted part stores the same angle as `angleOffset`
    // (schema.ts MOUNT_ANGLE). Both are radians about the body axis with the
    // same zero, so this is a rename, not a conversion. Without it a shroud a
    // builder had deliberately clocked to, say, 60° — between the fins, which
    // is where a camera goes — was relocated to 0°, which schema.ts's MOUNT_ANGLE
    // note calls out as precisely where an unrotated fin set puts fin 1: all
    // three views redrew the camera on the fin line, mountAngle's rail and wake
    // warnings started or stopped firing on a part nobody had moved, and the
    // next save persisted the 0.
    angleOffset: num(n, 'rotation', 0),
    position: n.position ?? { method: 'middle', offset: 0 },
  } as ComponentNode;
  if (typeof n['finish'] === 'string') out['finish'] = n['finish'];
  if (typeof n['color'] === 'string') out['color'] = n['color'];
  return out;
}

export interface ShroudConvertResult {
  tree: RocketTree;
  notes: string[];
}

/** Replaces the candidate sets (by id) with native fairing nodes, in place in the tree. */
export function convertShrouds(tree: RocketTree, ids: string[]): ShroudConvertResult {
  const wanted = new Set(ids);
  const notes: string[] = [];
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes.map((n) => {
      const kids = n.children ? walk(n.children) : undefined;
      let next = kids === n.children ? n : ({ ...n, children: kids } as ComponentNode);
      if (n.id && wanted.has(n.id)) {
        const fairing = shroudToFairing(n);
        if (kids?.length) fairing.children = kids;
        notes.push(
          `Converted “${fairing.name}” to a native camera shroud `
          + `(${Math.round((fairing['length'] as number) * 1000)}×${Math.round((fairing['width'] as number) * 1000)}`
          + `×${Math.round((fairing['height'] as number) * 1000)} mm, `
          + `${Math.round((fairing['mass'] as number) * 1000)} g — check mass/shape in its properties).`,
        );
        next = fairing;
      }
      return next;
    });
  return { tree: { ...tree, components: walk(tree.components) }, notes };
}
