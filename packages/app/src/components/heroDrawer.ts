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
 * Below this stage height (px, the padding box) the CSS floor stops holding
 * and the drawer is worth less than the canvas it is standing on.
 *
 * 366 IS NOT A ROUND NUMBER — IT IS WHERE THE CSS RULE GIVES OUT, and the two
 * have to meet exactly. `.stats-drawer`'s cap is
 * `min(75%, max(120px, calc(100% - 246px)))`: the `calc` is what reserves the
 * drawing's 200 px, and it stops being the binding term when it falls under
 * the 120 px guard — at `100% = 366`. Below that the drawer is pinned at its
 * floor and the drawing loses a pixel for every pixel the stage loses.
 *
 * This was 356 for about an hour on 2026-09-21, which left a live 10 px band
 * — a stage of 356 to 365 px, reachable on a window about 776 to 786 px tall,
 * the same quarter-screen shape as Eric's original report — where the drawer
 * stayed open and the drawing got 190 to 199 px. Found by an adversarial pass
 * over the release note that claimed the drawing "keeps 200 px right down to
 * the point where the drawer puts itself away". It does now.
 */
export const DRAWER_CLOSE_BELOW_PX = 366;

/** And above this it is worth reopening. The 60 px gap is the hysteresis. */
export const DRAWER_OPEN_ABOVE_PX = 426;

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
