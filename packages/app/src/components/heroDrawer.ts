/**
 * Whether the All-stats drawer should auto-collapse on a short hero canvas.
 *
 * Eric's quarter-screen window, 2026-09-18 item 3: with the drawer open there
 * was nothing left for the rocket. Option A gave the drawing a hard floor in
 * CSS; this is option B, and it exists because a drawing pinned at its floor
 * on a 200 px band is still not a usable view — below a point the right answer
 * is to put the drawer away and give the canvas back.
 *
 * THE TRAP, AND WHY MEASURING THE STAGE AVOIDS IT. The obvious input is the
 * band left over above the drawer, and it is the wrong one: closing the drawer
 * makes that band large, so the rule would immediately reverse its own verdict
 * and the drawer would flap. The STAGE's height has the opposite sign — the
 * drawer's measured height feeds the stage's ceiling (`--drawer-clearance`),
 * so closing the drawer can only make the stage shorter or leave it alone.
 * "Too short" therefore stays true once it is true, and the verdict latches in
 * the safe direction.
 *
 * Hysteresis is still required, in the other direction only: reopening lets
 * the ceiling grow again, so without a gap the reopen threshold would describe
 * a height reachable only while already open. 60 px also absorbs the jitter of
 * a window being dragged.
 */

/**
 * Below this stage height (px, the padding box) an open drawer has been
 * squeezed under about 140 px — a header and one line of tiles — and is worth
 * less than the canvas it is standing on.
 *
 * 356 = 140 + 216, where 216 is the drawing's own budget: the 200 px layout
 * floor the schematic keeps, plus the 20 px gap the clearance measurement
 * adds, less the 4 px inset that is already outside the padding box.
 */
export const DRAWER_CLOSE_BELOW_PX = 356;

/** And above this it is worth reopening. The 60 px gap is the hysteresis. */
export const DRAWER_OPEN_ABOVE_PX = 416;

/**
 * `true`/`false` to set the drawer, or `null` to leave it exactly as it is.
 *
 * A user who worked the drawer themselves is never overruled — that is what
 * `userSet` carries, and it is the difference between a layout that helps and
 * one that argues.
 */
export function drawerAutoState(
  { stageH, open, userSet }: { stageH: number; open: boolean; userSet: boolean },
): boolean | null {
  if (userSet) return null;
  // A stage that has not been laid out yet reports 0; it is not "short".
  if (!(stageH > 0)) return null;
  if (open && stageH < DRAWER_CLOSE_BELOW_PX) return false;
  if (!open && stageH > DRAWER_OPEN_ABOVE_PX) return true;
  return null;
}
