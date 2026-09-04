/**
 * Freeform fin outline validation — the browser-side copy of the kernel's
 * `FreeformFinSet.intersects()`
 * (engine-java/src/carved/java/info/openrocket/core/rocketcomponent/FreeformFinSet.java:556-607).
 *
 * WHY THIS EXISTS. On the desktop a self-intersecting outline is a non-event:
 * `setPoints` runs `intersects()`, logs a warning and rolls the points back.
 * In the browser it is fatal. The kernel formats that warning with
 *
 *     String.format("                   between (%g, %g) => (%g, %g)", …)
 *
 * and TeaVM's `String.format` implements no `%g` conversion, so it throws
 * `UnknownFormatConversionException: Unknown format conversion: g` straight
 * out of `OrkRocket.buildTree`. App.tsx catches that into an error banner and
 * `built` becomes null: the design loses mass, CG, CP, stability, the stats
 * drawer, every export and both Launch buttons, until the user manually undoes
 * an edit that looked perfectly fine on the canvas. Both file importers already
 * pre-empt the one case they can generate — a repeated tip point on a zero-tip-
 * chord fin (services/rasaeroFile.ts, services/rocksimFile.ts) — and
 * rasaeroFile.test.ts pins that end to end. This module is the same guard for
 * outlines the user edits by hand, which is the path the importers never cover.
 *
 * THE INTERSECTION TEST MUST MATCH THE KERNEL, NOT MERELY APPROXIMATE IT.
 * A stricter test refuses outlines the simulator would have flown; a looser one
 * lets the crash through. So `relativeCcw` below is a transcription of
 * java.awt.geom.Line2D.relativeCCW rather than the usual sign-of-cross-product
 * shortcut: Java resolves the collinear case by projecting onto the segment,
 * which makes two segments that merely TOUCH at an endpoint count as
 * intersecting. That is exactly how a duplicated point crashes the build — the
 * zero-length edge it creates leaves edges i-1 and i+1 sharing a point while
 * still being 2 apart in index, so the kernel's "adjacent edges can't
 * intersect" skip does not apply to them.
 */

export type FinOutlinePoint = readonly [number, number];

/** FreeformFinSet.java:25 — the kernel's own "same point" epsilon. */
const IGNORE_SMALLER_THAN = 1e-12;

/**
 * Two points closer than this (metres) are treated as one. 1 nm is far below
 * anything reachable through the UI: the coordinate table rounds the DISPLAY
 * unit to 4 decimals, which is 1e-7 m even in millimetres, so no two rows a
 * user can type land inside this window unless they are meant to be identical.
 */
const COINCIDENT_M = 1e-9;

/** java.awt.geom.Line2D.relativeCCW, transcribed. */
function relativeCcw(
  x1: number, y1: number, x2: number, y2: number, px: number, py: number,
): number {
  let dx2 = x2 - x1;
  let dy2 = y2 - y1;
  let dpx = px - x1;
  let dpy = py - y1;
  let ccw = dpx * dy2 - dpy * dx2;
  if (ccw === 0) {
    // Colinear: classify by the projection onto the segment, so a point
    // BEYOND either end reads as off-segment rather than as "on the line".
    ccw = dpx * dx2 + dpy * dy2;
    if (ccw > 0) {
      dpx -= dx2;
      dpy -= dy2;
      ccw = dpx * dx2 + dpy * dy2;
      if (ccw < 0) ccw = 0;
    }
  }
  return ccw < 0 ? -1 : ccw > 0 ? 1 : 0;
}

/** java.awt.geom.Line2D.linesIntersect, transcribed. Touching counts. */
function linesIntersect(a: FinOutlinePoint, b: FinOutlinePoint,
                        c: FinOutlinePoint, d: FinOutlinePoint): boolean {
  return relativeCcw(a[0], a[1], b[0], b[1], c[0], c[1])
       * relativeCcw(a[0], a[1], b[0], b[1], d[0], d[1]) <= 0
    && relativeCcw(c[0], c[1], d[0], d[1], a[0], a[1])
       * relativeCcw(c[0], c[1], d[0], d[1], b[0], b[1]) <= 0;
}

/**
 * The first self-intersection the kernel would find, as the two edge indices
 * (0-based, edge i is points[i] -> points[i+1]), or null if there is none.
 * Same loop bounds, same 2-apart skip and same co-located-endpoints exemption
 * as FreeformFinSet.intersects().
 */
export function finOutlineIntersection(
  points: readonly FinOutlinePoint[],
): { target: number; comparison: number } | null {
  for (let target = 0; target < points.length - 1; target++) {
    const t1 = points[target]!;
    const t2 = points[target + 1]!;
    for (let comparison = target + 1; comparison < points.length - 1; comparison++) {
      // A segment never intersects itself, and neighbouring segments always
      // share an endpoint, so the kernel skips index pairs less than 2 apart.
      if (Math.abs(target - comparison) < 2) continue;
      const c1 = points[comparison]!;
      const c2 = points[comparison + 1]!;
      // The kernel's one exemption: a fin whose first and last points are
      // co-located closes on itself legitimately.
      if (target === 0 && points.length === comparison + 2
        && Math.hypot(t1[0] - c2[0], t1[1] - c2[1]) < IGNORE_SMALLER_THAN) continue;
      if (linesIntersect(t1, t2, c1, c2)) return { target, comparison };
    }
  }
  return null;
}

/**
 * Why an outline cannot be used, in words for the user, or null when it is
 * fine. Checks, in the order a user is most likely to hit them:
 *
 *  - fewer than 3 points, or a coordinate that is not a finite number
 *  - two consecutive points in the same place (the zero-length edge that the
 *    kernel reports as a self-intersection, i.e. the %g crash above)
 *  - a root chord that is not positive — the kernel defines a freeform fin's
 *    length as `points[last].x - points[0].x` (FreeformFinSet.update():447 and
 *    clampFirstPoint():493), so a trailing corner at or forward of the leading
 *    one gives a fin of zero or negative length
 *  - a self-intersecting outline
 */
export function finOutlineProblem(
  points: readonly FinOutlinePoint[] | undefined | null,
): string | null {
  if (!points || points.length < 3) return 'A fin outline needs at least 3 points.';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      return `Point ${i + 1} is not a pair of numbers.`;
    }
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= COINCIDENT_M) {
      return `Points ${i} and ${i + 1} are in the same place — move one of them or delete it.`;
    }
  }
  const root = points[points.length - 1]![0] - points[0]![0];
  if (!(root > 0)) {
    return 'The last point must be aft of the first — the fin would have no root chord.';
  }
  const hit = finOutlineIntersection(points);
  if (hit) {
    return `The outline crosses itself — edge ${hit.target + 1}–${hit.target + 2} meets `
      + `edge ${hit.comparison + 1}–${hit.comparison + 2}.`;
  }
  return null;
}

/** Convenience wrapper for callers that only need yes/no. */
export function isValidFinOutline(points: readonly FinOutlinePoint[] | undefined | null): boolean {
  return finOutlineProblem(points) === null;
}
