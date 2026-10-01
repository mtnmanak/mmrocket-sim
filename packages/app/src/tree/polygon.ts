/**
 * Signed area of a closed polygon — the shoelace formula — in the square of
 * the points' unit: positive when the points run counter-clockwise, and the
 * closing edge (last point back to the first) implied.
 *
 * THE ONE COPY (audit 2026-09-22, from the 8 September record): solidMesh's
 * winding test and shroudConvert's mass estimate each carried their own.
 *
 * Meaningful only for a SIMPLE polygon. On one that crosses itself the lobes
 * wind opposite ways and cancel — a bow-tie reads as 0 — so a caller that
 * needs an AREA, rather than a winding, must rule that out first.
 * shroudToFairing does it with the kernel's own test
 * (finOutline.finOutlineIntersection, which checks the listed edges only),
 * and treats an area of exactly zero as unmeasurable too.
 */
export function signedArea(loop: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i]!;
    const [x1, y1] = loop[(i + 1) % loop.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/**
 * Whether a closed outline encloses any area at all: false when its points lie
 * on one line, exactly or to within the rounding of the shoelace sum. The
 * tolerance scales with the outline's bounding box, so no unit is assumed, and
 * an outline flat along an axis (a fin at height 0) has a box of no area and
 * reads false on the exact zero.
 *
 * Not a test of simplicity: a crossed outline whose lobes cancel reads false
 * too, which is the answer a caller about to extrude it wants.
 */
export function enclosesArea(loop: ReadonlyArray<readonly [number, number]>): boolean {
  if (loop.length < 3) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of loop) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Math.abs(signedArea(loop)) > 1e-9 * (x1 - x0) * (y1 - y0);
}
