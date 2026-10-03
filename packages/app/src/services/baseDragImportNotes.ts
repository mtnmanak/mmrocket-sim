import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { absoluteStations, type AbsoluteStation } from '../tree/position.js';

const hint = /base[\s-]*drag|\bBD\b|drag[\s-]*cone|\bvirtual\b/i;
const finite = (n: ComponentNode, key: string): number | undefined => {
  const v = n[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const aftRadius = (n: ComponentNode): number | undefined =>
  finite(n, n.type === 'bodytube' ? 'outerRadius' : 'aftRadius');

/** Component-local provenance only; never a mass or aerodynamic override. */
export const BASE_DRAG_DECLARATION = 'mmrBaseDragDeclaration';
export const BASE_DRAG_DECLARATION_TAG = 'mmrbasedragdeclaration';

/** Advisory only. The corpus's Gizmo transitions use 25.4 nm walls, NOT mass overrides.
 * CDX1 has no component mass/wall/name data: require an explicit declaration in its
 * design comments, never infer a massless part from the importer's default material.
 */
function baseDragCandidates(tree: RocketTree, description = '') {
  const declared = /(?:massless|virtual)[^\r\n]{0,80}base[\s-]*drag|base[\s-]*drag[^\r\n]{0,80}(?:massless|virtual)/i.test(description);
  const frames = new Map<string | null, AbsoluteStation[]>();
  for (const s of absoluteStations(tree).values()) {
    if (!['nosecone', 'transition', 'bodytube'].includes(s.node.type)) continue;
    // Only exterior chains, not an internal ring/coupler or a mass component.
    if (s.parent && !['podset', 'parallelstage'].includes(s.parent.type)) continue;
    const key = s.parent?.id ?? null;
    const chain = frames.get(key) ?? [];
    chain.push(s);
    frames.set(key, chain);
  }
  const candidates: { node: ComponentNode; evidence: string; declared: boolean }[] = [];
  for (const chain of frames.values()) {
    if (chain.length < 2) continue;
    const tail = chain[chain.length - 1]!;
    const previous = chain[chain.length - 2]!;
    const n = tail.node;
    if (tail.start < previous.end - 1e-9 || !(tail.end > tail.start)) continue;
    const radius = aftRadius(n), bodyRadius = aftRadius(previous.node);
    if (!(radius !== undefined && radius > 0 && bodyRadius !== undefined && bodyRadius > 0)) continue;
    const fore = n.type === 'nosecone' && n['flipped'] !== true ? 0 : finite(n, 'foreRadius');
    const expanding = (n.type === 'nosecone' || n.type === 'transition')
      && fore !== undefined && radius > fore && n['flipped'] !== true;
    const detachedTip = expanding && fore <= bodyRadius * 0.1;
    // Tubes have zero normal-force slope at zero AoA, even when disk-like.
    // Their finite-AoA body lift alone is not evidence of a virtual CP-shifting cone.
    if (!expanding) continue; // Also excludes real shrinking boattails.
    const mass = finite(n, 'overrideMass');
    const massless = mass !== undefined && mass >= 0 && mass <= 1e-6; // kg: at most 1 mg
    const named = hint.test(n.name ?? '');
    const wall = finite(n, 'thickness');
    // ORK omits filled for hollow shells; the kernel defaults it to false.
    const ghostWall = mass === undefined && named && n['filled'] !== true
      && wall !== undefined && wall >= 0 && wall <= 1e-7; // m: <= 0.1 micrometre
    const declaredPart = (declared || n[BASE_DRAG_DECLARATION] === true)
      && detachedTip && mass === undefined;
    const evidence = massless && (named || finite(n, 'overrideCD') === 0 || detachedTip)
      ? 'an approximately zero mass override'
      : ghostWall ? 'an extremely thin shell and a base-drag-related name'
        : declaredPart ? 'a virtual base-drag model described in the file comments' : null;
    if (!evidence) continue;
    candidates.push({ node: n, evidence, declared: declaredPart });
  }
  return candidates;
}

/** Retain CDX1 comment evidence on matching parts, so deleting the part also
 * deletes its declaration. Geometry/override checks still apply on every import. */
export function retainBaseDragDeclaration(tree: RocketTree, description: string): void {
  for (const candidate of baseDragCandidates(tree, description)) {
    if (candidate.declared) candidate.node[BASE_DRAG_DECLARATION] = true;
  }
}

export function baseDragImportNotes(tree: RocketTree): string[] {
  return baseDragCandidates(tree).map(({ node: n, evidence }) =>
    `Possible base-drag model: “${n.name ?? n.type}” is an aft ${n.type}
with ${evidence}. If this is a virtual part rather than part of the real rocket, its aerodynamic contribution
can move the center of pressure (CP) aft and so can overstate the stability margin of the real airframe.
The app keeps it as the file describes. To model the real airframe without it, use Delete on this part in the
component tree, then run the simulation again.`.replace(/\n/g, ' '));
}
