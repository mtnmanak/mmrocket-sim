import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { motorisedStagesWithNozzle, motorMounts, primaryMountOf, stages } from '../tree/treeModel.js';
import type { BuiltDesign, DesignBuildInput } from './buildDesign.js';
import { padMassSetKey } from './configSync.js';
import type { AeroMode } from './flightPipeline.js';
import type { HardwareMassResult } from './hardwareMass.js';
import type { LaunchConditions } from './launchConditions.js';
import type { MeasuredFigures, OrkMotorRef } from './orkFile.js';
import { reconcileLegacyPadMass, type LegacyPadMassStep, type PadMassText } from './padMassReconcile.js';
import {
  designMatchKeyOf, physicsRevisionsFor, requiresPhysicsRevision, type DesignMatchKey,
} from './simReport.js';

/**
 * WHAT A LAUNCH DERIVES FROM THE DESIGN BEFORE IT BUILDS — the memos and inline
 * expressions App computed in its body, each moved here unchanged (2026-10-01)
 * so the headless Launch (services/simulateDesign.ts) derives exactly what the
 * button's closure sees.
 *
 * ONE COPY, TWO CALLERS. App's memos call these one at a time, with the deps
 * arrays they always had, so a rename still re-runs none of them
 * (App.render.test.tsx counts); `deriveLaunchInputs` composes the same
 * functions for a caller with no React. Nothing here holds a branch of its own
 * that App does not run: a function that drifted would move App's numbers and
 * the headless run's together, which is why designDerivation.test.ts pins each
 * one against the expression it replaced, and the agreement test
 * (App.simulate.test.tsx) pins what each caller feeds them.
 */

/** The design as a Launch reads it: exactly the App state the button's closure sees. */
export interface DesignState {
  tree: RocketTree;
  mountMotors: Record<string, MountMotor>;
  launch: LaunchConditions;
  /** The Measured mass & CG box. Only `massKg` reaches the build. */
  measured: MeasuredFigures;
  savedConfigs: SavedConfig[];
  activeConfigId: string | null;
  /**
   * The file's motor references nothing could resolve (App's `unmatchedRefs`).
   * They decide the FILE's primary, and so whether a legacy pad mass is
   * dropped before the first Launch (padMassReconcile.ts). Absent = none.
   */
  unmatchedRefs?: Record<string, OrkMotorRef>;
}

/** The aero state: `effectiveAero(prefs, override)` plus App's session-only Auto upgrade. */
export interface AeroState {
  aeroMode: AeroMode;
  effectiveKbf: boolean;
  /** Auto has already crossed Mach 0.9 on this design (App's `autoSupersonic`). */
  autoSupersonic: boolean;
}

/** App's `assigned`: motors on mounts that still exist in the tree. */
export type Assigned = [string, MountMotor][];

/** Assigned motors on mounts that still exist in the tree, in record order. */
export function assignedMotorsOf(mountMotors: Record<string, MountMotor>, mounts: readonly ComponentNode[]): Assigned {
  return Object.entries(mountMotors).filter(([id]) => mounts.some((m) => m.id === id));
}

/**
 * The PRIMARY mount, which drives the report's lead columns, auto-delay and the
 * weighed pad mass: the topmost-stage mount with a motor (the sustainer's). ONE
 * definition of "the primary" — treeModel.primaryMountOf — shared with the
 * export gate, the .ork attach-on-open and the session migration.
 */
export function launchPrimaryOf(tree: RocketTree, assigned: Assigned): string | null {
  return primaryMountOf(tree, assigned.map(([id]) => id));
}

/**
 * The primary as the FILE sees it: the topmost-stage mount among the assigned
 * motors AND the unmatched references. When the file's sustainer motor could
 * not be matched this differs from `launchPrimaryOf` (the booster's).
 */
export function filePrimaryOf(
  tree: RocketTree, assigned: Assigned, unmatchedRefs: Record<string, OrkMotorRef>,
): string | null {
  return primaryMountOf(tree, [...assigned.map(([id]) => id), ...Object.keys(unmatchedRefs)]);
}

/**
 * The identity of the motor set on the rocket RIGHT NOW (configSync.padMassSetKey):
 * what a weighed pad mass is keyed to. Built from `assigned`, never from every
 * record — a motor left on a removed mount is not on the rocket.
 */
export function currentSetKeyOf(tree: RocketTree, assigned: Assigned): string {
  return padMassSetKey(tree, Object.fromEntries(assigned));
}

/** The model the design is on now: Supersonic, or Auto once it has crossed Mach 0.9. */
export function effectiveSupersonicOf(aeroMode: AeroMode, autoSupersonic: boolean): boolean {
  return aeroMode === 'supersonic' || (aeroMode === 'auto' && autoSupersonic);
}

/**
 * The physics-relevant projection of the tree: names and display colours
 * stripped at every level, so a cosmetic edit keeps the key (and the flight
 * on screen) while any physical one changes it.
 */
export function physicsKeyOf(components: readonly ComponentNode[]): string {
  const strip = (n: ComponentNode): unknown => {
    const { name: _n, color: _c, children, ...rest } = n as ComponentNode & { color?: string };
    return { ...rest, children: (children ?? []).map(strip) };
  };
  return JSON.stringify(components.map(strip));
}

/**
 * The mounts the build refused. Launch leaves them off the handle and stores
 * the delay vector of the mounts it flew (flightRunner.installedMounts).
 */
export function refusedMountIdsOf(motorFailures: readonly { mountId: string }[]): string[] {
  return motorFailures.map((f) => f.mountId);
}

