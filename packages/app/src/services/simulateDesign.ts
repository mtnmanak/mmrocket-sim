import type { FlightResult, OrkRocket, RocketTree } from '@online-openrocket/engine';
import { savedConfigLabel, type MountMotor, type SavedConfig } from '../model/design.js';
import { effectiveAero } from '../prefs/aeroChoice.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';
import { INITIAL_UNITS, type UnitSelection } from '../prefs/units.js';
import { isOnLaunchStage, motorisedStagesWithNozzle, mountMotorCount } from '../tree/treeModel.js';
import { APP_VERSION } from '../version.js';
import { buildDesign, KERNEL_HANDLES, type BuildHandle, type BuiltDesign, type HandleFactory } from './buildDesign.js';
import {
  deriveLaunchInputs, designBuildInputOf, hardwareDeltaKgOf, legacyPadMassStepOf, mountNamesOf, provenanceKeyOf,
  refusedMountIdsOf, type AeroState, type Assigned, type DesignState, type LaunchDerivation,
} from './designDerivation.js';
import { aeroModelFor, rogersKbfFor, stageMotorInfo } from './flightPipeline.js';
import { flyLaunch, type LaunchFlight } from './flightRunner.js';
import { kernelSimOptions, type LaunchConditions } from './launchConditions.js';
import { applyLegacyPadMassStep } from './padMassReconcile.js';
import { buildSimRun, type DesignMatchKey, type FreshSimRun } from './simReport.js';
import { padMassTextFor } from './unitText.js';

/**
 * THE LAUNCH, WITH NO REACT MOUNTED (2026-10-01; response-2026-10-01b § 3.2).
 *
 * Two entry points, one path:
 *
 *  - `flyBuiltDesign` is what the Launch button runs — onLaunch's flight and
 *    report, moved here as they stood at 78d3015 (App.tsx:1743-1817). App calls
 *    it with its memoised `built`; nothing in it touches React state, so the
 *    caller decides what lands where (App: `stillFlown`).
 *  - `simulateDesign` is the same Launch for a caller with no React: it derives
 *    (designDerivation.ts), builds (buildDesign.ts), settles a legacy pad mass
 *    the way App's reconcile effect does before any Launch can be pressed, and
 *    then calls `flyBuiltDesign`. So a script, a test or a later API flies what
 *    the button flies — and App.simulate.test.tsx holds the two to the same
 *    bytes on every case it has.
 *
 * App NEVER calls `simulateDesign`. It builds with `resetEngine`, which makes
 * every earlier handle throw "stale engine handle" — and App's `built.rocket`
 * is shared by the drag panel, the mass table and both re-fly paths. That is
 * why the shared path starts at the build, and why App keeps its own guarded
 * reset and `flightHoldsHandle` protocol unchanged.
 *
 * WHAT A HEADLESS RUN DOES NOT SEE (stated, not hidden): App's numbers are the
 * same physics PER INPUTS, and on a user's machine some inputs live in that
 * browser — the thrustcurve.org curve cache, a catalogue overlay from "Check
 * thrustcurve.org", custom presets and the EX motor library. `simulateFile`
 * (simulateFile.ts) reads the shipped catalogue, curves and presets only.
 *
 * A HANDLE THAT HAS SERVED THE DESIGN PAGE IS NOT A DIFFERENT HANDLE. App flies
 * a handle the drag sweep, component table and static analysis have already
 * read; `simulateDesign` flies a fresh one. The kernel's memoisation is per
 * component (engine-java/patches/LEDGER.md), so the two must agree, and
 * simulateDesign.test.ts pins it. If they ever disagree, App's numbers depend
 * on which panels the user opened — an App defect to fix in the kernel or the
 * bridge, never something to copy into this path.
 */

/** App's state as one Launch reads it, with the design already built. */
export interface BuiltLaunchInput<R extends BuildHandle = OrkRocket> {
  /** App: `built` (this render's). */
  built: BuiltDesign<R>;
  tree: RocketTree;
  /** What App's memos derived; the caller has already applied the Launch gate. */
  derived: Pick<LaunchDerivation, 'mounts' | 'stageList' | 'effectiveSupersonic'> & {
    assigned: Assigned;
    primaryMountId: string;
  };
  launch: LaunchConditions;
  aero: Pick<AeroState, 'aeroMode' | 'effectiveKbf'>;
  activeConfigId: string | null;
  savedConfigs: SavedConfig[];
  /** App passes its `provenanceKey` memo, the key every comparison uses; never recomputed here. */
  provenance: Pick<DesignMatchKey, 'designKey' | 'motorSetKey'>;
  /** App: `() => { if (stillFlown()) setAutoSupersonic(true); }`. Called after the last await. */
  onSupersonicUpgrade: () => void;
  /** App passes none, and that must not change: a Launch has no Stop. */
  signal?: AbortSignal;
  /**
   * The clock the flight's cost is read from (`performance.now` when absent).
   * It does not reach the auto-delay solver's own clock, whose `elapsedMs` is
   * wall time either way — which is why an agreement check strips it.
   */
  now?: () => number;
}

