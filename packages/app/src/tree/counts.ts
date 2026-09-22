import type { ComponentNode } from '@online-openrocket/engine';
import { num } from './nodeNum.js';
import { KERNEL_MAX_FINS, KERNEL_MAX_LINE_INSTANCES, MAX_ASSEMBLY_INSTANCES } from './schema.js';

/**
 * How many copies of a part the app DRAWS — read the same way by every view,
 * and never more than the kernel flies (audit 2026-09-22).
 *
 * Every renderer used to loop the raw stored number. The kernel clamps fins to
 * 8 and the bridge clamps line instances to 64, so a count above that was drawn
 * as N and flown as the ceiling; and a hostile one was fatal to the drawing
 * itself, as the audit measured: a .rkt FinCount of 70,000 made the side view's
 * `Math.min(...ys)` spread throw RangeError (unmounting the whole app into the
 * "Something went wrong" panel), a TubeCount of 100,000 held `buildPieces` for
 * 19.3 s, and a lug `instancecount` of 20,000 produced 2.0 M vertices. The
 * sanitize pass keeps a loaded tree inside these limits and the property panel
 * refuses to go past them, which is what keeps the exporters (which read the
 * node itself) honest; these readers are the guarantee that nothing stored can
 * DRAW more.
 *
 * Rounded, where the bridge truncates (`(int) dbl(node, …)`): the stored value
 * is a whole number in practice (the .ork reader and the panel both round, and
 * the sanitize pass rounds anything else), so the two only differ for a count
 * no path writes.
 */

/**
 * A fin set's fin (or tube) count, 1..KERNEL_MAX_FINS. An absent count is the
 * bridge's own default — 6 for tube fins, 3 otherwise (ComponentFactory's
 * `dbl(node, "finCount", 6)` / `3`) — which is also what `defaultParams` gives
 * a new set.
 */
export function finCountOf(n: ComponentNode): number {
  const raw = Math.round(num(n, 'finCount', n.type === 'tubefinset' ? 6 : 3));
  return Math.min(KERNEL_MAX_FINS, Math.max(1, raw));
}

/**
 * Collinear copies of a launch lug or rail button, 1..KERNEL_MAX_LINE_INSTANCES
 * — the clamp `ComponentFactory.applyLineInstances` applies before the kernel
 * sees it. Absent is one.
 */
export function lineInstanceCount(n: ComponentNode): number {
  const raw = Math.round(num(n, 'instanceCount', 1));
  return Math.min(KERNEL_MAX_LINE_INSTANCES, Math.max(1, raw));
}

/**
 * Copies of a pod set or booster around the body, 1..MAX_ASSEMBLY_INSTANCES.
 * Absent is two, `defaultParams('podset' | 'parallelstage')` and the bridge's
 * `dbl(node, "instanceCount", 2)` alike.
 */
export function assemblyInstanceCount(n: ComponentNode): number {
  const raw = Math.round(num(n, 'instanceCount', 2));
  return Math.min(MAX_ASSEMBLY_INSTANCES, Math.max(1, raw));
}