/** The hardware the build carries (kg), 0 when none — a provenance term (simReport's motorSetKeyOf). */
export function hardwareDeltaKgOf(built: Pick<BuiltDesign, 'hardware'> | null): number {
  return built && built.hardware.state === 'ok' ? built.hardware.deltaKg : 0;
}

/** What the report's delay table and the Auto-delay refusal call each mount: the card heading's own fallback. */
export function mountNamesOf(mounts: readonly ComponentNode[]): Record<string, string> {
  return Object.fromEntries(mounts.map((m) => [m.id!, m.name ?? 'Motor mount']));
}

/**
 * The build's input, assembled ONCE — App's build memo and the rail-button
 * placement's measuring build (onAdd) both pass through here, and so does the
 * headless build, so the three cannot name the kernel's fields differently.
 *
 * What it does NOT do (stated, verify-step1 finding 11): each caller still
 * PICKS the values it passes. App's memo and onAdd's measuring build pick them
 * from the same render's locals — one closure, the same names — and the
 * headless build from `deriveLaunchInputs`. The agreement test holds the memo's
 * build to the headless one (App.simulate.test.tsx compares `build.info` and
 * `build.hardware`); onAdd's pick is held to the memo's only by that shared
 * closure, as it was by the inline literal at 78d3015. App keeps no `derived`
 * object to hand over whole, so taking objects here would move the picking
 * into App rather than remove it.
 */
export function designBuildInputOf(a: {
  tree: RocketTree;
  assigned: Assigned;
  effectiveKbf: boolean;
  effectiveSupersonic: boolean;
  measuredDryMassKg: number | null;
  primaryMountId: string | null;
  currentSetKey: string;
}): DesignBuildInput {
  return {
    tree: a.tree,
    assigned: a.assigned,
    kbf: a.effectiveKbf,
    supersonic: a.effectiveSupersonic,
    measuredDryMassKg: a.measuredDryMassKg,
    primaryMountId: a.primaryMountId,
    currentSetKey: a.currentSetKey,
  };
}

/**
 * The provenance of the design, its motors and the conditions AS THEY STAND:
 * what a Launch stamps onto every run, and what a stored run is compared
 * against. Through simReport's designMatchKeyOf, the ONE assembly
 * (App.render.test.tsx counts its calls to see this memo re-run).
 */
export function provenanceKeyOf(a: {
  physicsKey: string;
  tree: RocketTree;
  assigned: Assigned;
  hardwareDeltaKg: number;
  launch: LaunchConditions;
  aero: AeroState;
}): DesignMatchKey {
  const { tree, assigned } = a;
  return designMatchKeyOf({
    physicsKey: a.physicsKey,
    assigned,
    hardwareDeltaKg: a.hardwareDeltaKg,
    launch: a.launch,
    aeroMode: a.aero.aeroMode,
    effectiveKbf: a.aero.effectiveKbf,
    autoSupersonic: a.aero.autoSupersonic,
    // Does the design SPEND the pressure-thrust term? A stored run flown
    // before v0.119 cannot be re-flown on a design that does — see
    // simReport's runCarriesNozzleStamp (2026-09-08).
    hasNozzle: motorisedStagesWithNozzle(tree, assigned).length > 0,
    requiresPhysicsRevision: requiresPhysicsRevision(tree),
    physicsRevisions: physicsRevisionsFor(tree),
  });
}

/** Everything a Launch derives before the build, for a caller with no React. */
export interface LaunchDerivation {
  /** `motorMounts(tree)`. */
  mounts: ComponentNode[];
  /** `stages(tree)`. */
  stageList: ComponentNode[];
  assigned: Assigned;
  primaryMountId: string | null;
  filePrimaryMountId: string | null;
  currentSetKey: string;
  effectiveSupersonic: boolean;
  physicsKey: string;
}

/** The functions above, composed in App's order. No branch of its own. */
export function deriveLaunchInputs(state: DesignState, aero: AeroState): LaunchDerivation {
  const { tree } = state;
  const mounts = motorMounts(tree);
  const assigned = assignedMotorsOf(state.mountMotors, mounts);
  return {
    mounts,
    stageList: stages(tree),
    assigned,
    primaryMountId: launchPrimaryOf(tree, assigned),
    filePrimaryMountId: filePrimaryOf(tree, assigned, state.unmatchedRefs ?? {}),
    currentSetKey: currentSetKeyOf(tree, assigned),
    effectiveSupersonic: effectiveSupersonicOf(aero.aeroMode, aero.autoSupersonic),
    physicsKey: physicsKeyOf(tree.components),
  };
}

/**
 * The legacy pad-mass decision's input, assembled ONCE for App's reconcile
 * effect and the headless settle (simulateDesign). A wiring slip here — the
 * file's primary passed as the launch primary, say — would make the drop
 * branch unreachable on both sides at once, and the agreement test pins what
 * each caller feeds in.
 */
export function legacyPadMassStepOf(a: {
  state: Pick<DesignState, 'tree' | 'mountMotors' | 'unmatchedRefs'>;
  derived: Pick<LaunchDerivation, 'primaryMountId' | 'filePrimaryMountId' | 'currentSetKey'>;
  /** The build's verdict on the pad mass (`built.hardware`); null with no build. */
  hardware: HardwareMassResult | null;
  text: PadMassText;
}): LegacyPadMassStep | null {
  return reconcileLegacyPadMass({
    hardware: a.hardware,
    primaryMountId: a.derived.primaryMountId,
    filePrimaryMountId: a.derived.filePrimaryMountId,
    motors: a.state.mountMotors,
    unmatchedRefs: a.state.unmatchedRefs ?? {},
    tree: a.state.tree,
    currentSetKey: a.derived.currentSetKey,
    text: a.text,
  });
}