/**
 * Launch, from a built design: fly it (flightRunner.flyLaunch, which owns the
 * Mach probe, the Auto upgrade, the auto delay and the handle protocol) and
 * build the run the report and Saved simulations read. Everything after the
 * flight is pure — it was after the same await in onLaunch, so its order
 * against the kernel cannot matter.
 */
export async function flyBuiltDesign<R extends BuildHandle>(
  input: BuiltLaunchInput<R>,
): Promise<{ flight: LaunchFlight; run: FreshSimRun }> {
  const { built, tree, derived, launch, aero, activeConfigId, savedConfigs, provenance, signal, now } = input;
  const { mounts, stageList, assigned, effectiveSupersonic, primaryMountId } = derived;
  const { aeroMode, effectiveKbf } = aero;
  // The keys and their order are onLaunch's at 78d3015; `signal` and `now` are
  // spread only when given, so the object App hands the runner is unchanged.
  const flight = await flyLaunch(built.rocket, {
    assigned,
    // What the report's delay table and the Auto-delay refusal call each
    // mount: the card heading's own fallback, never the internal id.
    mountNames: mountNamesOf(mounts),
    refusedMountIds: refusedMountIdsOf(built.motorFailures),
    hardware: built.hardware,
    primaryMountId,
    simOptions: kernelSimOptions(launch),
    aeroMode,
    supersonic: effectiveSupersonic,
    isOnLaunchStage: (id) => isOnLaunchStage(tree, id),
    // Rebuilds the engine handle with the flag on after this callback
    // finishes, so the design's displayed statics follow the flight. The
    // runner calls it after its last await: on a design opened meanwhile it
    // put "M+" on the strip and flew every later flight supersonic.
    onSupersonicUpgrade: input.onSupersonicUpgrade,
    ...(signal ? { signal } : {}),
    ...(now ? { now } : {}),
  });
  const { result: res, flownDelayS: flownDelay, usedSupersonic, execMs, delayResolution } = flight;
  // The primary's record is the one `assigned` carries (filtered from the
  // working set, so the same object App's `mountMotors[primaryMountId]` was):
  // ONE source for the motor the report names and the motor that flew. Read
  // after the flight, which has already refused a design with no motor there.
  const primary: MountMotor = assigned.find(([id]) => id === primaryMountId)![1];
  // Per-stage motor info so booster branches can be safety-checked
  // (a chuteless booster above the high-power line must warn). The branch
  // naming rule, and the reason it is not simply the stage's name, lives
  // with the function in services/flightPipeline.ts.
  const branchMotors = stageMotorInfo(tree, assigned, stageList);
  // Stage B: which flight configuration flew, by display name (the
  // CSV's trailing "Flight config" column; absent when none active).
  const activeConfig = activeConfigId === null ? undefined
    : savedConfigs.find((c) => c.id === activeConfigId);
  const run = buildSimRun({
    result: res,
    delayResolution, primaryMountId,
    info: built.info,
    motor: { ...primary.spec, ejectionDelay: flownDelay },
    meta: {
      ...primary.meta,
      // What the kernel flew on the primary mount — the cluster times any
      // enclosing pod set or strap-on ring (audit 2026-09-22, row 351: a
      // motor in a three-pod set was recorded as one). The report's
      // Motors row says "firing together"; the CSV column keeps its old
      // 'Motors (cluster)' header so a sheet keyed on it still reads.
      motorCount: mountMotorCount(tree, primaryMountId),
    },
    launch,
    rocketName: tree.name ?? 'Rocket',
    execMs,
    stageMotorInfo: branchMotors,
    boosterMotors: assigned
      .filter(([id]) => id !== primaryMountId)
      .map(([, mm]) => mm.label),
    // Both stamps are permanent on the stored run, so both live in
    // services/flightPipeline.ts with their reasoning and their tests —
    // including why `effectiveKbf` and never the raw preference.
    aeroModel: aeroModelFor(aeroMode, usedSupersonic),
    rogersKbf: rogersKbfFor(effectiveKbf, usedSupersonic),
    ...(activeConfig ? { flightConfig: savedConfigLabel(activeConfig) } : {}),
    // Provenance for the .ork <flightdata> guard: what this flight was
    // computed FROM, so a later export can prove the design, motors and
    // conditions have not moved since — and refuse to write the numbers
    // when they have. Stamped from the SAME key every comparison uses
    // (App's `provenanceKey`), so the two cannot be assembled apart.
    ...(activeConfigId !== null ? { flightConfigId: activeConfigId } : {}),
    designKey: provenance.designKey,
    motorSetKey: provenance.motorSetKey,
    // What the kernel was handed for each chute — so the report can state
    // the coefficient the verdict rests on, not just the device's name.
    flownRecovery: built.flownRecovery,
    // Which stages flew a nozzle AND a motor that can burn, so the report
    // can say the flown thrust is not the published curve (2026-09-08).
    // Motorised, not merely nozzle-bearing: the kernel's own gate is
    // `getThrust(t) > 0`, so a nozzle on a stage the flown configuration
    // left empty bought exactly nothing and must not be named as
    // corrected. Names only: whether the term was LIVE is decided from
    // the two model stamps above, which is the rest of that gate.
    nozzleStages: motorisedStagesWithNozzle(tree, assigned).map((s) => s.name),
  });
  return { flight, run };
}

