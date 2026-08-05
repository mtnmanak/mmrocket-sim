import type { ComponentNode, RocketTree } from '@online-openrocket/engine';

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

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

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

/** Shoelace area of the fin outline (points are [x along body, y off surface], m). */
function outlineArea(pts: [number, number][]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Builds the fairing node a candidate freeform set becomes (same id/position). */
export function shroudToFairing(n: ComponentNode): ComponentNode {
  const pts = (n['points'] as [number, number][] | undefined) ?? [];
  const length = pts.length ? Math.max(...pts.map((p) => p[0])) : 0.08;
  const height = pts.length ? Math.max(...pts.map((p) => p[1])) : 0.02;
  const width = num(n, 'thickness', 0.025);
  const override = n['overrideMass'];
  const mass = typeof override === 'number' && override > 0
    ? override
    : outlineArea(pts) * width * num(n, 'density', 680);
  const out: ComponentNode = {
    type: 'fairing',
    id: n.id,
    name: n.name ?? 'Camera shroud',
    length,
    width,
    height,
    fairingShape: 'halfround',
    mass,
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
