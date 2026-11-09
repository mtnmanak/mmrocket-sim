import type { ComponentNode } from '@online-openrocket/engine';
import { clusterCount, clusterOffsets } from './cluster.js';
import { kernelNum } from './kernelDefaults.js';
import { num } from './nodeNum.js';
import { axialLength, positionOf, startFromPosition } from './position.js';

/** Inner-tube sections in the containing parent's frame, including nested tubes. */
export function innerTubeSections(node: ComponentNode, parentLength: number, origin = { x: 0, y: 0, z: 0 }) {
  const sections: { start: number; end: number; y: number; z: number; r: number; clustered?: true }[] = [];
  const visit = (n: ComponentNode, pLen: number, p: typeof origin, ancestorClustered = false) => {
    const length = axialLength(n);
    const start = p.x + startFromPosition(positionOf(n), length, pLen);
    const r = kernelNum(n, 'outerRadius');
    const rp = n.type === 'innertube' ? num(n, 'radialPosition', 0) : 0;
    const rd = n.type === 'innertube' ? num(n, 'radialDirection', 0) : 0;
    const clustered = ancestorClustered || (n.type === 'innertube' && clusterCount(n['cluster'] as string | undefined) > 1);
    const offsets = n.type === 'innertube' ? clusterOffsets(n['cluster'] as string | undefined, r,
      num(n, 'clusterScale', 1), num(n, 'clusterRotation', 0), { radialDirection: rd }) : [{ y: 0, z: 0 }];
    for (const off of offsets) {
      const y = p.y + rp * Math.cos(rd) + off.y, z = p.z + rp * Math.sin(rd) + off.z;
      if (n.type === 'innertube') sections.push({ start, end: start + length, y, z, r, ...(clustered ? { clustered: true as const } : {}) });
      for (const child of n.children ?? []) {
        if (child.type === 'innertube' || child.type === 'tubecoupler') visit(child, length, { x: start, y, z }, clustered);
      }
    }
  };
  visit(node, parentLength, origin);
  return sections;
}