// ---------------------------------------------------------------------------
// The headless Launch.
// ---------------------------------------------------------------------------

/**
 * The aero model a first visit flies: the stored-preference defaults through
 * the same `effectiveAero` the app reads them with (Rogers Kbf on the classic
 * model), with no Auto upgrade yet. simulateDesign.test.ts pins it to
 * `effectiveAero(DEFAULT_PREFS, null)`.
 */
export const APP_DEFAULT_AERO: AeroState = { ...effectiveAero(DEFAULT_PREFS, null), autoSupersonic: false };

export interface SimulateDesignOptions {
  /** The aero model to fly; default APP_DEFAULT_AERO (what a first visit flies). */
  aero?: AeroState;
  /** Where the build gets its handle; default the kernel's own (`resetEngine` + buildTree). */
  handles?: HandleFactory<OrkRocket>;
  /** Cancels the run: rejects at once while it waits its turn for the kernel, else at the flight's next check. */
  signal?: AbortSignal;
  /** The clock the flight's cost is read from (`performance.now` when absent). */
  now?: () => number;
  /** Unit words for a note only (never a number): default INITIAL_UNITS. */
  units?: UnitSelection;
}

export interface SimulateDesignResult {
  /** The ONE flight the report is built from. */
  result: FlightResult;
  /** The run Saved simulations would store (not stored: nothing is persisted). */
  run: FreshSimRun;
  /** What else the flight said: the delay flown, the model, its cost, the delay solve. */
  flight: Omit<LaunchFlight, 'result'>;
  /**
   * App's `autoSupersonic` after this Launch: true once Auto has crossed
   * Mach 0.9 on this design (the next Launch flies supersonic statics, which
   * this function reproduces only when passed `aero.autoSupersonic: true`).
   */
  autoSupersonic: boolean;
  /** What the build said: statics, refusals, the weighed hardware, the chutes as flown. */
  build: Pick<BuiltDesign, 'info' | 'motorFailures' | 'hardware' | 'flownRecovery'>;
  /** The state flown — after the legacy pad-mass settle. */
  state: DesignState;
  /** The full provenance key App would stamp and compare on. */
  provenance: DesignMatchKey;
  /** The build that flew it (APP_VERSION): every answer says which. */
  appVersion: string;
}

/** Why a headless Launch did not fly, by kind, with the app's own words. */
export type SimulateFailureKind =
  /** The design file is refused before it is read (designFile.designFileTooLarge's sentence). */
  | 'file'
  /** The importer refused the file (designFile.designFileOpenFailure's sentence). */
  | 'parse'
  /** The kernel would not build the design: what App shows as its build error, verbatim. */
  | 'build'
  /** No motor on any mount: App's Launch button is disabled. */
  | 'no-motor'
  /** The flight threw: what App shows as its simulation error, verbatim. */
  | 'flight';

export class SimulateDesignError extends Error {
  readonly kind: SimulateFailureKind;
  constructor(kind: SimulateFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SimulateDesignError';
    this.kind = kind;
  }
}

