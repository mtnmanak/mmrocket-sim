import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { isAssembly } from '../tree/assembly.js';
import { num } from '../tree/nodeNum.js';
import { absoluteStations, startFromPosition } from '../tree/position.js';
import { oneLine } from './textFold.js';

/** One nanometre, in metres: ignore arithmetic roundoff, not placement changes. */
export const LEGACY_STATION_TOLERANCE_M = 1e-9;
const CHAIN_TYPES = new Set(['nosecone', 'bodytube', 'transition']);

/** Frozen d9185db^ position.ts axialLength and absoluteStations start walk.
 * Check-only: never use this historical rule to place or rewrite live parts.
 * Preserve its missing-field defaults, including top/0 and 0.025 m length. */
export function historicalStations(tree: RocketTree): Map<string, number> {
  const length = (n: ComponentNode): number => {
    if (n.type === 'freeformfinset') {
      const pts = (n['points'] as [number, number][] | undefined) ?? [];
      return pts.length ? pts[pts.length - 1]![0] : 0.05;
    }
    if (n.type === 'trapezoidfinset' || n.type === 'ellipticalfinset') return num(n, 'rootChord', 0.05);
    if (n.type === 'railbutton') return 0;
    if (isAssembly(n.type)) {
      return (n.children ?? []).filter(c => CHAIN_TYPES.has(c.type)).reduce((s, c) => s + num(c, 'length', 0), 0);
    }
    return num(n, 'length', num(n, 'packedLength', 0.025));
  };
  const out = new Map<string, number>();
  const descend = (parent: ComponentNode, pStart: number, pLen: number): void => {
    for (const child of parent.children ?? []) {
      const len = length(child);
      const pos = child.position ?? { method: 'top', offset: 0 };
      const start = pos.method === 'absolute' ? pos.offset : pStart + startFromPosition(pos, len, pLen);
      if (child.id) out.set(child.id, start);
      descend(child, start, len);
    }
  };
  let x = 0;
  for (const top of tree.components) {
    for (const member of top.type === 'stage' ? top.children ?? [] : [top]) {
      const len = CHAIN_TYPES.has(member.type) ? length(member) : 0;
      if (member.id) out.set(member.id, x);
      descend(member, x, len);
      x += len;
    }
  }
  return out;
}

export interface LegacyPositionCandidate {
  id: string;
  name: string;
  assembly: string;
  oldStartM: number;
  newStartM: number;
}
const nameOf = (node: ComponentNode) => oneLine(typeof node.name === 'string' ? node.name : node.type);

/** Component records inside assemblies, not physical copies or proven damage. */
export function legacyPositionCandidates(tree: RocketTree): LegacyPositionCandidate[] {
  const old = historicalStations(tree);
  const current = absoluteStations(tree);
  const candidates: LegacyPositionCandidate[] = [];
  const visit = (nodes: ComponentNode[], assembly: string | undefined, parentType?: string): void => {
    for (const node of nodes) {
      const oldStartM = node.id ? old.get(node.id) : undefined;
      const newStartM = node.id ? current.get(node.id)?.start : undefined;
      // placeChildren stacks ALL assembly children (even a malformed non-chain
      // child); their own position fields are ignored. Descendants mounted in
      // those children do use the fields that the historical rewrite changed.
      const usesPosition = parentType !== undefined && parentType !== 'stage' && !isAssembly(parentType);
      if (assembly !== undefined && usesPosition && node.id && oldStartM !== undefined && newStartM !== undefined
        && Math.abs(oldStartM - newStartM) > LEGACY_STATION_TOLERANCE_M) {
        candidates.push({ id: node.id, name: nameOf(node), assembly,
          oldStartM, newStartM });
      }
      visit(node.children ?? [], isAssembly(node.type) ? nameOf(node) : assembly, node.type);
    }
  };
  visit(tree.components, undefined);
  return candidates;
}

/** Pending IDs and acknowledgement belong to this autosaved design. Placement
 * provenance additionally survives eligible file/share exports. A writer's
 * version is not placement provenance. Old boolean markers remain unknown. */
