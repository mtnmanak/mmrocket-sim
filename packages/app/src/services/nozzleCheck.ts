import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { findNode, stageIdByNode, stagesWithNozzle } from '../tree/treeModel.js';
import { clusterCount } from '../tree/cluster.js';

/**
 * Is the typed nozzle exit diameter physically possible for the motors in the
 * stage that carries it? (2026-09-08.)
 *
 * The field takes 1-200 mm and nothing has ever checked it. That was cheap
 * while it only trimmed base drag - the worst a silly value could do was about
 * half a percent of apogee. Since 2026-09-08 the same number buys thrust: the
 * kernel adds `A_exit x (101325 - P(h))` to the burning stage under Rogers Kbf
 * or the supersonic model, so a typo is now a large error in a safety number.
 * The corpus already holds the evidence - RASAero over-predicted an N1000W
 * flight by 55-61 % on a 2.737 in exit, and G record 2023 carries 0.45 in where
 * Chuck's own notes say 0.20 in
 * (docs/research/thrust-with-altitude-2026-09-08.md, Risks). Eric ruled the
 * check in on 2026-09-08: warn when the exit is wider than the motor casing.
 *
 * WHY THE CASING AREAS ARE SUMMED, not compared one at a time. The field is
 * defined as the SINGLE EQUIVALENT nozzle with the exit AREAS added
 * (`schema.ts`), and the kernel charges exactly one such area per stage - so
 * three 29 mm motors each with a 20 mm exit are entered as 20 x sqrt(3) =
 * 34.6 mm, which is wider than any one casing and entirely correct. Comparing
 * against a single casing would fire on every honest cluster. The bound is
 * therefore sqrt(sum of count x casing^2) over every motor loaded in the stage:
 * the exit plane cannot be wider than the motors it comes out of, however many
 * there are.
 *
 * Silent when nothing is typed and silent when no motor is loaded - a stage
 * with a nozzle and no motor is a design in progress, not a mistake.
 */

/** Below this the two diameters read as the same number on screen, so a warning would say "20 mm is wider than 20 mm". */
const NOZZLE_SLOP_M = 5e-5;

export interface NozzleOversize {
  /** The stage node's id - the notice key, so one bad stage cannot mask another. */
  stageId: string;
  stageName: string;
  /** What the user typed, SI metres. */
  exitDiameterM: number;
  /** sqrt(sum of count x casing^2) over the motors loaded in that stage, SI metres. */
  casingEquivalentM: number;
  /** How many motors that bound was built from (cluster counts included). */
  motorCount: number;
}

/**
 * Every stage whose typed nozzle exit diameter exceeds the motors loaded in
 * it, in tree order. Pure - App renders these, and the batch dialog never
 * needs them because it strips the nozzle from the sweep entirely.
 */
export function nozzleOversize(
  tree: RocketTree,
  /** `[mountId, record]` pairs — App's own `assigned`, which has already dropped mounts the tree lost. */
  assigned: readonly (readonly [string, MountMotor])[],
): NozzleOversize[] {
  // Which STAGE ID owns each mount. Keyed by id, never by index: `stages()`
  // filters `tree.components` to type 'stage' while `stageIndexOf` indexes it
  // unfiltered, so the two index spaces agree only while every top-level node
  // IS a stage — and `asStageNodes` exists precisely because the legacy flat
  // shape does not satisfy that. Off by one there would accuse a stage whose
  // motors were never counted (2026-09-08, review).
  const stageOfNode = stageIdByNode(tree);

  // Summed casing AREA per stage id, plus how many motors went into it.
  const sumSq = new Map<string, { area: number; count: number }>();
  for (const [mountId, mm] of assigned) {
    const d = mm.spec?.diameter;
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) continue;
    const stageId = stageOfNode.get(mountId);
    // Absent = a stale record whose mount the tree no longer has; it flies
    // nothing, so it must not raise (or suppress) a warning.
    if (stageId === undefined) continue;
    // HOW MANY MOTORS THAT MOUNT FIRES, read off the TREE. It used to read
    // `mm.meta.motorCount`, which NOTHING in the app ever writes onto a
    // MountMotor - every construction site omits it (motorMatch's
    // `mountMotorFromDb`, MotorBrowser's onSelect), and the count is derived
    // from `node.cluster` at report time instead (App.tsx, hardwareMass.ts).
    // So the cluster branch below was dead in production and an honest 4x29 mm
    // cluster entered as its 36 mm equivalent got a permanent, non-dismissible
    // warning against a 29 mm bound (2026-09-08, review). Same call as every
    // other consumer, so the four cannot drift.
    const n = clusterCount(findNode(tree, mountId)?.['cluster'] as string | undefined);
    const cur = sumSq.get(stageId) ?? { area: 0, count: 0 };
    sumSq.set(stageId, { area: cur.area + n * d * d, count: cur.count + n });
  }

  const out: NozzleOversize[] = [];
  for (const st of stagesWithNozzle(tree)) {
    const loaded = sumSq.get(st.id);
    if (!loaded || loaded.count === 0) continue;
    const casing = Math.sqrt(loaded.area);
    if (st.exitDiameterM <= casing + NOZZLE_SLOP_M) continue;
    out.push({
      stageId: st.id,
      stageName: st.name,
      exitDiameterM: st.exitDiameterM,
      casingEquivalentM: casing,
      motorCount: loaded.count,
    });
  }
  return out;
}

/**
 * The warning in words. `len` formats an SI metre length the way the user has
 * asked to see lengths, so the two numbers match the box they were typed into;
 * keeping it a callback is what lets this sentence be tested without prefs.
 */
export function nozzleOversizeText(w: NozzleOversize, len: (m: number) => string): string {
  const bound = w.motorCount > 1
    ? `the ${len(w.casingEquivalentM)} its ${w.motorCount} motors add up to (exit areas summed, as the field expects)`
    : `the ${len(w.casingEquivalentM)} casing of the motor loaded in it`;
  return `${w.stageName}: the nozzle exit diameter is ${len(w.exitDiameterM)}, wider than ${bound}`
    + ' — a nozzle cannot be wider than the motor it comes out of. This value now raises thrust as'
    + ' the rocket climbs as well as trimming base drag, so an overstated exit overstates apogee.'
    + ' Check it under the stage on the Design tab.';
}