/**
 * ONE HEADLESS LAUNCH AT A TIME. A build resets the kernel, which makes every
 * earlier handle throw "stale engine handle" (packages/engine orkEngine.ts),
 * and a flight awaits (the auto-delay solver yields), so two concurrent runs
 * would interleave one's reset into the other's flight. Each run holds the
 * kernel from its build to its return.
 *
 * The chain swallows each run's outcome before the next one waits on it, so a
 * run that rejects (a build error, no motor) never poisons the runs queued
 * behind it. A caller whose signal is already aborted is refused without
 * joining the queue; one aborted while it waits is refused at once, and its
 * turn, when it comes, does nothing.
 *
 * App does not take this lock: it never calls `simulateDesign` (see the header).
 */
let tail: Promise<void> = Promise.resolve();

export function withKernel<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  let started = false;
  const run = tail.then(() => {
    signal?.throwIfAborted();
    started = true;
    return fn();
  });
  tail = run.then(() => undefined, () => undefined);
  if (!signal) return run;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { if (!started) reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    run.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort); });
  });
}

/** The caller's abort reason when it is an Error (what `throwIfAborted` throws), else an AbortError naming it. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(reason === undefined ? 'The operation was aborted.' : String(reason), 'AbortError');
}

/**
 * Fly a design state the way the Launch button flies it, from the build on.
 * Nothing is persisted: `addRun` and every other write stay with App.
 */
export function simulateDesign(state: DesignState, opts: SimulateDesignOptions = {}): Promise<SimulateDesignResult> {
  return withKernel(() => simulateDesignNow(state, opts), opts.signal);
}

function buildOrThrow(
  state: DesignState, aero: AeroState, handles: HandleFactory<OrkRocket>,
): { derived: LaunchDerivation; built: BuiltDesign } {
  const derived = deriveLaunchInputs(state, aero);
  const built = buildDesign(designBuildInputOf({
    tree: state.tree,
    assigned: derived.assigned,
    effectiveKbf: aero.effectiveKbf,
    effectiveSupersonic: derived.effectiveSupersonic,
    measuredDryMassKg: state.measured.massKg,
    primaryMountId: derived.primaryMountId,
    currentSetKey: derived.currentSetKey,
  }), handles);
  if ('error' in built) throw new SimulateDesignError('build', built.error);
  return { derived, built };
}

async function simulateDesignNow(input: DesignState, opts: SimulateDesignOptions): Promise<SimulateDesignResult> {
  const aero = opts.aero ?? APP_DEFAULT_AERO;
  const handles = opts.handles ?? KERNEL_HANDLES;
  let state = input;
  let { derived, built } = buildOrThrow(state, aero, handles);
  // THE LEGACY PAD-MASS SETTLE. App's reconcile effect runs after the first
  // build, before anyone can press Launch: a value keyed 'legacy' (a
  // v0.116/v0.117 session, a bare-form .ork) is re-keyed to the set now loaded
  // or dropped, and App rebuilds because the motors changed. The same decision
  // and the same writes, then the same rebuild. At most one step: after it the
  // record carries no legacy key.
  const step = legacyPadMassStepOf({
    state, derived, hardware: built.hardware, text: padMassTextFor(opts.units ?? INITIAL_UNITS),
  });
  if (step) {
    state = applyLegacyPadMassStep(state, step);
    ({ derived, built } = buildOrThrow(state, aero, handles));
  }
  // The Launch gate (App: the button is disabled with no primary mount).
  const { primaryMountId } = derived;
  if (!primaryMountId) throw new SimulateDesignError('no-motor', 'no motor on the primary mount — assign one first');
  const provenance = provenanceKeyOf({
    physicsKey: derived.physicsKey, tree: state.tree, assigned: derived.assigned,
    hardwareDeltaKg: hardwareDeltaKgOf(built), launch: state.launch, aero,
  });
  let upgraded = false;
  let flown: Awaited<ReturnType<typeof flyBuiltDesign>>;
  try {
    flown = await flyBuiltDesign({
      built,
      tree: state.tree,
      derived: { ...derived, primaryMountId },
      launch: state.launch,
      aero,
      activeConfigId: state.activeConfigId,
      savedConfigs: state.savedConfigs,
      provenance,
      onSupersonicUpgrade: () => { upgraded = true; },
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
  } catch (e) {
    throw new SimulateDesignError('flight', e instanceof Error ? e.message : String(e), { cause: e });
  }
  const { result, ...flight } = flown.flight;
  return {
    result,
    run: flown.run,
    flight,
    autoSupersonic: aero.autoSupersonic || upgraded,
    build: { info: built.info, motorFailures: built.motorFailures, hardware: built.hardware, flownRecovery: built.flownRecovery },
    state,
    provenance,
    appVersion: APP_VERSION,
  };
}
