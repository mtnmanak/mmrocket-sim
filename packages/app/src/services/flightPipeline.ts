import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import type { SimRun } from './simReport.js';
import { findParent, stageIndexOf } from '../tree/treeModel.js';

/**
 * The three-way aerodynamics mode, as `effectiveAero` in prefs/PrefsContext
 * returns it. Spelled out rather than imported: PrefsContext is a .tsx module
 * that pulls React in, and nothing else here needs it.
 */
export type AeroMode = 'classic' | 'supersonic' | 'auto';

/**
 * The decisions `onLaunch` makes that are pure functions of the design, the
 * motors and the aero settings — the parts that write numbers and labels into
 * every stored run.
 *
 * They lived inside the component closure, where the only way the suite could
 * reach them was to read App.tsx as text (services/savedMarkSites.test.ts,
 * components/statsDrawerDefault.test.ts). That is inverted coverage on a repo
 * where a push to main IS production: moving a line failed CI while changing
 * the aeroModel stamp — which is written permanently into every user's saved
 * run history — passed untouched. Everything here is now reachable from a
 * unit test with a plain object.
 *
 * The two OTHER pure pieces of the flight path already live outside the
 * component and are already tested there: the Mach-probe truncation
 * (`machProbeSeconds`, services/machProbe.ts) and the auto-delay rounding
 * (`recommendDelay`, services/simReport.ts). Nothing is duplicated here.
 */

/**
 * Per-branch motor info for the launch report's staging safety checks — a
 * chuteless HIGH-POWER booster has to warn (the owner's G80 rule).
 *
 * Branches are named after the SERIAL stage, EXCEPT mounts inside a parallel
 * stage (a strap-on booster), whose branch carries the parallelstage node's own
 * name. Keyed by the name the branch will actually have, so a strap-on booster
 * neither misses its warning nor overwrites its host stage's entry.
 */
export function stageMotorInfo(
  tree: RocketTree,
  assigned: [string, MountMotor][],
  stageList: ComponentNode[],
): Record<string, { label: string; highPower: boolean }> {
  const out: Record<string, { label: string; highPower: boolean }> = {};
  for (const [id, mm] of assigned) {
    let branchName: string | undefined;
    let p = findParent(tree, id);
    while (p && p !== 'stage') {
      if (p.type === 'parallelstage') { branchName = p.name; break; }
      p = p.id ? findParent(tree, p.id) : null;
    }
    branchName ??= stageList[stageIndexOf(tree, id)]?.name;
    if (branchName) {
      out[branchName] = { label: mm.label, highPower: mm.meta.highPower === true };
    }
  }
  return out;
}

/**
 * Which aerodynamics model this flight is recorded as having used.
 *
 * 'auto-supersonic' and 'supersonic' are the SAME physics; they are told apart
 * so the report can say whether the user chose the model or Auto upgraded into
 * it. The stamp is permanent — it decides, for the life of that run, whether a
 * later look at it is labelled "flown on a different model" — so it must
 * describe what the kernel actually did, never what was selected before the
 * Mach probe ran.
 */
export function aeroModelFor(aeroMode: AeroMode, usedSupersonic: boolean): SimRun['aeroModel'] {
  if (aeroMode === 'auto' && usedSupersonic) return 'auto-supersonic';
  return usedSupersonic ? 'supersonic' : 'classic';
}

/**
 * Whether Rogers Modified Barrowman (Kbf) applies to this flight.
 *
 * Kbf only matters on the classic model — the supersonic model supersedes it —
 * so a supersonic flight records `false` however the preference is set.
 * `effectiveKbf` here is always the EFFECTIVE value, never the raw preference:
 * with the vitals strip's session override active the two differ, and stamping
 * the preference onto a run flown the other way would put a permanent lie in
 * the run history.
 */
export function rogersKbfFor(effectiveKbf: boolean, usedSupersonic: boolean): boolean {
  return effectiveKbf && !usedSupersonic;
}