type CheckedTree = RocketTree & { legacyPositionCheck?: { pending: string[]; provenance?: 'current' } | true };
function pendingIds(tree: RocketTree): string[] | undefined {
  const state = (tree as CheckedTree).legacyPositionCheck;
  return state && typeof state === 'object' && Array.isArray(state.pending)
    && state.pending.every(id => typeof id === 'string') ? state.pending : undefined;
}

export function pendingLegacyPositions(tree: RocketTree): LegacyPositionCandidate[] {
  const ids = pendingIds(tree);
  if (!ids?.length) return [];
  const pending = new Set(ids);
  return legacyPositionCandidates(tree).filter(part => pending.has(part.id));
}

/** Use only at a known-current creation/import boundary, never on ordinary
 * save. Even then an existing unresolved check takes precedence. */
export function recordCurrentPlacement(tree: RocketTree): RocketTree {
  return { ...tree, legacyPositionCheck: { pending: pendingIds(tree) ?? [], provenance: 'current' } } as CheckedTree;
}

/** Conditional placement stamp, not a last-writer stamp. Unknown legacy trees
 * and unresolved candidates must still be checked after a current writer saves.
 * No candidate means no XML change; import records that clean check in memory. */
export function currentPlacementStamp(tree: RocketTree): string {
  const state = (tree as CheckedTree).legacyPositionCheck;
  return state && typeof state === 'object' && state.provenance === 'current'
    && pendingIds(tree) !== undefined && !pendingLegacyPositions(tree).length
    && legacyPositionCandidates(tree).length ? ' mmrsim-placement="current"' : '';
}

export function legacyPositionNote(parts: LegacyPositionCandidate[]): string | undefined {
  if (!parts.length) return undefined;
  const names = parts.map(part => `“${part.name}” in “${part.assembly}”`).join(', ');
  return `Possible pre-v0.138 position error: ${parts.length} part${parts.length === 1 ? '' : 's'} may need checking: ${names}. `
    + 'This is a check because an app version before v0.138 placed parts inside a pod or strap-on differently. '
    + 'Open the part, compare Position (in parent) / Relative to / Offset with the design you intended, '
    + 'or reopen the file you started from, if you still have it. '
    + 'The saved file may also contain intentional positions; no parts were moved by this check.';
}

export function isLegacyPositionNote(note: string): boolean {
  return note.startsWith('Possible pre-v0.138 position error:');
}

/** Run at each load, independently of the last writer's version. Geometry is
 * never changed. Existing state scopes the note to the original candidate IDs. */
export function checkLegacyPositions(tree: RocketTree, eligible: boolean, notes: string[]): RocketTree {
  if (!eligible) return tree;
  const previous = pendingIds(tree);
  const parts = previous === undefined ? legacyPositionCandidates(tree) : pendingLegacyPositions(tree);
  const note = legacyPositionNote(parts);
  if (note) notes.push(note);
  if (previous === undefined && !parts.length && !(tree as CheckedTree).legacyPositionCheck) return tree;
  const pending = parts.map(part => part.id);
  if (previous && previous.length === pending.length && previous.every((id, i) => id === pending[i])) return tree;
  const state = (tree as CheckedTree).legacyPositionCheck;
  return { ...tree, legacyPositionCheck: { ...(typeof state === 'object' ? state : {}), pending } } as CheckedTree;
}

/** The notice's X persists to this design's browser autosave, including reloads.
 * Reopening a file/share checks afresh. No acknowledgement is exported. */
export function dismissLegacyPositions(tree: RocketTree): RocketTree {
  const state = (tree as CheckedTree).legacyPositionCheck;
  return { ...tree, legacyPositionCheck: { ...(typeof state === 'object' ? state : {}), pending: [] } } as CheckedTree;
}

/** Undo changes the design, not the user's acknowledgement. App resets its
 * history on a new/opened design, so this only carries state within one design. */
export function preserveLegacyPositionCheck(restored: RocketTree, live: RocketTree): RocketTree {
  const pending = pendingIds(live);
  return pending === undefined ? restored : { ...restored, legacyPositionCheck: (live as CheckedTree).legacyPositionCheck } as CheckedTree;
}
