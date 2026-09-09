import type { ComponentNode } from '@online-openrocket/engine';

/**
 * Read a numeric geometry field off a component node — the ONE reader.
 *
 * There were twelve copies of this before 2026-09-08, and eleven of them wrote
 * the test as `typeof n[key] === 'number'`. That is true of **NaN**, so a NaN
 * stored on a node was passed through as a number by every geometry module
 * except two. What that cost, measured:
 *
 *  - A nose cone with a NaN radius produced 3,072 triangles, **all** of them
 *    with non-finite vertices, and `piecesToStl` wrote a 153,684-byte STL of
 *    NaN facets with no throw and no warning. The radius floor meant to stop
 *    exactly this — `Math.max(0.0001, r)` — does not, because
 *    `Math.max(0.0001, NaN)` is NaN.
 *  - Those vertices reach three.js, where a NaN bounding sphere breaks frustum
 *    culling and raycast picking, so the part cannot even be clicked.
 *
 * `scaleRocket.ts` and one reader in `treeModel.ts` had it right and returned
 * null on a non-finite value, which is why a NaN survived scaling untouched
 * while every other module propagated it. Two behaviours for one question is
 * how that stayed invisible.
 *
 * A NaN is not a number the geometry layer can use, so it falls back exactly as
 * a missing field does. Where a caller genuinely needs to tell "absent" from
 * "present but unusable" it should read `node[key]` itself — no caller does.
 *
 * Not exported from a barrel and not re-implemented locally: import it. The
 * whole point is that there is one.
 */
export function num(n: ComponentNode, key: string, fb: number): number {
  const v = n[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
}

/** `num` for a field whose absence is meaningful — same finiteness rule. */
export function numOpt(n: ComponentNode, key: string): number | undefined {
  const v = n[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * `num` returning null rather than a fallback, for callers that branch on
 * "is there a usable number here at all" — `scaleRocket`'s field walk and
 * `treeModel`'s radial reader, which both had this shape already.
 */
export function numOrNull(n: ComponentNode, key: string): number | null {
  const v = n[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
