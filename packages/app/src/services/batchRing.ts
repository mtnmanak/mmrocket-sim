import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { aftLayout } from '../tree/aftLayout.js';
import { mountBore } from '../tree/scaleRocket.js';
import { stageIdByNode } from '../tree/treeModel.js';
import type { BatchMountOption, BatchSplit } from './batchSweep.js';

/** Use the Aft view's actual tube centres, including radial offsets and inherited rotation. */
export function batchRingSplits(tree: RocketTree, targets: readonly BatchMountOption[]): {
  halves: BatchSplit | null; pairs: BatchSplit | null;
} {
  const absent = { halves: null, pairs: null };
  const n = targets.length;
  if (n !== 4 && n !== 6) return absent;
  const nodes = new Map<string, { node: ComponentNode; parent: ComponentNode | undefined }>();
  const walk = (children: ComponentNode[], parent?: ComponentNode) => {
    for (const node of children) {
      if (node.id) nodes.set(node.id, { node, parent });
      walk(node.children ?? [], node);
    }
  };
  walk(tree.components);
  const first = nodes.get(targets[0]!.id);
  if (!first?.parent || first.parent.type !== 'bodytube' && first.parent.type !== 'innertube') return absent;
  const stages = stageIdByNode(tree);
  const stage = stages.get(targets[0]!.id);
  if (stage === undefined || targets.some(m => {
    const found = nodes.get(m.id);
    return !found || found.parent !== first.parent || found.node.type !== 'innertube'
      || m.motorCount !== 1 || found.node['cluster'] !== undefined && found.node['cluster'] !== 'single'
      || stages.get(m.id) !== stage || Math.abs(mountBore(found.node) - mountBore(first.node)) > 0.0005;
  })) return absent;
  const bores = targets.map(m => mountBore(nodes.get(m.id)!.node));
  if (Math.max(...bores) - Math.min(...bores) > 0.0005) return absent;
  const shapes = aftLayout(tree, 0).inner;
  const positions = targets.map(m => {
    const circle = shapes.find(s => s.key === m.id && s.kind === 'circle');
    return circle ? { id: m.id, radius: Math.hypot(circle.y, circle.z),
      angle: (Math.atan2(circle.z, circle.y) + 2 * Math.PI) % (2 * Math.PI) } : null;
  });
  if (positions.some(p => !p)) return absent;
  const sorted = positions.filter(p => p !== null).sort((a, b) => a.angle - b.angle);
  const start = sorted.findIndex(p => p.id === targets[0]!.id);
  const ordered = [...sorted.slice(start), ...sorted.slice(0, start)];
  // Compare the entire radius range, rather than allowing two ends each half a millimetre from a reference.
  if (ordered[0]!.radius <= 0 || Math.max(...ordered.map(p => p.radius)) - Math.min(...ordered.map(p => p.radius)) > 0.0005) return absent;
  const angleError = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  if (ordered.some((p, i) => angleError(p.angle, ordered[0]!.angle + i * 2 * Math.PI / n) > Math.PI / 180 + 1e-12)) return absent;
  const make = (groups: string[][]): BatchSplit => ({ tree, mountIds: groups.map(g => g[0]!),
    mountGroups: groups, groupSize: groups[0]!.length, pattern: n === 4 ? '4-ring' : '6-ring' });
  const halves = make([ordered.filter((_, i) => i % 2 === 0).map(p => p.id), ordered.filter((_, i) => i % 2 === 1).map(p => p.id)]);
  const pairs = n === 6 ? make(ordered.slice(0, 3).map((p, i) => [p.id, ordered[i + 3]!.id])) : null;
  return { halves, pairs };
}
