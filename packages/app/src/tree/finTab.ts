import type { ComponentNode } from '@online-openrocket/engine';
import { num } from './nodeNum.js';

/**
 * Through-the-wall fin TAB placement — the one reader every fin output shares:
 * the 2D schematic's dashed tab (components/TreeSchematic.tsx), the printable
 * prism and the DXF contour (solidMesh.finCutOutline).
 *
 * It lives in tree/ rather than beside the schematic that first needed it
 * (audit 2026-09-22): solidMesh.ts — a pure geometry module the STL and DXF
 * exporters are built on — imported it from a React component, which drags
 * React and the whole schematic into anything that wants to cut a fin, and
 * blocks moving the exporters to a worker or a script.
 */

/** Tab front edge from the fin's leading edge (AxialMethod.getAsPosition). */
export function finTabFront(n: ComponentNode, finLen: number): number {
  const offset = num(n, 'tabOffset', 0);
  const tabLen = num(n, 'tabLength', 0);
  const method = typeof n['tabOffsetMethod'] === 'string' ? (n['tabOffsetMethod'] as string) : 'middle';
  if (method === 'top') return offset;
  if (method === 'bottom') return offset + (finLen - tabLen);
  return offset + (finLen - tabLen) / 2;
}
