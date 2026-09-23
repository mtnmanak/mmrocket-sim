import type { ComponentNode } from '@online-openrocket/engine';
import { num } from './nodeNum.js';

/**
 * Fin ROOT CHORD and through-the-wall TAB placement — the one reader every fin
 * output shares: the 2D schematic's dashed tab (components/TreeSchematic.tsx),
 * the printable prism and the DXF contour (solidMesh.finCutOutline), and the
 * paper cut template (services/finTemplate.ts). A template that disagrees with
 * the cut file is worse than either, so they read these numbers from here
 * rather than each deriving them from the outline.
 *
 * It lives in tree/ rather than beside the schematic that first needed it
 * (audit 2026-09-22): solidMesh.ts — a pure geometry module the STL and DXF
 * exporters are built on — imported it from a React component, which drags
 * React and the whole schematic into anything that wants to cut a fin, and
 * blocks moving the exporters to a worker or a script.
 */

const EPS = 1e-9;
/** A closing point this close to the first counts as a repeat of it (m). */
const SAME_POINT = 1e-7;

/**
 * The fin's ROOT CHORD (m) — the kernel's `length`, the span of the root edge
 * on y = 0 that the tab is stationed along.
 *
 * Trapezoid and elliptical: `rootChord`. Freeform: the LAST point's x — the
 * kernel's own definition (FreeformFinSet.java:494 and :546, `this.length =
 * points.get(lastIndex).x`), read after dropping a closing point that repeats
 * the first, exactly as finCutOutline trims it (a closed list would otherwise
 * read 0).
 *
 * It is NEVER the maximum x of the outline. That is the drawn EXTENT, and it
 * differs from the chord whenever the tip overhangs the root: a trapezoid with
 * sweep + tip > root, or a freeform tip corner FinPointsEditor lets you drag
 * aft of the root's. The paper template took max-x for a trapezoid until the
 * 2026-09-22 audit — root 100 / tip 50 / sweep 80 mm printed "root 130.0 mm"
 * and drew its middle tab at 35-95 mm, where the STL and DXF cut it at 20-80.
 */
export function finRootChord(node: ComponentNode): number {
  if (node.type !== 'freeformfinset') return num(node, 'rootChord', 0.05);
  const raw = node['points'];
  if (!Array.isArray(raw)) return 0;
  const pts = raw.filter((p): p is [number, number] =>
    Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  while (pts.length > 1) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (Math.abs(a[0] - b[0]) <= SAME_POINT && Math.abs(a[1] - b[1]) <= SAME_POINT) pts.pop();
    else break;
  }
  return pts.length > 0 ? Math.max(0, pts[pts.length - 1]![0]) : 0;
}

/** Tab front edge from the fin's leading edge (AxialMethod.getAsPosition). */
export function finTabFront(n: ComponentNode, finLen: number): number {
  const offset = num(n, 'tabOffset', 0);
  const tabLen = num(n, 'tabLength', 0);
  const method = typeof n['tabOffsetMethod'] === 'string' ? (n['tabOffsetMethod'] as string) : 'middle';
  if (method === 'top') return offset;
  if (method === 'bottom') return offset + (finLen - tabLen);
  return offset + (finLen - tabLen) / 2;
}

/**
 * The tab as it is CUT: [x0, x1] along the root (m from the leading edge) and
 * its depth below the root line, or null when there is no tab to cut.
 *
 * Clamped into [0, rootLen] — a tab offset past either end of the root is cut
 * at that end, and one pushed entirely off it is dropped rather than smeared.
 * That is the rule the STL prism and the DXF contour have always applied
 * (solidMesh.finCutOutline); the paper template drew the tab unclamped until
 * the 2026-09-22 audit, so a tab hanging off the leading edge printed longer
 * than the part the cut files made.
 */
export function finTabSpan(
  node: ComponentNode, rootLen: number,
): { x0: number; x1: number; depth: number } | null {
  const depth = num(node, 'tabHeight', 0);
  const len = num(node, 'tabLength', 0);
  if (!(depth > EPS && len > EPS && rootLen > EPS)) return null;
  const front = finTabFront(node, rootLen);
  const x0 = Math.min(Math.max(front, 0), rootLen);
  const x1 = Math.min(Math.max(front + len, 0), rootLen);
  return x1 - x0 > EPS ? { x0, x1, depth } : null;
}
