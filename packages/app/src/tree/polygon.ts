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
 * needs an AREA, rather than a winding, must rule that out first
 * (finOutline.finOutlineIntersection), as shroudToFairing does.
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
